# Calendar Home, Plan A: Fixes for Everyone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four existing bugs for every user before the calendar home is built: the timezone lags a location change by up to 24 h; a repeating event or reminder whose first time moved earlier disappears; one Google hiccup hides a monthly series from `/week` until the next deploy; one person gets several rate-limit buckets.

**Architecture:** Four independent, small fixes, each with a before/after smoke. None of them is behind the calendar-home switch: they go live for everyone on deploy.
- Rate limiting keys on the proved DB row, not the raw `user_id` string.
- The recurring-series candidate filter also loads a series that has an `OVERRIDE` instance before the window's end. It is applied in the event store, the reminder ping pass and the carry-over read.
- The weekly recurrence lookup cache moves to a leaf module on `globalThis`, keyed per user, with expiry.
- A location save refreshes the cached timezone in the background, only on a strict, successful lookup.

**Tech Stack:** Next.js 16.1 (standalone, Turbopack `next build`) · TypeScript · Prisma 5 + Neon Postgres · Upstash Redis · node-cron · tsx smoke scripts (no test runner).

**Spec:** `docs/superpowers/specs/2026-10-16-calendar-home-design.md`, §8 (and Ruling R20). This is the first of the spec's five delivery plans (A → B → C ∥ D → E).

## Global Constraints

- The repo is PUBLIC. Never commit, print or hardcode secrets. Never read or print `.env*` files. Production is read-only; never call `/api/health`.
- **No test runner.** Tests are `tsx` smoke scripts in `scripts/`, in the `check()`/`assert()` style of `scripts/smoke-week-lookahead.ts`, printing `N/N passed` and exiting non-zero on failure. They stub modules through `require.cache` and never touch the real DB, Redis, Google, Telegram or AI. They must type-check: `next build` type-checks `scripts/**`.
- **Every smoke run fakes every `.env` name first** (Prisma loads `.env` for any unset variable). Use this prefix, adding `TZ=Asia/Jerusalem` runs where a step says so:
  ```bash
  TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/<name>.ts; echo "exit $?"
  ```
  The steps below spell the prefix out in full.
- Every commit passes `npx tsc --noEmit -p .` and `npm run -s lint`.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
  ```
- Work on branch `feat/calendar-home`. Never push to `main` from a task, and never force-push. Task 5 (the controller) lands the plan.
- **Cross-bundle state:** Next 16 compiles `instrumentation.ts` (the scheduler and cron handlers) and the route handlers into separate module instances. In-process state that both sides touch lives on `globalThis`, the way `src/utils/prisma.ts` keeps `global.prisma`.
- **Unchanged behaviour:** outside these four fixes, nothing changes. `scripts/smoke-native-provider-reminders.ts` and `scripts/smoke-reminders.ts` must pass unchanged. Never refactor Telegram flows to swap `user.id` and `telegramId`. Don't change the TTS remote/local pattern or the Gemini thinking level.
- **Fixed values** (spec §8):
  - rate-limit key: `` `u${user.id}` `` for every route through `verifyUserAuth`;
  - recurring candidate: `{ rrule: { not: null }, OR: [{ startsAt: { lt: to } }, { instances: { some: { status: 'OVERRIDE', startsAt: { lt: to } } } }] }`;
  - recurrence cache key `${userId}:${calendarId}:${recurringEventId}`; answers 6 h, failures 10 min, 404/410 6 h;
  - timezone lookup: one Nominatim and one Open-Meteo request, each `fetchWithTimeout(url, opts, 3000, 0)`; Redis `tz:user:{id}` written with `{ ex: 86400 }` only for a non-null zone.

## Review Focus

1. **Two location saves a few seconds apart** ("Tel Aviv", then "London"). The zone that sticks must be the last saved location's, even when the first lookup answers last. Pinned by Task 4 check (j), and (k) for a location changed again before its lookup lands.
2. **A location typed in Hebrew or Russian** ("תל אביב", "Москва"). The lookup must send it percent-encoded and store the right zone. Pinned by Task 4 check (l).
3. **Two people sharing one Google calendar and series id** (a spouse calendar). One person's failed lookup must never hide the series for the other. Pinned by Task 3's per-user key checks.
4. **One person reaching the app from Telegram and from a WhatsApp browser session, or sending a padded id** (`'0123'`). They share one bucket per limiter, and two different people never share one. Pinned by Task 1 checks #23–#25.
5. **A weekly reminder or event whose first occurrence was moved before the series start**, seen in the digest, `/week`, the ping pass and the carry-over list. It must appear exactly once, at its new time, and the armed-time rule for carry-overs must still hold. Pinned by Task 2's checks in `smoke-recurrence`, `smoke-native-reminders` and `smoke-native-reminder-digest` (the `Stretch` fixture pins the armed rule).

Not pinnable by a smoke: the query cost of the wider candidate filter in the 1-minute ping pass and the 5-minute alert pass. Task 5 asks the controller to watch Sentry and the deploy for slow-query warnings.

## Planning Rulings

Decided while drafting. The spec's §8 is updated to match. Executors treat these as binding.

1. **The moved-first-occurrence fix also covers the reminder ping pass and the carry-over read** (`pass.ts` `loadCandidateSeries`, `open-reminders.ts` `fetchOpenReminders`). Repeated reminders there hit the same `startsAt < bound` filter. `latestOccurrenceBefore` also searches back to the earliest `OVERRIDE` start, because its search stopped at `series.startsAt`. *Why:* same bug, same users; fixing only the event store would leave such a reminder unpinged and never carried. *If wrong:* a few extra series rows per pass.
2. **No index for the new `instances: { some: … }` filter.** Prisma renders it as a subquery that an index on the instances table would not narrow. *If wrong:* a hand-written index migration later.
3. **The weekly recurrence cache lives in a new leaf module, `src/services/recurrence-cache.ts`, with no imports.** `week-lookahead.ts` re-exports its two clear functions. Entries carry `ttlMs` as well as the spec's `{ value, at }`, because a failure and a gone series both store `null` and only the lifetime tells them apart. *Why:* Plan B's `stampGoogleCache`, which `google-provider.ts` imports, must clear a user's entries. Importing it from `week-lookahead.ts` would close the cycle google-provider → calendar-read/google → week-lookahead → calendar-provider → google-provider. *If wrong:* one extra file.
4. **The timezone refresh re-reads the user's location after the lookup and writes only if it is unchanged.** *Why:* two quick saves would otherwise let the older lookup land last and set the wrong zone for 24 h. *If wrong:* one extra DB read per location change.
5. **Not fixed here (reported only):** on `main` today, an occurrence moved to a time that has already passed never pings (the pass bounds it by the move time) but is still carried as open in the next digest (the carry-over bounds it by `series.armedAt`).

## File Structure

| File | Task | Change |
|---|---|---|
| `src/lib/api-auth.ts` | 1 | `verifyUserAuth` keys the limiter on `` `u${user.id}` `` |
| `src/services/native-calendar/event-store.ts` | 2 | `rangeCandidates`: wider recurring entry |
| `src/services/native-reminders/pass.ts` | 2 | `loadCandidateSeries`: one more OR entry |
| `src/services/native-reminders/open-reminders.ts` | 2 | `fetchOpenReminders`: wider `startsAt` filter for repeats |
| `src/services/native-calendar/recurrence.ts` | 2 | `latestOccurrenceBefore` searches back to the earliest override |
| `src/services/recurrence-cache.ts` (new) | 3 | The recurrence cache store on `globalThis`, its TTLs and clear functions |
| `src/services/week-lookahead.ts` | 3 | Uses the store; one lookup per series per run; re-exports the clear functions |
| `src/lib/timezone.ts` | 4 | `resolveTimezoneForLocation` |
| `app/api/settings/route.ts` | 4 | Schedules the refresh in `after()` when the location changes |
| `scripts/smoke-auth-identity.ts` | 1 | Rate-limit key checks #23–#27 |
| `scripts/smoke-recurrence.ts`, `smoke-native-reminders.ts`, `smoke-native-reminder-digest.ts` | 2 | Moved-first-occurrence checks |
| `scripts/smoke-week-lookahead.ts` | 3 | Cache checks, section (g) |
| `scripts/smoke-location-timezone.ts` (new) | 4 | The timezone refresh |

Tasks 1–4 touch disjoint files and can be done in this order or any other; their smoke counts below assume this order.

---

### Task 1: Rate-limit buckets keyed on the proved user (spec §8.4)

**Why:** `verifyUserAuth` passes the raw `user_id` string to the limiter (`src/lib/api-auth.ts:97`). So `'111111111'`, `'0111111111'`, `'9'` and `'09'` from one Telegram user each get their own bucket. Worse, a Telegram user whose telegramId is 42 and the WhatsApp user whose DB id is 42 share bucket `'42'`. After this task the key is `u<user.id>`, from the row the credential proved.

**Findings (read before you start):**
- The limiter call already runs **after** the user row is known. The order is 400 (no user_id) → 401 (no credential matches) → 404 (proved but no row) → 403 (suspended) → 429. Nothing moves; the order and status codes stay exactly as they are.
- A request that is both unknown and over the limit still gets 401 (or 404, or 403), as today. The limiter is never asked about it, so it uses up no token. Guard check #26 locks this in.
- The limiters are the four instances in `src/lib/rate-limit.ts:10-37`: `commandRateLimiter`, `settingsRateLimiter`, `generalRateLimiter` and `tokenPollRateLimiter`. Their only consumer is `verifyUserAuth`: 20 call sites in 15 files under `app/api/**`. No other code calls `checkRateLimit` or `.limit()`, and nothing reads or deletes `ratelimit:*` keys, so no other key scheme shares a limiter. Guard check #27 locks this in.
- `execute-command`'s `CRON_SECRET` operator path skips `verifyUserAuth` and has no limiter. That stays as it is.
- Other smokes are unaffected. `smoke-google-connect.ts` records only the limiter's *name*. `smoke-page-auth`, `smoke-oauth-weather`, `smoke-initdata-header`, `smoke-admin-panel-ssr` and `smoke-pairing-accept` always allow. `smoke-reminders.ts` stubs `verifyUserAuth` as a whole.
- What changes live, for everyone, on deploy:
  1. A user who sends different `user_id` spellings (the telegramId from the Mini App, the DB id from an old button, a leading zero) now has one budget per limiter instead of one per spelling.
  2. Two different users who send the same number no longer share a bucket.
  3. The Upstash keys go from `ratelimit:<prefix>:<raw user_id>:<window>` to `ratelimit:<prefix>:u<id>:<window>`. The old keys are never read again and expire by themselves (the sliding window sets `PEXPIRE window*2+1s`, about 2 minutes). Each user starts with a fresh window at deploy. That's a one-off, worth at most one extra minute of requests.
- The working tree may show `docs/superpowers/specs/2026-10-16-calendar-home-design.md` as modified. That isn't part of this task: stage only the two paths in Step 6.

**Files:**
- Modify: `src/lib/api-auth.ts:44-45` (the `@returns` doc), `src/lib/api-auth.ts:96-97` (the limiter call)
- Modify (test): `scripts/smoke-auth-identity.ts:5-11` (header), `:249` (recorders), `:297-301` (rate-limit stub), `:373-374` (seed reset), `:649-651` (new checks #23–#27 after #22)
- Test: `scripts/smoke-auth-identity.ts`

**Interfaces:**
- Consumes:
  - `checkRateLimit(limiter: Ratelimit, identifier: string | number): Promise<RateLimitResult>` (`src/lib/rate-limit.ts:48`, unchanged; it calls `limiter.limit(String(identifier))`)
  - `UserConfig.id: number` (`src/types.ts:22`, the Prisma `User.id`)
- Produces:
  - `verifyUserAuth(request: NextRequest, userId: string | null, initData: string | null | undefined, rateLimiter: Ratelimit, endpointName: string): Promise<AuthResult>`. The signature and result are unchanged. The rate-limit identifier is now always `` `u${user.id}` ``.
  - Later plan tasks rely on this: the calendar range route and `smoke-calendar-range.ts`'s "bucket keyed `u<id>`" check.

- [ ] **Step 1: Extend `scripts/smoke-auth-identity.ts` with a recording fake limiter and the rate-limit checks**

Make five edits.

Edit 1a, the header comment (lines 5-11). Replace:
```ts
// the number. Also covers the 24h initData window, suspended users, the one-use magic
// token and the Telegram link builders.
//
// The routes, user-service, pairing-service, subscription-service, session-auth,
// telegram-auth and magic-link run for real. Faked at the boundaries: Prisma (in memory),
// Redis (in memory), the rate limiter (always allows), Telegram and messaging (record
// every send), error capture, Next's after() (queued, then run), and fetch (blocked).
```
with:
```ts
// the number. Also covers the 24h initData window, suspended users, the one-use magic
// token, the Telegram link builders, and the rate-limit bucket (one per proved user).
//
// The routes, user-service, pairing-service, subscription-service, session-auth,
// telegram-auth and magic-link run for real. Faked at the boundaries: Prisma (in memory),
// Redis (in memory), the rate limiter (records each key; allows unless a check says no),
// Telegram and messaging (record every send), error capture, Next's after() (queued, then
// run), and fetch (blocked).
```

Edit 1b, the recorders (after line 249). Replace:
```ts
const captured: string[] = [];

const recorder = (platform: string, prefix: string): Row =>
```
with:
```ts
const captured: string[] = [];
/** Every rate-limit check: the limiter's name and the key it was given. */
const rateChecks: { limiter: string; key: string }[] = [];
/** When false the fake limiter says no, as a spent bucket does. */
let rateAllow = true;

const recorder = (platform: string, prefix: string): Row =>
```

Edit 1c, the rate-limit stub (lines 297-301). Replace:
```ts
  stub('src/lib/rate-limit.ts', {
    settingsRateLimiter: {}, commandRateLimiter: {}, generalRateLimiter: {},
    checkRateLimit: async () => ({ success: true, limit: 99, remaining: 99, reset: 0 }),
    getRateLimitHeaders: () => ({}),
  });
```
with:
```ts
  stub('src/lib/rate-limit.ts', {
    settingsRateLimiter: { name: 'settings' }, commandRateLimiter: { name: 'command' }, generalRateLimiter: { name: 'general' },
    // The real checkRateLimit hands String(identifier) to limiter.limit(): record that key.
    checkRateLimit: async (limiter: Row, identifier: string | number) => {
      rateChecks.push({ limiter: String(limiter?.name), key: String(identifier) });
      return { success: rateAllow, limit: 99, remaining: rateAllow ? 99 : 0, reset: 0 };
    },
    getRateLimitHeaders: () => ({}),
  });
```

Edit 1d, the reset in `seed()` (lines 373-374). Replace:
```ts
  captured.length = 0;
  afterQueue.length = 0;
  DB.user = [
```
with:
```ts
  captured.length = 0;
  afterQueue.length = 0;
  rateChecks.length = 0;
  rateAllow = true;
  DB.user = [
```

Edit 1e, the new checks after #22 (lines 648-651). Replace:
```ts
    assert(found.length === 0, `DB id in a Telegram link at ${found.join(', ')}`);
  });

  let failed = 0;
```
with:
```ts
    assert(found.length === 0, `DB id in a Telegram link at ${found.join(', ')}`);
  });

  // ---- Rate limit: one bucket per proved user ----

  const keysOf = (limiter: string) => rateChecks.filter(c => c.limiter === limiter).map(c => c.key);

  await check('#23 rate limit: TG initData 111111111 with user_id 111111111, 0111111111, 9 and 09 all use bucket u9', async () => {
    seed();
    for (const userId of ['111111111', '0111111111', '9', '09']) {
      const res = await postSettings(userId, { initData: initDataFor(111111111) });
      assert(res.status === 200, `user_id=${userId}: status ${res.status} ${await bodyOf(res)}`);
    }
    assert(show(keysOf('settings')) === show(['u9', 'u9', 'u9', 'u9']), `rate checks: ${show(rateChecks)}`);
  });

  await check('#24 rate limit: WA cookie 42 with user_id 42 and 042 uses bucket u42, on settings and on execute-command', async () => {
    seed();
    for (const userId of ['42', '042']) {
      const res = await postSettings(userId, { cookie: waCookie });
      assert(res.status === 200, `user_id=${userId}: status ${res.status} ${await bodyOf(res)}`);
    }
    const { POST } = await load('app/api/execute-command/route.ts');
    const res = await POST(req('/api/execute-command', { body: { user_id: 42, command: 'summary' }, cookie: waCookie }));
    await drainAfter();
    assert(res.status === 200, `execute-command: status ${res.status} ${await bodyOf(res)}`);
    assert(show(keysOf('settings')) === show(['u42', 'u42']), `rate checks: ${show(rateChecks)}`);
    assert(show(keysOf('command')) === show(['u42']), `rate checks: ${show(rateChecks)}`);
  });

  await check('#25 rate limit: TG user 7 (telegramId 42) and WA user 42, both sending user_id=42, get separate buckets', async () => {
    seed({ collision: true });
    const tg = await postSettings(42, { initData: initDataFor(42) });
    assert(tg.status === 200, `TG: status ${tg.status} ${await bodyOf(tg)}`);
    const wa = await postSettings(42, { cookie: waCookie });
    assert(wa.status === 200, `WA: status ${wa.status} ${await bodyOf(wa)}`);
    assert(show(keysOf('settings')) === show(['u7', 'u42']), `rate checks: ${show(rateChecks)}`);
  });

  await check('#26 [guard] the limiter sees only proved users: 400, 401, 404 and 403 come first; a spent bucket is 429', async () => {
    seed();
    rateAllow = false;
    const { POST } = await load('app/api/settings/route.ts');
    const noId = await POST(req('/api/settings', { body: settingsBody, cookie: waCookie }));
    assert(noId.status === 400, `no user_id: status ${noId.status} ${await bodyOf(noId)}`);
    const wrongId = await postSettings(7, { cookie: waCookie });
    assert(wrongId.status === 401, `WA cookie 42 with user_id=7: status ${wrongId.status} ${await bodyOf(wrongId)}`);
    const noRow = await postSettings(222222222, { initData: initDataFor(222222222) });
    assert(noRow.status === 404, `TG user with no row: status ${noRow.status} ${await bodyOf(noRow)}`);
    userRow(9).suspendedAt = new Date(Date.now() - DAY);
    const suspended = await postSettings(111111111, { initData: initDataFor(111111111) });
    assert(suspended.status === 403, `suspended: status ${suspended.status} ${await bodyOf(suspended)}`);
    assert(rateChecks.length === 0, `the limiter was asked about a refused request: ${show(rateChecks)}`);
    const spent = await postSettings(42, { cookie: waCookie });
    assert(spent.status === 429, `spent bucket: status ${spent.status} ${await bodyOf(spent)}`);
    assert(userWrites.length === 0, `a refused save was written: ${show(userWrites)}`);
  });

  await check('#27 [guard] only src/lib/api-auth.ts calls a limiter, so no other key shares a bucket', () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(e.name) && /\bcheckRateLimit\(|RateLimiter\.limit\(/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) {
          callers.push(rel);
        }
      }
    };
    walk('app');
    walk('src');
    const others = callers.filter(f => f !== path.join('src', 'lib', 'rate-limit.ts') && f !== path.join('src', 'lib', 'api-auth.ts'));
    assert(others.length === 0, `a limiter is also called from ${others.join(', ')}`);
  });

  let failed = 0;
```

Every helper used here already exists in the smoke: `seed`, `postSettings`, `initDataFor`, `waCookie`, `req`, `load`, `drainAfter`, `bodyOf`, `show`, `userRow`, `userWrites`, `settingsBody`, `DAY`, `fs`, `path` and `ROOT`.

- [ ] **Step 2: Run the smoke on today's code and watch #23–#25 fail**

Run:
```bash
TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-auth-identity.ts; echo "exit $?"
```
Expected: #1–#22 OK, plus #26 and #27 OK (guards), and these three failures, then `23/26 passed` and `exit 1`:
```
FAIL  #23 rate limit: TG initData 111111111 with user_id 111111111, 0111111111, 9 and 09 all use bucket u9 — rate checks: [{"limiter":"settings","key":"111111111"},{"limiter":"settings","key":"0111111111"},{"limiter":"settings","key":"9"},{"limiter":"settings","key":"09"}]
FAIL  #24 rate limit: WA cookie 42 with user_id 42 and 042 uses bucket u42, on settings and on execute-command — rate checks: [{"limiter":"settings","key":"42"},{"limiter":"settings","key":"042"},{"limiter":"command","key":"42"}]
FAIL  #25 rate limit: TG user 7 (telegramId 42) and WA user 42, both sending user_id=42, get separate buckets — rate checks: [{"limiter":"settings","key":"42"},{"limiter":"settings","key":"42"}]
```
They fail because `verifyUserAuth` calls `checkRateLimit(rateLimiter, userId)` with the raw query or body string. Every spelling gets its own key, and two users who send the same number get the same key. #26 and #27 already pass: the limiter is already consulted after the 400/401/404/403 checks, and nothing but `api-auth.ts` calls it.

- [ ] **Step 3: Key the limiter on the proved row in `src/lib/api-auth.ts`**

Edit 3a, the doc comment (lines 44-45). Replace:
```ts
 * @returns 400 without user_id, 401 when no credential matches it, 404 when the proved
 *   user has no row, 403 when that user is suspended, 429 when rate limited
 */
```
with:
```ts
 * @returns 400 without user_id, 401 when no credential matches it, 404 when the proved
 *   user has no row, 403 when that user is suspended, 429 when that user's bucket
 *   (keyed `u<user.id>` in rateLimiter) is spent
 */
```

Edit 3b, the limiter call (lines 96-97). Replace:
```ts
  // Check rate limits
  const rateLimitResult = await checkRateLimit(rateLimiter, userId);
```
with:
```ts
  // Rate limit the proved row, not the raw user_id: '123', '0123' and the DB id of one
  // user share a bucket, and two users who send the same number never do.
  const rateLimitResult = await checkRateLimit(rateLimiter, `u${user.id}`);
```

Nothing else changes. At this point TypeScript has already narrowed `user` to non-null (the 404 return above). The check order, the status codes, the 429 body and headers, and every route stay as they are.

- [ ] **Step 4: Run the smoke again (both timezones) and the smokes that share the rate-limit stub, and expect PASS**

Run (`E` holds the env prefix):
```bash
E="DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake"
for tz in UTC Asia/Jerusalem; do eval "env TZ=$tz $E npx tsx scripts/smoke-auth-identity.ts" 2>&1 | tail -1; done
for s in smoke-page-auth smoke-oauth-weather smoke-initdata-header smoke-admin-panel-ssr smoke-pairing-accept smoke-google-connect smoke-reminders; do eval "env TZ=UTC $E npx tsx scripts/$s.ts" > /dev/null 2>&1; echo "$s exit $?"; done
```
Expected: `26/26 passed` twice (UTC, then Asia/Jerusalem). Then every listed smoke prints `exit 0`. Their counts when run on their own: page-auth 10/10, oauth-weather 14/14, initdata-header 9/9, admin-panel-ssr 6/6, pairing-accept 17/17, google-connect 30/30, reminders 23/23. `smoke-reminders.ts` passes **unchanged**, as the spec requires.

- [ ] **Step 5: Type-check and lint**

Run:
```bash
npx tsc --noEmit -p . && npm run -s lint && echo CLEAN
```
Expected: no output from either command, then `CLEAN`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api-auth.ts scripts/smoke-auth-identity.ts
git commit -m "$(cat <<'EOF'
fix(rate-limit): one bucket per proved user, whichever user_id the request sent

verifyUserAuth keyed the limiter on the raw user_id, so '123', '0123' and the
user's DB id each had a bucket of their own, and a Telegram user whose
telegramId equals a WhatsApp user's DB id shared that user's bucket. It now
keys on the proved row, u<user.id>, for every route. The check order and the
status codes are unchanged: 400/401/404/403 still come before the limiter.

smoke-auth-identity records each limiter key: #23-#25 prove one bucket per
user on both credentials, #26-#27 guard the order and the single caller.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

### Task 2: A repeating event whose first time moved earlier (spec §8.2)

**Why:** The store loads a repeating series only when the series starts before the window ends: `{ rrule: { not: null }, startsAt: { lt: range.to } }` in `rangeCandidates` (`src/services/native-calendar/event-store.ts:162-181`, the recurring entry is at `:177-179`). Moving the first occurrence earlier writes an OVERRIDE row with an earlier `startsAt`, but the series row keeps its original start. Take a window that ends before the series start: the series never loads, so the moved occurrence is missing from every view, summary, event alert and voice match.

Two reminder reads filter repeating series the same way:
- the reminder ping pass, `loadCandidateSeries` (`src/services/native-reminders/pass.ts:94-120`, the entry is at `:107`). The moved occurrence of a repeating reminder never pings.
- the carry-over read, `fetchOpenReminders` (`src/services/native-reminders/open-reminders.ts:125-149`, `startsAt: { lt: cutoff }` at `:138`). The moved occurrence is never carried as open, in the digests or for voice.

After this task, all three also take a repeating series with an OVERRIDE moved to before their bound. The carry-over then has a second gap: its search for the latest occurrence, `latestOccurrenceBefore` (`src/services/native-calendar/recurrence.ts:262-283`), stopped at the series start. It now reaches back to an occurrence moved before it.

**Findings (read before you start):**
- **Who reads `rangeCandidates`:** `fetchEventsInCalendars` (`event-store.ts:226-240`) and `fetchRemindersForUserInRange` (`:249-263`). Both go through the native provider's `fetchForViewer` (`src/services/calendar-provider/native-provider.ts:186-193`). That covers the summaries, `/week`, the 5-minute event-alert pass (`getDueReminders`, `src/services/reminders.ts:163`) and the voice matcher (`src/services/voice/event-resolution.ts:465`, `src/services/voice/handler.ts:79,174`). All of them get the fix. Nothing is behind a switch.
- **Schema names checked** against `prisma/schema.prisma`:
  - the relation is `NativeEvent.instances NativeEventInstance[]` (`:218`);
  - `NativeEventInstance.status` is the enum `NativeEventInstanceStatus { OVERRIDE CANCELLED }` (`:161-164`, `:233`);
  - `NativeEventInstance.startsAt` is `DateTime?` (`:237`).
  `tsc` accepts all three filters as written in Step 3.
- **The expansion needs no fix.** `expandSeries` (`src/services/native-calendar/recurrence.ts:230-240`) already renders any override whose original slot isn't a candidate, as long as its moved instance overlaps the window. For a window before the series start, `ruleset.between` returns no candidates. The override loop then builds the moved occurrence with its own times, keyed by its original slot. Step 1's pure check pins this down; it passes before and after the change. For views, summaries and alerts, the store's query was the only thing in the way.
- **What the wider filters load, and what they don't:**
  - These still don't load: an OVERRIDE that only renames (its `startsAt` is NULL, and `NULL < x` isn't true), an occurrence moved later, and a moved occurrence that was then deleted. Deleting keeps the row's times and sets `status` to CANCELLED (`event-store.ts:793-797`).
  - The only new rows are series with an occurrence moved to before the bound. `expandSeries` still decides what shows, and for the carry-over `selectOpenReminders` decides what is open. So the only output change is the moved occurrence appearing.
- **The ping pass (`pass.ts`), checked downstream:**
  - The new entry sits beside the old recurring entry in the OR of `loadCandidateSeries`: `{ rrule: { not: null }, instances: { some: { status: 'OVERRIDE', startsAt: { lt: range.to } } } }`. Like `rangeCandidates`, it has no lower bound. The overrides then load for every series returned (`:112-114`), the moved one included.
  - `occurrencesOf` calls `expandSeries` over the pass window (48 h back, 26 h ahead, `:28-29`). The override loop renders the moved occurrence, keyed by its original slot.
  - It is due at its new time. For the armed bound, `armedAtOf` (`:156-159`) gives a moved occurrence its override's `updatedAt`, not the series' `armedAt`. So a first occurrence moved to a time still ahead pings at that time. If the move came more than `ARMED_GRACE_MS` after the new time, it doesn't ping, as for any moved occurrence on `main` today.
  - The claim and the state row use the original slot. The series' own first slot has no occurrence any more, because it moved, so nothing pings twice. `nextDue` now includes the moved occurrence, so the due gate wakes for it.
- **The carry-over read (`open-reminders.ts`), checked downstream:**
  - `startsAt: { lt: cutoff }` becomes `AND: [{ OR: [{ startsAt: { lt: cutoff } }, { rrule: { not: null }, instances: { some: { status: 'OVERRIDE', startsAt: { lt: cutoff } } } }] }]`.
  - A one-off is still read by its own time alone.
  - The creator `OR` stays where it is and keeps its meaning. A where object has only one `OR` key, so the new one goes in `AND`. Prisma ANDs top-level keys, so both conditions must hold.
  - The same read feeds voice matching: `openReminderCandidates` (`src/services/voice/event-resolution.ts:373-383`) calls it with the cutoff at now. Voice gets the moved occurrence too.
  - `selectOpenReminders` (`:85-117`) asks `latestOccurrenceBefore` for the series' latest occurrence before the cutoff. That search widens its window in steps (2, 14, 62, 400 and 4000 days back). It stopped once the window reached `series.startsAt` (`recurrence.ts:280`). So it never found a moved first occurrence more than two days before the cutoff. That happens even for a series that has begun, e.g. a weekly reminder on Wednesday's digest whose first Tuesday moved to the Friday before.
  - Step 3 moves the stop to the earliest of the series start and every OVERRIDE's `startsAt`. For a series with nothing moved before its start, that is the series start, as today.
  - The rest of `selectOpenReminders` already handles the moved occurrence:
    - the series has no occurrence on the summary day, because its first slot moved away;
    - the occurrence is due before the cutoff;
    - its state row is keyed by the original slot.
  - **The armed bound is unchanged (Planning Ruling 4).** A repeating occurrence is carried only when it is due at or after `series.armedAt - ARMED_GRACE_MS` (`:107`). A single-occurrence move leaves the series' `armedAt` alone (`event-store.ts:607-608`). So:
    - a first occurrence moved to a time after the series was set is carried, open since the day it moved to;
    - one moved to more than 15 minutes before the series was set is not carried. The pass never pinged it either, because its override's `updatedAt` is later still. Step 1 pins this case (`Stretch`).
- **Out of scope, raise with the plan owner:** the carry-over bounds a moved occurrence by the series' `armedAt`, but the pass bounds it by the override's `updatedAt`. Say a weekly reminder for Tuesdays at 22:00 was set on Monday, and on Tuesday at 21:00 that day's occurrence was moved to 20:00. It never pings, yet Wednesday's digest carries it as open since Tuesday. This holds for any moved occurrence on `main` today. This task only lets it also reach a first occurrence moved before the series start.
- **Query cost: no index and no migration.**
  - Prisma 5.22 renders `instances: { some: … }` as an uncorrelated `"NativeEvent"."id" IN (SELECT "seriesEventId" FROM "NativeEventInstance" WHERE "status" = 'OVERRIDE' AND "startsAt" < $n AND "seriesEventId" IS NOT NULL)`, not as a correlated EXISTS.
  - Inside an OR, Postgres can't turn that into a semi-join. It runs it as a hashed SubPlan: one pass over the instance table per query, then a hash probe per candidate series.
  - `NativeEventInstance` has only the unique index and a plain index on `(seriesEventId, originalStartsAt)` (`prisma/migrations/20260506000000_native_calendar_init/migration.sql:87-88`).
  - A `(seriesEventId, status, startsAt)` index can't serve a subquery that doesn't filter on `seriesEventId`. A `(status, startsAt)` index wouldn't be selective either, because `startsAt < to` keeps every past override.
  - The table only has rows for single occurrences someone edited or skipped, so the pass is small. The event-alert pass makes one or two of these reads per built-in-calendar user every 5 minutes.
  - The reminder reads add few more. The ping pass reads at most once a minute, and only when its gate is open. The carry-over reads once per digest and once per voice lookup.
  - Revisit only if the table reaches hundreds of thousands of rows, and then with a tighter filter, not an index.
- **Other smokes:**
  - `scripts/smoke-native-provider-reminders.ts` runs the real store over a stand-in Prisma that throws on `some`. It only reaches that branch for a repeating series that starts after the window, and none of its fixtures does, so it stays 11/11 (Step 4 runs it).
  - `scripts/smoke-reminders.ts` runs the event-alert pass over stubbed store functions, so it stays 23/23 (Step 4 runs it).
  - The other smokes that read events stub the provider or the store functions.
  - With this change applied, every `smoke-native-*`, `smoke-recurrence`, `smoke-reminders`, `smoke-week-lookahead`, `smoke-voice-dates`, `smoke-partner-labels`, `smoke-account-merge`, `smoke-day-shaping`, `smoke-pairing-accept`, `smoke-auth-identity` and `smoke-weather-command` passes under both clocks.

**Files:**
- Modify: `src/services/native-calendar/event-store.ts:177-179`, the recurring entry of `rangeCandidates` (`:162-181`).
- Modify: `src/services/native-reminders/pass.ts`, the doc comment of `loadCandidateSeries` (`:89-93`) and a new OR entry after `:107`.
- Modify: `src/services/native-reminders/open-reminders.ts:138`, the `startsAt` filter in the `where` of `fetchOpenReminders` (`:134-146`).
- Modify: `src/services/native-calendar/recurrence.ts:273-283`, the search loop of `latestOccurrenceBefore`.
- Modify (test): `scripts/smoke-recurrence.ts`, five spots:
  - `:550-559`: the stand-in's types and the head of `matches`;
  - after `:573`: module-level `table` and `storeOver`;
  - `:589-596`: `checkStore` uses `storeOver`;
  - `:610-614`: the new section and its `main` line;
  - `:480-483`: a latest-before check after the one that ends at `:481`.
- Modify (test): `scripts/smoke-native-reminders.ts`, three spots:
  - `:85-89`: the fake's relations learn `instances`;
  - `:110-114`: `matches` filters through it with `some`;
  - `:635-637`: the new pass check after the one that ends there.
- Modify (test): `scripts/smoke-native-reminder-digest.ts`, three spots:
  - `:133-149`: the fake's `nativeEvent.findMany` filters by its `where`, and `asRow` gives the calendar its `isDeleted`;
  - `:362-368`: the `where` the read check expects;
  - `:380-381`: the new carry-over check after the one that ends there.
- Test: `scripts/smoke-recurrence.ts`, `scripts/smoke-native-reminders.ts`, `scripts/smoke-native-reminder-digest.ts`
- Regression (unchanged): `scripts/smoke-native-provider-reminders.ts`, `scripts/smoke-reminders.ts`

**Interfaces:**
- Consumes (all unchanged):
  - `fetchEventsInCalendars(calendarCuids: string[], range: FetchRange): Promise<NativeEventRow[]>`
  - `fetchRemindersForUserInRange(forUserId: number, creatorUserId: number, range: FetchRange): Promise<NativeEventRow[]>`
  - `expandSeries(event: NativeEvent, range: { from: Date; to: Date }, overrides?: NativeEventInstance[]): VirtualInstance[]`
  - `runNativeReminderPass(now?: Date): Promise<NativeReminderPassResult>` (`pass.ts:231`)
  - `fetchOpenReminders(user: UserConfig, ctx: ViewerContext, cutoff: Date, summaryDay: string, timezone: string, cap?: number): Promise<{ events: CalendarEvent[]; moreCount: number }>`
  - `selectOpenReminders(candidates: OpenReminderCandidate[], ctx: ViewerContext, cutoff: Date, summaryDay: string, timezone: string, now: Date, cap?: number): { events: CalendarEvent[]; moreCount: number }`
- Produces (no export changes anywhere):
  - `rangeCandidates(range: FetchRange): Prisma.NativeEventWhereInput[]`. It stays module-private with the same signature, and only its recurring entry is wider.
  - `loadCandidateSeries(now: Date, range: { from: Date; to: Date })`. It stays module-private with the same signature, and its OR gains one entry.
  - `fetchOpenReminders`: same signature. Its `where` swaps `startsAt` for an `AND`.
  - `latestOccurrenceBefore(event: NativeEvent, overrides: NativeEventInstance[], at: Date): VirtualInstance | null`: same signature. It also searches back to the earliest moved occurrence.
  - Smoke-local helpers that later smoke edits can reuse:
    - in `scripts/smoke-recurrence.ts`:
      - `matches(row: Row, where: Where, relations?: Relations): boolean`
      - `table<T extends Row>(rows: T[], relations?: Relations): { findMany(args: { where: Where }): Promise<T[]> }`
      - `storeOver(tables: Record<string, unknown>): Promise<typeof import('../src/services/native-calendar/event-store')>`
    - in `scripts/smoke-native-reminders.ts`: `listRelations: Record<string, (row: Row) => Row[]>`, which `matches` filters with `some`;
    - in `scripts/smoke-native-reminder-digest.ts`:
      - `matches(row: Row, where: Row): boolean`. The fake `nativeEvent.findMany` now filters `reminderRows` with it.
      - `fromThursday(title: string, setAt: Date): NativeEvent`
      - `firstMovedTo(s: NativeEvent, to: Date): OpenReminderCandidate`

- [ ] **Step 1: Extend the three smokes with the moved-first-occurrence checks**

Make eleven edits. Line numbers are today's, before any edit.

In `scripts/smoke-recurrence.ts`, five edits.

Edit 1a: the stand-in learns relation filters (lines 550-559). Replace:
```ts
type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    const value = row[key];
```
with:
```ts
type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
/** The relations a stand-in table can filter through: a row's rows in another table. */
type Relations = Record<string, (row: Row) => Row[]>;

const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

function matches(row: Row, where: Where, relations: Relations = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w, relations));
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w, relations));
    if (Object.hasOwn(relations, key)) {
      // A relation filter, e.g. { instances: { some: { status: 'OVERRIDE' } } }.
      const { some, ...rest } = cond as { some?: Where };
      if (!some || Object.keys(rest).length > 0) throw new Error(`stand-in Prisma only knows '${key}: { some }'`);
      return relations[key](row).some((r) => matches(r, some));
    }
    const value = row[key];
```

Edit 1b: module-level `table` and `storeOver`, between the end of `matches` and `checkStore` (lines 569-575). Replace:
```ts
        default: throw new Error(`stand-in Prisma does not know '${op}'`);
      }
    });
  });
}

async function checkStore() {
```
with:
```ts
        default: throw new Error(`stand-in Prisma does not know '${op}'`);
      }
    });
  });
}

/** A stand-in table: findMany filters its rows, following `relations`. */
const table = <T extends Row>(rows: T[], relations: Relations = {}) => ({
  findMany: async ({ where }: { where: Where }) => rows.filter((r) => matches(r, where, relations)),
});

/**
 * The event store, reading through a stand-in Prisma made of these tables.
 * src/utils/prisma takes global.prisma once, when the store first loads, so a
 * later call swaps the tables on that same object.
 */
async function storeOver(tables: Record<string, unknown>) {
  const g = globalThis as { prisma?: unknown };
  g.prisma = Object.assign((g.prisma as Record<string, unknown> | undefined) ?? {}, tables);
  return import('../src/services/native-calendar/event-store');
}

async function checkStore() {
```

Edit 1c: `checkStore` loads the store through `storeOver` (lines 589-596). Replace:
```ts
  const table = <T extends Row>(rows: T[]) => ({ findMany: async ({ where }: { where: Where }) => rows.filter((r) => matches(r, where)) });
  // src/utils/prisma reuses global.prisma when set; it must be in place before the store loads.
  (globalThis as { prisma?: unknown }).prisma = {
    nativeCalendar: table([calendar]),
    nativeEvent: table(events as unknown as Row[]),
    nativeEventInstance: table([] as Row[]),
  };
  const { fetchEventsInCalendars } = await import('../src/services/native-calendar/event-store');
```
with:
```ts
  const { fetchEventsInCalendars } = await storeOver({
    nativeCalendar: table([calendar]),
    nativeEvent: table(events as unknown as Row[]),
    nativeEventInstance: table([] as Row[]),
  });
```

Edit 1d: the new section, and its run in `main` (lines 610-614). Replace:
```ts
  assert(sun === 'Camp', `Sunday got [${sun}]`);
}

async function main() {
  await checkAsync('overlap: fetchEventsInCalendars takes everything running into the window', checkStore);
```
with:
```ts
  assert(sun === 'Camp', `Sunday got [${sun}]`);
}

// --- A first occurrence moved before the series start -----------------------
// Moving a repeating event's first time earlier leaves the series row starting
// after that occurrence. The store loaded a series only once its start was
// before the window's end, so the moved occurrence never reached any window
// before the series start: no view, summary or alert had it.

// 2026-11-15 is a Sunday, 2026-11-17 a Tuesday.
const swimFirst = at('2026-11-17 17:00');
const swimSeries = (fields: Partial<NativeEvent> = {}) => jlm({
  title: 'Swim', startsAt: swimFirst, endsAt: at('2026-11-17 18:00'), rrule: 'FREQ=WEEKLY;BYDAY=TU', ...fields,
});
/** The series' first occurrence, moved to Sunday 16:00-17:00. */
const movedToSunday = (seriesId: string) =>
  makeOverride(seriesId, swimFirst, { startsAt: at('2026-11-15 16:00'), endsAt: at('2026-11-15 17:00') });

check('moved earlier: expandSeries renders a first occurrence moved before the series start', () => {
  const series = swimSeries();
  const sun = expandSeries(series, dayOf('2026-11-15'), [movedToSunday(series.id)]);
  assert(sun.length === 1, `expected the moved occurrence on Sunday, got ${sun.length}`);
  assert(sun[0].startsAt.getTime() === at('2026-11-15 16:00').getTime(), `wrong start: ${sun[0].startsAt.toISOString()}`);
  assert(sun[0].instanceStartsAt.getTime() === swimFirst.getTime(), 'keyed by its original slot');
  assert(expandSeries(series, dayOf('2026-11-17'), [movedToSunday(series.id)]).length === 0, 'gone from its Tuesday');
});

async function checkMovedFirstOccurrence() {
  const calendar = { id: 'cal-1', name: 'Family', isDeleted: false };
  const events: NativeEvent[] = [
    swimSeries({ id: 'swim', calendarId: 'cal-1' }),
    // A daily 08:00 reminder the partner (user 1) set for the viewer (user 2).
    jlm({
      id: 'pills', calendarId: 'cal-1', kind: 'REMINDER', creatorUserId: 1, forUserId: 2, title: 'Pills',
      startsAt: at('2026-11-17 08:00'), endsAt: at('2026-11-17 08:00'), rrule: 'FREQ=DAILY',
    }),
    // These start after Sunday and have nothing on it.
    swimSeries({ id: 'piano', calendarId: 'cal-1', title: 'Piano' }),
    swimSeries({ id: 'choir', calendarId: 'cal-1', title: 'Choir' }),
    swimSeries({ id: 'chess', calendarId: 'cal-1', title: 'Chess' }),
    swimSeries({ id: 'drama', calendarId: 'cal-1', title: 'Drama' }),
  ];
  const instances: NativeEventInstance[] = [
    movedToSunday('swim'),
    // Its first time moved to Sunday 20:00.
    makeOverride('pills', at('2026-11-17 08:00'), { startsAt: at('2026-11-15 20:00'), endsAt: at('2026-11-15 20:00') }),
    // Retitled only: an OVERRIDE with no time of its own.
    makeOverride('choir', swimFirst, { title: 'Choir (hall B)' }),
    // Moved later, to Wednesday.
    makeOverride('chess', swimFirst, { startsAt: at('2026-11-18 17:00'), endsAt: at('2026-11-18 18:00') }),
    // Moved to Sunday, then deleted: the row keeps its times and turns CANCELLED.
    { ...movedToSunday('drama'), status: 'CANCELLED' },
  ];
  const instanceRows = instances as unknown as Row[];
  const eventTable = table(events as unknown as Row[], {
    instances: (row) => instanceRows.filter((i) => i.seriesEventId === row.id),
  });
  // The series the query returned, before expansion drops any.
  let loaded: string[] = [];
  const store = await storeOver({
    nativeCalendar: table([calendar]),
    nativeEvent: {
      findMany: async (args: { where: Where }) => {
        const rows = await eventTable.findMany(args);
        loaded.push(...rows.map((r) => String(r.id)));
        return rows;
      },
    },
    nativeEventInstance: table(instanceRows),
  });
  const sunday = dayOf('2026-11-15');
  const titles = (rows: Array<{ instance: VirtualInstance }>) => rows.map((r) => r.instance.title).sort().join(', ');
  const loadedIds = () => [...loaded].sort().join(', ');

  const onCalendar = await store.fetchEventsInCalendars(['cal-1'], sunday);
  assert(titles(onCalendar) === 'Pills, Swim', `Sunday got [${titles(onCalendar)}], loaded [${loadedIds()}]`);
  const swim = onCalendar.find((r) => r.series.id === 'swim');
  assert(swim?.instance.startsAt.getTime() === at('2026-11-15 16:00').getTime(), 'Swim shows at the time it moved to');
  // A series that starts after the window, with nothing moved into it, still stays out of the query.
  assert(loadedIds() === 'pills, swim', `loaded [${loadedIds()}]`);

  // The reminders a partner set for the viewer read through the same filter.
  loaded = [];
  const forViewer = await store.fetchRemindersForUserInRange(2, 1, sunday);
  assert(titles(forViewer) === 'Pills', `the viewer's reminders got [${titles(forViewer)}], loaded [${loadedIds()}]`);
}

async function main() {
  await checkAsync('overlap: fetchEventsInCalendars takes everything running into the window', checkStore);
  await checkAsync('moved earlier: a series whose first occurrence moved before its start loads for that window', checkMovedFirstOccurrence);
```

The `loaded [...]` assertion pins down both halves of the `some` filter: without `status: 'OVERRIDE'`, `drama` loads; without the instance's `startsAt: { lt }`, `choir` and `chess` load.

Edit 1e: a latest-before check, after the one that ends at line 481 (lines 480-483). Replace:
```ts
  assert(found.isOverridden && found.instanceStartsAt.toISOString() === iso('2026-11-13 08:00'), `key ${found.instanceStartsAt.toISOString()}`);
});

check('latest before: it reaches back as far as the series needs', () => {
```
with:
```ts
  assert(found.isOverridden && found.instanceStartsAt.toISOString() === iso('2026-11-13 08:00'), `key ${found.instanceStartsAt.toISOString()}`);
});

check('latest before: a first occurrence moved before the series start counts, however far back', () => {
  // The series' first occurrence, Monday 2026-11-02 08:00, moved a week earlier.
  const moved = [makeOverride('series-1', at('2026-11-02 08:00'), { startsAt: at('2026-10-26 18:00'), endsAt: at('2026-10-26 18:00') })];
  // Thursday, three days on and still before the series start.
  const found = latestOccurrenceBefore(dailyPills(), moved, at('2026-10-29 12:00'));
  assert(found !== null && found.startsAt.toISOString() === iso('2026-10-26 18:00'), `Thursday got ${found?.startsAt.toISOString() ?? 'none'}`);
  assert(found.instanceStartsAt.toISOString() === iso('2026-11-02 08:00'), `key ${found.instanceStartsAt.toISOString()}`);
  // Monday noon: that morning's slot is the one that moved, so the moved one is still the latest.
  const monday = latestStart(dailyPills(), at('2026-11-02 12:00'), moved);
  assert(monday === iso('2026-10-26 18:00'), `Monday noon got ${monday}`);
});

check('latest before: it reaches back as far as the series needs', () => {
```

In `scripts/smoke-native-reminders.ts`, three edits.

Edit 1f: the fake's relations learn `instances` (lines 85-89). Replace:
```ts
// The filters the pass and the claim use: equality, null, in, not, ranges, OR, and the
// event's calendar relation.
const relations: Record<string, (row: Row) => Row | undefined> = {
  calendar: (row) => db.calendars.find((c) => c.id === row.calendarId),
};
```
with:
```ts
// The filters the pass and the claim use: equality, null, in, not, ranges, OR, the
// event's calendar relation, and `some` over its instances.
const relations: Record<string, (row: Row) => Row | undefined> = {
  calendar: (row) => db.calendars.find((c) => c.id === row.calendarId),
};
const listRelations: Record<string, (row: Row) => Row[]> = {
  instances: (row) => db.instances.filter((i) => i.seriesEventId === row.id),
};
```

Edit 1g: `matches` filters through it with `some` (lines 110-114). Replace:
```ts
    if (key in relations) {
      const related = relations[key](row);
      return !!related && matches(related, cond as Row);
    }
    return fieldMatches(row[key], cond);
```
with:
```ts
    if (key in relations) {
      const related = relations[key](row);
      return !!related && matches(related, cond as Row);
    }
    if (key in listRelations) {
      const { some, ...rest } = cond as { some?: Row };
      if (!some || Object.keys(rest).length > 0) throw new Error(`fake prisma: only '${key}: { some }'`);
      return listRelations[key](row).some((r) => matches(r, some));
    }
    return fieldMatches(row[key], cond);
```

Edit 1h: the new pass check, after the one that ends at line 637 (lines 635-637). Replace:
```ts
      if (pings) assert(!!stateOf(daily.id, today('08:00')), 'not keyed by its original slot');
    }
  });
```
with:
```ts
      if (pings) assert(!!stateOf(daily.id, today('08:00')), 'not keyed by its original slot');
    }
  });

  await check('pass: a first occurrence moved before the series start pings at the time it moved to', async () => {
    reset();
    // Daily at 08:00 from Monday 19 Oct, set yesterday at noon. An hour later its first
    // time, Monday's, moved to today 10:00: four days before the series starts.
    const daily = (id: string, title: string) =>
      reminder({ id, title, startsAt: at('2026-10-19 08:00'), rrule: 'FREQ=DAILY', armedAt: at('2026-10-14 12:00') });
    const moveFirst = (seriesEventId: string, fields: Row) => db.instances.push({
      id: `ov-${seriesEventId}`, seriesEventId, originalStartsAt: at('2026-10-19 08:00'), status: 'OVERRIDE', title: null,
      description: null, location: null, startsAt: null, endsAt: null, allDay: null,
      createdAt: at('2026-10-14 13:00'), updatedAt: at('2026-10-14 13:00'), ...fields,
    });
    daily('pills', 'Pills');
    moveFirst('pills', { startsAt: today('10:00'), endsAt: today('10:00') });
    // These don't load: renamed only, moved later, and moved to today then deleted.
    daily('renamed', 'Renamed');
    moveFirst('renamed', { title: 'Pills (blue box)' });
    daily('later', 'Later');
    moveFirst('later', { startsAt: at('2026-10-20 10:00'), endsAt: at('2026-10-20 10:00') });
    daily('dropped', 'Dropped');
    moveFirst('dropped', { status: 'CANCELLED', startsAt: today('10:00'), endsAt: today('10:00') });

    // The series the query returned, before expansion drops any.
    const findSeries = fakePrisma.nativeEvent.findMany;
    const loaded: string[] = [];
    fakePrisma.nativeEvent.findMany = async (args: Args) => {
      const rows = await findSeries(args);
      loaded.push(...rows.map((r) => String(r.id)));
      return rows;
    };
    try {
      const result = await pass(today('10:00'));
      assert(sentLines() === '1001: ⏰ <b>Pills</b>', `${sentLines()}, loaded [${loaded}]`);
      assert(result.sent === 1, show(result));
      assert(!!stateOf('pills', at('2026-10-19 08:00')), `not keyed by its original slot: ${show(db.states)}`);
      assert(loaded.join(', ') === 'pills', `loaded [${loaded}]`);
    } finally {
      fakePrisma.nativeEvent.findMany = findSeries;
    }
  });
```

Here too, the `loaded [...]` assertion pins both halves of the `some` filter: without `status: 'OVERRIDE'`, `dropped` loads; without the instance's `startsAt: { lt }`, `renamed` and `later` load.

In `scripts/smoke-native-reminder-digest.ts`, three edits.

Edit 1i: the fake filters by its `where` (lines 133-149). Replace:
```ts
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
```
with:
```ts
const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

// The filters fetchOpenReminders uses: equality, not, lt, AND, OR, the calendar, and
// `some` over the instances. A row carries both, as asRow includes them.
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some(w => matches(row, w));
    if (key === 'AND') return (cond as Row[]).every(w => matches(row, w));
    if (key === 'calendar') return matches(row.calendar as Row, cond as Row);
    if (key === 'instances') {
      const { some, ...rest } = cond as { some?: Row };
      if (!some || Object.keys(rest).length > 0) throw new Error("fake prisma: only 'instances: { some }'");
      return (row.instances as Row[]).some(i => matches(i, some));
    }
    const value = row[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return same(value, cond);
    return Object.entries(cond as Row).every(([op, arg]) => {
      switch (op) {
        case 'not': return !same(value, arg);
        case 'lt': return value != null && (value as Date) < (arg as Date);
        default: throw new Error(`fake prisma: no operator ${op}`);
      }
    });
  });
}

/** The rows nativeEvent.findMany filters, and every query it was asked. */
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
      return reminderRows.filter(r => matches(r, args.where as Row));
    },
  },
};
/** A row as findMany returns it with its calendar, overrides and states included. */
const asRow = (c: OpenReminderCandidate): Row =>
  ({ ...c.series, calendar: { ...c.calendar, isDeleted: false }, instances: c.overrides, states: c.states });
```

Every existing fixture the fake hands back is a REMINDER by user 1, on a live calendar, from before the cutoff, so the filter keeps them all.

Edit 1j: the `where` the read check expects (lines 362-368). Replace:
```ts
      where: {
        kind: 'REMINDER',
        isDeleted: false,
        startsAt: { lt: cutoff },
        calendar: { isDeleted: false },
        OR: [{ creatorUserId: 1 }, { creatorUserId: 2, forUserId: 1 }],
      },
```
with:
```ts
      where: {
        kind: 'REMINDER',
        isDeleted: false,
        calendar: { isDeleted: false },
        AND: [{
          OR: [
            { startsAt: { lt: cutoff } },
            { rrule: { not: null }, instances: { some: { status: 'OVERRIDE', startsAt: { lt: cutoff } } } },
          ],
        }],
        OR: [{ creatorUserId: 1 }, { creatorUserId: 2, forUserId: 1 }],
      },
```

Edit 1k: the new carry-over check, after the one that ends at line 381 (lines 380-381). Replace:
```ts
    assert(none.events.length === 0 && findManyCalls.length === 0, 'read for a Google user');
  });
```
with:
```ts
    assert(none.events.length === 0 && findManyCalls.length === 0, 'read for a Google user');
  });

  // Daily at 08:00 from Thursday 15 Oct, the day after the summary day, set at `setAt`.
  // Moving its first time earlier leaves the series row starting Thursday, after the cutoff.
  const fromThursday = (title: string, setAt: Date) =>
    series(title, il('2026-10-15 08:00:00'), { rrule: 'FREQ=DAILY', armedAt: setAt, createdAt: setAt, updatedAt: setAt });
  /** The series with its first occurrence, Thursday's, moved to `to` when the series was set. */
  const firstMovedTo = (s: NativeEvent, to: Date): OpenReminderCandidate => candidate(s, [], [{
    id: `ov-${s.id}`, seriesEventId: s.id, originalStartsAt: s.startsAt, status: 'OVERRIDE', title: null, description: null,
    location: null, startsAt: to, endsAt: to, allDay: null, createdAt: s.createdAt, updatedAt: s.createdAt,
  }]);

  await check('fetch: a first occurrence moved before the series start is read and carried, however far back', async () => {
    reminderRows = [
      firstMovedTo(fromThursday('Pills', il('2026-10-12 12:00:00')), il('2026-10-13 20:00:00')),
      // Moved to Sunday, three days before the cutoff.
      firstMovedTo(fromThursday('Vitamins', il('2026-10-09 12:00:00')), il('2026-10-11 20:00:00')),
      // Set Tuesday at 21:00 with its first time moved to 20:00, already past: never
      // armed, so never pinged, and not open (Planning Ruling 4).
      firstMovedTo(fromThursday('Stretch', il('2026-10-13 21:00:00')), il('2026-10-13 20:00:00')),
    ].map(asRow);
    const { events } = await fetchOpenReminders(raziel, razielCtx, cutoff, WEDNESDAY, IL);
    assertList(linesOf(events, WEDNESDAY), [
      'Pills (Reminder (open since Tue 13 Oct)) [Calendar: Raziel]',
      'Vitamins (Reminder (open since Sun 11 Oct)) [Calendar: Raziel]',
    ]);
  });
```

`Pills` needs only the wider read. `Vitamins` also needs the search fix: its moved occurrence is 52 hours before the cutoff, past the search's first window. `Stretch` is due before its `armedAt - 15 min`, so it pins the armed bound.

- [ ] **Step 2: Run the three smokes and see the new checks fail**

```bash
cd /Users/razielgershoni/development/famcalbot
for f in smoke-recurrence smoke-native-reminders smoke-native-reminder-digest; do for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts; echo "$f $tz exit=$?"; done; done
```

Expected, under both clocks: every other check is `OK`. These lines print among the `OK` lines, in this order, and each run ends as shown.

`smoke-recurrence` (35 checks before, 38 now):
```
FAIL  latest before: a first occurrence moved before the series start counts, however far back — Thursday got none
OK  moved earlier: expandSeries renders a first occurrence moved before the series start
FAIL  moved earlier: a series whose first occurrence moved before its start loads for that window — Sunday got [], loaded []

36/38 passed
smoke-recurrence UTC exit=1
```

`smoke-native-reminders` (44 checks before, 45 now):
```
FAIL  pass: a first occurrence moved before the series start pings at the time it moved to — (nothing), loaded []

44/45 passed (process TZ=UTC)
smoke-native-reminders UTC exit=1
```

`smoke-native-reminder-digest` (32 checks before, 33 now):
```
FAIL  fetch: one read of the viewer's and the partner's-for-the-viewer REMINDER series before the cutoff — {"where":{"kind":"REMINDER","isDeleted":false,"startsAt":{"lt":"2026-10-13T21:00:00.000Z"},"calendar":{"isDeleted":false},"OR":[{"creatorUserId":1},{"creatorUserId":2,"forUserId":1}]},"include":{"calendar":true,"instances":true,"states":true}}
FAIL  fetch: a first occurrence moved before the series start is read and carried, however far back — 
     got  []
     want [
 "Pills (Reminder (open since Tue 13 Oct)) [Calendar: Raziel]",
 "Vitamins (Reminder (open since Sun 11 Oct)) [Calendar: Raziel]"
]

31/33 passed (process TZ=UTC)
smoke-native-reminder-digest UTC exit=1
```
The Asia/Jerusalem runs end the same way, with `(process TZ=Asia/Jerusalem)` where the smoke prints it.

Why each fails today:
- **The store check** (`Sunday got [], loaded []`): every fixture series starts on Tuesday 2026-11-17, after Sunday's window ends. Today's recurring candidate is `startsAt < range.to`, so `nativeEvent.findMany` returns nothing and `fetchEventsInCalendars` returns early with `[]`. The pure `expandSeries` check already passes, which shows the query is the only thing at fault there.
- **The latest-before check** (`Thursday got none`): the search's first window, two days back, already starts before the series start, so it stops there. The moved occurrence is three days back.
- **The pass check** (`(nothing), loaded []`): the series starts four days after now, past the pass window's end, so the query returns nothing.
- **The digest read checks:** the read still asks for `startsAt < cutoff`, so the first check sees the old `where`. In the second, every series starts on Thursday, after the cutoff, so nothing is read and nothing is carried.

- [ ] **Step 3: Widen the three reads, and the carry-over's search**

Make five edits.

Edit 3a: in `src/services/native-calendar/event-store.ts`, lines 177-179. Replace:
```ts
    // recurring: include all whose dtstart is before range.to and (no UNTIL
    // filter at SQL level — rrule expansion handles bounded series).
    { rrule: { not: null }, startsAt: { lt: range.to } },
  ];
}
```
with:
```ts
    // recurring: every series that has begun by range.to, and any with an
    // occurrence moved to before it - a first occurrence moved earlier than the
    // series start would otherwise never load. No UNTIL filter at SQL level:
    // expandSeries handles bounded series and puts a moved occurrence where it
    // landed.
    {
      rrule: { not: null },
      OR: [
        { startsAt: { lt: range.to } },
        { instances: { some: { status: 'OVERRIDE', startsAt: { lt: range.to } } } },
      ],
    },
  ];
}
```

Edit 3b: in `src/services/native-reminders/pass.ts`, the doc comment of `loadCandidateSeries` (lines 89-93). Replace:
```ts
/**
 * Reminder series that may have an occurrence due in the window: one-offs starting in
 * it, every repeating series that has begun by its end, and any series with an undone
 * snooze waking in it, whenever its occurrence was.
 */
```
with:
```ts
/**
 * Reminder series that may have an occurrence due in the window: one-offs starting in
 * it, every repeating series that has begun by its end or has an occurrence moved to
 * before its end, and any series with an undone snooze waking in it, whenever its
 * occurrence was.
 */
```

Edit 3c: in `src/services/native-reminders/pass.ts`, a new OR entry after the recurring one (lines 107-108). Replace:
```ts
        { rrule: { not: null }, startsAt: { lt: range.to } },
        ...(snoozedSeriesIds.length ? [{ id: { in: snoozedSeriesIds } }] : []),
```
with:
```ts
        { rrule: { not: null }, startsAt: { lt: range.to } },
        // A first occurrence moved earlier than the series start: the series row keeps
        // its own start, so only the moved instance says it is due.
        { rrule: { not: null }, instances: { some: { status: 'OVERRIDE', startsAt: { lt: range.to } } } },
        ...(snoozedSeriesIds.length ? [{ id: { in: snoozedSeriesIds } }] : []),
```

Edit 3d: in `src/services/native-reminders/open-reminders.ts`, the `where` of `fetchOpenReminders` (lines 136-140). Replace:
```ts
      kind: 'REMINDER',
      isDeleted: false,
      startsAt: { lt: cutoff },
      calendar: { isDeleted: false },
      OR: [
```
with:
```ts
      kind: 'REMINDER',
      isDeleted: false,
      calendar: { isDeleted: false },
      // Due before the cutoff: a one-off by its own time, a repeating one once it has
      // begun or when an occurrence was moved to before the cutoff (a first occurrence
      // moved earlier than the series start). In AND because the OR below is taken: it
      // says whose reminders these are.
      AND: [
        {
          OR: [
            { startsAt: { lt: cutoff } },
            { rrule: { not: null }, instances: { some: { status: 'OVERRIDE', startsAt: { lt: cutoff } } } },
          ],
        },
      ],
      OR: [
```

Edit 3e: in `src/services/native-calendar/recurrence.ts`, the search loop of `latestOccurrenceBefore` (lines 273-283). Replace:
```ts
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
```
with:
```ts
  // Nothing starts before the series except an occurrence moved there, such as a
  // first occurrence moved earlier: the search goes back to that too.
  const earliest = overrides.reduce(
    (min, o) => (o.status === 'OVERRIDE' && o.startsAt && o.startsAt < min ? o.startsAt : min),
    event.startsAt
  );
  for (const days of LOOKBACK_STEPS_DAYS) {
    const from = new Date(at.getTime() - days * DAY_MS);
    // Only occurrences that start in [from, at). One that started earlier and is
    // still running at `from` may not be the latest; a wider window decides it.
    const started = expandSeries(event, { from, to: at }, overrides).filter((i) => i.startsAt >= from);
    if (started.length > 0) return started[started.length - 1];
    // The window already reaches the series' first occurrence, and any moved before it.
    if (from <= earliest) break;
  }
  return null;
}
```

Nothing else changes. No migration: see "Query cost" in the findings.

- [ ] **Step 4: Run the three smokes again, plus the two that must stay unchanged**

```bash
cd /Users/razielgershoni/development/famcalbot
for f in smoke-recurrence smoke-native-reminders smoke-native-reminder-digest smoke-native-provider-reminders smoke-reminders; do for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts; echo "$f $tz exit=$?"; done; done
```
Expected: every line `OK`, and each run ends like this:
```
38/38 passed
smoke-recurrence UTC exit=0
38/38 passed
smoke-recurrence Asia/Jerusalem exit=0
45/45 passed (process TZ=UTC)
smoke-native-reminders UTC exit=0
45/45 passed (process TZ=Asia/Jerusalem)
smoke-native-reminders Asia/Jerusalem exit=0
33/33 passed (process TZ=UTC)
smoke-native-reminder-digest UTC exit=0
33/33 passed (process TZ=Asia/Jerusalem)
smoke-native-reminder-digest Asia/Jerusalem exit=0
11/11 passed (process TZ=UTC)
smoke-native-provider-reminders UTC exit=0
11/11 passed (process TZ=Asia/Jerusalem)
smoke-native-provider-reminders Asia/Jerusalem exit=0
23/23 passed (process TZ=UTC)
smoke-reminders UTC exit=0
23/23 passed (process TZ=Asia/Jerusalem)
smoke-reminders Asia/Jerusalem exit=0
```

- [ ] **Step 5: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p . && npm run -s lint; echo "exit=$?"
```
Expected: no output from either, then `exit=0`.

- [ ] **Step 6: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add src/services/native-calendar/event-store.ts src/services/native-calendar/recurrence.ts src/services/native-reminders/pass.ts src/services/native-reminders/open-reminders.ts scripts/smoke-recurrence.ts scripts/smoke-native-reminders.ts scripts/smoke-native-reminder-digest.ts
git commit -m "$(cat <<'EOF'
fix(native-calendar): a repeating event whose first time moved earlier shows, pings and carries over

A series loaded only once its start was before the window's end, so moving
its first occurrence earlier hid it from every view, summary, alert and
voice match until the series' own start. The reminder pass and the digest
carry-over read filtered the same way, so that occurrence of a repeating
reminder never pinged and was never carried as open. All three now also
take a series with an occurrence moved to before their bound; expandSeries
already puts a moved occurrence where it landed. The carry-over's search
for the latest occurrence now also reaches back past the series start to
an occurrence moved there. A rename-only, moved-later or deleted
occurrence still doesn't load its series, a one-off is still read by its
own time, and the armed bound on carry-over is unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```
Stage only these seven paths.

---

### Task 3: Weekly recurrence lookup cache (spec §8.3)

**What is wrong today.** `/week`, `/nextweek` and the tomorrow summary's lookahead hide daily series, and weekly ones unless the user opts in. To know which is which they ask Google (or the native table) for each series' master event, through `getMasterEventRecurrence` (`src/services/week-lookahead.ts:121-171`). Its cache (`:59`) is a module-level `Map` keyed `${calendarId}:${recurringEventId}`. That causes three problems:

- A failed lookup stores `null` forever, and `null` reads as "daily", so the event is filtered out. One Google hiccup hides a monthly series from `/week` until the next deploy.
- The key has no user in it, so every user with that calendar and series id gets the first user's answer, including that user's failure.
- The `Map` is module state. Next 16 gives the scheduler (`instrumentation.ts`) and the route handlers separate module instances, so nothing can clear it for both.

**The fix:**
- The cache moves to `globalThis.__recurrenceCache`, keyed `${userId}:${calendarId}:${recurringEventId}`. Each entry is `{ value, at, ttlMs }`.
- An answer is kept 6 h. A failure is kept 10 min. A 404 or 410 means the series is gone; that counts as an answer and is kept 6 h.
- Each series is looked up once per lookahead run: a per-run map of promises.
- New export: `clearRecurrenceCacheForUser(userId)`. `clearRecurrenceCache()` still clears everything.
- The store lives in a new leaf module, `src/services/recurrence-cache.ts`, which imports nothing. Plan B's `stampGoogleCache` (`src/services/calendar-read/google.ts`, imported by `google-provider.ts`) must call `clearRecurrenceCacheForUser` after every Google write. Importing it from `week-lookahead.ts` would close the cycle google-provider → calendar-read/google → week-lookahead → calendar-provider → google-provider. `week-lookahead.ts` imports the store's helpers and re-exports both clear functions, so imports from it keep working. The per-run map stays in `week-lookahead.ts`.

The fix is live for everyone on deploy. Nothing else in the lookahead changes.

**Files:**
- Create: `src/services/recurrence-cache.ts` (the store: TTLs, key, read/write, the two clear functions)
- Modify: `src/services/week-lookahead.ts:9` (import the store), `:58-59` (the cache becomes the per-run map's type), `:117-132` (the head of `getMasterEventRecurrence`, which splits into three functions), `:144-153` (native returns), `:163-170` (Google return and catch), `:265` (the per-run map), `:298-302` (the one call site), `:496-501` (`clearRecurrenceCache` becomes a re-export of both clear functions)
- Test: `scripts/smoke-week-lookahead.ts` (extend). Changed lines: `:10` header, `:16` imports, `:83-84` fixtures, `:109` timezones, `:113-114` new recorders, `:125` `events.get` stub, `:161` users, `:212` import, and a new `(g)` section inserted before `let failed = 0;` (`:435`)
- Regression: `scripts/smoke-partner-labels.ts` (imports `getWeekLookahead`; unchanged, stays 19/19)

**Interfaces:**
- Consumes:
  - `UserConfig.id: number` (`src/types.ts:22`, Prisma `User.id Int`). This is the DB id, not `telegramId`.
  - `getCalendarClient(token).events.get({ calendarId, eventId })` (`src/services/calendar.ts`). On an HTTP error it throws a gaxios 6.7.1 `GaxiosError` (`node_modules/@googleapis/calendar/node_modules/gaxios`) with `status: number` and `response.status: number`. A network error has neither field, only `code: string` (`'ECONNRESET'`).
  - `getNativeSeriesRrule(seriesCuid: string): Promise<string | null>` (`src/services/native-calendar/event-store.ts:734`). It returns `null` for an unknown series and throws only when the DB fails.
- Produces, in `src/services/recurrence-cache.ts` (a leaf: no imports at all, so no googleapis, Prisma, Redis or provider module loads with it; the smoke's last `(g)` check pins that):
  - `export const RECURRENCE_ANSWER_TTL_MS = 6 * 60 * 60 * 1000` (21 600 000, 6 h): the master's rules, or none.
  - `export const RECURRENCE_GONE_TTL_MS = RECURRENCE_ANSWER_TTL_MS` (6 h): a Google 404 or 410.
  - `export const RECURRENCE_FAILURE_TTL_MS = 10 * 60 * 1000` (600 000, 10 min): any other failure.
  - `export type RecurrenceEntry = { value: string[] | null; at: number; ttlMs: number }`. This adds `ttlMs` to the spec's `{ value, at }`, because a failure and a gone series both store `null` and only the lifetime tells them apart. `at` is `Date.now()` taken *before* the lookup: an answer is as old as its question.
  - `globalThis.__recurrenceCache: Map<string, RecurrenceEntry>`, created on first load (`??=`), so every bundle's instance of the module shares it.
  - `export function recurrenceCacheKey(userId: number, calendarId: string, recurringEventId: string): string` → `${userId}:${calendarId}:${recurringEventId}`.
  - `export function readRecurrenceCache(key: string, now: number): RecurrenceEntry | undefined`. The entry while `now - entry.at < entry.ttlMs`, else `undefined`. It never deletes; the next write replaces a stale entry.
  - `export function writeRecurrenceCache(key: string, entry: RecurrenceEntry): void`. Replaces what was there.
  - `export function clearRecurrenceCacheForUser(userId: number): void`. It deletes every key that starts with `${userId}:`. For example, user `6` does not touch user `66`. Plan B's `stampGoogleCache` will call it after every Google write, imported from `../recurrence-cache`. In this plan only the smoke calls it.
  - `export function clearRecurrenceCache(): void`. It clears every user, as today's does.
- Produces, in `src/services/week-lookahead.ts`:
  - `export { clearRecurrenceCache, clearRecurrenceCacheForUser } from './recurrence-cache'`. `clearRecurrenceCache` keeps its signature and behaviour. On `main @ 858886c` nothing calls it except its own definition (`git grep -n clearRecurrenceCache` → only `week-lookahead.ts:499`). From this task on, `smoke-week-lookahead.ts` calls both through this re-export.
  - Internal: `getMasterEventRecurrence(user: UserConfig, calendarId: string, recurringEventId: string, lookups: SeriesLookups): Promise<string[] | null>`, where `type SeriesLookups = Map<string, Promise<string[] | null>>`. Its only caller is `filterAndBuildLookaheadEvents` (`:298`), which creates one `SeriesLookups` per run.

---

- [ ] **Step 1: Extend the smoke with the cache checks**

Every edit is in `scripts/smoke-week-lookahead.ts`.

1a. Header. Find (line 10):

```ts
// Google, the native calendar, the timezone lookup and the AI are stubbed. No network.
```

Replace with:

```ts
// The series lookup behind the daily/weekly filter kept a failed lookup forever, under a
// key every user shared: one Google hiccup hid a monthly series from /week until the
// next deploy, for everyone with that calendar.
//
// Google, the native calendar, the timezone lookup and the AI are stubbed. No network.
```

1b. Imports, for the leaf check in 1i. Find (line 16):

```ts
import path from 'path';
```

Replace with:

```ts
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
```

1c. Fixtures. Find (lines 83-84):

```ts
const GOOGLE_EVENTS: Record<string, Fixture[]> = { 'token-il': ISRAEL_EVENTS, 'token-ny': NEW_YORK_EVENTS, 'token-running': RUNNING_EVENTS };
const RRULES: Record<string, string> = { gym: 'RRULE:FREQ=DAILY', anniv: 'FREQ=YEARLY', standup: 'FREQ=DAILY', vitamins: 'FREQ=DAILY' };
```

Replace with:

```ts
// Two series for the lookup-cache checks, in Israel: a monthly book club, listed once its
// rule is known, and a daily carpool on three days, never listed.
const SERIES_EVENTS: Fixture[] = [
  { summary: 'Carpool', start: '2026-10-13T16:00:00+03:00', end: '2026-10-13T16:30:00+03:00', recurringEventId: 'carpool' },
  { summary: 'Carpool', start: '2026-10-14T16:00:00+03:00', end: '2026-10-14T16:30:00+03:00', recurringEventId: 'carpool' },
  { summary: 'Carpool', start: '2026-10-15T16:00:00+03:00', end: '2026-10-15T16:30:00+03:00', recurringEventId: 'carpool' },
  { summary: 'Book club', start: '2026-10-15T19:00:00+03:00', end: '2026-10-15T21:00:00+03:00', recurringEventId: 'bookclub' },
];

const GOOGLE_EVENTS: Record<string, Fixture[]> = {
  'token-il': ISRAEL_EVENTS, 'token-ny': NEW_YORK_EVENTS, 'token-running': RUNNING_EVENTS,
  'token-series-6': SERIES_EVENTS, 'token-series-66': SERIES_EVENTS,
};
const RRULES: Record<string, string> = {
  gym: 'RRULE:FREQ=DAILY', anniv: 'FREQ=YEARLY', standup: 'FREQ=DAILY', vitamins: 'FREQ=DAILY',
  bookclub: 'RRULE:FREQ=MONTHLY', carpool: 'RRULE:FREQ=DAILY',
};
```

1d. Timezones. Find (line 109):

```ts
const TIMEZONES: Record<number, string> = { 1: IL, 2: NY, 3: NY, 4: NY, 5: IL };
```

Replace with:

```ts
const TIMEZONES: Record<number, string> = { 1: IL, 2: NY, 3: NY, 4: NY, 5: IL, 6: IL, 66: IL };
```

1e. Recorders and the cache's clock. Find (lines 113-114):

```ts
/** Every prompt sent to the AI. */
const prompts: string[] = [];
```

Replace with:

```ts
/** Every prompt sent to the AI. */
const prompts: string[] = [];
/** Every events.get request (a series' master event), as token:eventId. */
const masterCalls: string[] = [];
/** What events.get throws for a token, while set. */
const masterErrors: Record<string, Error> = {};
/** How far the cache's clock moves while events.get answers. */
let masterTookMs = 0;
/** The cache's clock: Date.now returns it during the (g) checks. */
let clock = 0;

/** A Google API error as gaxios throws it: the HTTP status on the error and on its response. */
const googleError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status, response: { status } });
```

1f. The `events.get` stub. Find (line 125, inside `fakeGoogleClient`):

```ts
      get: async ({ eventId }: { eventId: string }) => ({ data: { recurrence: [RRULES[eventId]] } }),
```

Replace with:

```ts
      get: async ({ eventId }: { eventId: string }) => {
        masterCalls.push(`${token}:${eventId}`);
        clock += masterTookMs;
        if (masterErrors[token]) throw masterErrors[token];
        return { data: { recurrence: [RRULES[eventId]] } };
      },
```

1g. Users. Find (line 161):

```ts
const nativeIsraeli = user(5, { culture: 'default', googleRefreshToken: '', calendarSource: 'NATIVE' });
```

Replace with:

```ts
const nativeIsraeli = user(5, { culture: 'default', googleRefreshToken: '', calendarSource: 'NATIVE' });
// Two Israeli Google users with the same calendar and series ids; 66 starts with 6.
const seriesUser = user(6, { culture: 'default', googleRefreshToken: 'token-series-6' });
const otherSeriesUser = user(66, { culture: 'default', googleRefreshToken: 'token-series-66' });
```

1h. Import. The clear functions come through `week-lookahead`'s re-export, so the check also covers it. Find (line 212):

```ts
  const { getWeekLookahead, getNextWeekLookahead, formatTomorrowLookahead } = await import('../src/services/week-lookahead');
```

Replace with:

```ts
  const { getWeekLookahead, getNextWeekLookahead, formatTomorrowLookahead, clearRecurrenceCache, clearRecurrenceCacheForUser } =
    await import('../src/services/week-lookahead');
```

1i. The `(g)` checks. Find (lines 435-436, right after the last `(f)` check):

```ts
  let failed = 0;
  for (const r of results) {
```

Replace with:

```ts
  // (g) the series lookup cache
  const seriesTuesday = new Date('2026-10-13T09:00:00+03:00');
  const T0 = seriesTuesday.getTime();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const BOTH = (token: string) => `asked ${token}:carpool, ${token}:bookclub`;
  /** One /week run at `at` on the cache's clock: what it lists | the lookups it made. */
  const seriesWeek = async (u: UserConfig, at: number) => {
    clock = at;
    masterCalls.length = 0;
    const lookahead = await getWeekLookahead(u, calendars, seriesTuesday);
    return `${lookahead.events.map(e => e.summary).join(', ') || 'nothing'} | asked ${masterCalls.join(', ') || 'nothing'}`;
  };
  const freshCache = () => {
    clearRecurrenceCache();
    for (const token of Object.keys(masterErrors)) delete masterErrors[token];
    masterTookMs = 0;
  };

  // The cache reads Date.now; nothing else in a lookahead given a reference date does.
  // The failed lookups' warnings are expected.
  const realNow = Date.now;
  const realWarn = console.warn;
  Date.now = () => clock;
  console.warn = () => undefined;
  try {
    await check('(g) a failed lookup is kept 10 minutes, then asked again', async () => {
      freshCache();
      masterErrors['token-series-6'] = googleError(503);
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

    await check('(g) an answer is kept 6 hours, then asked again', async () => {
      freshCache();
      const got = [`0:00:00: ${await seriesWeek(seriesUser, T0)}`];
      // Asked again now, the lookup would fail: what shows is the kept answer.
      masterErrors['token-series-6'] = googleError(503);
      got.push(`5:59:59: ${await seriesWeek(seriesUser, T0 + 6 * HOUR - 1000)}`);
      got.push(`6:00:00: ${await seriesWeek(seriesUser, T0 + 6 * HOUR)}`);
      assertList(got, [
        `0:00:00: Book club | ${BOTH('token-series-6')}`,
        '5:59:59: Book club | asked nothing',
        `6:00:00: nothing | ${BOTH('token-series-6')}`,
      ]);
    });

    await check('(g) a series that is gone (404, 410) is kept 6 hours, not asked again after 10 minutes', async () => {
      const got: string[] = [];
      for (const status of [404, 410]) {
        freshCache();
        masterErrors['token-series-6'] = googleError(status);
        got.push(`${status} 0:00:00: ${await seriesWeek(seriesUser, T0)}`);
        delete masterErrors['token-series-6'];
        got.push(`${status} 0:10:00: ${await seriesWeek(seriesUser, T0 + 10 * MIN)}`);
        got.push(`${status} 5:59:59: ${await seriesWeek(seriesUser, T0 + 6 * HOUR - 1000)}`);
        got.push(`${status} 6:00:00: ${await seriesWeek(seriesUser, T0 + 6 * HOUR)}`);
      }
      assertList(got, [404, 410].flatMap(status => [
        `${status} 0:00:00: nothing | ${BOTH('token-series-6')}`,
        `${status} 0:10:00: nothing | asked nothing`,
        `${status} 5:59:59: nothing | asked nothing`,
        `${status} 6:00:00: Book club | ${BOTH('token-series-6')}`,
      ]));
    });

    await check('(g) two users with the same calendar and series ids each get their own answer', async () => {
      freshCache();
      masterErrors['token-series-6'] = googleError(503);
      assertList([await seriesWeek(seriesUser, T0), await seriesWeek(otherSeriesUser, T0)], [
        `nothing | ${BOTH('token-series-6')}`,
        `Book club | ${BOTH('token-series-66')}`,
      ]);
    });

    await check('(g) each series is looked up once per run, even when its answer runs out mid-run', async () => {
      freshCache();
      masterErrors['token-series-6'] = googleError(503);
      // Each lookup takes 11 minutes on the cache's clock, so a failure is stale before the
      // next Carpool. The run still asks about each series once.
      masterTookMs = 11 * MIN;
      assertList([await seriesWeek(seriesUser, T0)], [`nothing | ${BOTH('token-series-6')}`]);
    });

    await check('(g) clearRecurrenceCacheForUser drops that user\'s answers only', async () => {
      freshCache();
      await seriesWeek(seriesUser, T0);
      await seriesWeek(otherSeriesUser, T0);
      clearRecurrenceCacheForUser(6);
      assertList([await seriesWeek(seriesUser, T0 + MIN), await seriesWeek(otherSeriesUser, T0 + MIN)], [
        `Book club | ${BOTH('token-series-6')}`,
        'Book club | asked nothing',
      ]);
    });
  } finally {
    Date.now = realNow;
    console.warn = realWarn;
    freshCache();
  }

  await check('(g) recurrence-cache.ts loads on its own: no Google client, Prisma or calendar provider', () => {
    // Calendar write paths clear the cache through this module, so it must stay a leaf.
    // Asked in a fresh process with this one's tsx loader: this process has week-lookahead
    // and the stubs loaded already.
    const root = path.resolve(__dirname, '..');
    const leaf = path.join(root, 'src/services/recurrence-cache.ts');
    assert(existsSync(leaf), 'src/services/recurrence-cache.ts does not exist');
    const probe = `require(${JSON.stringify(leaf)}); console.log(JSON.stringify(Object.keys(require.cache)));`;
    const loaded = JSON.parse(execFileSync(process.execPath, [...process.execArgv, '-e', probe], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })) as string[];
    const appModules = loaded
      .filter(file => file.startsWith(root + path.sep) && !file.includes(`${path.sep}node_modules${path.sep}`))
      .map(file => path.relative(root, file));
    assertList(appModules, ['src/services/recurrence-cache.ts']);
    const packages = loaded.filter(file => /[\\/]node_modules[\\/](@googleapis|googleapis|@prisma|\.prisma|@upstash)[\\/]/.test(file));
    assert(packages.length === 0, `it loaded ${packages.join(', ')}`);
  });

  let failed = 0;
  for (const r of results) {
```

Do not run `tsc` yet: `clearRecurrenceCacheForUser` isn't exported until Step 3. `tsx` doesn't type-check, so the smoke still runs.

- [ ] **Step 2: Run the smoke on today's code and see it fail**

```bash
set -o pipefail; for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-week-lookahead.ts 2>&1 | grep -v '^OK'; echo "exit $?"; done
```

Expected, under each clock, `23/29 passed (process TZ=UTC)` / `(process TZ=Asia/Jerusalem)`, then `exit 1` (with `pipefail` the pipeline's status is the smoke's, not `grep`'s). The two `[Upstash Redis] ... missing` lines were already there before this task. The six FAIL lines are:

- `(g) a failed lookup is kept 10 minutes, then asked again`: got `"0:10:00: nothing | asked nothing"`. Today the failure's `null` is kept forever, so the book club never comes back.
- `(g) an answer is kept 6 hours, then asked again`: got `"6:00:00: Book club | asked nothing"`. Today an answer never expires.
- `(g) a series that is gone (404, 410) ...`: got `"404 6:00:00: nothing | asked nothing"` and `"410 6:00:00: nothing | asked nothing"`. Today a gone series is never asked about again.
- `(g) two users with the same calendar and series ids ...`: got `"nothing | asked nothing"` for user 66. Today the key has no user, so 66 gets user 6's failure without asking.
- `(g) clearRecurrenceCacheForUser drops that user's answers only`: `clearRecurrenceCacheForUser is not a function`.
- `(g) recurrence-cache.ts loads on its own ...`: `src/services/recurrence-cache.ts does not exist`.

`(g) each series is looked up once per run ...` passes today, because today's cache never expires. It guards the per-run map. Without that map the run would ask `carpool` three times: the stub's 11-minute lookups make each failure stale before the next Carpool. This was checked by disabling the map in the Step 3 code: that check then fails with `asked token-series-6:carpool, token-series-6:carpool, token-series-6:carpool, token-series-6:bookclub`.

The leaf check was checked the other way too, by adding one import to the Step 3 store:
- `import './calendar';`: it fails with `got ["src/services/recurrence-cache.ts", "src/services/calendar.ts", ...]` (six more app modules follow).
- `import { prisma } from '../utils/prisma';`, used: `got ["src/services/recurrence-cache.ts", "src/utils/prisma.ts"]`.
- `import { calendar } from '@googleapis/calendar';`, used: `it loaded .../node_modules/@googleapis/calendar/build/index.js, ...`.

An import used only as a type, or not used at all, is erased when the TypeScript is stripped (seen here under tsx: an unused `import { getCalendarClient } from './calendar';` passes) and loads nothing, so the check lets it through. An erased import can't close a cycle at run time.

The 22 existing checks still pass.

- [ ] **Step 3: Implement the cache: the store in a new leaf module, the lookups in `week-lookahead.ts`**

3a. Create `src/services/recurrence-cache.ts` with exactly this content:

```ts
// The recurrence rules of series masters, kept so a series costs one lookup (spec §8.3).
// src/services/week-lookahead.ts reads and fills it to tell daily series from weekly and
// monthly ones; a write to a user's calendar clears that user's entries.
//
// A leaf: it imports nothing, so the calendar write paths can clear a user's entries
// without importing week-lookahead, which imports the calendar providers (that import
// would close a cycle through the Google provider).
//
// Keyed `${userId}:${calendarId}:${recurringEventId}`: two users can share a calendar and
// its series ids, and one user's failure must not become the other's answer. It lives on
// globalThis: Next 16 compiles the scheduler (instrumentation.ts, the tomorrow summary's
// lookahead) and the route handlers (/week, /nextweek) into separate module instances,
// and clearing a user's entries must reach both. Railway runs one instance; a second
// replica would keep its own.
//
// An answer is kept 6 hours. A failed lookup is kept 10 minutes: kept for good, one
// Google hiccup hid a monthly series from /week until the next deploy. A series that is
// gone (404, 410) is an answer.

/** How long an answer is kept: the master's rules, or none. */
export const RECURRENCE_ANSWER_TTL_MS = 6 * 60 * 60 * 1000;
/** How long a series that is gone (a Google 404 or 410) is kept: it is an answer too. */
export const RECURRENCE_GONE_TTL_MS = RECURRENCE_ANSWER_TTL_MS;
/** How long a failed lookup is kept, so a hiccup is asked about again soon. */
export const RECURRENCE_FAILURE_TTL_MS = 10 * 60 * 1000;

/**
 * A kept lookup: the rules (null for none, or none known), when it was asked (epoch ms)
 * and how long it holds. A failure and a gone series both keep null, so the entry carries
 * its own lifetime.
 */
export type RecurrenceEntry = { value: string[] | null; at: number; ttlMs: number };

const g = globalThis as { __recurrenceCache?: Map<string, RecurrenceEntry> };
const cache = (g.__recurrenceCache ??= new Map<string, RecurrenceEntry>());

/** The cache key of one user's series. */
export function recurrenceCacheKey(userId: number, calendarId: string, recurringEventId: string): string {
  return `${userId}:${calendarId}:${recurringEventId}`;
}

/** The entry under `key` while it holds at `now` (epoch ms); undefined if none, or it ran out. */
export function readRecurrenceCache(key: string, now: number): RecurrenceEntry | undefined {
  const entry = cache.get(key);
  return entry && now - entry.at < entry.ttlMs ? entry : undefined;
}

/** Keeps `entry` under `key`, replacing what was there. */
export function writeRecurrenceCache(key: string, entry: RecurrenceEntry): void {
  cache.set(key, entry);
}

/**
 * Forget one user's kept recurrence rules, for after a write to their calendar: their
 * next lookahead asks again. A run already under way keeps the answers it has.
 */
export function clearRecurrenceCacheForUser(userId: number): void {
  const prefix = `${userId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/**
 * Clear recurrence cache, every user's (useful for testing or memory management)
 */
export function clearRecurrenceCache(): void {
  cache.clear();
}
```

3b. Every edit from here on is in `src/services/week-lookahead.ts`. The import. Find (line 9):

```ts
import { getNativeSeriesRrule } from './native-calendar/event-store';
```

Replace with:

```ts
import { getNativeSeriesRrule } from './native-calendar/event-store';
import {
  RECURRENCE_ANSWER_TTL_MS,
  RECURRENCE_FAILURE_TTL_MS,
  RECURRENCE_GONE_TTL_MS,
  readRecurrenceCache,
  recurrenceCacheKey,
  writeRecurrenceCache,
} from './recurrence-cache';
```

3c. The cache becomes the per-run map's type. Find (lines 58-59):

```ts
// Cache for master event recurrence rules to avoid repeated API calls
const recurrenceCache = new Map<string, string[] | null>();
```

Replace with:

```ts
/**
 * One lookahead run's series lookups, by cache key: each series is asked about once per
 * run. ./recurrence-cache keeps the answers across runs.
 */
type SeriesLookups = Map<string, Promise<string[] | null>>;
```

3d. Split `getMasterEventRecurrence`. Find (lines 117-132; the native comment block that follows stays):

```ts
/**
 * Fetch recurrence rules from master event
 * Uses caching to avoid repeated API calls for the same recurring event
 */
async function getMasterEventRecurrence(
  user: UserConfig,
  calendarId: string,
  recurringEventId: string
): Promise<string[] | null> {
  const cacheKey = `${calendarId}:${recurringEventId}`;

  if (recurrenceCache.has(cacheKey)) {
    return recurrenceCache.get(cacheKey) || null;
  }

  // NATIVE: the series rule lives in our own table. Falling through to the
```

Replace with:

```ts
/** The HTTP status of a Google API error, if it has one (gaxios sets status and response.status). */
function googleErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const status of [e.status, e.response?.status, e.code]) {
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/**
 * Fetch recurrence rules from master event
 * Kept per user (./recurrence-cache), and asked once per lookahead run (`lookups`)
 */
async function getMasterEventRecurrence(
  user: UserConfig,
  calendarId: string,
  recurringEventId: string,
  lookups: SeriesLookups
): Promise<string[] | null> {
  const cacheKey = recurrenceCacheKey(user.id, calendarId, recurringEventId);
  let lookup = lookups.get(cacheKey);
  if (!lookup) {
    lookup = lookUpRecurrence(user, calendarId, recurringEventId, cacheKey);
    lookups.set(cacheKey, lookup);
  }
  return lookup;
}

/** The kept answer while it holds; otherwise ask, and keep the answer. */
async function lookUpRecurrence(
  user: UserConfig,
  calendarId: string,
  recurringEventId: string,
  cacheKey: string
): Promise<string[] | null> {
  // An answer is as old as its question.
  const at = Date.now();
  const cached = readRecurrenceCache(cacheKey, at);
  if (cached) return cached.value;

  const { value, ttlMs } = await fetchMasterEventRecurrence(user, calendarId, recurringEventId);
  writeRecurrenceCache(cacheKey, { value, at, ttlMs });
  return value;
}

/** A series' rules from its master event, and how long that answer holds. Never rejects. */
async function fetchMasterEventRecurrence(
  user: UserConfig,
  calendarId: string,
  recurringEventId: string
): Promise<{ value: string[] | null; ttlMs: number }> {
  // NATIVE: the series rule lives in our own table. Falling through to the
```

3e. Native returns. Find (lines 144-153):

```ts
      const recurrence = rrule
        ? [rrule.startsWith('RRULE:') ? rrule : `RRULE:${rrule}`]
        : null;
      recurrenceCache.set(cacheKey, recurrence);
      return recurrence;
    } catch (error) {
      console.warn(`Failed to read native series ${recurringEventId}:`, error);
      recurrenceCache.set(cacheKey, null);
      return null;
    }
```

Replace with:

```ts
      const recurrence = rrule
        ? [rrule.startsWith('RRULE:') ? rrule : `RRULE:${rrule}`]
        : null;
      return { value: recurrence, ttlMs: RECURRENCE_ANSWER_TTL_MS };
    } catch (error) {
      console.warn(`Failed to read native series ${recurringEventId}:`, error);
      return { value: null, ttlMs: RECURRENCE_FAILURE_TTL_MS };
    }
```

3f. Google return and catch. Find (lines 163-170):

```ts
    const recurrence = master.data.recurrence || null;
    recurrenceCache.set(cacheKey, recurrence);
    return recurrence;
  } catch (error) {
    console.warn(`Failed to fetch master event ${recurringEventId}:`, error);
    recurrenceCache.set(cacheKey, null);
    return null;
  }
```

Replace with:

```ts
    return { value: master.data.recurrence || null, ttlMs: RECURRENCE_ANSWER_TTL_MS };
  } catch (error) {
    console.warn(`Failed to fetch master event ${recurringEventId}:`, error);
    // A 404 or 410 is an answer: the series is gone. Anything else may pass in a moment.
    const status = googleErrorStatus(error);
    return { value: null, ttlMs: status === 404 || status === 410 ? RECURRENCE_GONE_TTL_MS : RECURRENCE_FAILURE_TTL_MS };
  }
```

3g. One map per run. Find (lines 265-267, in `filterAndBuildLookaheadEvents`):

```ts
  const lookaheadEvents: LookaheadEvent[] = [];

  for (const event of events) {
```

Replace with:

```ts
  const lookaheadEvents: LookaheadEvent[] = [];
  // Each series is asked about once per run, even if its kept answer runs out mid-run.
  const seriesLookups: SeriesLookups = new Map();

  for (const event of events) {
```

3h. The call site. Find (lines 298-302):

```ts
      const rrule = await getMasterEventRecurrence(
        user,
        event.calendarId,
        event.recurringEventId
      );
```

Replace with:

```ts
      const rrule = await getMasterEventRecurrence(
        user,
        event.calendarId,
        event.recurringEventId,
        seriesLookups
      );
```

3i. The clear functions, now a re-export. Find (lines 496-501, end of file):

```ts
/**
 * Clear recurrence cache (useful for testing or memory management)
 */
export function clearRecurrenceCache(): void {
  recurrenceCache.clear();
}
```

Replace with:

```ts
// The clear functions live in ./recurrence-cache, which imports nothing, so a calendar
// write path can call them without importing this module and the calendar providers
// behind it. Re-exported for the callers that import them from here.
export { clearRecurrenceCache, clearRecurrenceCacheForUser } from './recurrence-cache';
```

After 3a–3i, the old module-level map is gone from `week-lookahead.ts`: `grep -cw recurrenceCache src/services/week-lookahead.ts` → `0` (`-w`, so `recurrenceCacheKey` doesn't count).

- [ ] **Step 4: Run the smokes and see them pass**

```bash
set -o pipefail; for tz in UTC Asia/Jerusalem; do for s in smoke-week-lookahead smoke-partner-labels; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$s.ts 2>&1 | grep -v '^OK'; echo "exit $?"; done; done
```

Expected: no `FAIL` lines. Under each clock:
- `smoke-week-lookahead`: `29/29 passed` (the 22 existing checks plus 7 new)
- `smoke-partner-labels`: `19/19 passed` (its week has no recurring events, so it makes no lookups)

Each run is followed by `exit 0` (four in all).

- [ ] **Step 5: Type-check and lint**

```bash
npx tsc --noEmit -p . && npm run -s lint
```

Expected: both exit 0 with no output. `tsc` also type-checks `scripts/**`, which now resolves `clearRecurrenceCacheForUser` through the re-export.

- [ ] **Step 6: Commit**

```bash
git add src/services/recurrence-cache.ts src/services/week-lookahead.ts scripts/smoke-week-lookahead.ts
git commit -m "$(cat <<'EOF'
fix(week): a failed series lookup no longer hides a monthly event until the next deploy

The weekly lookahead asks for each series' master event to tell daily
from monthly. Its cache kept a failure's null forever, under a key every
user shared, so one Google hiccup filtered a monthly series out of /week
for everyone with that calendar.

Keyed per user on globalThis (the scheduler and the routes are separate
bundles). An answer is kept 6 h, a failure 10 min, and a gone series
(404/410) 6 h. Each series is looked up once per run.
clearRecurrenceCacheForUser drops one user's entries, for after a write.

The store is a new leaf module, src/services/recurrence-cache.ts, that
imports nothing, so calendar write paths can clear it without importing
week-lookahead (an import cycle through the Google provider).
week-lookahead re-exports both clear functions.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

**Notes for later tasks:**
- Plan B's `stampGoogleCache` (`src/services/calendar-read/google.ts`, imported by `src/services/calendar-provider/google-provider.ts`) imports `clearRecurrenceCacheForUser` from `../recurrence-cache`, never from `../week-lookahead`. That second import would close the cycle google-provider → calendar-read/google → week-lookahead → calendar-provider → google-provider.
- Keep `src/services/recurrence-cache.ts` free of imports. The smoke's last `(g)` check fails as soon as it loads another app module or a googleapis, Prisma or Upstash package.
- A lookup already in flight when `clearRecurrenceCacheForUser` runs still stores its answer when it lands. A series' frequency rarely changes, so the worst case is a stale weekly/monthly call for up to 6 h. Nothing in this task closes that window.

---

### Task 4: The timezone follows a location change (spec §8.1, Ruling R20)

**Why:** A settings save that changes the location writes the new location to the DB, but the zone stays cached under `tz:user:{id}` (`REDIS_KEYS.userTimezone`, `src/config/redis-keys.ts:46`). `resolveUserTimezone` (`src/lib/timezone.ts:20-81`) reads that cache first and caches for 24 h. So the summaries, reminders and voice keep the old city's clock for up to 24 h. After this task, a save that changes the location looks the new zone up after the response, and caches it when the lookup finds one and the stored location is still the one it looked up.

**Findings (read before you start):**
- **Ruling R20 replaces the spec's "geocodeLocation with the existing retry".** `geocodeLocation` (`src/services/weather/geocoding.ts:45-95`) reads and fills the in-process `geocodeCache` (`:34`, `:47-51`, `:86`). Its `getTimezoneFromCoords` (`:100-116`) answers `'Asia/Jerusalem'` whenever Open-Meteo fails or sends no zone. The new `resolveTimezoneForLocation` uses neither. It makes the same two requests itself: the same URLs, and the same `User-Agent` that Nominatim requires.
- `fetchWithTimeout(url, options = {}, timeoutMs = 5000, maxRetries = 3)` (`geocoding.ts:14`) makes `maxRetries + 1` attempts. Calling it as `(url, opts, 3000, 0)` gives one attempt with a 3 s `AbortSignal.timeout`. A non-2xx status doesn't throw; the caller checks `.ok`.
- **How the route stores the location:** `location: location || undefined` (`app/api/settings/route.ts:49`), without trimming. An empty string doesn't write the column, so the old location stays. A whitespace-only string is stored as it is. This task changes neither. The Mini App (`app/[locale]/settings/SettingsClient.tsx:271-299`) sends a trimmed, validated value, or the raw state when it is blank. The route compares `location.trim()` with `auth.user.location.trim()`. `auth.user` is the row `verifyUserAuth` read before the update. A change counts only when the trimmed new value is non-empty and differs from the stored one.
- **No zone found** (a request failed, Nominatim found nothing, or Open-Meteo sent no zone or one `Intl` rejects): the old key stays as it is. When it expires (within 24 h), `resolveUserTimezone` resolves from the new stored location through `geocodeLocation`, with its retries.
- **Location cleared** (`''` or spaces): no lookup, and the key stays as it is. `resolveUserTimezone` keeps answering the cached zone until it expires. Then:
  - after `''`: the stored location is still the old one (not saved), so it re-resolves from that;
  - after spaces: geocoding the blank fails, then it tries the Google calendar setting, then caches the `Asia/Jerusalem` default for 24 h (today's behaviour, unchanged).
- **`after()`:**
  - next@16.1.1 exports it (`node_modules/next/server.d.ts:21`, `server.js:14`) with the signature `after<T>(task: Promise<T> | (() => T | Promise<T>)): void`.
  - It already runs in a route handler here (`app/api/execute-command/route.ts:2`, `:98`). On the self-hosted `next start` server, callbacks run once the response has closed.
  - Outside a request scope it throws "`after` was called outside a request scope" (`node_modules/next/dist/server/after/after.js`).
- **Testing `after()`:** the smoke replaces `after` on `nodeRequire('next/server')` with a queue and runs the queue itself. That's the existing pattern in `scripts/smoke-auth-identity.ts:333-337`. A scheduler isn't injected, because a `route.ts` may export only handlers and route config (Next type-checks route exports). The compiled route reads `after` from the module object when it calls it, so the patch lands even though the route imports it statically.
- **Two quick saves race.** Each save that changes the location schedules its own lookup, and nothing orders them. After "Tel Aviv" then "London", the Tel Aviv lookup can land last and cache `Asia/Jerusalem` for 24 h over London's zone. So once its lookup has found a zone, `refreshTimezone` reads the stored location back (`prisma.user.findUnique({ where: { id }, select: { location: true } })`; Prisma `User.location String @default("")`, `prisma/schema.prisma:28`). It writes only if that location, trimmed, still equals the one it looked up. The route compares trimmed values and passes the trimmed `newLocation`, so both sides match the same way. A row that is gone reads as `''` and is skipped too. A lookup that found nothing returns before the read, so a failure costs no DB query.
  - What's left is the gap between that read and the `redis.set`, one Redis round trip. For the older lookup to win, the newer save's DB write, its two HTTP requests, its read and its `redis.set` would all have to fit inside that gap.
- **Non-Latin locations** (the Mini App runs in he/en/ru): the Nominatim URL carries the location through `encodeURIComponent`, so "תל אביב" goes out as `q=%D7%AA%D7%9C%20%D7%90%D7%91%D7%99%D7%91`, all ASCII. The guard compares the stored string with the looked-up one, so non-Latin text needs no other handling.
- `resolveTimezoneForLocation` never throws (any error → `null`). So the route's `.catch` only ever sees a failed location read or `redis.set`, which becomes `captureError(err, 'settings-timezone', {...}, 'warning')`. The response is already 200 by then.
- **Two other smokes call the real route; both still pass with no edits:**
  - `scripts/smoke-reminders.ts` stubs `next/server` without `after` (`:194-197`). None of its saves send a `location` (`:554`, `:564`, `:578`), so `after` is never reached. It already stubs `src/utils/prisma.ts` (`:201`), so the route's new `prisma` import loads its fake.
  - `smoke-auth-identity.ts` patches `after()` and stubs `src/utils/prisma.ts` (`:295`). Most saves queue a refresh that `seed()` drops. Task 1's #24 drains one: it calls the real geocoding `fetchWithTimeout`, which hits the smoke's blocked fetch, so `resolveTimezoneForLocation` returns null, the location isn't read back, and nothing is written. No edit needed.
- **Live for everyone on deploy.** Each save that changes the location makes two outbound requests after the response, then one primary-key read when the lookup found a zone. Saves are rare and go through `settingsRateLimiter`.
- The working tree may show other plan or spec files as modified. Stage only the three paths in Step 8.

**Files:**
- Modify: `src/lib/timezone.ts:10` (import), insert after `:13` (helper and new function)
- Modify: `app/api/settings/route.ts:1-7` (imports and a module-level helper that re-reads the location before it writes), insert before `:46` (change detection), insert after `:66` (schedule the refresh)
- Create (test): `scripts/smoke-location-timezone.ts`
- Test: `scripts/smoke-location-timezone.ts`; regression: `scripts/smoke-reminders.ts`, `scripts/smoke-auth-identity.ts`

**Interfaces:**
- Consumes:
  - `fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 5000, maxRetries = 3): Promise<Response>` (`src/services/weather/geocoding.ts:14`)
  - `after<T>(task: AfterTask<T>): void` from `'next/server'`
  - `redis.set(key, value, { ex: number })` (`src/utils/redis.ts`, Upstash)
  - `REDIS_KEYS.userTimezone(userId: number): string` → `tz:user:${userId}`
  - `captureError(error: unknown, context: string, extra?: ErrorContext, severity: 'fatal' | 'error' | 'warning' | 'info' = 'error'): void` (`src/lib/error-capture.ts:21`)
  - `AuthResult.user.location: string` (Prisma `User.location`, `String @default("")`)
  - `prisma.user.findUnique({ where: { id: number }, select: { location: true } }): Promise<{ location: string } | null>` (`prisma` from `src/utils/prisma.ts:11`)
- Produces:
  - `resolveTimezoneForLocation(location: string): Promise<string | null>` (exported from `src/lib/timezone.ts`). Never throws. Never touches `geocodeCache`, never calls `geocodeLocation` or `getTimezoneFromCoords`, never writes Redis.
  - `POST /api/settings`: response unchanged. Side effect: when the trimmed `location` is non-empty and differs from the stored one, `tz:user:{id}` is set to the new zone with `{ ex: 86400 }` after the response. That happens only when the lookup finds a zone and the stored location, read back after the lookup and trimmed, is still the one looked up.

- [ ] **Step 1: Write the failing smoke `scripts/smoke-location-timezone.ts`**

Create the file with exactly this content:

```ts
// Smoke test for the timezone after a location change (app/api/settings/route.ts and
// resolveTimezoneForLocation in src/lib/timezone.ts). A settings save wrote the new
// location but left the old zone cached under tz:user:{id} for up to 24 h, so the
// summaries, reminders and voice kept the old city's clock that long. A save that
// changes the location now looks the zone up after the response: one Nominatim request
// and one Open-Meteo request, 3 s each, no retries, no geocode cache and no
// Asia/Jerusalem fallback. Only a lookup that finds a valid zone replaces the cached one,
// and only while the stored location is still the one it looked up: two quick saves each
// schedule a lookup, and the older one can land last.
//
// The route, resolveTimezoneForLocation and REDIS_KEYS run for real. Faked: auth (a
// Telegram user), the user row (written through updateUserById, its location read back
// through prisma.user.findUnique), the reminder cache, Telegram, error capture, Redis (in
// memory), the geocoding module (its fetchWithTimeout records every request, can hold a
// Nominatim answer back, and answers from the scenario), the Google calendar service, and
// Next's after() (queued, then run by the test, since it needs a live request scope). No
// network, no DB.
//
// Run with the fake env from the plan:
//   TZ=UTC npx tsx scripts/smoke-location-timezone.ts

import path from 'path';
import { createRequire } from 'module';

type Row = Record<string, unknown>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

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

const show = (v: unknown) => JSON.stringify(v);

// ---- Fakes ----

const USER_ID = 7;
const TELEGRAM_ID = 7007;
const TZ_KEY = `tz:user:${USER_ID}`;
const OLD_ZONE = 'Europe/London';

/** The stored user row; the route reads it through verifyUserAuth and writes it through updateUserById. */
let userRow: Row = {};

/** Redis, in memory. Every set is recorded with its options. */
const redisStore = new Map<string, unknown>();
const redisSets: { key: string; value: unknown; opts: unknown }[] = [];
let redisSetError: Error | null = null;
const fakeRedis = {
  get: async (key: string) => (redisStore.has(key) ? redisStore.get(key) : null),
  set: async (key: string, value: unknown, opts?: unknown) => {
    redisSets.push({ key, value, opts });
    if (redisSetError) throw redisSetError;
    redisStore.set(key, value);
    return 'OK';
  },
  del: async (key: string) => (redisStore.delete(key) ? 1 : 0),
};

/** Every request the lookup made, with the timeout and retry count it passed. */
type LookupRequest = { url: string; options: unknown; timeoutMs: unknown; maxRetries: unknown };
const requests: LookupRequest[] = [];
/** How each host answers a request in the current scenario: a Response, or a thrown error. */
let answers: { nominatim: (url: URL) => Response; openMeteo: (url: URL) => Response } = {
  nominatim: () => { throw new Error('no scenario'); },
  openMeteo: () => { throw new Error('no scenario'); },
};
/** Nominatim queries whose answer waits for its release: a lookup still in flight. */
const held = new Map<string, Promise<void>>();
/** Holds Nominatim's answer to `query` back until the returned function is called. */
function hold(query: string): () => void {
  let release = () => {};
  held.set(query, new Promise<void>(resolve => { release = resolve; }));
  return () => release();
}
async function fakeFetchWithTimeout(url: string, options?: unknown, timeoutMs?: unknown, maxRetries?: unknown): Promise<Response> {
  requests.push({ url, options, timeoutMs, maxRetries });
  const parsed = new URL(url);
  if (parsed.host === 'nominatim.openstreetmap.org') {
    await held.get(parsed.searchParams.get('q') ?? '');
    return answers.nominatim(parsed);
  }
  if (parsed.host === 'api.open-meteo.com') return answers.openMeteo(parsed);
  throw new Error(`unexpected request: ${url}`);
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** The places the fake geocoder knows: Nominatim's coordinates, and Open-Meteo's zone for them. */
const PLACES: Record<string, { lat: string; lon: string; zone: string }> = {
  'New York': { lat: '40.7127281', lon: '-74.0060152', zone: 'America/New_York' },
  'London': { lat: '51.5074456', lon: '-0.1277653', zone: 'Europe/London' },
  'Tel Aviv': { lat: '32.0852997', lon: '34.7818064', zone: 'Asia/Jerusalem' },
  'תל אביב': { lat: '32.0852997', lon: '34.7818064', zone: 'Asia/Jerusalem' },
  'Москва': { lat: '55.7505412', lon: '37.6174782', zone: 'Europe/Moscow' },
};

/** Prisma, for the one read the route makes itself: the stored location, before the zone is written. */
const locationReads: unknown[] = [];
let userGone = false;
const fakePrisma = {
  user: {
    findUnique: async (args: { where: { id: number }; select: Record<string, boolean> }) => {
      locationReads.push(args);
      if (userGone || args.where.id !== USER_ID) return null;
      return Object.fromEntries(Object.keys(args.select).map(key => [key, userRow[key]]));
    },
  },
};

/** Calls into the geocoding module's cached path (geocodeLocation / getTimezone): there must be none. */
const cachedPathCalls: string[] = [];

/** captureError calls: context and severity. */
const captured: { context: string; severity: unknown; message: string }[] = [];

/** Next's after(): tasks queued by the route, run by drainAfter(). */
const afterQueue: (() => unknown)[] = [];
async function drainAfter() {
  while (afterQueue.length) await afterQueue.shift()!();
}

function installStubs() {
  const Module = nodeRequire('module');
  const stub = (rel: string, exports: Row) => {
    const filename = path.join(ROOT, rel);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  stub('src/utils/redis.ts', { redis: fakeRedis });
  stub('src/utils/prisma.ts', { prisma: fakePrisma });
  stub('src/lib/rate-limit.ts', { settingsRateLimiter: {} });
  stub('src/lib/api-auth.ts', {
    // A Telegram save: the proved row, as the route gets it (a copy, read before the update).
    verifyUserAuth: async () => ({ success: true, via: 'telegram', user: { ...userRow } }),
  });
  stub('src/services/user-service.ts', {
    updateUserById: async (id: number, data: Row) => {
      assert(id === USER_ID, `updateUserById(${id})`);
      for (const [key, value] of Object.entries(data)) if (value !== undefined) userRow[key] = value;
      return { ...userRow };
    },
  });
  stub('src/services/reminder-cache.ts', { updateUserInCache: async () => {}, removeUserFromCache: async () => {} });
  stub('src/services/telegram/index.ts', { setUserMenuButton: async () => {} });
  stub('src/lib/error-capture.ts', {
    captureError: (error: unknown, context: string, _extra?: unknown, severity: unknown = 'error') => {
      captured.push({ context, severity, message: error instanceof Error ? error.message : String(error) });
    },
    captureWarning: () => {},
    captureInfo: () => {},
  });
  stub('src/services/calendar.ts', { getUserCalendarTimezone: async () => null });
  stub('src/services/weather/geocoding.ts', {
    fetchWithTimeout: fakeFetchWithTimeout,
    geocodeLocation: async (location: string) => {
      cachedPathCalls.push(`geocodeLocation(${location})`);
      throw new Error('the cached geocode path was used');
    },
    getTimezone: async (location: string) => {
      cachedPathCalls.push(`getTimezone(${location})`);
      throw new Error('the cached geocode path was used');
    },
  });

  // Next's after() throws outside a request scope; queue the task and run it after the response.
  const nextServer = nodeRequire('next/server');
  nextServer.after = (task: unknown) => {
    afterQueue.push(typeof task === 'function' ? (task as () => unknown) : () => task);
  };
}

function seed() {
  userRow = {
    id: USER_ID, telegramId: TELEGRAM_ID, location: 'London', language: 'en',
    remindersEnabled: false, suspendedAt: null, unreachableSince: null,
    googleRefreshToken: '', calendarSource: 'NATIVE',
  };
  redisStore.clear();
  redisStore.set(TZ_KEY, OLD_ZONE); // as the summaries resolved it from London
  redisSets.length = 0;
  redisSetError = null;
  requests.length = 0;
  cachedPathCalls.length = 0;
  captured.length = 0;
  afterQueue.length = 0;
  held.clear();
  locationReads.length = 0;
  userGone = false;
  answers = {
    nominatim: url => {
      const place = PLACES[url.searchParams.get('q') ?? ''];
      return json(place ? [{ lat: place.lat, lon: place.lon }] : []);
    },
    openMeteo: url => {
      const place = Object.values(PLACES).find(p => String(parseFloat(p.lat)) === url.searchParams.get('latitude'));
      return place
        ? json({ timezone: place.zone, latitude: Number(place.lat), longitude: Number(place.lon) })
        : json({ error: true, reason: 'unknown place' }, 400);
    },
  };
}

async function main() {
  installStubs();
  const { NextRequest } = nodeRequire('next/server');
  const { POST } = (await import(path.join(ROOT, 'app/api/settings/route.ts'))) as {
    POST: (req: unknown) => Promise<Response>;
  };

  /** A settings save from the mini app, through the real route. */
  const save = async (body: Row) => {
    const log = console.log;
    console.log = () => {};
    try {
      return await POST(new NextRequest(`http://localhost/api/settings?user_id=${TELEGRAM_ID}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
    } finally {
      console.log = log;
    }
  };

  /** Each request, as "host timeout/retries". */
  const shape = () => requests.map(r => `${new URL(r.url).host} ${String(r.timeoutMs)}/${String(r.maxRetries)}`);

  await check('(a) a new location: the save answers at once, then tz:user:{id} becomes the new zone for 24 h', async () => {
    seed();
    const res = await save({ location: 'New York' });
    assert(res.status === 200, `status ${res.status}`);
    assert(userRow.location === 'New York', `stored location ${show(userRow.location)}`);
    assert(afterQueue.length === 1, `${afterQueue.length} tasks scheduled with after()`);
    assert(requests.length === 0, `the lookup ran before the response: ${show(shape())}`);
    assert(redisStore.get(TZ_KEY) === OLD_ZONE, `zone before the task ran: ${show(redisStore.get(TZ_KEY))}`);
    await drainAfter();
    assert(redisStore.get(TZ_KEY) === 'America/New_York', `cached zone ${show(redisStore.get(TZ_KEY))}`);
    assert(show(redisSets) === show([{ key: TZ_KEY, value: 'America/New_York', opts: { ex: 86400 } }]), `redis sets ${show(redisSets)}`);
    assert(captured.length === 0, `captured ${show(captured)}`);
  });

  await check('(a) the lookup: one Nominatim and one Open-Meteo request, each with a 3 s timeout and no retries, no geocode cache', async () => {
    seed();
    await save({ location: 'New York' });
    await drainAfter();
    assert(show(shape()) === show(['nominatim.openstreetmap.org 3000/0', 'api.open-meteo.com 3000/0']), `requests ${show(shape())}`);
    const search = new URL(requests[0].url);
    assert(search.pathname === '/search' && search.searchParams.get('q') === 'New York' && search.searchParams.get('format') === 'json' && search.searchParams.get('limit') === '1', `Nominatim url ${requests[0].url}`);
    const headers = (requests[0].options as { headers?: Record<string, string> } | undefined)?.headers;
    assert(headers?.['User-Agent'] === 'FamilyCalendarBot/1.0', `Nominatim headers ${show(headers)}`);
    const forecast = new URL(requests[1].url);
    assert(forecast.searchParams.get('latitude') === '40.7127281' && forecast.searchParams.get('longitude') === '-74.0060152' && forecast.searchParams.get('timezone') === 'auto', `Open-Meteo url ${requests[1].url}`);
    assert(cachedPathCalls.length === 0, `cached path used: ${show(cachedPathCalls)}`);
  });

  await check('(b) Open-Meteo fails: the cached zone stays, nothing is written, no retry', async () => {
    seed();
    answers.openMeteo = () => { throw new TypeError('fetch failed'); };
    const res = await save({ location: 'New York' });
    assert(res.status === 200, `status ${res.status}`);
    await drainAfter();
    assert(show(shape()) === show(['nominatim.openstreetmap.org 3000/0', 'api.open-meteo.com 3000/0']), `requests ${show(shape())}`);
    assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
  });

  await check('(b) Open-Meteo answers 503: the cached zone stays', async () => {
    seed();
    answers.openMeteo = () => json({ error: true, reason: 'busy' }, 503);
    await save({ location: 'New York' });
    await drainAfter();
    assert(requests.length === 2, `requests ${show(shape())}`);
    assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
  });

  await check('(c) Nominatim finds nothing: the cached zone stays, Open-Meteo is not asked', async () => {
    seed();
    answers.nominatim = () => json([]);
    await save({ location: 'Atlantis' });
    await drainAfter();
    assert(show(shape()) === show(['nominatim.openstreetmap.org 3000/0']), `requests ${show(shape())}`);
    assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
  });

  await check('(d) Open-Meteo sends a zone Intl does not know: the cached zone stays', async () => {
    seed();
    answers.openMeteo = () => json({ timezone: 'Mars/Olympus_Mons' });
    await save({ location: 'New York' });
    await drainAfter();
    assert(requests.length === 2, `requests ${show(shape())}`);
    assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
  });

  await check('(e) Open-Meteo sends no zone: the cached zone stays (no Asia/Jerusalem default)', async () => {
    seed();
    answers.openMeteo = () => json({ latitude: 40.71, longitude: -74.0 });
    await save({ location: 'New York' });
    await drainAfter();
    assert(requests.length === 2, `requests ${show(shape())}`);
    assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
  });

  await check('(f) the Redis write fails: the save still answers 200 and the failure is a warning', async () => {
    seed();
    redisSetError = new Error('redis down');
    const res = await save({ location: 'New York' });
    assert(res.status === 200, `status ${res.status}`);
    await drainAfter();
    assert(show(captured.map(c => [c.severity, c.message])) === show([['warning', 'redis down']]), `captured ${show(captured)}`);
  });

  await check('(g) [guard] the same location, or the same with spaces around it: no lookup, the zone stays', async () => {
    for (const location of ['London', '  London ']) {
      seed();
      const res = await save({ location, weatherEnabled: true });
      assert(res.status === 200, `status ${res.status}`);
      await drainAfter();
      assert(requests.length === 0, `"${location}": requests ${show(shape())}`);
      assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `"${location}": zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
    }
  });

  await check('(h) [guard] no location in the save, or an empty one: no lookup, the zone stays', async () => {
    for (const body of [{ weatherEnabled: true }, { location: '' }, { location: '   ' }]) {
      seed();
      const res = await save(body);
      assert(res.status === 200, `status ${res.status}`);
      await drainAfter();
      assert(requests.length === 0, `${show(body)}: requests ${show(shape())}`);
      assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `${show(body)}: zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
    }
  });

  await check('(i) resolveTimezoneForLocation on its own: the zone, or null on any failure', async () => {
    const { resolveTimezoneForLocation } = (await import(path.join(ROOT, 'src/lib/timezone.ts'))) as {
      resolveTimezoneForLocation: (location: string) => Promise<string | null>;
    };
    seed();
    assert(await resolveTimezoneForLocation('New York') === 'America/New_York', 'New York');
    answers.nominatim = () => { throw new Error('timeout'); };
    assert(await resolveTimezoneForLocation('New York') === null, 'Nominatim throws');
    seed();
    answers.nominatim = () => json([], 500);
    assert(await resolveTimezoneForLocation('New York') === null, 'Nominatim 500');
    seed();
    answers.openMeteo = () => json({ timezone: '' });
    assert(await resolveTimezoneForLocation('New York') === null, 'empty zone');
    assert(cachedPathCalls.length === 0, `cached path used: ${show(cachedPathCalls)}`);
  });

  await check('(j) [race] two quick saves, Tel Aviv then London: the Tel Aviv lookup lands last and writes nothing, London\'s zone stays', async () => {
    seed();
    userRow.location = 'New York';
    redisStore.set(TZ_KEY, 'America/New_York');
    const releaseTelAviv = hold('Tel Aviv');
    await save({ location: 'Tel Aviv' });
    await save({ location: 'London' });
    assert(afterQueue.length === 2, `${afterQueue.length} tasks scheduled with after()`);
    const [telAviv, london] = afterQueue.splice(0);
    const telAvivLanded = Promise.resolve(telAviv()); // asks Nominatim, then waits for the answer
    await london();
    releaseTelAviv();
    await telAvivLanded;
    const asked = requests.map(r => {
      const url = new URL(r.url);
      return url.host === 'nominatim.openstreetmap.org' ? `place ${url.searchParams.get('q')}` : `zone ${url.searchParams.get('latitude')}`;
    });
    assert(show(asked) === show(['place Tel Aviv', 'place London', 'zone 51.5074456', 'zone 32.0852997']), `asked ${show(asked)}`);
    assert(show(redisSets) === show([{ key: TZ_KEY, value: 'Europe/London', opts: { ex: 86400 } }]), `redis sets ${show(redisSets)}`);
    assert(redisStore.get(TZ_KEY) === 'Europe/London', `cached zone ${show(redisStore.get(TZ_KEY))}`);
    // Each lookup found a zone, so each read the location back before writing.
    const read = { where: { id: USER_ID }, select: { location: true } };
    assert(show(locationReads) === show([read, read]), `location reads ${show(locationReads)}`);
  });

  await check('(k) [race] the location changes before its lookup lands (saved again as spaces, or the row is gone): nothing is written', async () => {
    for (const change of ['saved as spaces', 'row gone']) {
      seed();
      await save({ location: 'New York' });
      assert(afterQueue.length === 1, `${change}: ${afterQueue.length} tasks scheduled with after()`);
      if (change === 'saved as spaces') {
        await save({ location: '   ' }); // stored as it is, with no lookup of its own
        assert(userRow.location === '   ' && afterQueue.length === 1, `${change}: stored ${show(userRow.location)}, ${afterQueue.length} tasks`);
      } else {
        userGone = true;
      }
      await drainAfter();
      assert(requests.length === 2, `${change}: requests ${show(shape())}`);
      assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `${change}: zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
      assert(locationReads.length === 1, `${change}: ${locationReads.length} location reads`);
    }
  });

  await check('(l) a Hebrew or a Russian location goes to Nominatim URL-encoded, and its zone is cached', async () => {
    const cases: [string, string][] = [['תל אביב', 'Asia/Jerusalem'], ['Москва', 'Europe/Moscow']];
    for (const [location, zone] of cases) {
      seed();
      await save({ location });
      await drainAfter();
      assert(requests.length === 2, `"${location}": requests ${show(shape())}`);
      const url = requests[0].url;
      assert(url.includes(`?q=${encodeURIComponent(location)}&`) && /^[\x21-\x7e]+$/.test(url), `"${location}": Nominatim url ${url}`);
      assert(new URL(url).searchParams.get('q') === location, `"${location}": q reads back as ${show(new URL(url).searchParams.get('q'))}`);
      assert(show(redisSets) === show([{ key: TZ_KEY, value: zone, opts: { ex: 86400 } }]), `"${location}": redis sets ${show(redisSets)}`);
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

- [ ] **Step 2: Run it on today's code and watch it fail**

```bash
TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-location-timezone.ts; echo "exit $?"
```

Expected, ending with:

```
FAIL  (a) a new location: the save answers at once, then tz:user:{id} becomes the new zone for 24 h — 0 tasks scheduled with after()
FAIL  (a) the lookup: one Nominatim and one Open-Meteo request, each with a 3 s timeout and no retries, no geocode cache — requests []
FAIL  (b) Open-Meteo fails: the cached zone stays, nothing is written, no retry — requests []
FAIL  (b) Open-Meteo answers 503: the cached zone stays — requests []
FAIL  (c) Nominatim finds nothing: the cached zone stays, Open-Meteo is not asked — requests []
FAIL  (d) Open-Meteo sends a zone Intl does not know: the cached zone stays — requests []
FAIL  (e) Open-Meteo sends no zone: the cached zone stays (no Asia/Jerusalem default) — requests []
FAIL  (f) the Redis write fails: the save still answers 200 and the failure is a warning — captured []
OK  (g) [guard] the same location, or the same with spaces around it: no lookup, the zone stays
OK  (h) [guard] no location in the save, or an empty one: no lookup, the zone stays
FAIL  (i) resolveTimezoneForLocation on its own: the zone, or null on any failure — resolveTimezoneForLocation is not a function
FAIL  (j) [race] two quick saves, Tel Aviv then London: the Tel Aviv lookup lands last and writes nothing, London's zone stays — 0 tasks scheduled with after()
FAIL  (k) [race] the location changes before its lookup lands (saved again as spaces, or the row is gone): nothing is written — saved as spaces: 0 tasks scheduled with after()
FAIL  (l) a Hebrew or a Russian location goes to Nominatim URL-encoded, and its zone is cached — "תל אביב": requests []

2/14 passed (process TZ=UTC)
exit 1
```

Why it fails today:
- The route never schedules a lookup: no `after()` task and no request. That fails (a)–(f) and (j)–(l), including the negative cases, which also assert that the lookup was made.
- `src/lib/timezone.ts` has no `resolveTimezoneForLocation`, which fails (i).
- (g) and (h) are guards: they pass before and after.

(j) and (k) guard the location read-back in Step 4a. This was checked by running the smoke on Steps 3–4 with `refreshTimezone` writing as soon as the lookup finds a zone, with no read-back. Both fail then, and nothing else does (`12/14 passed`):
- `(j)`: `redis sets [{"key":"tz:user:7","value":"Europe/London","opts":{"ex":86400}},{"key":"tz:user:7","value":"Asia/Jerusalem","opts":{"ex":86400}}]`. The Tel Aviv lookup, landing last, overwrites London's zone.
- `(k)`: `saved as spaces: zone "America/New_York", sets [{"key":"tz:user:7","value":"America/New_York","opts":{"ex":86400}}]`. New York's zone is written though the stored location is no longer New York.

- [ ] **Step 3: Add `resolveTimezoneForLocation` to `src/lib/timezone.ts`**

Edit 3a, the import (line 10). Replace:
```ts
import { geocodeLocation } from '../services/weather/geocoding';
```
with:
```ts
import { fetchWithTimeout, geocodeLocation } from '../services/weather/geocoding';
```

Edit 3b, after `const TIMEZONE_CACHE_TTL = 24 * 60 * 60; // 24 hours in seconds` (line 13). Replace:
```ts
const TIMEZONE_CACHE_TTL = 24 * 60 * 60; // 24 hours in seconds

/**
 * Resolve user's timezone dynamically
```
with:
```ts
const TIMEZONE_CACHE_TTL = 24 * 60 * 60; // 24 hours in seconds
const LOOKUP_TIMEOUT_MS = 3000;

/** True when Intl accepts `tz` as an IANA zone. */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The timezone of a location, looked up fresh: one Nominatim request for the place and
 * one Open-Meteo request for its zone, each with a 3 s timeout and no retries. Unlike
 * geocodeLocation it neither reads nor fills the in-process geocode cache, and it has no
 * fallback zone. Null when either request fails, the place is not found, or Open-Meteo
 * sends no zone Intl accepts. Never throws.
 */
export async function resolveTimezoneForLocation(location: string): Promise<string | null> {
  try {
    const searchUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
    const place = await fetchWithTimeout(searchUrl, { headers: { 'User-Agent': 'FamilyCalendarBot/1.0' } }, LOOKUP_TIMEOUT_MS, 0);
    if (!place.ok) return null;
    const results = await place.json() as Array<{ lat: string; lon: string }>;
    if (!Array.isArray(results) || results.length === 0) return null;
    const latitude = parseFloat(results[0].lat);
    const longitude = parseFloat(results[0].lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

    const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m&timezone=auto`;
    const forecast = await fetchWithTimeout(forecastUrl, {}, LOOKUP_TIMEOUT_MS, 0);
    if (!forecast.ok) return null;
    const { timezone } = await forecast.json() as { timezone?: unknown };
    return typeof timezone === 'string' && timezone !== '' && isValidTimeZone(timezone) ? timezone : null;
  } catch {
    return null;
  }
}

/**
 * Resolve user's timezone dynamically
```

`resolveUserTimezone` and everything below it stay byte-for-byte the same.

- [ ] **Step 4: Refresh the cached zone from `app/api/settings/route.ts`**

Edit 4a, the imports (lines 1-7). Replace:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { updateUserById } from '@/src/services/user-service';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { captureError } from '@/src/lib/error-capture';
import { setUserMenuButton } from '@/src/services/telegram';
import { updateUserInCache, removeUserFromCache } from '@/src/services/reminder-cache';
```
with:
```ts
import { NextRequest, NextResponse, after } from 'next/server';
import { updateUserById } from '@/src/services/user-service';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { captureError } from '@/src/lib/error-capture';
import { setUserMenuButton } from '@/src/services/telegram';
import { updateUserInCache, removeUserFromCache } from '@/src/services/reminder-cache';
import { resolveTimezoneForLocation } from '@/src/lib/timezone';
import { redis } from '@/src/utils/redis';
import { prisma } from '@/src/utils/prisma';
import { REDIS_KEYS } from '@/src/config/redis-keys';

const TIMEZONE_CACHE_TTL = 24 * 60 * 60; // as resolveUserTimezone caches it

/**
 * Caches the zone of a newly saved location (`location` is trimmed). A failed lookup
 * leaves the cached zone as it is. So does a location that changed again while the lookup
 * ran: two quick saves each schedule a lookup, and the older one can land last.
 */
async function refreshTimezone(userId: number, location: string): Promise<void> {
  const tz = await resolveTimezoneForLocation(location);
  if (!tz) return;
  // Compared trimmed, as the save compares it. A row that is gone reads as ''.
  const stored = await prisma.user.findUnique({ where: { id: userId }, select: { location: true } });
  if ((stored?.location ?? '').trim() !== location) return;
  await redis.set(REDIS_KEYS.userTimezone(userId), tz, { ex: TIMEZONE_CACHE_TTL });
}
```

Edit 4b, before the update (line 46). Replace:
```ts
    // auth.user is the row the credential proved (a Telegram user, or a WhatsApp session's DB id)
    const updatedUser = await updateUserById(auth.user.id, {
```
with:
```ts
    // A changed location moves the cached timezone with it (else the old zone stays up to 24 h).
    // Compared trimmed, so spaces alone are no change; an empty location is not saved
    // (`location || undefined` below), so it changes nothing here either.
    const newLocation = typeof location === 'string' ? location.trim() : '';
    const locationChanged = newLocation !== '' && newLocation !== (auth.user.location ?? '').trim();

    // auth.user is the row the credential proved (a Telegram user, or a WhatsApp session's DB id)
    const updatedUser = await updateUserById(auth.user.id, {
```

Edit 4c, after the update (lines 65-66). Replace:
```ts
      voiceInputEnabled: typeof voiceInputEnabled === 'boolean' ? voiceInputEnabled : undefined
    });

    // Update reminder cache (no extra DB query - uses data from updateUserById). Who belongs
```
with:
```ts
      voiceInputEnabled: typeof voiceInputEnabled === 'boolean' ? voiceInputEnabled : undefined
    });

    // The lookup runs after the response, so the save answers at once.
    if (locationChanged) {
      const id = auth.user.id;
      after(() =>
        refreshTimezone(id, newLocation).catch(error =>
          captureError(error, 'settings-timezone', { api_route: '/api/settings', user_id: id }, 'warning')
        )
      );
    }

    // Update reminder cache (no extra DB query - uses data from updateUserById). Who belongs
```

The task is scheduled straight after the DB write. A later failure in the reminder-cache or menu-button steps then still lets the cached zone follow the location that was saved. Nothing else in the route changes. The read-back in `refreshTimezone` runs after the response, like the lookup, so the save's own path makes no extra query.

- [ ] **Step 5: Run the smoke under both clocks and expect PASS**

```bash
TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-location-timezone.ts; echo "exit $?"
TZ=Asia/Jerusalem DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-location-timezone.ts; echo "exit $?"
```

Expected: all 14 lines `OK` under each clock, then `14/14 passed (process TZ=UTC)` and `exit 0`, then `14/14 passed (process TZ=Asia/Jerusalem)` and `exit 0`.

- [ ] **Step 6: Run the two other smokes that call the real settings route, and expect PASS**

```bash
TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-reminders.ts; echo "exit $?"
TZ=Asia/Jerusalem DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-reminders.ts; echo "exit $?"
TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-auth-identity.ts; echo "exit $?"
TZ=Asia/Jerusalem DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-auth-identity.ts; echo "exit $?"
```

Expected in plan order (Task 1 lands first, then Task 2, then Task 3, then this task), every line `OK`:
- `smoke-reminders`: `23/23 passed (process TZ=UTC)`, then `23/23 passed (process TZ=Asia/Jerusalem)`. No task in this plan changes it.
- `smoke-auth-identity`: `26/26 passed` under each clock (its 21 checks on 858886c plus Task 1's #23–#27; Tasks 2 and 3 don't touch it).

Each run prints `exit 0`.

- [ ] **Step 7: Type-check and lint**

```bash
npx tsc --noEmit -p .
npm run -s lint
```

Expected: both exit 0 with no output. `tsconfig.json` includes `scripts/**`, so the new smoke is type-checked too.

- [ ] **Step 8: Commit**

```bash
git add src/lib/timezone.ts app/api/settings/route.ts scripts/smoke-location-timezone.ts
git commit -F - <<'EOF'
fix(settings): a new location moves the cached timezone with it

A settings save that changed the location left the old zone in
tz:user:{id} for up to 24 h, so summaries, reminders and voice kept the
old city's clock. The save now looks the new zone up after the response
(resolveTimezoneForLocation: one Nominatim and one Open-Meteo request,
3 s each, no retries, no geocode cache, no Asia/Jerusalem fallback) and
caches it for 24 h only when the lookup finds a zone Intl accepts. A
failed lookup, an unchanged location or an empty one leaves the key as
it is.

Two quick saves each schedule a lookup, and the older one can land
last, so before writing the lookup reads the stored location back and
writes only if it is still the one it looked up.

Smoke: scripts/smoke-location-timezone.ts (2/14 before, 14/14 after).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

---

### Task 5: Verification and landing (run by the controller, not a subagent)

**Files:** none changed, unless a check fails.

- [ ] **Step 1: Run every smoke under both clocks**

```bash
cd /Users/razielgershoni/development/famcalbot
set -o pipefail
E="DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake"
for s in scripts/smoke-*.ts; do for tz in UTC Asia/Jerusalem; do eval "env TZ=$tz $E npx tsx $s" > /tmp/smoke.out 2>&1; c=$?; echo "$(basename $s) $tz exit=$c $(tail -1 /tmp/smoke.out)"; done; done
eval "env $E npx tsx scripts/check-i18n-parity.ts"; echo "parity exit $?"
```

Expected: every line `exit=0`. Smokes that need a live service print their own SKIP line and exit 0; any non-zero exit is a failure to fix before landing.

- [ ] **Step 2: Type-check and lint the branch**

Run: `npx tsc --noEmit -p . && npm run -s lint; echo "exit $?"`
Expected: `exit 0`, no output before it.

- [ ] **Step 3: Build a fresh clone on Node 22**

```bash
rm -rf /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/fresh-A
git clone -q --branch feat/calendar-home /Users/razielgershoni/development/famcalbot /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/fresh-A
cd /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/fresh-A
npx -y node@22 "$(command -v npm)" ci --no-audit --no-fund > ../fresh-A-ci.log 2>&1; echo "ci exit $?"
npx -y node@22 node_modules/.bin/prisma generate > ../fresh-A-gen.log 2>&1; echo "generate exit $?"
npx -y node@22 node_modules/.bin/next build > ../fresh-A-build.log 2>&1; echo "build exit $?"; tail -5 ../fresh-A-build.log
```

Expected: three `exit 0` lines and a finished build. No migration runs here (no `.env` in the clone); Plan A has none.

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

Expected: a fast-forward with no merge commit. If `--ff-only` refuses, stop: `main` moved, so rebase the branch onto it, re-run Steps 1–3 and try again.

- [ ] **Step 5: Confirm the deploy**

Poll `gh api repos/raziel-gershoni/famcalbot/commits/<sha>/status --jq '.statuses[] | "\(.context) \(.state)"'` every few minutes (not in a tight loop), until the context `famcalbot - famcalbot` (Railway) and the Vercel context both read `success`. On `failure`, read the build log, fix on the branch and land again.

- [ ] **Step 6: Watch the first hours**

After the deploy, check Sentry for new errors tagged `settings`, `native-reminders` or `week-lookahead`, and for slow-query warnings from the ping and alert passes (Review Focus, last note). Production stays read-only.

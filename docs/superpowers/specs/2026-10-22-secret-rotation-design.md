# Secret rotation hardening: design

- **Date:** 2026-10-22
- **Status:** approved in chat by the owner on 2026-10-22 ("build these now", then "you can start with the plan")
- **Base:** `main` at b765741. Every `file:line` below refers to that commit.

## Why

Railway disclosed on 2026-10-21 that customers' environment variables were exposed. The owner rules that FamCal was probably not targeted ("no panic"), but every secret gets replaced in one window when deploys are possible again, on Railway or on a new host. Plain replacement breaks the app in three places, and two secrets quietly stand in for each other:

1. **`ENCRYPTION_KEY` can't change today.** It is read once at module load (`src/utils/encryption.ts:11`), and every stored Google refresh token is decrypted inside `convertPrismaUserToConfig` (`src/types.ts:55`), which every `getUser*` goes through. With a new key:
   - `getAllUsers` throws (`user-service.ts:114-116`) and the whole hourly summary batch fails (`summary.ts:482`, caught at `:658`);
   - every lookup of a Google-connected user throws, so connect and reconnect fail too (`oauth-callback/page.tsx:317`).
2. **Redis holds plaintext Google tokens.** `reminders:users` stores every remindable user's decrypted token with no TTL (`reminder-cache.ts:19,52-57`). `voice:pending:*` holds a full `UserConfig` with the plaintext token for 600 s.
3. **One secret does another's job.**
   - Image links are signed with `ENCRYPTION_KEY || CRON_SECRET` (`app/api/weather-image/route.ts:19`, `sign/route.ts:77`).
   - Session cookies use `SESSION_SECRET || CRON_SECRET` (`src/lib/session-auth.ts:14`).
   - Unsigned WhatsApp webhooks are accepted (`src/lib/whatsapp-signature.ts:14`).

## Goal

Every secret can be replaced in one window, and nothing breaks quietly while that happens:
- summaries keep going out;
- Google stays connected;
- WhatsApp and the Mini App keep working;
- every failure is logged and sent to Sentry.

Afterwards, no secret is stored in plain form outside the DB, and no secret stands in for another.

The code is **host-agnostic**. The owner may move off Railway; nothing here depends on Railway. It only needs one long-lived Node process, which FamCal needs anyway because of node-cron.

## Non-goals (owner rulings and scope cuts)

- **No separate dev bot or staging.** The owner tests in prod and will raise it when it matters.
- **No provider rotation in code.** Resetting Neon, Telegram, Meta, Google, Gemini, Upstash and Sentry are console steps in the deploy-day checklist (a separate page, rewritten for whichever host is used).
- **No dual-key checking for image links or session cookies.** During the few seconds old and new servers both run, such a request may be refused. Accepted.
- **No other route or file deletions:**
  - `app/api/subscription/usage/route.ts` stays and gets the shared secret check;
  - the legacy `src/index.ts` and the unused AI clients are left alone;
  - the dead names in `.env.example` are not pruned.
- **No data migration for `iv:tag:` rows.** `normalizeStored` treats them as "no token" (section a).
- **No TTL on the new reminder cache key.**
- **No change** to `/api/health`, `app/api/set-menu-button` auth, the Gemini model or the thinking level.
- **No host-coupling changes.** The deploy message reading `RAILWAY_GIT_COMMIT_SHA` belongs to the host move, not here.

## Terms

- **Overlap:** during a zero-downtime deploy, the old container keeps serving until the new one is healthy. For a short time both run node-cron and both serve requests.
- **Deploy 1 / Deploy 2:** first the code ships on the old values (Deploy 1), then the values are replaced (Deploy 2), in the same window. Deploy 1 records the old key's fingerprint and a baseline.

---

## (a) Encryption key rotation

### `src/utils/encryption.ts`

1. **Read env on each call.** A `keys()` helper parses `ENCRYPTION_KEY` and `ENCRYPTION_KEY_PREVIOUS` from `process.env` on every call and caches the parsed `Buffer` per raw string, so tests and a changed env are seen.
2. **`ENCRYPTION_KEY`** missing or not 64 hex characters (32 bytes) throws, as today, with the same messages.
3. **`ENCRYPTION_KEY_PREVIOUS`** is optional and used for decryption only:
   - unset or `''`: ignored, silently;
   - not 64 hex characters: `console.error` plus `captureError(..., 'encryption-previous-invalid')`, once per process (`globalThis` flag), then ignored;
   - the same bytes as `ENCRYPTION_KEY`: `console.warn` once per process, then ignored.
4. **`encrypt(text)`** always uses `ENCRYPTION_KEY`. The format stays `iv:tag:data` (hex), so `isEncrypted` (`:79`) still accepts it.
5. **`decryptDetailed(text): { value: string; key: 'current' | 'previous' }`**:
   - checks the format first, as `decrypt` does today (`:50-64`: three parts, a 16-byte tag);
   - tries the current key, then PREVIOUS;
   - throws `UndecryptableError` if neither works.
   - Two keys are safe to try: AES-GCM's tag check rejects a wrong key with practical certainty.
6. **`UndecryptableError extends Error`**, with `name = 'UndecryptableError'`. It must **not** have a `code` property and must not wrap Node's crypto error. `classifyGoogleError` treats any error with a string `code` and no `response` as transient (`calendar-read/google-map.ts:129`), and that would hide it from Sentry.
7. **`decrypt(text)`** returns `decryptDetailed(text).value`. **`safeDecrypt`** keeps its signature and behaviour.
8. **`normalizeStored(raw: string): string`** maps an "empty cipher" `^[0-9a-f]{32}:[0-9a-f]{32}:$` (case-insensitive) to `''` and returns anything else unchanged. Those rows were written by the `select-calendars` bug (item 5 below) for users with no token.
9. **`readStoredToken(stored, ctx: { userId: number; column: string }): string`** never throws:
   - `normalizeStored` first; `''` returns `''`;
   - a value that is not `isEncrypted` is legacy plaintext: returned as-is, as today;
   - a decryptable value returns the decrypted text;
   - an undecryptable value returns `''`, with `console.error('[token] undecryptable', {userId, column})` and `captureError(err, 'token-undecryptable', {user_id, column})`. This happens once per `userId:column` per process, using a `Set` on `globalThis`. The scheduler and the routes load separate copies of each module (Next 16 cross-bundle state), so module-level state isn't shared.
   - It never logs the value.
10. **`keyFingerprint(which: 'current' | 'previous'): string | null`** gives the first 8 hex characters of sha256 over the 32 raw key bytes, or `null` when that key is unset or invalid. Log lines only.
11. **`sealSecret(v)` / `openSecret(v)`**, for secrets at rest in Redis (section c):
    - `sealSecret`: `''` stays `''`, an `isEncrypted` value passes through, anything else is encrypted;
    - `openSecret`: `''` gives `''`; otherwise `decrypt` (strict, with the PREVIOUS fallback, throws `UndecryptableError`).

### Call sites

1. **`src/types.ts:55`**: `readStoredToken(prismaUser.googleRefreshToken, { userId: prismaUser.id, column: 'googleRefreshToken' })`. This one line covers every `getUser*`.
2. **`src/cron/handlers.ts:77`** (reminder-cache sync) no longer decrypts. It stores `sealSecret(normalizeStored(raw))` (section c), so one bad row can't abort the sync.
3. **`src/services/google-connect.ts:206`** (claim of a parked `oauth:pending` entry):
   - catch a decrypt failure;
   - `captureError(err, 'oauth-claim-undecryptable', {user_id})`;
   - return `{ status: 'expired' }`. The user taps Connect again.
4. **Bug fix, `app/api/select-calendars/route.ts:133`:** delete `googleRefreshToken: encrypt(currentUser.googleRefreshToken)`. Saving calendar choices doesn't change the token.
   - Today it writes `iv:tag:` for users with no token.
   - With `readStoredToken` it would write `encrypt('')` over a real token that only failed to decrypt, destroying it.
5. **Bug fix, `src/services/native-reminders/actions.ts:212`:** it passes the encrypted column to `resolveUserTimezone` as a refresh token, and the failure is swallowed (`timezone.ts:132`). Pass `readStoredToken(...)` instead.
6. **`src/services/google-sync/worker.ts:170` `tokenOf` keeps throwing, on purpose.** Returning `''` would trigger `outage('token')` (`:620`) and send the user a false "reconnect Google" message. The throw stays within that user and reaches Sentry via `stopUser` (`:309-310`).
7. **`account-linking.ts:433,493`** copy ciphertext raw between rows. That is safe through PREVIOUS and the sweep's compare-and-set, so no change.

### Key sweep: new `src/services/key-rotation.ts`

`runKeySweep()` runs `*/10 * * * *` from `src/cron/scheduler.ts`, with the scheduler's existing try/catch and `captureError('cron-key-sweep')` pattern.

1. **Uptime gate.** If `process.uptime() < 600` it returns before any DB or Redis call. The old container may still be serving during the first minutes.
2. **Lock.** Redis `SET keysweep:lock <uuid> NX EX 300`. Held: skip quietly. Redis error: skip the tick with `console.warn`.
3. **Baseline tick.** The first tick after the gate always runs read-only, even with no PREVIOUS. It logs the counts:

   `[key-sweep] baseline: users current=N previous=N plaintext=N empty_cipher=N unreadable=N; links current=N previous=N unreadable=N`
4. **Rows walked:** `User.googleRefreshToken <> ''` and `GoogleSyncLink.unlinkToken IS NOT NULL` (`schema.prisma:62,304`), in batches of 100 by id.
5. **Conversion** runs only while PREVIOUS is valid and differs from the current key. For each row:
   - **under PREVIOUS:** decrypt, `encrypt` with the current key, then write with compare-and-set (CAS: write only if the value hasn't changed since it was read), e.g. `updateMany({ where: { id, googleRefreshToken: old }, data: { googleRefreshToken: next } })`. `count === 0` counts as **raced**: the row is retried next tick, and a newer value is never overwritten.
   - **legacy plaintext** (non-empty, not `isEncrypted`, not empty cipher): encrypted with the same CAS write. This also runs without PREVIOUS, so "no unencrypted tokens" holds after Deploy 1.
   - **empty cipher:** counted, never written.
   - **unreadable** (neither key): never written. The ids are logged (never values), with one `captureError('key-sweep-unreadable', {ids})` and one `notifyAdminWarning('key-sweep', ...)` per process.
6. **After any conversion:** call `rebuildReminderCache()` (section c), so the Redis copy moves to the current key too.
7. **Each active tick logs** (idle ticks, item 9, log nothing):

   `[key-sweep] users current=N converted=N raced=N unreadable=N plaintext_encrypted=N empty_cipher=N; links current=N converted=N raced=N unreadable=N; legacy_cache=0|1`
8. **SAFE condition:** all of these hold:
   - uptime ≥ 1800 s;
   - a full pass with 0 rows under PREVIOUS, 0 legacy plaintext, 0 raced and 0 unreadable, in both columns;
   - every `reminders:users:v2` entry's `googleToken` is `''` or decrypts with the **current** key;
   - the legacy `reminders:users` key doesn't exist.

   Then it logs once per process:

   `[key-sweep] SAFE: every stored token is under ENCRYPTION_KEY (fp XXXXXXXX); nothing needs ENCRYPTION_KEY_PREVIOUS. You can remove it at the next deploy.`

   It sends the admins one Telegram message, deduplicated by Redis `SET keysweep:safe:<previous fp> 1 NX EX 2592000` and sent with the `getAdminUserIds` + `getBot` pattern. Without a PREVIOUS key, SAFE is neither logged nor sent: nothing was rotated.

9. **Idle mode** (owner-approved amendment, 2026-10-23). Once SAFE is logged, or once a full pass finds nothing to write and either PREVIOUS isn't valid or unreadable rows remain, later ticks in that process return before any DB or Redis call. A query every 10 minutes would keep Neon awake about half the time (around 90 of the free 100 CU-hours a month). The next deploy starts a new process, which runs the baseline again.

### Startup line, `instrumentation.ts`

`[startup] ENCRYPTION_KEY fp ab12cd34; ENCRYPTION_KEY_PREVIOUS unset | fp 9f8e7d6c | invalid (ignored) | same as ENCRYPTION_KEY (ignored)`

It is logged in every environment where `NEXT_RUNTIME === 'nodejs'`.

### Failure modes

| Mistake | Effect | Seen as | Fix |
|---|---|---|---|
| PREVIOUS forgotten or wrong | Google users count as not connected; summaries go out FamCal-only; nothing is overwritten | `token-undecryptable` in Sentry; the sweep's unreadable alert | Set PREVIOUS correctly; the next read works |
| PREVIOUS in the wrong format | Same as forgotten | Startup error line | Fix the value |
| Both keys equal | Nothing rotated | Startup warning; no SAFE | Generate a new key |
| PREVIOUS removed before SAFE | Unconverted rows can't be read | The same alerts | Put it back |
| New key not 64 hex | Every encrypt throws | Startup and Sentry | `openssl rand -hex 32` |
| Rollback wanted | Swap the two values; the sweep converts back | | |

Side effect: a user who reconnects while their token is unreadable has their saved Google calendar choices cleared as stale (`google-connect.ts:228-230`). Accepted; the real fix is PREVIOUS.

---

## (b) A separate key for summary-image links

1. **New `src/lib/app-keys.ts`:** `appKey(purpose: 'session-cookie' | 'image-link'): Buffer | null`.
   - Derived with `hkdfSync('sha256', SESSION_SECRET, '', 'famcal/<purpose>/v1', 32)`. HKDF is a standard way to turn one secret into several independent keys, each with its own label.
   - `null` when `SESSION_SECRET` is unset or `''`. That is reported once per process per purpose (`captureError(..., 'app-key-missing', {purpose})`).
   - It reads env on each call.
2. **New `src/lib/image-link.ts`:** `signImageLink(payload)` and `verifyImageLink(payload, sig)`, used by both routes.
   - The payload is unchanged: `${userId}:${source}:${msgId ?? ''}:${timestamp}`.
   - Verification rejects a `ts` more than 60 s in the future or older than 1 h, compares in constant time, and returns false when the key is `null`.
3. **`app/api/weather-image/route.ts`** verifies with `verifyImageLink`. There is no `ENCRYPTION_KEY` or `CRON_SECRET` fallback.
4. **`app/api/weather-image/sign/route.ts`** checks `appKey('image-link')` **before** building the image (today it builds first, `:46-75`). If it is null: 500 plus `captureError`, and no image is built.

During the overlap, a link signed by one container and fetched from the other gets a 401, and the user taps share again. Old messages are unaffected: their buttons point at the page, not at a signed URL (`commands.ts:402`, `summary.ts:888`).

---

## (c) No unencrypted Google tokens in Redis

Ciphertext lives in Redis and is decrypted per user only when it's used. The token can't simply be dropped from the cache: a DB read every 5 minutes would keep Neon from ever scaling to zero (about 183 CU-hours a month against the free 100).

### `src/services/reminder-cache.ts`
- New key `reminders:users:v2`. The legacy `reminders:users` is only ever deleted, never read or written.
- The cached field is renamed `googleRefreshToken` → `googleToken` and holds ciphertext, so TypeScript flags every reader that still expects plaintext.
- One `toEntry(user)` builds every entry, for both the sync and `updateUserInCache`. It sets `googleToken: sealSecret(normalizeStored(raw))`.
- `purgeLegacyReminderCache()` deletes `reminders:users`. On failure it logs and captures (`reminder-cache-purge`).

### `src/cron/handlers.ts`
- The sync copies the DB value through `toEntry`. It never decrypts, so it can't throw on a bad row.
- `openSecret(entry.googleToken)` runs **inside the per-user try** (`:165-171`). A bad entry only fails that user, captured as today (`cron-reminders-process-user`, `:191`).
- Extract `rebuildReminderCache()`, used by the hourly job, the boot step and the key sweep.
- The hourly job also calls `purgeLegacyReminderCache()`.

### Boot step
`startScheduler()` fires `bootReminderCache()` (purge legacy, then rebuild) as fire-and-forget, with `captureError('boot-reminder-cache')`. Without it, reminders would pause for up to an hour: an empty v2 key means "No cached users" (`handlers.ts:149-155`). It costs one DB query per deploy.

### Voice pending entries
- `sealUser(user)` and `openUser(stored)` replace `googleRefreshToken` with its sealed or opened form.
- They go only inside the existing setters and getters (`voice/confirmations.ts:51,97,136,511,597,678`, `bulk-confirmations.ts:46,50`).
- `webhook-handlers.ts:1202` calls the shared `setPendingEvent()` instead of writing Redis directly.
- None of the consumers change.
- `openUser` accepts a legacy plaintext entry (a value that is not `isEncrypted`) with a `console.warn`. This covers entries written in the 10 minutes before the deploy; remove it in a later release.

`oauth:pending:*` is already ciphertext (`google-connect.ts:142`) and is unchanged.

A Redis dump that may already have happened is fixed by rotating `GOOGLE_CLIENT_SECRET` (checklist): a refresh token is useless without the client secret.

---

## (d) Fail-closed secrets

### Session cookie
- `src/lib/session-auth.ts:14` uses `appKey('session-cookie')`, with no `CRON_SECRET` fallback.
  - `createSessionToken` throws when the key is null.
  - `validateSessionToken` returns null (deny) and reports once.
  - The empty catch at `:75` becomes `console.warn('[session] malformed session cookie')`, without the value.
- `app/api/auth/magic/route.ts` checks the key **before** `validateMagicToken` (`:20`), because GETDEL uses up the link. A missing key goes to `captureError` and shows the existing "get a fresh link" card (`:26-32`).
- Only the WhatsApp web cookie uses this. Telegram users are checked with initData first (`api-auth.ts:65-72`).
- Effect: WhatsApp web users are signed out once per deploy that changes the key, including Deploy 1 (the switch to HKDF). Magic links already sent keep working.

### WhatsApp webhook
- Delete `ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS`, the `'unverified'` result and `UNSIGNED_WARNING` (`whatsapp-signature.ts:9-16,35-42`).
- An unset secret gives `'unconfigured'`, which `app/api/webhook/route.ts:37-40` already answers with a 500. Add one `captureError` per process.

### Startup checks
- New pure `startupSecretProblems(env): string[]` in `src/lib/startup-checks.ts`. Its lines:
  - `SESSION_SECRET is not set: WhatsApp sign-in and share-story image links are refused`
  - `WHATSAPP_APP_SECRET is not set: every WhatsApp webhook is refused (500)`
  - `TELEGRAM_WEBHOOK_SECRET is not set: every Telegram update is refused`. This line describes the webhook route's real behaviour when the secret is unset; check it first and word the line to match.
  - `SESSION_SECRET equals CRON_SECRET: give it its own value`
- In production, `instrumentation.ts` logs each one as `console.error('[startup] ' + line)` with one `captureError` each. The deploy message gets a `missing: <names>` line.
- **It never throws.** A crash-looping container would take the bot down for everyone.
- The two empty `.catch(() => {})` in the deploy-message block (`instrumentation.ts:29,33`) log and capture instead.

---

## (e) Same-class fixes the rotation needs

1. **`matchesSecret(given, expected)`** in a new `src/lib/secret-compare.ts`.
   - It returns false when `expected` is unset or `''`, or `given` is missing. Otherwise it compares sha256 digests with `timingSafeEqual` (constant time).
   - Used by `src/lib/cron-handler.ts:35-37`, `app/api/subscription/usage/route.ts:16-19`, `app/api/execute-command/route.ts:31`, and `app/api/webhook/route.ts:13,49` (Meta verify token, Telegram secret header).
   - **Cron routes accept only the `Authorization: Bearer` header; `?secret=` is gone.** Nothing outside the app calls them.
   - Why: with `CRON_SECRET=''`, `?secret=` with no value opens every cron route today, and secrets in URLs end up in logs.
2. **`src/lib/sentry-scrub.ts`** also scrubs:
   - the `authorization` and `x-telegram-bot-api-secret-token` headers;
   - the `secret`, `sig` and `hub.verify_token` query values;
   - `/bot<digits>:<token>/` in URLs, replaced with `/bot[scrubbed]/`, in server breadcrumbs (a `beforeBreadcrumb` in `sentry.server.config.ts`) and in span descriptions and URL attributes. Telegram API calls carry the bot token in the path.
3. **`scripts/setup-webhook.ts`**, the one command the owner runs on deploy day:
   - remove `dotenv.config()` (`:4`); the local `.env` is DEV;
   - require `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` from the environment, and exit 1 before any network call if either is missing;
   - validate the secret against `^[A-Za-z0-9_-]{1,256}$`, and require `set` URLs to match `^https://[^/]+/api/webhook$`;
   - call `getMe` first and print `@username`;
   - after `set`, print `getWebhookInfo` (url, pending count, last error), never the token or the secret;
   - the request-parameter building moves into an exported pure function for the smoke check.

---

## Env vars

- **New:** `ENCRYPTION_KEY_PREVIOUS`, optional, decrypt-only. It is set on deploy day to the old `ENCRYPTION_KEY`, and deleted after SAFE.
- **Now required, no fallback:** `SESSION_SECRET`, `WHATSAPP_APP_SECRET`.
- **No other new variables.** The image-link key is derived from `SESSION_SECRET`.
- **Docs:**
  - `.env.example` gets a commented `# ENCRYPTION_KEY_PREVIOUS=` with one line on its use, and marks `SESSION_SECRET` "required, no fallback". It stays commented, per `smoke-auth-leftovers.ts:241-250`.
  - `README.md` gets the rotation rule and the SAFE line.
  - `CLAUDE.md` gets one line on the rule: never replace `ENCRYPTION_KEY` without setting `ENCRYPTION_KEY_PREVIOUS`.

## Rollout (host-agnostic)

1. **Deploy 1:** the code on the current values, adding `SESSION_SECRET` and `WHATSAPP_APP_SECRET` first if missing. Check:
   - the startup fp line: write it down as FP_OLD;
   - the baseline sweep line;
   - the yahrzeit count is 0.
2. **Replace values** at the providers and on the host. Set `ENCRYPTION_KEY_PREVIOUS` = the old key and `ENCRYPTION_KEY` = new.
3. **Deploy 2.** Re-attach the Telegram webhook with `setup-webhook.ts`, and re-verify the Meta webhook. Check:
   - PREVIOUS fp = FP_OLD;
   - the sweep converts;
   - SAFE appears after about 30-40 minutes.
4. **Revoke the old values** at the providers once everything passes. Delete `ENCRYPTION_KEY_PREVIOUS` with a later deploy.

The step-by-step list lives in the deploy-day checklist page, which is rewritten for the destination host if FamCal moves.

## Accepted overlap effects

- **Deploy 1:**
  - a voice pending entry sealed by the new container but read by the old one sends ciphertext to Google, so that confirmation fails and the user retries;
  - the old container's `updateUserInCache` writes only the legacy key, so a settings edit made during the overlap reaches v2 at the next hourly rebuild;
  - the old container sees "No cached users" once the new one purges the legacy key, while the new one covers everyone; the shared `reminder:*` dedup keys prevent doubles.
- **Deploy 2:** between the bot-token revoke and the new container going live, the old container accepts Telegram updates but can't reply, so those replies are lost. Updates refused for a bad secret are retried by Telegram for up to 24 h.
- **Both deploys:** image links and WhatsApp web sessions signed by one container fail on the other.

## Testing

Every new check must be **seen failing on b765741** before it counts.

**Smoke hygiene:**
- every smoke environment sets `ENCRYPTION_KEY_PREVIOUS=''` explicitly, because Prisma loads `.env` for unset variables;
- smokes never reach live services (fake Prisma, Redis, Telegram, Google and capture), as existing smokes do.

**`scripts/smoke-encryption.ts` (extend):**
- a value encrypted under key A decrypts with `KEY=B, PREVIOUS=A`;
- `encrypt` under B+A writes with B (it fails to decrypt with A alone);
- neither key: `UndecryptableError` with no `code`;
- an invalid PREVIOUS, or one equal to KEY, is ignored and logged once;
- `readStoredToken` gives `''` for a wrong-key value and captures once over two calls; it returns `''` for an empty cipher, plaintext as-is, and never throws;
- `normalizeStored`, `sealSecret` and `openSecret` cases;
- `keyFingerprint` is 8 hex characters and stable.

**New `scripts/smoke-key-rotation.ts`:**
- `getAllUsers` with one bad row returns every user, with `''` for that one;
- the summary batch still delivers to the good users;
- the reminder-cache sync isn't aborted by a bad row;
- the OAuth callback and claim with an unreadable stored token commit the new token under B;
- a claim parked under A connects with `KEY=B, PREVIOUS=A`; an unknown key gives `expired`;
- **sweep:**
  - converts both columns;
  - encrypts legacy plaintext;
  - leaves current, empty-cipher and unreadable rows byte-for-byte unchanged;
  - doesn't overwrite a CAS race;
  - is a no-op on a second run;
  - makes no Prisma or Redis call before 600 s uptime;
  - logs the baseline;
  - logs SAFE only at ≥ 1800 s, with the legacy key gone and v2 clean, and sends its message once (dedup);
  - doesn't log SAFE without PREVIOUS;
- `select-calendars` POST leaves the stored token unchanged;
- the native-reminder snooze passes the decrypted token to the timezone lookup;
- the Google sync worker with an unreadable token sends no outage or reconnect message and captures `google-sync-user`.

**`scripts/smoke-reminders.ts` (extend):**
- after the sync and after a settings save, the raw v2 value doesn't contain the token, and every non-empty `googleToken` passes `isEncrypted`;
- Google still receives the plaintext token;
- one bad row: the sync writes both users and only the bad one fails;
- the legacy key is ignored, then purged by `bootReminderCache()`;
- a plaintext or empty-cipher DB row produces a sealed or `''` entry.

**New `scripts/smoke-secret-hygiene.ts`:**
- **Image links:**
  - signed with `ENCRYPTION_KEY`: 401;
  - signed with the HKDF key: 200;
  - with `ENCRYPTION_KEY='' SESSION_SECRET='' CRON_SECRET=C`, a C-signed link gets a 401, and `sign` gets a 500 with a capture and no image built;
  - `ts = now + 2h`: 401.
- **Session cookie:**
  - `SESSION_SECRET=''`: `createSessionToken` throws, and a cookie signed with the CRON value is null;
  - a raw-`s`-signed cookie is refused, and an HKDF-signed one is accepted.
- **WhatsApp:** `ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS` is gone, and an unset secret gives `'unconfigured'` and a 500.
- **Startup:** `startupSecretProblems` covers every case, and `register()` in production logs and captures each one without throwing.
- **Cron:**
  - `CRON_SECRET=''` with `?secret=`: 401;
  - `?secret=c`: 401;
  - `Bearer c`: 200.
- **`setup-webhook`:** the params builder throws on a missing or bad secret or a bad URL, and the source has no `dotenv.config()`.
- **Sentry scrub:** removes the new headers, the query values and the bot token in URLs.
- **Source scan:** no `process.env.<SECRET> || process.env.<SECRET>` remains.

**Existing smokes to update:**
- `smoke-google-connect.ts`:
  - flip the plaintext-cache assertions at `:780-781`;
  - move the cache key literals to v2 (`:833,886,1214`);
  - rewrite #17 (`:1008-1020`, unsigned webhook: 500, nothing processed, one capture);
  - sign the post in #22 (`:1199-1203`).
- `smoke-calendar-connection.ts:588-590`.
- `smoke-account-merge.ts` cache key literals (`:623,957,1025,1191,1251,1821,1835`).
- `smoke-auth-leftovers.ts` #5 text (`:198-205`).
- `smoke-summary-retry.ts:337`: the encryption stub also exports `readStoredToken`.
- `smoke-native-reminder-create-flow.ts`: the raw pending value doesn't contain the token, while the getter returns it (event, edit, delete, batch, WhatsApp). The hand-seeded plaintext entry at `:926` stays as the legacy case.
- `smoke-native-reminder-edit.ts` and `smoke-hebrew-repeats-bot.ts`, which touch `voice:pending:*`.

**Gate before push:**
- `npx tsc --noEmit`, lint, every `scripts/smoke-*.ts`, `npx next build`. Never `npm run build`: it runs `prisma migrate deploy` against prod.
- A fresh-clone build on Node 22.

## Review focus

1. **A user with no Google token** (`''` or an empty cipher) goes through every path: summary, reminders, select-calendars, the sweep and the cache. Nothing is written to their row, and no capture fires.
2. **The scheduler bundle and the routes bundle** each hold their own module state. The once-per-process sets and flags live on `globalThis`, and env is read per call, so both bundles see the same keys.
3. **A token refreshed by Google during the sweep:** the CAS write loses, and the fresh token survives.
4. **`ENCRYPTION_KEY_PREVIOUS` set to the current key** (a pasting mistake): a warning, no SAFE, no conversions, and nothing breaks.
5. **A pending voice entry written before Deploy 1** (plaintext) is still confirmed after it.

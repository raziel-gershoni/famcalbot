# Secret Rotation Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every FamCal secret can be replaced in one window without breaking summaries, Google, WhatsApp or the Mini App, with no plaintext Google tokens in Redis and no secret standing in for another.

**Architecture:**
- `encryption.ts` learns a decrypt-only `ENCRYPTION_KEY_PREVIOUS` and a never-throwing `readStoredToken`.
- A 10-minute key sweep re-encrypts stored tokens with compare-and-set writes and announces SAFE.
- Redis copies of tokens are sealed (ciphertext).
- Image links and session cookies use HKDF keys derived from `SESSION_SECRET`.
- Missing secrets fail closed with startup reports.
- Shared helpers cover the remaining secret compares, Sentry scrubbing and the webhook setup script.

**Tech Stack:** Next.js 16, TypeScript, Node 22 `crypto` (AES-256-GCM, HKDF, timingSafeEqual), Prisma (Neon), Upstash Redis, node-cron, Sentry, tsx smoke scripts.

**Spec:** `docs/superpowers/specs/2026-10-22-secret-rotation-design.md`

## Global Constraints

- Branch `feat/secret-rotation`, base b765741. One commit per task (or per fix round). Every commit message ends with these two lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31`
- No new npm dependencies. Node's built-in `crypto` covers AES-GCM, `hkdfSync`, `timingSafeEqual` and sha256.
- **Running smokes:** `bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/<name>.ts`, run from the repo root.
  - It sets fake values for every `.env` name, plus `ENCRYPTION_KEY_PREVIOUS=''`.
  - A smoke ends with a line `N/M passed` and exits non-zero on any failure.
  - Smokes never reach live services (fake Prisma, Redis, Telegram, Google and Sentry capture), following the existing smoke patterns.
  - A test that needs specific env values sets `process.env` inside the script, and always sets `ENCRYPTION_KEY_PREVIOUS` explicitly (`''` when unset is meant).
- **Typecheck and lint:** `npx tsc --noEmit -p .` and `npm run -s lint`. **Never run `npm run build`:** it runs `prisma migrate deploy` against prod.
- **TDD:** every new check is run and seen FAILING on the pre-task code before the implementation step.
- **Expected counts are predictions.** Before each task's red step, run the listed smokes on the pre-task code and record the real `N/M`. A mismatch with the plan's expected count, or a check failing for a reason other than the one stated, is a stop: report it, and don't adjust the smoke to fit.
- **Never log or capture a secret value or a token**: ids, counts and fingerprints only.
- **No empty catches.** Every caught error is logged and sent with `captureError(err, '<context>', extra?)` from `src/lib/error-capture.ts`. The one exception is a catch that is the expected control flow and says so in a comment (trying a key that GCM refuses in `encryption.ts` `openWith`; classifying a stored value or a cached token in `key-rotation.ts`, `classify` and `reminderCacheIsCurrent`). It returns a sentinel and the caller reports the failure (`UndecryptableError`, the unreadable count). Don't add logs there: they would fire once per wrong key per row.
- **Once-per-process state lives on `globalThis`.** Next 16 gives the scheduler bundle and the route bundles separate module instances.
- **Secret code reads `process.env` on each call**, never in a module-level constant. Parsed values may be cached per raw string.
- **Admin Telegram messages** follow the existing inline-English pattern of `src/utils/error-notifier.ts` (`notifyAdminWarning`, or `getAdminUserIds` + `getBot`). No new end-user strings; any that turn out to be needed go through the i18n messages (en/he/ru).
- **Out of scope (spec Non-goals), do not touch:**
  - `/api/health`, `app/api/set-menu-button`;
  - the Gemini model and thinking level;
  - `RAILWAY_GIT_COMMIT_SHA` in the deploy message;
  - the legacy `src/index.ts` and the unused AI clients;
  - the dead names in `.env.example`;
  - `subscription/usage` stays (it only gets `matchesSecret`);
  - no `iv:tag:` data migration.
- Match the surrounding code's comment density and naming. Don't refactor beyond what a task names.

## Owner sign-off (approved by the owner on 2026-10-23)

The owner approved all three as written: the sweep goes idle, the legacy reconnect wording stays, and the empty-cipher readers are left for now.

1. **The key sweep goes idle** (Task 5 Deviation 1). The spec walks the DB every 10 minutes forever and logs every tick. The plan stops reading the DB in a process once SAFE is logged, or once nothing is left to write, so Neon can still scale to zero (a query every 10 minutes keeps it awake about half the time, roughly 90 of the free 100 CU-hours a month). After that there are no more tick lines until the next deploy.
2. **A legacy `calendarSource: 'GOOGLE'` user with an unreadable token reads as "reconnect"** (Task 2 Deviation 5). Only in the "PREVIOUS forgotten or wrong" failure mode; FamCal users read as "not connected" and their summaries go out FamCal-only. `google-state.ts` is out of scope.
3. **Known leftover, not changed:** raw-column readers still treat an empty cipher (`iv:tag:`) as "has a token": setup nudges (`setup-tracks.ts:57-65`), `countCalendars` (`subscription-service.ts:882`), `ensurePrimaryNativeCalendar` (`native-calendar/onboarding.ts:29`), `handleSetupReminders` (`cron/handlers.ts:430`) and admin stats (`app/api/admin/stats/route.ts:33`). The spec rules out an `iv:tag:` data migration.

## Review Focus

1. **A user with no Google token** (`''` or an empty cipher `^[0-9a-f]{32}:[0-9a-f]{32}:$`) flows through summary, reminders, select-calendars, the sweep and the cache. Their row is never written and no capture fires. Pinned in Tasks 2, 3 and 5.
2. **The scheduler and route bundles** have separate module state. The once-per-process sets live on `globalThis`, and keys are read from env per call. Pinned in Task 1, which imports the module twice and checks a single report.
3. **A token Google refreshes mid-sweep:** the compare-and-set write loses, and the fresh token survives. Pinned in Task 5.
4. **`ENCRYPTION_KEY_PREVIOUS` equal to the current key:** one warning, no conversions, no SAFE, nothing breaks. Pinned in Tasks 1 and 5.
5. **A plaintext voice pending entry written before Deploy 1** still confirms after it. Pinned in Task 4.

---


### Task 1: Encryption core: a decrypt-only previous key, never-throwing token reads, sealed secrets

**Deviation:** (1) `UndecryptableError` takes an optional message. A value not in the `iv:tag:data` format (wrong part count, tag not 16 bytes) now throws `UndecryptableError('Invalid encrypted text format')` instead of a plain `Error` with that message, so every decrypt failure has one type and the existing malformed-format checks keep their exact message. `openSecret` of a non-empty value that is not `isEncrypted` throws `UndecryptableError('Not an encrypted value')` (strict, per the contract). A missing or malformed `ENCRYPTION_KEY` still throws the plain `Error`s it throws today. (2) The once-per-process reports for an invalid or equal `ENCRYPTION_KEY_PREVIOUS` fire from `previousKeyStatus()`, which decryption and `describeKeys()` both call, so the startup line (Task 7) reports a bad PREVIOUS at boot rather than at the first failed decrypt. (3) The Google sync worker guard (spec "Testing", listed under `smoke-key-rotation.ts`) lives in `scripts/smoke-google-sync-worker.ts`, whose harness runs the worker, and in this task: the worker is deliberately unchanged, so the check fails on b765741 (Node's crypto error reaches Sentry) and passes once this task makes the error an `UndecryptableError`.

**Files:**
- Modify: `src/utils/encryption.ts` (whole file, lines 1-88)
- Modify (test): `scripts/smoke-encryption.ts` (whole file, lines 1-108)
- Modify (test): `scripts/smoke-google-sync-worker.ts` (lines 39-40 imports, line 53 env, after line 1322 a new check)

**Interfaces:**
- Consumes: `captureError(error: unknown, context: string, extra?: ErrorContext, severity?)` from `src/lib/error-capture.ts`.
- Produces (all in `src/utils/encryption.ts`):
  - `export class UndecryptableError extends Error` (`name === 'UndecryptableError'`, no `code`, no `cause`; `constructor(message?: string)`)
  - `export function encrypt(text: string): string` (always `ENCRYPTION_KEY`)
  - `export function decrypt(text: string): string` (`= decryptDetailed(text).value`)
  - `export function decryptDetailed(text: string): { value: string; key: 'current' | 'previous' }`
  - `export function isEncrypted(text: string): boolean` (unchanged)
  - `export function safeDecrypt(text: string): string` (unchanged signature)
  - `export function isEmptyCipher(raw: string): boolean` (`/^[0-9a-f]{32}:[0-9a-f]{32}:$/i`)
  - `export function normalizeStored(raw: string): string`
  - `export function readStoredToken(stored: string, ctx: { userId: number; column: string }): string` (never throws; captures `'token-undecryptable'` with `{ user_id, column }` once per `userId:column` per process)
  - `export type PreviousKeyStatus = 'unset' | 'valid' | 'invalid' | 'same'`
  - `export function previousKeyStatus(): PreviousKeyStatus` (invalid: `console.error` + `captureError(..., 'encryption-previous-invalid')` once per process; same: `console.warn` once per process)
  - `export function keyFingerprint(which: 'current' | 'previous'): string | null`
  - `export function describeKeys(): string`
  - `export function sealSecret(v: string): string`
  - `export function openSecret(v: string): string`
  - Once-per-process state: `globalThis.__famcalEncryptionReports = { previousInvalid: boolean; previousSame: boolean; undecryptable: Set<string> }`. A smoke that counts these reports resets them with `delete (globalThis as any).__famcalEncryptionReports`.

- [ ] **Step 1: Write the failing tests: replace `scripts/smoke-encryption.ts`**

Replace the whole file with:

```ts
// Smoke test for src/utils/encryption.ts. decrypt() accepted any GCM tag length Node
// allowed, and Node 22 (engines.node) still takes tags down to 4 bytes (DEP0182), so a
// forged token only had to match 32 bits. It now insists on the 16 bytes encrypt()
// writes; tokens already stored must keep decrypting. No network.
//
// Key rotation (secret rotation spec §a, #8-#16): ENCRYPTION_KEY_PREVIOUS decrypts only;
// both keys are read from env on every call; a value neither key opens throws
// UndecryptableError (no code); readStoredToken never throws and reports a bad value once
// per user and column per process, also across two copies of the module (the scheduler
// and the routes load their own); an invalid PREVIOUS, or one equal to the key, is
// ignored and reported once. Error capture is faked.
//
// Run: npx tsx scripts/smoke-encryption.ts

import crypto from 'crypto';
import path from 'path';
import { createRequire } from 'module';

// The stored sample below was written with this key. Every check sets the keys it needs.
const K0 = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
process.env.ENCRYPTION_KEY = K0;
// Empty, not deleted: @prisma/client loads a .env file into every variable that is unset
process.env.ENCRYPTION_KEY_PREVIOUS = '';

type Encryption = typeof import('../src/utils/encryption');

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** The message decrypt() threw, or a failure when it returned instead. */
function rejection(fn: () => string): string {
  try {
    return `returned "${fn()}"`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** What fn threw (null when it returned). */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

// What encrypt() wrote before the tag length was enforced, with the key above.
const STORED = 'e8020bf86da8073ffc540848f664ecfc:66fab8a94d7179dc738f10b52a27047d:f7e601aece3c96078dc5d12d8c6ce8fc50b7d84529d882e77caab2448f59fc0c30';
const STORED_PLAIN = '1//0gTestRefreshToken-abc_XYZ.123';
const MALFORMED = 'Invalid encrypted text format';

// Rotation keys: A is the old one, B the new one, C one this server never had.
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

/** AES-256-GCM in our iv:tag:data format, with Node's crypto directly (not the module under test). */
function encryptWith(keyHex: string, text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const data = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data}`;
}
function decryptWith(keyHex: string, value: string): string | null {
  const [iv, tag, data] = value.split(':');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(iv, 'hex'), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(tag, 'hex'));
    return d.update(data, 'hex', 'utf8') + d.final('utf8');
  } catch {
    return null; // the wrong key: what the check asserts
  }
}

// ---- Fakes: error capture, and the console lines the module writes ----

const nodeRequire = createRequire(__filename);
const ROOT = path.resolve(__dirname, '..');
const captured: { ctx: string; extra?: Record<string, unknown>; name: string; message: string }[] = [];
{
  const Module = nodeRequire('module');
  const filename = path.join(ROOT, 'src/lib/error-capture.ts');
  const mod = new Module(filename);
  const capture = (e: unknown, ctx: string, extra?: Record<string, unknown>) => {
    captured.push({ ctx, extra, name: e instanceof Error ? e.name : typeof e, message: e instanceof Error ? e.message : String(e) });
  };
  Object.assign(mod, { filename, loaded: true, exports: { captureError: capture, captureWarning: capture, captureInfo: () => undefined } });
  Module._cache[filename] = mod;
}
const consoleLines: { level: 'error' | 'warn'; text: string }[] = [];
const realConsole = { error: console.error, warn: console.warn };
console.error = (...a: unknown[]) => { consoleLines.push({ level: 'error', text: a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') }); };
console.warn = (...a: unknown[]) => { consoleLines.push({ level: 'warn', text: a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') }); };

const ENCRYPTION_PATH = path.join(ROOT, 'src/utils/encryption.ts');
/** A fresh copy of the module, as a second Next bundle loads its own. */
function freshCopy(): Encryption {
  delete nodeRequire.cache[ENCRYPTION_PATH];
  return nodeRequire(ENCRYPTION_PATH) as Encryption;
}

/** Runs fn with these keys in env, then puts back K0 and an empty PREVIOUS. */
function withKeys<T>(key: string, previous: string, fn: () => T): T {
  process.env.ENCRYPTION_KEY = key;
  process.env.ENCRYPTION_KEY_PREVIOUS = previous;
  try {
    return fn();
  } finally {
    process.env.ENCRYPTION_KEY = K0;
    process.env.ENCRYPTION_KEY_PREVIOUS = '';
  }
}

/** Forget the once-per-process reports and what was recorded, for a check that counts them. */
function resetReports() {
  delete (globalThis as { __famcalEncryptionReports?: unknown }).__famcalEncryptionReports;
  captured.length = 0;
  consoleLines.length = 0;
}

async function main() {
  const enc = nodeRequire(ENCRYPTION_PATH) as Encryption;
  const { encrypt, decrypt, isEncrypted, safeDecrypt } = enc;

  check('roundtrip', () => {
    for (const text of [STORED_PLAIN, 'ya29.a0Af_access-token', 'שלום עולם 🎉', '']) {
      const out = decrypt(encrypt(text));
      assert(out === text, `"${text}" came back as "${out}"`);
    }
  });

  check('encrypt writes iv:tag:data with a 16-byte iv and tag', () => {
    const [iv, tag, data] = encrypt(STORED_PLAIN).split(':');
    assert(iv.length === 32 && tag.length === 32, `iv ${iv.length / 2} bytes, tag ${tag.length / 2} bytes`);
    assert(data.length > 0, 'no ciphertext');
  });

  check('a token stored by the old encrypt() still decrypts', () => {
    const out = decrypt(STORED);
    assert(out === STORED_PLAIN, `got "${out}"`);
    assert(isEncrypted(STORED) && safeDecrypt(STORED) === STORED_PLAIN, 'safeDecrypt disagrees');
  });

  // A prefix of the real tag is what a forger would send: Node 22 verifies only those bytes.
  check('a truncated tag is rejected as malformed', () => {
    const [iv, tag, data] = STORED.split(':');
    for (const bytes of [4, 8, 12, 15]) {
      const got = rejection(() => decrypt(`${iv}:${tag.slice(0, bytes * 2)}:${data}`));
      assert(got === MALFORMED, `${bytes}-byte tag: ${got}`);
    }
  });

  check('an empty or oversized tag is rejected as malformed', () => {
    const [iv, tag, data] = STORED.split(':');
    for (const bad of ['', `${tag}00`]) {
      const got = rejection(() => decrypt(`${iv}:${bad}:${data}`));
      assert(got === MALFORMED, `${bad.length / 2}-byte tag: ${got}`);
    }
  });

  check('tampered data is rejected', () => {
    const [iv, tag, data] = STORED.split(':');
    const flip = (hex: string) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);
    for (const bad of [`${iv}:${tag}:${flip(data)}`, `${iv}:${flip(tag)}:${data}`, `${flip(iv)}:${tag}:${data}`]) {
      const got = rejection(() => decrypt(bad));
      assert(!got.startsWith('returned'), `tampered input decrypted: ${got}`);
    }
  });

  check('a wrong part count is still malformed', () => {
    const got = rejection(() => decrypt('abc:def'));
    assert(got === MALFORMED, got);
  });

  // ---- Key rotation ----

  check('#8 a value encrypted under A decrypts with KEY=B, PREVIOUS=A, and decryptDetailed says previous; under B it says current', () => {
    const underA = encryptWith(A, STORED_PLAIN);
    const underB = encryptWith(B, 'new-token');
    withKeys(B, A, () => {
      assert(decrypt(underA) === STORED_PLAIN, 'decrypt under A');
      const a = enc.decryptDetailed(underA);
      assert(a.value === STORED_PLAIN && a.key === 'previous', JSON.stringify(a));
      const b = enc.decryptDetailed(underB);
      assert(b.value === 'new-token' && b.key === 'current', JSON.stringify(b));
    });
  });

  check('#9 encrypt with KEY=B, PREVIOUS=A writes with B: it opens with B and never with A; env is read on each call', () => {
    const written = withKeys(B, A, () => encrypt('fresh-token'));
    assert(decryptWith(B, written) === 'fresh-token', 'not written with B');
    assert(decryptWith(A, written) === null, 'it opens with A');
    const later = withKeys(A, '', () => encrypt('fresh-token'));
    assert(decryptWith(A, later) === 'fresh-token' && decryptWith(B, later) === null, 'a changed ENCRYPTION_KEY was not seen');
  });

  check('#10 neither key: UndecryptableError, with no code and nothing wrapped; a malformed value is one too', () => {
    const underC = encryptWith(C, STORED_PLAIN);
    const err = withKeys(B, A, () => thrown(() => decrypt(underC))) as Record<string, unknown> | null;
    assert(err instanceof enc.UndecryptableError, `threw ${String(err)}`);
    assert(err instanceof Error && err.name === 'UndecryptableError', `name ${String(err?.name)}`);
    assert(!('code' in err) && err.cause === undefined, `code ${String(err.code)} cause ${String(err.cause)}`);
    const malformed = thrown(() => decrypt('abc:def'));
    assert(malformed instanceof enc.UndecryptableError && (malformed as Error).message === MALFORMED, `malformed threw ${String(malformed)}`);
  });

  check('#11 an invalid PREVIOUS is ignored: the current key still works, a value under the old key is undecryptable, one error line and one capture over two module copies', () => {
    resetReports();
    const copy = freshCopy();
    assert(copy !== enc && copy.decrypt !== enc.decrypt, 'not a second copy of the module');
    const underA = encryptWith(A, 'old');
    withKeys(B, 'not-a-key', () => {
      assert(enc.previousKeyStatus() === 'invalid' && copy.previousKeyStatus() === 'invalid', 'status');
      for (const m of [enc, copy, enc, copy]) {
        assert(m.decrypt(m.encrypt('x')) === 'x', 'the current key stopped working');
        assert(thrown(() => m.decrypt(underA)) instanceof Error, 'a value under the old key decrypted');
      }
    });
    const caps = captured.filter(c => c.ctx === 'encryption-previous-invalid');
    assert(caps.length === 1, `captures ${JSON.stringify(captured)}`);
    const lines = consoleLines.filter(l => l.level === 'error' && l.text.includes('ENCRYPTION_KEY_PREVIOUS'));
    assert(lines.length === 1 && !lines[0].text.includes('not-a-key'), `lines ${JSON.stringify(consoleLines)}`);
  });

  check('#12 PREVIOUS equal to KEY (also in upper case) is "same": one warning, no capture, the key works, another key\'s value is still undecryptable', () => {
    resetReports();
    const copy = freshCopy();
    const underC = encryptWith(C, 'other');
    for (const previous of [B, B.toUpperCase()]) {
      withKeys(B, previous, () => {
        assert(enc.previousKeyStatus() === 'same' && copy.previousKeyStatus() === 'same', `status for ${previous === B ? 'same case' : 'upper case'}`);
        const r = enc.decryptDetailed(enc.encrypt('x'));
        assert(r.value === 'x' && r.key === 'current', JSON.stringify(r));
        assert(thrown(() => copy.decrypt(underC)) instanceof copy.UndecryptableError, 'another key decrypted');
        assert(enc.describeKeys().endsWith('ENCRYPTION_KEY_PREVIOUS same as ENCRYPTION_KEY (ignored)'), enc.describeKeys());
      });
    }
    const warnings = consoleLines.filter(l => l.level === 'warn' && l.text.includes('ENCRYPTION_KEY_PREVIOUS'));
    assert(warnings.length === 1, `warnings ${JSON.stringify(consoleLines)}`);
    assert(captured.length === 0, `captures ${JSON.stringify(captured)}`);
  });

  check('#13 readStoredToken: a wrong-key value is "" with one error line and one capture (ids only) over two calls and two module copies; never throws', () => {
    resetReports();
    const copy = freshCopy();
    const underC = encryptWith(C, 'secret-token-value');
    const ctx = { userId: 7, column: 'googleRefreshToken' };
    withKeys(B, A, () => {
      assert(enc.readStoredToken(underC, ctx) === '', 'first call');
      assert(enc.readStoredToken(underC, ctx) === '', 'second call');
      assert(copy.readStoredToken(underC, ctx) === '', 'the other copy');
      // A malformed tag never throws either; it is a second column, so it is reported once too.
      const [iv, tag, data] = underC.split(':');
      assert(enc.readStoredToken(`${iv}:${tag.slice(0, 8)}:${data}`, { userId: 7, column: 'unlinkToken' }) === '', 'malformed');
    });
    const caps = captured.filter(c => c.ctx === 'token-undecryptable');
    assert(caps.length === 2, `captures ${JSON.stringify(captured)}`);
    assert(caps[0].extra?.user_id === 7 && caps[0].extra?.column === 'googleRefreshToken' && caps[0].name === 'UndecryptableError', JSON.stringify(caps[0]));
    assert(caps[1].extra?.column === 'unlinkToken', JSON.stringify(caps[1]));
    const lines = consoleLines.filter(l => l.text.includes('[token] undecryptable'));
    assert(lines.length === 2, `lines ${JSON.stringify(consoleLines)}`);
    const everything = JSON.stringify({ captured, consoleLines });
    assert(!everything.includes('secret-token-value') && !everything.includes(underC), 'a value was logged');
  });

  check('#14 readStoredToken: "" and an empty cipher are "" with no capture; plaintext comes back as it is; current and previous values decrypt', () => {
    resetReports();
    const emptyCipher = encryptWith(A, '');
    assert(/^[0-9a-f]{32}:[0-9a-f]{32}:$/.test(emptyCipher), `empty cipher shape ${emptyCipher}`);
    withKeys(B, A, () => {
      const ctx = { userId: 9, column: 'googleRefreshToken' };
      assert(enc.readStoredToken('', ctx) === '', 'empty');
      assert(enc.readStoredToken(emptyCipher, ctx) === '', 'empty cipher');
      assert(enc.readStoredToken(emptyCipher.toUpperCase(), ctx) === '', 'empty cipher in upper case');
      assert(enc.readStoredToken('1//0gLegacyPlain', ctx) === '1//0gLegacyPlain', 'plaintext');
      assert(enc.readStoredToken(encryptWith(B, 'now'), ctx) === 'now', 'current');
      assert(enc.readStoredToken(encryptWith(A, 'before'), ctx) === 'before', 'previous');
    });
    assert(captured.length === 0, `captures ${JSON.stringify(captured)}`);
  });

  check('#15 normalizeStored and isEmptyCipher; sealSecret and openSecret', () => {
    const emptyCipher = encryptWith(K0, '');
    assert(enc.isEmptyCipher(emptyCipher) && enc.isEmptyCipher(emptyCipher.toUpperCase()), 'empty cipher');
    assert(!enc.isEmptyCipher('') && !enc.isEmptyCipher(STORED) && !enc.isEmptyCipher('plain'), 'not empty ciphers');
    assert(enc.normalizeStored(emptyCipher) === '' && enc.normalizeStored(STORED) === STORED && enc.normalizeStored('plain') === 'plain' && enc.normalizeStored('') === '', 'normalizeStored');

    assert(enc.sealSecret('') === '', 'seal of empty');
    assert(enc.sealSecret(STORED) === STORED, 'a sealed value passes through');
    const sealed = enc.sealSecret('plain-token');
    assert(sealed !== 'plain-token' && isEncrypted(sealed) && decryptWith(K0, sealed) === 'plain-token', 'seal encrypts with the current key');
    assert(enc.openSecret('') === '' && enc.openSecret(sealed) === 'plain-token', 'open');
    const underA = encryptWith(A, 'old-sealed');
    assert(withKeys(K0, A, () => enc.openSecret(underA)) === 'old-sealed', 'open with PREVIOUS');
    assert(thrown(() => enc.openSecret(underA)) instanceof enc.UndecryptableError, 'open without the key');
    assert(thrown(() => enc.openSecret('plain-token')) instanceof enc.UndecryptableError, 'open of plaintext is strict');
  });

  check('#16 keyFingerprint is 8 hex characters, stable, null when unset or invalid; describeKeys names both keys by fingerprint only', () => {
    resetReports();
    const fpB = withKeys(B, A, () => enc.keyFingerprint('current'));
    const fpA = withKeys(B, A, () => enc.keyFingerprint('previous'));
    const want = (hex: string) => crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex').slice(0, 8);
    assert(fpB === want(B) && fpA === want(A) && /^[0-9a-f]{8}$/.test(fpB ?? ''), `fp ${fpB} ${fpA}`);
    assert(withKeys(B, '', () => enc.keyFingerprint('current')) === fpB, 'not stable');
    assert(withKeys(B, '', () => enc.keyFingerprint('previous')) === null, 'unset previous');
    assert(withKeys('nope', 'zz', () => enc.keyFingerprint('current') === null && enc.keyFingerprint('previous') === null), 'invalid keys');
    assert(withKeys(B, '', () => enc.describeKeys()) === `[startup] ENCRYPTION_KEY fp ${fpB}; ENCRYPTION_KEY_PREVIOUS unset`, withKeys(B, '', () => enc.describeKeys()));
    assert(withKeys(B, A, () => enc.describeKeys()) === `[startup] ENCRYPTION_KEY fp ${fpB}; ENCRYPTION_KEY_PREVIOUS fp ${fpA}`, withKeys(B, A, () => enc.describeKeys()));
    assert(withKeys(B, 'zz', () => enc.describeKeys()) === `[startup] ENCRYPTION_KEY fp ${fpB}; ENCRYPTION_KEY_PREVIOUS invalid (ignored)`, 'invalid previous');
    assert(withKeys('', A, () => enc.describeKeys()) === `[startup] ENCRYPTION_KEY missing or invalid; ENCRYPTION_KEY_PREVIOUS fp ${fpA}`, 'missing key');
    const lines = JSON.stringify(consoleLines) + withKeys(B, A, () => enc.describeKeys());
    assert(!lines.includes(A) && !lines.includes(B), 'a key was printed');
  });

  check('#17 a key with a trailing newline or space from a paste still works, as Buffer.from(hex) allowed before; so does such a PREVIOUS', () => {
    for (const pad of ['\n', ' ', '\r\n']) {
      assert(withKeys(B + pad, '', () => decrypt(encryptWith(B, 'x'))) === 'x', `KEY with ${JSON.stringify(pad)}`);
      assert(withKeys(B, A + pad, () => decrypt(encryptWith(A, 'y'))) === 'y', `PREVIOUS with ${JSON.stringify(pad)}`);
      assert(withKeys(B + pad, A + pad, () => enc.keyFingerprint('current') !== null && enc.keyFingerprint('previous') !== null), `fingerprints with ${JSON.stringify(pad)}`);
    }
  });

  // Print results
  Object.assign(console, realConsole);
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { Object.assign(console, realConsole); console.error(err); process.exit(1); });
```

- [ ] **Step 2: Add the sync worker guard to `scripts/smoke-google-sync-worker.ts`**

In `scripts/smoke-google-sync-worker.ts` (lines 39-40), replace:

```ts
import path from 'path';
import { createRequire } from 'module';
```

with:

```ts
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
```

In `scripts/smoke-google-sync-worker.ts` (line 53), replace:

```ts
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
```

with:

```ts
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
// Empty, not deleted: @prisma/client loads a .env file into every variable that is unset
process.env.ENCRYPTION_KEY_PREVIOUS = '';
```

In `scripts/smoke-google-sync-worker.ts` (the end of the check `'token: a token Google refuses (invalid_grant) mid-run is the same outage'`, around line 1315-1322), replace:

```ts
    google.accounts.clear();
    await pass();
    assert(link('L').state === 'token' && sent.length === 1, `link ${show(link('L'))} sent ${show(sent)}`);
  });
```

with:

```ts
    google.accounts.clear();
    await pass();
    assert(link('L').state === 'token' && sent.length === 1, `link ${show(link('L'))} sent ${show(sent)}`);
  });

  await check('token: a stored token neither ENCRYPTION_KEY nor ENCRYPTION_KEY_PREVIOUS opens is not an outage: the copies stay as they are, no reconnect message, no Google call; Sentry gets google-sync-user with UndecryptableError\'s message, never the value (secret rotation §a)', async () => {
    seedCopy();
    seriesRow('a', 'home');
    itemRow('L', 'a');
    // iv:tag:data under a key this server never had: GCM refuses it under both keys.
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from('c'.repeat(64), 'hex'), iv);
    const data = cipher.update('tok-1', 'utf8', 'hex') + cipher.final('hex');
    const stored = `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data}`;
    DB.user[0].googleRefreshToken = stored;
    await pass();
    assert(link('L').state === 'ok' && google.calls.length === 0, `link ${show(link('L'))} calls ${show(google.calls)}`);
    assert(sent.length === 0, `sent ${show(sent)}`);
    assert(!captured.some((c) => c.ctx === 'google-sync-outage'), `captured ${show(captured)}`);
    const failures = captured.filter((c) => c.ctx === 'google-sync-user');
    assert(failures.length === 1 && failures[0].extra?.user_id === TAL && failures[0].message === 'The value does not decrypt with ENCRYPTION_KEY or ENCRYPTION_KEY_PREVIOUS', `captured ${show(captured)}`);
    assert(!show(captured).includes(stored), 'the stored value was captured');
  });
```

This is a guard on purpose: `tokenOf` in `src/services/google-sync/worker.ts:170` keeps throwing (spec §a call site 6). Returning `''` would send a false "reconnect Google" message through `outage('token')`. Do not change the worker.

- [ ] **Step 3: Run the tests to verify they fail**

Run (from the repo root):
```bash
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-encryption.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-google-sync-worker.ts
```
Expected on the pre-task code:
- `smoke-encryption.ts`: `7/17 passed`, exit 1. The seven existing checks pass. These fail:
  - `#8`: the module read `ENCRYPTION_KEY` once at load and has no PREVIOUS, so decrypting an A value under `KEY=B, PREVIOUS=A` throws `Unsupported state or unable to authenticate data`;
  - `#9`: `encrypt` still uses the key read at load (K0), so the value does not open with B (`not written with B`);
  - `#10`: `UndecryptableError` is not exported (`Right-hand side of 'instanceof' is not an object`);
  - `#11`, `#12`: `enc.previousKeyStatus is not a function`;
  - `#13`, `#14`: `enc.readStoredToken is not a function`;
  - `#15`: `enc.isEmptyCipher is not a function`;
  - `#16`: `enc.keyFingerprint is not a function`;
  - `#17`: the key read at load (K0) does not open a B value (`Unsupported state or unable to authenticate data`). It would also fail on a strict `^[0-9a-f]{64}$` check without the trim (`ENCRYPTION_KEY must be 32 bytes`).
- `smoke-google-sync-worker.ts`: `89/90 passed`, exit 1. The new `token: a stored token neither ENCRYPTION_KEY nor ...` check fails: the `google-sync-user` capture's message is Node's `Unsupported state or unable to authenticate data`, not UndecryptableError's.

- [ ] **Step 4: Implement: replace `src/utils/encryption.ts`**

Replace the whole file with:

```ts
/**
 * Encryption utility for sensitive data (OAuth tokens)
 * Uses AES-256-GCM encryption
 *
 * Key rotation (secret rotation spec §a): ENCRYPTION_KEY encrypts and decrypts;
 * ENCRYPTION_KEY_PREVIOUS, when set, only decrypts, so values written under the old key
 * stay readable until the key sweep re-encrypts them. Both are read from env on every
 * call. The scheduler and the routes load separate copies of this module (Next 16), so
 * the once-per-process reports live on globalThis.
 */

import crypto from 'crypto';
import { captureError } from '../lib/error-capture';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_HEX = /^[0-9a-f]{64}$/i;
/** What encrypt('') writes: iv and tag, no data. select-calendars wrote it for users with no token. */
const EMPTY_CIPHER = /^[0-9a-f]{32}:[0-9a-f]{32}:$/i;

/**
 * A stored value that neither key opens, or that is not in our iv:tag:data format. It has
 * no `code` and wraps nothing: classifyGoogleError counts an error with a string code and
 * no response as transient, which would keep it out of Sentry.
 */
export class UndecryptableError extends Error {
  constructor(message = 'The value does not decrypt with ENCRYPTION_KEY or ENCRYPTION_KEY_PREVIOUS') {
    super(message);
    this.name = 'UndecryptableError';
  }
}

/** Once per process, shared by every copy of this module. */
type Reports = { previousInvalid: boolean; previousSame: boolean; undecryptable: Set<string> };
function reports(): Reports {
  const g = globalThis as typeof globalThis & { __famcalEncryptionReports?: Reports };
  g.__famcalEncryptionReports ??= { previousInvalid: false, previousSame: false, undecryptable: new Set() };
  return g.__famcalEncryptionReports;
}

/** Parsed keys by their raw env value: a changed env is seen on the next call. */
const parsedKeys = new Map<string, Buffer>();
function parseKey(raw: string): Buffer | null {
  if (!KEY_HEX.test(raw)) return null;
  let key = parsedKeys.get(raw);
  if (!key) {
    key = Buffer.from(raw, 'hex');
    parsedKeys.set(raw, key);
  }
  return key;
}

/**
 * A key as set in env, trimmed. Buffer.from(hex) used to stop at a trailing newline or
 * space from a paste, so a value like that worked before and must keep working.
 */
function envKey(name: 'ENCRYPTION_KEY' | 'ENCRYPTION_KEY_PREVIOUS'): string {
  return (process.env[name] ?? '').trim();
}

// The current key: encrypts, and decrypts first. Missing or malformed throws, as before.
function getKeyBuffer(): Buffer {
  const raw = envKey('ENCRYPTION_KEY');
  if (!raw) {
    console.error('ENCRYPTION_KEY environment variable is not set');
    throw new Error('ENCRYPTION_KEY environment variable is required');
  }
  const key = parseKey(raw);
  if (!key) {
    console.error(`ENCRYPTION_KEY has wrong length or format: ${raw.length} characters (expected 64 hex)`);
    throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
  }
  return key;
}

export type PreviousKeyStatus = 'unset' | 'valid' | 'invalid' | 'same';

/**
 * ENCRYPTION_KEY_PREVIOUS as decryption sees it. An invalid value (logged and captured)
 * or one equal to ENCRYPTION_KEY (a warning) is ignored, each reported once per process.
 */
export function previousKeyStatus(): PreviousKeyStatus {
  const raw = envKey('ENCRYPTION_KEY_PREVIOUS');
  if (raw === '') return 'unset';
  const previous = parseKey(raw);
  if (!previous) {
    const r = reports();
    if (!r.previousInvalid) {
      r.previousInvalid = true;
      console.error(`[encryption] ENCRYPTION_KEY_PREVIOUS is not 64 hex characters (${raw.length} characters); ignored`);
      captureError(new Error('ENCRYPTION_KEY_PREVIOUS is not 64 hex characters; ignored'), 'encryption-previous-invalid');
    }
    return 'invalid';
  }
  const current = parseKey(envKey('ENCRYPTION_KEY'));
  if (current && current.equals(previous)) {
    const r = reports();
    if (!r.previousSame) {
      r.previousSame = true;
      console.warn('[encryption] ENCRYPTION_KEY_PREVIOUS is the same key as ENCRYPTION_KEY; ignored (nothing is rotated)');
    }
    return 'same';
  }
  return 'valid';
}

function previousKey(): Buffer | null {
  return previousKeyStatus() === 'valid' ? parseKey(envKey('ENCRYPTION_KEY_PREVIOUS')) : null;
}

/**
 * Encrypt a string, always with ENCRYPTION_KEY
 */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKeyBuffer(), iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:encryptedData
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/** The plaintext under `key`, or null when GCM's tag check refuses the key (or the data). */
function openWith(key: Buffer, iv: Buffer, authTag: Buffer, encrypted: string): string | null {
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    // Expected while trying keys: a wrong key fails the tag check. The caller throws
    // UndecryptableError, which is logged, once neither key opens the value.
    return null;
  }
}

/**
 * Decrypt with ENCRYPTION_KEY, then ENCRYPTION_KEY_PREVIOUS, and say which one opened it.
 * Two keys are safe to try: AES-GCM's tag check refuses a wrong key.
 */
export function decryptDetailed(encryptedText: string): { value: string; key: 'current' | 'previous' } {
  const parts = encryptedText.split(':');

  if (parts.length !== 3) {
    throw new UndecryptableError('Invalid encrypted text format');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];

  // encrypt() always writes a 16-byte tag. Node 22 (engines.node) would otherwise verify
  // a truncated one down to 4 bytes (DEP0182), so a forgery only had to match 32 bits.
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new UndecryptableError('Invalid encrypted text format');
  }

  const current = openWith(getKeyBuffer(), iv, authTag, encrypted);
  if (current !== null) return { value: current, key: 'current' };
  const previous = previousKey();
  const old = previous ? openWith(previous, iv, authTag, encrypted) : null;
  if (old !== null) return { value: old, key: 'previous' };
  throw new UndecryptableError();
}

/**
 * Decrypt a string (ENCRYPTION_KEY, then ENCRYPTION_KEY_PREVIOUS)
 */
export function decrypt(encryptedText: string): string {
  return decryptDetailed(encryptedText).value;
}

/**
 * Check if a string is encrypted (has our format)
 */
export function isEncrypted(text: string): boolean {
  return /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(text);
}

/**
 * Safely decrypt (returns original if not encrypted)
 */
export function safeDecrypt(text: string): string {
  if (!text) return text;
  return isEncrypted(text) ? decrypt(text) : text;
}

/** An empty cipher (iv:tag: with no data) is what select-calendars wrote for "no token". */
export function isEmptyCipher(raw: string): boolean {
  return EMPTY_CIPHER.test(raw);
}

/** A stored token column as the app means it: an empty cipher is no token (''). */
export function normalizeStored(raw: string): string {
  return isEmptyCipher(raw) ? '' : raw;
}

/**
 * A stored Google token, decrypted. Never throws: no token or an empty cipher is '', legacy
 * plaintext comes back as it is, and a value neither key opens is '' (the user counts as
 * not connected), logged and captured once per user and column per process. Never logs
 * the value.
 */
export function readStoredToken(stored: string, ctx: { userId: number; column: string }): string {
  if (!stored) return '';
  const value = normalizeStored(stored);
  if (!value) return '';
  if (!isEncrypted(value)) return value;
  try {
    return decrypt(value);
  } catch (err) {
    const seen = reports().undecryptable;
    const key = `${ctx.userId}:${ctx.column}`;
    if (!seen.has(key)) {
      seen.add(key);
      console.error('[token] undecryptable', { userId: ctx.userId, column: ctx.column });
      captureError(err, 'token-undecryptable', { user_id: ctx.userId, column: ctx.column });
    }
    return '';
  }
}

/** The first 8 hex characters of sha256 over the key's 32 bytes; null when unset or invalid. For log lines only. */
export function keyFingerprint(which: 'current' | 'previous'): string | null {
  const key = parseKey(envKey(which === 'current' ? 'ENCRYPTION_KEY' : 'ENCRYPTION_KEY_PREVIOUS'));
  return key ? crypto.createHash('sha256').update(key).digest('hex').slice(0, 8) : null;
}

/** The startup line: which keys this process has, by fingerprint. */
export function describeKeys(): string {
  const fp = keyFingerprint('current');
  const current = fp ? `ENCRYPTION_KEY fp ${fp}` : 'ENCRYPTION_KEY missing or invalid';
  const status = previousKeyStatus();
  const previous =
    status === 'unset' ? 'unset'
    : status === 'invalid' ? 'invalid (ignored)'
    : status === 'same' ? 'same as ENCRYPTION_KEY (ignored)'
    : `fp ${keyFingerprint('previous')}`;
  return `[startup] ${current}; ENCRYPTION_KEY_PREVIOUS ${previous}`;
}

/** A secret for Redis: '' stays '', a value already encrypted passes, anything else is encrypted. */
export function sealSecret(v: string): string {
  if (v === '' || isEncrypted(v)) return v;
  return encrypt(v);
}

/** A sealed secret back: '' is '', anything else must decrypt (either key) or UndecryptableError is thrown. */
export function openSecret(v: string): string {
  if (v === '') return '';
  if (!isEncrypted(v)) throw new UndecryptableError('Not an encrypted value');
  return decrypt(v);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-encryption.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-google-sync-worker.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-google-sync-worker.ts Asia/Jerusalem
```
Expected: `17/17 passed`, `90/90 passed`, `90/90 passed`.

Review focus 2 is pinned by `#11`, `#12` and `#13`: each loads a second copy of the module (`freshCopy()` drops it from require's cache), and a report still fires once. If the reports lived in module state, those three checks would fail with two reports each.

- [ ] **Step 6: Typecheck, lint, and the smokes that load `encryption.ts`**

`encryption.ts` now imports `src/lib/error-capture.ts`, and several smokes load it without a stub. Run:
```bash
npx tsc --noEmit -p .
npm run -s lint
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-calendar-range.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-calendar-connection.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-account-merge.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-google-connect.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-summary-retry.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-reminder-actions.ts
```
Expected: no tsc output; lint clean; every smoke ends `N/N passed` (today: 24/24, 57/57, 64/64, 59/59, 23/23, 33/33).

- [ ] **Step 7: Commit**

```bash
git add src/utils/encryption.ts scripts/smoke-encryption.ts scripts/smoke-google-sync-worker.ts
git commit -F - <<'EOF'
feat(security): a decrypt-only ENCRYPTION_KEY_PREVIOUS, never-throwing token reads and sealed secrets

Keys are read from env on every call; a value neither key opens throws
UndecryptableError (no code, so it is never classed as a transient Google
error); readStoredToken returns '' for it and reports once per user and
column per process (state on globalThis, shared by the scheduler and route
bundles); an empty cipher is no token; fingerprints and the startup line
name the keys without printing them.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

---

### Task 2: Token reads that never throw at the call sites

**Deviation:** (1) The native-reminder snooze check lives in `scripts/smoke-reminder-actions.ts`, whose harness already runs `applyReminderAction` with the ping edit (the spec lists it under `smoke-key-rotation.ts`). (2) The end-to-end "summary batch still delivers to the good users" check is not built: `smoke-summary-retry.ts` stubs `user-service`, and a second batch harness would duplicate it. The batch's only token-dependent step before its per-user try is `getAllUsers()` (`src/services/telegram/summary.ts:482`), which checks `#1` and `#2` cover with the real `user-service` and `types.ts`. (3) The Google sync worker guard went into Task 1 (see there). (4) `scripts/smoke-summary-retry.ts`'s encryption stub gains `readStoredToken` as the spec asks; no check fails without it today (that smoke stubs `user-service`, so `types.ts` never calls it), so it is hygiene, not a red-green step. (5) **Accepted, for the owner to confirm:** while a token is unreadable (PREVIOUS forgotten or wrong), a FamCal user's stored Google choices count as none (`#9`: the summary goes out FamCal-only, no Google call), but a legacy `calendarSource: 'GOOGLE'` user keeps them and reads as `reconnect` (`googleStateOf`, `src/lib/google-state.ts:34-47`), so the app may ask them to reconnect until PREVIOUS is fixed. `#9` pins this as it is; `google-state.ts` is out of scope. Likewise `select-calendars` (`route.ts:141-151`, unchanged) sees no stored choices for such a user, so a first save can run `dropFreshFamcalPrimary` (it only acts on a fresh, empty FamCal main). Both only happen in the "PREVIOUS forgotten" failure mode, whose fix is setting PREVIOUS.

**Files:**
- Create (test): `scripts/smoke-key-rotation.ts`
- Modify: `src/types.ts` (line 2 import, line 55)
- Modify: `src/services/google-connect.ts` (lines 205-206, in `claimPendingGoogleToken`)
- Modify: `app/api/select-calendars/route.ts` (line 6 import, lines 97-98 comment, line 133). Lines 152-167 (`updateUserInCache`) are left for Task 3.
- Modify: `src/services/native-reminders/actions.ts` (line 17 imports, line 212 in `editLivePing`)
- Modify (test): `scripts/smoke-reminder-actions.ts` (line 307, line 331, `reset()` around line 384, a new check before `'ping: the edit is Telegram\'s to fail ...'` around line 627)
- Modify (test): `scripts/smoke-summary-retry.ts` (line 337)

**Interfaces:**
- Consumes (Task 1): `readStoredToken(stored: string, ctx: { userId: number; column: string }): string`, `decrypt(text: string): string` (throws `UndecryptableError` when neither key opens it), and the `globalThis.__famcalEncryptionReports` reset used by the smoke.
- Produces:
  - `convertPrismaUserToConfig(user)` never throws on the token: `googleRefreshToken` is the decrypted token, legacy plaintext as it is, or `''` for no token, an empty cipher or a value neither key opens. Every `getUser*` and `getAllUsers` inherit this.
  - `claimPendingGoogleToken(pendingId, sender): Promise<GoogleConnectClaim>` answers `{ status: 'expired' }` for an entry neither key opens, after `captureError(err, 'oauth-claim-undecryptable', { user_id })`. Signature unchanged.
  - `POST /api/select-calendars` no longer writes `googleRefreshToken`.
  - `editLivePing` passes the decrypted token to `resolveUserTimezone`.

- [ ] **Step 1: Write the failing test: create `scripts/smoke-key-rotation.ts`**

```ts
// Smoke test for reading stored Google tokens while ENCRYPTION_KEY is rotated (secret
// rotation spec §a, call sites). Before, every getUser* decrypted the token with
// safeDecrypt, so one row the key couldn't open made getAllUsers throw (the whole hourly
// summary batch failed) and every lookup of that user throw (connect and reconnect too).
// Now convertPrismaUserToConfig reads it with readStoredToken: '' (not connected) for a
// value neither key opens, reported once, and '' for an empty cipher (what select-calendars
// wrote for users with no token). The OAuth claim catches a pending entry it can't decrypt
// and answers "expired". select-calendars no longer writes the token at all.
//
// Keys: ENCRYPTION_KEY = B (new), ENCRYPTION_KEY_PREVIOUS = A (old); C is a key this server
// never had. Users with no token ('' or an empty cipher) must never be captured or written
// (review focus 1).
//
// getAllUsers, convertPrismaUserToConfig, google-connect (park, claim, commit), the OAuth
// callback page, verifyUserAuth and the select-calendars route run for real. Faked at the
// boundaries: Prisma (in memory), Redis (in memory), the rate limiter (always allows),
// error capture, the admin notifier, Telegram and WhatsApp (record), the sync plan check,
// and fetch (Google's token endpoint answers; anything else is blocked). Every user here
// has reminders off, so nothing reaches the reminder cache.
// No network, no DB.
//
// The native-reminder snooze and the Google sync worker are checked in their own smokes
// (smoke-reminder-actions.ts, smoke-google-sync-worker.ts), whose harnesses run them.
//
// Run with the fake env (no dotenv):
//   npx tsx scripts/smoke-key-rotation.ts

import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
// Set before any module loads: encryption.ts used to read the key once, at load.
process.env.ENCRYPTION_KEY = B;
process.env.ENCRYPTION_KEY_PREVIOUS = A;
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.CRON_SECRET ||= 'test-cron';
process.env.TELEGRAM_BOT_USERNAME = 'famcal_test_bot';
process.env.WHATSAPP_PHONE_NUMBER = '15550001111';

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

/** AES-256-GCM in our iv:tag:data format, with Node's crypto directly (not the module under test). */
function encryptWith(keyHex: string, text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const data = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data}`;
}
function decryptWith(keyHex: string, value: string): string | null {
  const [iv, tag, data] = String(value).split(':');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(iv, 'hex'), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(tag, 'hex'));
    return d.update(data, 'hex', 'utf8') + d.final('utf8');
  } catch {
    return null; // the wrong key: what the checks assert
  }
}

// ---- Fake Prisma: in-memory tables, any model ----

const DB: Record<string, Row[]> = {};
/** Every write to the user table: the where it used, the data and the row ids it hit. */
const userWrites: { method: string; where: Row; data: Row; hit: number[] }[] = [];

const num = (x: unknown) => (x instanceof Date ? x.getTime() : Number(x));
function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') return a != null && b != null && String(a) === String(b);
  return a === b;
}
const isPlain = (v: unknown): v is Row =>
  v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);

function matches(row: Row, where?: Row): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    if (k === 'AND') return ([] as Row[]).concat(cond).every(c => matches(row, c));
    if (k === 'OR') return (cond as Row[]).some(c => matches(row, c));
    if (k === 'NOT') return !([] as Row[]).concat(cond).some(c => matches(row, c));
    const v = row[k];
    if (isPlain(cond)) {
      if ('equals' in cond && !same(v ?? null, cond.equals)) return false;
      if ('in' in cond && !(cond.in as unknown[]).some(x => same(v, x))) return false;
      if ('not' in cond && (isPlain(cond.not) ? matches(row, { [k]: cond.not }) : same(v ?? null, cond.not))) return false;
      if ('gt' in cond && !(v != null && num(v) > num(cond.gt))) return false;
      if ('gte' in cond && !(v != null && num(v) >= num(cond.gte))) return false;
      if ('lt' in cond && !(v != null && num(v) < num(cond.lt))) return false;
      if ('lte' in cond && !(v != null && num(v) <= num(cond.lte))) return false;
      return true;
    }
    return same(v ?? null, cond);
  });
}

function pick(row: Row | undefined, select?: Row): Row | null {
  if (!row) return null;
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]]));
}

function applyData(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (isPlain(v) && 'increment' in v) row[k] = (row[k] ?? 0) + v.increment;
    else if (isPlain(v) && 'set' in v) row[k] = v.set;
    else if (isPlain(v) && ('connect' in v || 'create' in v || 'disconnect' in v)) continue;
    else row[k] = v;
  }
}

let seq = 0;

function model(name: string): Row {
  const t = () => (DB[name] ??= []);
  const recordUser = (method: string, where: Row, data: Row, hit: Row[]) => {
    if (name === 'user') userWrites.push({ method, where, data, hit: hit.map(r => r.id) });
  };
  const create = (data: Row): Row => {
    const now = new Date();
    const id = name === 'user' ? Math.max(0, ...t().map(r => Number(r.id))) + 1 : `${name}-${++seq}`;
    const row: Row = { id, createdAt: now, updatedAt: now };
    applyData(row, data);
    t().push(row);
    recordUser('create', {}, data, [row]);
    return row;
  };
  const updateOne = (where: Row, data: Row, method: string): Row => {
    const row = t().find(r => matches(r, where));
    recordUser(method, where, data, row ? [row] : []);
    if (!row) throw Object.assign(new Error(`No ${name} record was found for an update.`), { code: 'P2025' });
    applyData(row, data);
    if ('updatedAt' in row) row.updatedAt = new Date();
    return row;
  };
  return {
    findUnique: async (a: Row = {}) => pick(t().find(r => matches(r, a.where)), a.select),
    findFirst: async (a: Row = {}) => pick(t().find(r => matches(r, a.where)), a.select),
    findMany: async (a: Row = {}) => t().filter(r => matches(r, a.where)).map(r => pick(r, a.select)),
    count: async (a: Row = {}) => t().filter(r => matches(r, a.where)).length,
    create: async (a: Row) => pick(create(a.data), a.select),
    update: async (a: Row) => pick(updateOne(a.where, a.data, 'update'), a.select),
    updateMany: async (a: Row) => {
      const rows = t().filter(r => matches(r, a.where));
      recordUser('updateMany', a.where ?? {}, a.data, rows);
      rows.forEach(r => applyData(r, a.data));
      return { count: rows.length };
    },
    upsert: async (a: Row) => {
      const row = t().find(r => matches(r, a.where));
      return row ? pick(updateOne(a.where, a.update, 'upsert'), a.select) : pick(create({ ...a.where, ...a.create }), a.select);
    },
    delete: async (a: Row) => {
      const i = t().findIndex(r => matches(r, a.where));
      if (i < 0) throw Object.assign(new Error(`No ${name} record to delete`), { code: 'P2025' });
      recordUser('delete', a.where, {}, [t()[i]]);
      return t().splice(i, 1)[0];
    },
    deleteMany: async (a: Row = {}) => {
      const keep = t().filter(r => !matches(r, a.where));
      const count = t().length - keep.length;
      DB[name] = keep;
      return { count };
    },
    groupBy: async () => [],
    aggregate: async () => ({ _count: {}, _sum: {}, _max: {}, _min: {} }),
  };
}

const models: Record<string, Row> = {};
const fakePrisma: Row = new Proxy({} as Row, {
  get(_t, prop) {
    if (typeof prop !== 'string' || prop === 'then') return undefined;
    if (prop === '$transaction') {
      return async (arg: unknown) => (typeof arg === 'function' ? arg(fakePrisma) : Promise.all(arg as Promise<unknown>[]));
    }
    if (prop.startsWith('$')) return async () => undefined;
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
  getdel: async (k: string) => { const raw = redisStore.get(k); redisStore.delete(k); return decode(raw); },
  exists: async (...ks: string[]) => ks.filter(k => redisStore.has(k)).length,
  incr: async (k: string) => { const n = Number(redisStore.get(k) ?? 0) + 1; redisStore.set(k, String(n)); return n; },
  mget: async (...ks: unknown[]) => ks.flat().map(k => decode(redisStore.get(String(k)))),
  scan: async () => [0, []],
  expire: async () => 1,
  ttl: async () => -1,
};
const fakeRedis = new Proxy(redisImpl, {
  get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? (async () => null)),
});

// ---- Boundaries: stubs in require's cache, served to import() by a load hook ----

const captured: { ctx: string; extra?: Row; message: string }[] = [];
const sent: { via: string; chatId: unknown }[] = [];
const recorder = (prefix: string): Row =>
  new Proxy({} as Row, {
    get: (_t, p) =>
      typeof p !== 'string' || p === 'then'
        ? undefined
        : async (chatId: unknown) => { sent.push({ via: `${prefix}.${p}`, chatId }); return { message_id: 1 }; },
  });

const Module = nodeRequire('module');
const stubs: Record<string, Row> = {};
(globalThis as Row).__smokeStubs = stubs;
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs)) return nextLoad(url, context);
    const names = Object.keys(stubs[file]).filter(n => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
    const source = [
      `const s = globalThis.__smokeStubs[${JSON.stringify(file)}];`,
      ...names.map(n => `export const ${n} = s[${JSON.stringify(n)}];`),
      'export default (s.__esModule ? s.default : s);',
    ].join('\n');
    return { format: 'module', source, shortCircuit: true };
  },
});

// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-partner-labels.ts).
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};

function stub(rel: string, exports: Row) {
  const filename = path.join(ROOT, rel);
  stubs[filename] = exports;
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  Module._cache[filename] = mod;
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BOTH_SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events';

function installStubs() {
  stub('src/utils/prisma.ts', { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() });
  stub('src/utils/redis.ts', { redis: fakeRedis });
  stub('src/lib/rate-limit.ts', {
    settingsRateLimiter: { name: 'settings' }, commandRateLimiter: { name: 'command' }, generalRateLimiter: { name: 'general' },
    tokenPollRateLimiter: { name: 'token-poll' },
    checkRateLimit: async () => ({ success: true, limit: 99, remaining: 99, reset: 0 }),
    getRateLimitHeaders: () => ({}),
  });
  const capture = (e: unknown, ctx: string, extra?: Row) => {
    captured.push({ ctx, extra, message: e instanceof Error ? e.message : String(e) });
  };
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
  stub('src/utils/error-notifier.ts', {
    notifyAdminWarning: async () => undefined,
    notifyAdminError: async () => undefined,
    notifyAdminFeedback: async () => undefined,
    getAdminUserIds: async () => [],
  });
  const bot = recorder('bot');
  stub('src/services/telegram/bot.ts', {
    getBot: () => bot,
    initBot: () => bot,
    getMessagingService: () => recorder('tg'),
    setUserMenuButton: async () => undefined,
  });
  const types = nodeRequire(path.join(ROOT, 'src/services/messaging/types.ts'));
  const messaging = {
    ...types,
    getMessagingService: (platform: unknown) => recorder(String(platform)),
    getTelegramService: () => recorder('telegram'),
    getWhatsAppService: () => recorder('whatsapp'),
  };
  stub('src/services/messaging/index.ts', messaging);
  stub('src/services/messaging/factory.ts', messaging);
  stub('src/services/google-sync/access.ts', { syncAllowed: async () => true });
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === GOOGLE_TOKEN_URL) {
      return new Response(JSON.stringify({ refresh_token: 'google-rt-new', scope: BOTH_SCOPES, access_token: 'test' }), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`network blocked in smoke: ${url}`);
  }) as typeof fetch;
}

// ---- Fixtures ----

const DAY = 86_400_000;
const TAL_TG = 111111111;

function baseUser(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', culture: 'default',
    messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null, calendarSource: 'NATIVE',
    googleScopes: [], googleSyncNotifiedAt: null,
    pairingId: null, remindersEnabled: false, suspendedAt: null, unreachableSince: null, whatsappPhone: null,
    whatsappBsuid: null, telegramId: null, isAdmin: false, globalRules: [], voiceInputEnabled: true,
    textSummaryEnabled: true, voiceSummaryEnabled: false, weatherEnabled: true, locationForced: false,
    createdAt: new Date(Date.now() - 30 * DAY), updatedAt: new Date(Date.now() - DAY),
    ...o,
  };
}

/** A clean world, with every once-per-process report forgotten. */
function seed(users: Row[]) {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  userWrites.length = 0;
  captured.length = 0;
  sent.length = 0;
  delete (globalThis as Row).__famcalEncryptionReports;
  DB.user = users;
  DB.oAuthState = [];
  DB.googleSyncLink = [];
  DB.nativeCalendar = users.map(u => ({ id: `cal-${u.id}`, ownerUserId: u.id, name: `${u.name} calendar`, isDeleted: false, labels: ['yours', 'primary'] }));
}

const userRow = (id: number) => DB.user.find(u => u.id === id) as Row;
const tokenCaptures = () => captured.filter(c => c.ctx === 'token-undecryptable');

function addState(userId: number): string {
  const token = `u1_${crypto.randomBytes(32).toString('hex')}`;
  DB.oAuthState.push({ id: `st-${++seq}`, userId: BigInt(userId), token, createdAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60_000) });
  return token;
}

/** Valid Telegram initData for a Telegram user id, signed with the bot token. */
function initDataFor(tgId: number): string {
  const params: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAH-smoke',
    user: JSON.stringify({ id: tgId, first_name: 'Test' }),
  };
  const checkString = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN ?? '').digest();
  const hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  return [...Object.entries(params), ['hash', hash]].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

/** Runs `fn` with the services' logs silenced. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn, error } = console;
  console.log = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

type CallbackEnd = { redirect?: string; element?: Row; threw?: string };

/** Run the OAuth callback page as Next does; its success path ends in a redirect, which throws. */
async function runCallback(state: string): Promise<CallbackEnd> {
  const page = (await load('app/oauth-callback/page.tsx')).default;
  try {
    const element = await page({ searchParams: Promise.resolve({ code: 'test-code', state }) });
    return { element: element as Row };
  } catch (err) {
    const digest = String((err as Row)?.digest ?? '');
    if (digest.startsWith('NEXT_REDIRECT')) return { redirect: digest.split(';')[2] };
    return { threw: err instanceof Error ? err.message : String(err) };
  }
}

/** A pending entry parked as the callback parks it, its token encrypted under `keyHex`. Returns the pendingId. */
function parkUnder(keyHex: string, ownerUserId: number, token: string): string {
  const pendingId = crypto.randomBytes(24).toString('base64url');
  const key = `oauth:pending:${crypto.createHash('sha256').update(pendingId).digest('hex')}`;
  redisStore.set(key, JSON.stringify({ ownerUserId, refreshToken: encryptWith(keyHex, token), scopes: BOTH_SCOPES.split(' ') }));
  return pendingId;
}

const pendingKeys = () => [...redisStore.keys()].filter(k => k.startsWith('oauth:pending:'));

async function saveChoices(tgId: number): Promise<{ status: number; body: Row }> {
  const { NextRequest } = nodeRequire('next/server');
  const route = await load('app/api/select-calendars/route.ts');
  const req = new NextRequest(`http://localhost/api/select-calendars?user_id=${tgId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      initData: initDataFor(tgId),
      calendarAssignments: [{ calendarId: 'me@gmail.com', labels: ['primary', 'yours'], name: 'Me', color: '#039BE5' }],
    }),
  });
  const res = await quietly(() => route.POST(req) as Promise<Response>);
  return { status: res.status, body: await res.json() };
}

async function main() {
  installStubs();
  const { getAllUsers } = await load('src/services/user-service.ts');
  const { claimPendingGoogleToken } = await load('src/services/google-connect.ts');

  const EMPTY_CIPHER = encryptWith(A, '');

  // ---- getAllUsers: the summary batch's first step ----

  await check('#1 getAllUsers with one row neither key opens returns every user: B and A tokens decrypted, plaintext as it is, \'\' for the bad one, reported once (ids only), nothing written', async () => {
    seed([
      baseUser({ id: 1, name: 'Current', telegramId: BigInt(1001), googleRefreshToken: encryptWith(B, 'tok-current') }),
      baseUser({ id: 2, name: 'Previous', telegramId: BigInt(1002), googleRefreshToken: encryptWith(A, 'tok-previous') }),
      baseUser({ id: 3, name: 'Lost', telegramId: BigInt(1003), googleRefreshToken: encryptWith(C, 'tok-lost') }),
      baseUser({ id: 4, name: 'Legacy', telegramId: BigInt(1004), googleRefreshToken: '1//0gLegacyPlain' }),
    ]);
    const users = await quietly(() => getAllUsers()) as Row[];
    const tokens = Object.fromEntries(users.map(u => [u.id, u.googleRefreshToken]));
    assert(show(tokens) === show({ 1: 'tok-current', 2: 'tok-previous', 3: '', 4: '1//0gLegacyPlain' }), `tokens ${show(tokens)}`);
    // A second read of the bad row is not reported again.
    await quietly(() => getAllUsers());
    const caps = tokenCaptures();
    assert(caps.length === 1 && caps[0].extra?.user_id === 3 && caps[0].extra?.column === 'googleRefreshToken', `captures ${show(captured)}`);
    assert(!show(captured).includes('tok-lost'), 'the token was captured');
    assert(userWrites.length === 0, `writes ${show(userWrites)}`);
  });

  await check('#2 getAllUsers: users with no token (\'\' or an empty cipher) read as \'\' with no capture and no write (review focus 1)', async () => {
    seed([
      baseUser({ id: 5, name: 'Native', telegramId: BigInt(1005), googleRefreshToken: '' }),
      baseUser({ id: 6, name: 'EmptyCipher', telegramId: BigInt(1006), googleRefreshToken: EMPTY_CIPHER }),
    ]);
    const users = await quietly(() => getAllUsers()) as Row[];
    assert(users.length === 2 && users.every(u => u.googleRefreshToken === ''), `tokens ${show(users.map(u => [u.id, u.googleRefreshToken]))}`);
    assert(captured.length === 0, `captures ${show(captured)}`);
    assert(userWrites.length === 0, `writes ${show(userWrites)}`);
  });

  // ---- Connect and reconnect ----

  await check('#3 the OAuth callback and the claim work for a user whose stored token neither key opens: the new token is committed under ENCRYPTION_KEY (B)', async () => {
    seed([baseUser({ id: 9, name: 'Tal Cohen', telegramId: BigInt(TAL_TG), googleRefreshToken: encryptWith(C, 'tok-lost') })]);
    const end = await quietly(() => runCallback(addState(9)));
    assert(end.redirect, `callback ended with ${show(end.threw ?? end.element?.type ?? end)}; ${show(captured)}`);
    const pendingId = new URLSearchParams(end.redirect.split('#')[1] ?? '').get('p') ?? '';
    const claim = await quietly(() => claimPendingGoogleToken(pendingId, { telegramId: TAL_TG })) as Row;
    assert(claim.status === 'connected', `claim ${show(claim)}`);
    const stored = userRow(9).googleRefreshToken;
    assert(decryptWith(B, stored) === 'google-rt-new', 'the committed token does not open with B');
    assert(decryptWith(A, stored) === null && decryptWith(C, stored) === null, 'the committed token opens with an old key');
    assert(tokenCaptures().length === 1 && tokenCaptures()[0].extra?.user_id === 9, `captures ${show(captured)}`);
  });

  await check('#4 a claim parked under the old key (A) connects with KEY=B, PREVIOUS=A, and the token is saved under B', async () => {
    seed([baseUser({ id: 9, name: 'Tal Cohen', telegramId: BigInt(TAL_TG) })]);
    const pendingId = parkUnder(A, 9, 'google-rt-parked');
    const claim = await quietly(() => claimPendingGoogleToken(pendingId, { telegramId: TAL_TG })) as Row;
    assert(claim.status === 'connected', `claim ${show(claim)}`);
    assert(decryptWith(B, userRow(9).googleRefreshToken) === 'google-rt-parked', 'not saved under B');
    assert(captured.every(c => !c.ctx.includes('undecryptable')), `captures ${show(captured)}`);
  });

  await check('#5 a claim parked under a key this server never had (C) answers expired: the entry is used up, captured (oauth-claim-undecryptable, the user id), nothing written', async () => {
    seed([baseUser({ id: 9, name: 'Tal Cohen', telegramId: BigInt(TAL_TG), googleRefreshToken: encryptWith(B, 'tok-kept') })]);
    const before = userRow(9).googleRefreshToken;
    const pendingId = parkUnder(C, 9, 'google-rt-unknown');
    const claim = await quietly(async () => {
      try {
        return await claimPendingGoogleToken(pendingId, { telegramId: TAL_TG });
      } catch (err) {
        return { threw: err instanceof Error ? err.message : String(err) };
      }
    }) as Row;
    assert(show(claim) === show({ status: 'expired' }), `claim ${show(claim)}`);
    assert(pendingKeys().length === 0, 'the entry is still parked');
    const caps = captured.filter(c => c.ctx === 'oauth-claim-undecryptable');
    assert(caps.length === 1 && caps[0].extra?.user_id === 9, `captures ${show(captured)}`);
    assert(userWrites.length === 0 && userRow(9).googleRefreshToken === before, `writes ${show(userWrites)}`);
  });

  // ---- select-calendars: saving choices never writes the token ----

  await check('#6 select-calendars: saving choices leaves a connected user\'s stored token byte for byte; the update carries no googleRefreshToken', async () => {
    seed([baseUser({ id: 9, name: 'Tal Cohen', telegramId: BigInt(TAL_TG), googleRefreshToken: encryptWith(B, 'tok-kept') })]);
    const before = userRow(9).googleRefreshToken;
    const res = await saveChoices(TAL_TG);
    assert(res.status === 200, `status ${res.status} ${show(res.body)} ${show(captured)}`);
    assert(userRow(9).googleRefreshToken === before, 'the stored token changed');
    const updates = userWrites.filter(w => w.hit.includes(9));
    assert(updates.length > 0 && updates.every(w => !('googleRefreshToken' in w.data)), `writes ${show(updates.map(w => Object.keys(w.data)))}`);
  });

  await check('#7 select-calendars: a user whose token neither key opens can still save, and the stored token is left byte for byte (PREVIOUS may open it later)', async () => {
    seed([baseUser({ id: 9, name: 'Tal Cohen', telegramId: BigInt(TAL_TG), googleRefreshToken: encryptWith(C, 'tok-lost') })]);
    const before = userRow(9).googleRefreshToken;
    const res = await saveChoices(TAL_TG);
    assert(res.status === 200, `status ${res.status} ${show(res.body)} ${show(captured)}`);
    assert(userRow(9).googleRefreshToken === before, 'the stored token was overwritten');
  });

  await check('#8 select-calendars: users with no token (\'\' or an empty cipher) save with no capture, and their column is not written (no iv:tag: for \'\') (review focus 1)', async () => {
    seed([
      baseUser({ id: 5, name: 'Native', telegramId: BigInt(1005), googleRefreshToken: '' }),
      baseUser({ id: 6, name: 'EmptyCipher', telegramId: BigInt(1006), googleRefreshToken: EMPTY_CIPHER }),
    ]);
    for (const [id, tg] of [[5, 1005], [6, 1006]]) {
      const before = userRow(id).googleRefreshToken;
      const res = await saveChoices(tg);
      assert(res.status === 200, `user ${id}: status ${res.status} ${show(res.body)}`);
      assert(userRow(id).googleRefreshToken === before, `user ${id}: the column was written`);
    }
    assert(captured.length === 0, `captures ${show(captured)}`);
    const cacheKeys = [...redisStore.keys()].filter(k => k.startsWith('reminders:users'));
    assert(cacheKeys.length === 0, `reminder cache written: ${show(cacheKeys)}`);
  });

  // ---- The summary's Google choices (calendar-read/google.ts reads liveGoogleChoices) ----

  await check('#9 after getAllUsers, a FamCal (NATIVE) user whose token neither key opens, or who has an empty cipher, has no live Google choices, so the summary makes no Google call; only the unreadable ones are captured; a B token keeps its choices; a legacy GOOGLE-source user with an unreadable token reads as "reconnect" (accepted, Deviation 5) (review focus 1)', async () => {
    const choices = [{ calendarId: 'me@gmail.com', labels: ['primary', 'yours'], name: 'Me', color: '#039BE5' }];
    seed([
      baseUser({ id: 21, name: 'Lost', telegramId: BigInt(1021), googleRefreshToken: encryptWith(C, 'tok-lost'), calendarAssignments: choices }),
      baseUser({ id: 22, name: 'EmptyCipher', telegramId: BigInt(1022), googleRefreshToken: EMPTY_CIPHER, calendarAssignments: choices }),
      baseUser({ id: 23, name: 'Current', telegramId: BigInt(1023), googleRefreshToken: encryptWith(B, 'tok-current'), calendarAssignments: choices }),
      baseUser({ id: 24, name: 'LegacyGoogle', telegramId: BigInt(1024), googleRefreshToken: encryptWith(C, 'tok-lost-2'), calendarAssignments: choices, calendarSource: 'GOOGLE' }),
    ]);
    const { liveGoogleChoices, googleStateOf } = await load('src/lib/google-state.ts');
    const users = await quietly(() => getAllUsers()) as Row[];
    const counts = Object.fromEntries(users.map(u => [u.id, liveGoogleChoices(u).length]));
    assert(show(counts) === show({ 21: 0, 22: 0, 23: 1, 24: 1 }), `live choices ${show(counts)}`);
    const states = Object.fromEntries(users.map(u => [u.id, googleStateOf(u)]));
    assert(show(states) === show({ 21: 'none', 22: 'none', 23: 'connected', 24: 'reconnect' }), `states ${show(states)}`);
    const capturedIds = tokenCaptures().map(c => c.extra?.user_id).sort();
    assert(show(capturedIds) === show([21, 24]), `captures ${show(captured)}`);
    assert(!show(captured).includes('tok-lost'), 'a token was captured');
    assert(userWrites.length === 0, `writes ${show(userWrites)}`);
  });

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

- [ ] **Step 2: Add the snooze check to `scripts/smoke-reminder-actions.ts`**

In `scripts/smoke-reminder-actions.ts` (line 307), replace:

```ts
const captured: { ctx: string; extra?: Row; message: string; severity?: string }[] = [];
```

with:

```ts
const captured: { ctx: string; extra?: Row; message: string; severity?: string }[] = [];
/** The Google token each timezone lookup was given, in call order. */
const timezoneTokens: (string | undefined)[] = [];
```

In `scripts/smoke-reminder-actions.ts` (line 331), replace:

```ts
  stub('src/lib/timezone.ts', { resolveUserTimezone: async (u: { id: number }) => TIMEZONES[u.id] ?? IL });
```

with:

```ts
  stub('src/lib/timezone.ts', {
    resolveUserTimezone: async (u: { id: number; googleRefreshToken?: string }) => {
      timezoneTokens.push(u.googleRefreshToken);
      return TIMEZONES[u.id] ?? IL;
    },
  });
```

In `scripts/smoke-reminder-actions.ts` (in `reset()`, around line 384), replace:

```ts
    captured.length = 0;
    activity.length = 0;
    failOn = null;
```

with:

```ts
    captured.length = 0;
    timezoneTokens.length = 0;
    activity.length = 0;
    failOn = null;
```

In `scripts/smoke-reminder-actions.ts` (around line 627), replace:

```ts
  await check('ping: the edit is Telegram\'s to fail: the action still succeeds, answered ok, a warning is captured', async () => {
```

with:

```ts
  await check('ping: the edit\'s timezone lookup gets the owner\'s Google token decrypted, never the stored ciphertext (secret rotation §a)', async () => {
    reset();
    const { encrypt } = await import('../src/utils/encryption');
    db.users.find((u) => u.id === RAZIEL)!.googleRefreshToken = encrypt('raz-google-token');
    // The actor comes decrypted, as convertPrismaUserToConfig gives it; the edit reads the owner's row itself.
    const r = await applyReminderAction({ ...actor(RAZIEL), googleRefreshToken: 'raz-google-token' }, PLUMBER_KEY, 'snooze15', NOW, 'app');
    assert(r.status === 'ok', json(r));
    assert(edits().length === 1, json(botCalls));
    assertJson(timezoneTokens, ['raz-google-token', 'raz-google-token'], 'the tokens the timezone lookups got');
  });

  await check('ping: the edit is Telegram\'s to fail: the action still succeeds, answered ok, a warning is captured', async () => {
```

- [ ] **Step 3: Give the summary-retry encryption stub `readStoredToken`**

In `scripts/smoke-summary-retry.ts` (line 337), replace:

```ts
  [`${SRC}/utils/encryption.ts`]: { safeDecrypt: (value: string) => value },
```

with:

```ts
  [`${SRC}/utils/encryption.ts`]: { safeDecrypt: (value: string) => value, readStoredToken: (value: string) => value },
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-key-rotation.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-reminder-actions.ts
```
Expected on the code as Task 1 left it:
- `smoke-key-rotation.ts`: `1/9 passed`, exit 1.
  - `#1`: `getAllUsers` throws `The value does not decrypt with ENCRYPTION_KEY or ENCRYPTION_KEY_PREVIOUS` (types.ts still calls `safeDecrypt`).
  - `#2`: the empty-cipher user's token comes back as the `iv:tag:` string (`safeDecrypt` passes a non-`isEncrypted` value through), not `''`.
  - `#3`: the callback's `getUserById` throws, so it never redirects (`callback ended with "The value does not decrypt ..."`).
  - `#5`: the claim throws instead of answering `expired`.
  - `#6`: the route rewrites the token with a fresh IV (`the stored token changed`).
  - `#7`: `verifyUserAuth`'s lookup throws, so the route answers 500.
  - `#8`: the `''` user gets `encrypt('')` written (`user 5: the column was written`).
  - `#9`: `getAllUsers` throws on user 21's row (types.ts still calls `safeDecrypt`); with that row alone, the empty cipher would still read as the truthy `iv:tag:` string and keep its choices.
  - `#4` already passes here: Task 1 gave `decrypt` the PREVIOUS fallback and made `encrypt` read the key per call. It pins the claim end to end. See it fail against b765741's `encryption.ts` with the commands below.
- `smoke-reminder-actions.ts`: `33/34 passed`, exit 1. The new `ping: the edit's timezone lookup gets the owner's Google token decrypted ...` check fails: the second lookup got the stored ciphertext, not `raz-google-token`.

Then see `#4` fail without Task 1's key fallback, by putting b765741's `encryption.ts` back for one run and restoring it straight after:

```bash
git show b765741:src/utils/encryption.ts > src/utils/encryption.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-key-rotation.ts | grep '#4'
git checkout HEAD -- src/utils/encryption.ts
git status --short src/utils/encryption.ts
```

Expected: the `#4` line reads `FAIL` with `Unsupported state or unable to authenticate data` (the old module reads `ENCRYPTION_KEY` (B) once and has no PREVIOUS, so the A-sealed claim does not open). The last command prints nothing: `encryption.ts` is Task 1's version again. Do not go on until it does.

- [ ] **Step 5: Implement: `src/types.ts`**

In `src/types.ts` (line 2), replace:

```ts
import { safeDecrypt } from './utils/encryption';
```

with:

```ts
import { readStoredToken } from './utils/encryption';
```

In `src/types.ts` (line 55), replace:

```ts
    googleRefreshToken: safeDecrypt(user.googleRefreshToken), // Decrypt OAuth token
```

with:

```ts
    // Decrypt OAuth token. Never throws: a token neither key opens reads as '' (not
    // connected) and is reported once, so one bad row can't fail getAllUsers or a lookup.
    googleRefreshToken: readStoredToken(user.googleRefreshToken, { userId: user.id, column: 'googleRefreshToken' }),
```

- [ ] **Step 6: Implement: the OAuth claim in `src/services/google-connect.ts`**

In `src/services/google-connect.ts` (lines 205-206), replace:

```ts
  const grant = Array.isArray(entry.scopes) ? { scopes: entry.scopes, ...(entry.sync ? { sync: entry.sync } : {}) } : undefined;
  const committed = await commitGoogleToken(owner.id, decrypt(entry.refreshToken), grant);
```

with:

```ts
  const grant = Array.isArray(entry.scopes) ? { scopes: entry.scopes, ...(entry.sync ? { sync: entry.sync } : {}) } : undefined;
  let refreshToken: string;
  try {
    refreshToken = decrypt(entry.refreshToken);
  } catch (err) {
    // Parked under a key this server has neither as ENCRYPTION_KEY nor as
    // ENCRYPTION_KEY_PREVIOUS: the entry is used up, and the user taps Connect again.
    captureError(err, 'oauth-claim-undecryptable', { user_id: owner.id });
    return { status: 'expired' };
  }
  const committed = await commitGoogleToken(owner.id, refreshToken, grant);
```

The imports already include `decrypt` and `captureError`; leave them.

- [ ] **Step 7: Implement: `app/api/select-calendars/route.ts` stops writing the token**

In `app/api/select-calendars/route.ts` (lines 5-6), replace:

```ts
import { prisma } from '@/src/utils/prisma';
import { encrypt } from '@/src/utils/encryption';
```

with:

```ts
import { prisma } from '@/src/utils/prisma';
```

In `app/api/select-calendars/route.ts` (lines 97-99), replace:

```ts
    // The proved user (verifyUserAuth already returned 404 for a missing row); its
    // decrypted refresh token is re-encrypted below
    const currentUser = auth.user;
```

with:

```ts
    // The proved user (verifyUserAuth already returned 404 for a missing row). Saving the
    // choices never writes the Google token: it is '' here when it can't be decrypted,
    // and writing that back would destroy a token PREVIOUS could still open.
    const currentUser = auth.user;
```

In `app/api/select-calendars/route.ts` (lines 132-134), replace:

```ts
        ...(globalRules !== undefined && { globalRules }),
        googleRefreshToken: encrypt(currentUser.googleRefreshToken) // Re-encrypt
      }
```

with:

```ts
        ...(globalRules !== undefined && { globalRules }),
      }
```

- [ ] **Step 8: Implement: the snooze ping edit in `src/services/native-reminders/actions.ts`**

In `src/services/native-reminders/actions.ts` (line 17), replace:

```ts
import { captureError } from '../../lib/error-capture';
```

with:

```ts
import { captureError } from '../../lib/error-capture';
import { readStoredToken } from '../../utils/encryption';
```

In `src/services/native-reminders/actions.ts` (line 212), replace:

```ts
      const timeZone = owner ? await resolveUserTimezone({ id: owner.id, location: owner.location ?? undefined, googleRefreshToken: owner.googleRefreshToken ?? undefined }) : 'UTC';
```

with:

```ts
      // The column is encrypted: the timezone lookup needs the token itself ('' when unreadable).
      const timeZone = owner ? await resolveUserTimezone({ id: owner.id, location: owner.location ?? undefined, googleRefreshToken: readStoredToken(owner.googleRefreshToken, { userId: owner.id, column: 'googleRefreshToken' }) }) : 'UTC';
```

`resolveUserTimezone` treats `''` as no token (`!!user.googleRefreshToken`, `src/lib/timezone.ts:87,142`), the same as the `undefined` it got before for a user without one.

- [ ] **Step 9: Run the tests to verify they pass**

```bash
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-key-rotation.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-reminder-actions.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-reminder-actions.ts Asia/Jerusalem
```
Expected: `9/9 passed`, `34/34 passed`, `34/34 passed`.

- [ ] **Step 10: Typecheck, lint, and every smoke that loads these modules**

```bash
npx tsc --noEmit -p .
npm run -s lint
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-encryption.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-summary-retry.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-google-connect.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-google-sync-worker.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-account-merge.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-calendar-connection.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-calendar-range.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-auth-identity.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-calendar-home-render.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-calendar-read-google.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-digest-reader.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-miniapp-gate.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-native-rule-guards.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-page-auth.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-reminders.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-summary-seam.ts
```
Expected: no tsc output; lint clean; every smoke ends `N/N passed` (today: 17/17, 23/23, 59/59, 90/90, 64/64, 57/57, 24/24, 26/26, 151/151, 40/40, 30/30, 19/19, 9/9, 16/16, 25/25, 25/25).

- [ ] **Step 11: Commit**

```bash
git add src/types.ts src/services/google-connect.ts app/api/select-calendars/route.ts src/services/native-reminders/actions.ts scripts/smoke-key-rotation.ts scripts/smoke-reminder-actions.ts scripts/smoke-summary-retry.ts
git commit -F - <<'EOF'
fix(security): a token the key can't open no longer breaks summaries, connect or calendar saves

convertPrismaUserToConfig reads the token with readStoredToken, so one bad
row can't fail getAllUsers (the hourly batch) or a lookup (connect and
reconnect); an empty cipher is no token. The OAuth claim answers "expired"
for an entry neither key opens. select-calendars no longer rewrites the
token (it wrote iv:tag: for users with none, and would have overwritten a
token PREVIOUS could still open). The snooze ping edit passes the decrypted
token to the timezone lookup instead of the ciphertext.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

---


### Task 3: Reminder cache v2 holds Google tokens sealed, rebuilt at boot

**Deviation:**
- The spec puts the cache-key literals `:833,886` in `smoke-google-connect.ts`. They are in `scripts/smoke-calendar-connection.ts` (checks H1 and H6). In `smoke-google-connect.ts` the cache is read at `:780` (#6) and matched at `:1214` (#23).
- `updateUserInCache` keeps its call shape. It takes a `ReminderCacheSource` with the token under the old field name `googleRefreshToken` (stored or decrypted) and builds the entry through `toEntry` itself. So its four callers (`app/api/settings/route.ts:113`, `app/api/select-calendars/route.ts:154`, `src/services/google-connect.ts:245`, `src/services/account-linking.ts:541`) don't change. Only the cached entry renames the field (`googleToken`). Its one reader is `handleReminders` (`src/cron/handlers.ts:171`).
- `REMINDER_CACHE_KEY` and `LEGACY_REMINDER_CACHE_KEY` are exported from `reminder-cache.ts` as the spec says. Their values come from the central `REDIS_KEYS` registry (`REMINDER_USERS` becomes `'reminders:users:v2'`, and `REMINDER_USERS_LEGACY = 'reminders:users'` is new), so the literal types stay `'reminders:users:v2'` and `'reminders:users'`.

Every reader and writer of the old key and field (grep `REMINDER_USERS|reminders:users|CachedReminderUser|updateUserInCache|removeUserFromCache|syncReminderCache|getCachedReminderUsers` over `app src scripts`):
- `src/config/redis-keys.ts:22`: the key (changed here).
- `src/services/reminder-cache.ts:10,16-34,40-98`: every read and write of the key (changed here).
- `src/cron/handlers.ts:46-88`: the sync, which wrote `safeDecrypt(...)` (changed here).
- `src/cron/handlers.ts:148,171`: the run, the only reader of the token field (changed here).
- `updateUserInCache` callers: `app/api/settings/route.ts:113`, `app/api/select-calendars/route.ts:154`, `src/services/google-connect.ts:245`, `src/services/account-linking.ts:541`. Unchanged (see Deviation).
- `removeUserFromCache` callers: `app/api/settings/route.ts:127`, `src/lib/user-moderation.ts:153`, `src/services/account-linking.ts:538`. Unchanged; they now act on v2.
- Smokes:
  - `scripts/smoke-reminders.ts:579,593` read `REDIS_KEYS.REMINDER_USERS`, which follows the constant to v2;
  - `scripts/smoke-calendar-connection.ts:588-590,833,886`, `scripts/smoke-google-connect.ts:780-781,1214` and `scripts/smoke-account-merge.ts:623-625,957,1025,1191,1251-1253,1821,1835` change in Step 2;
  - `scripts/smoke-summary-retry.ts:329-336` stubs the module (Step 2);
  - `scripts/smoke-calendar-read-google-cache.ts:342` and `scripts/smoke-location-timezone.ts:156` stub only `updateUserInCache`/`removeUserFromCache`, so they don't change.

**Files:**
- Modify: `src/config/redis-keys.ts:21-22`
- Modify: `src/services/reminder-cache.ts:1-98`
- Modify: `src/cron/handlers.ts:39-88` (sync), `:158-171` (run)
- Modify: `src/cron/scheduler.ts:11-12` (boot step)
- Test: `scripts/smoke-reminders.ts` (header, imports, the Google fake, the stubs, new helpers before `main`, 8 new checks before the summary)
- Test: `scripts/smoke-calendar-connection.ts:588-590,833,886`
- Test: `scripts/smoke-google-connect.ts:780-781,1214`
- Test: `scripts/smoke-account-merge.ts:623-625,957,1025,1191,1251-1253,1821,1835`
- Test: `scripts/smoke-summary-retry.ts:329-336` (stub gains `toEntry`, `purgeLegacyReminderCache`)

**Interfaces:**
- Consumes (Task 1, `src/utils/encryption.ts`):
  - `sealSecret(v: string): string`
  - `normalizeStored(raw: string): string`
  - `openSecret(v: string): string` (strict, throws `UndecryptableError`)
  - `isEncrypted(text: string): boolean`
  - `encrypt(text: string): string` (reads `ENCRYPTION_KEY` per call)
- Produces (`src/services/reminder-cache.ts`):
  - `export const REMINDER_CACHE_KEY` (= `'reminders:users:v2'`)
  - `export const LEGACY_REMINDER_CACHE_KEY` (= `'reminders:users'`)
  - `export interface ReminderCacheSource { id: number; telegramId: string; googleRefreshToken: string; calendarAssignments: unknown; defaultReminderMinutes: number | null; language: string; name: string; pickupRemindersEnabled: boolean; calendarSource?: string; pairingId?: string | null; location?: string }`
  - `export interface CachedReminderUser`: as before, but `googleRefreshToken` is renamed `googleToken: string` (sealed, or `''`)
  - `export function toEntry(user: ReminderCacheSource): CachedReminderUser` (`googleToken: sealSecret(normalizeStored(user.googleRefreshToken))`)
  - `export async function syncReminderCache(users: CachedReminderUser[]): Promise<void>` (unchanged)
  - `export async function updateUserInCache(user: ReminderCacheSource): Promise<void>` (builds through `toEntry`)
  - `export async function purgeLegacyReminderCache(): Promise<void>` (never throws; logs, then `captureError(err, 'reminder-cache-purge')`)
- Produces (`src/cron/handlers.ts`):
  - `export async function rebuildReminderCache(): Promise<number>` (the users synced; a DB failure throws to the caller)
  - `export async function bootReminderCache(): Promise<void>` (purge legacy, then rebuild; never throws: `captureError(err, 'boot-reminder-cache')`)
- Produces (`src/config/redis-keys.ts`): `REDIS_KEYS.REMINDER_USERS = 'reminders:users:v2'`, `REDIS_KEYS.REMINDER_USERS_LEGACY = 'reminders:users'`.
- `startScheduler()` fires `bootReminderCache()` fire-and-forget. Task 5 (key sweep) consumes `rebuildReminderCache`, `REMINDER_CACHE_KEY`, `LEGACY_REMINDER_CACHE_KEY` and the `googleToken` field.

- [ ] **Step 1: Write the failing checks in `scripts/smoke-reminders.ts`**

(a) In `scripts/smoke-reminders.ts`, replace:

```ts
// as its own ping, a "<" or "&" in a title made Telegram refuse the alert, and a user who
// blocked the bot was retried every five minutes. No network.
```

With:

```ts
// as its own ping, a "<" or "&" in a title made Telegram refuse the alert, and a user who
// blocked the bot was retried every five minutes. The cache also held every Google token in
// plain form under reminders:users; v2 holds them sealed, the run opens each one per user,
// and the old key is only ever deleted (at boot and by the hourly sync). No network.
```

(b) In `scripts/smoke-reminders.ts`, replace:

```ts
import { REDIS_KEYS } from '../src/config/redis-keys';

type Result = { name: string; ok: boolean; reason?: string };
```

With:

```ts
import { REDIS_KEYS } from '../src/config/redis-keys';

// No decrypt-only fallback key here (Prisma would load .env for an unset name).
process.env.ENCRYPTION_KEY_PREVIOUS = '';

type Result = { name: string; ok: boolean; reason?: string };
```

(c) In `scripts/smoke-reminders.ts`, replace:

```ts
const fakeGoogle = {
  calendar: () => ({
```

With:

```ts
/** The refresh tokens Google's OAuth clients were given, in order. */
let googleTokens: string[] = [];
const fakeGoogle = {
  calendar: () => ({
```

(d) In `scripts/smoke-reminders.ts`, replace:

```ts
  auth: { OAuth2: class { setCredentials() {} } },
```

With:

```ts
  // Records the refresh token each client is given: Google must get it in plain form.
  auth: { OAuth2: class { setCredentials(credentials: { refresh_token?: string }) { googleTokens.push(credentials.refresh_token ?? ''); } } },
```

(e) In `scripts/smoke-reminders.ts`, replace:

```ts
const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  '@googleapis/calendar': fakeGoogle,
```

With:

```ts
const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  '@googleapis/calendar': fakeGoogle,
  // startScheduler's jobs never run here; only its boot step does.
  'node-cron': { schedule: () => ({ stop: () => {} }) },
```

(f) In `scripts/smoke-reminders.ts`, replace:

```ts
async function main() {
  const handlers = await import('../src/cron/handlers');
```

With:

```ts
type CacheEntry = { id: number; googleToken?: string; [key: string]: unknown };
/** The reminder cache as stored under v2: its raw JSON ('' when missing) and its entries. */
function cacheV2(): { raw: string; entries: CacheEntry[] } {
  const raw = store.get('reminders:users:v2') ?? '';
  return { raw, entries: raw ? (JSON.parse(raw) as CacheEntry[]) : [] };
}

/** `text` encrypted under a key this deployment has neither as ENCRYPTION_KEY nor as PREVIOUS. */
async function foreignCipher(text: string): Promise<string> {
  const { encrypt } = await import('../src/utils/encryption');
  const key = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = key === 'f0'.repeat(32) ? '0f'.repeat(32) : 'f0'.repeat(32);
  try {
    return encrypt(text);
  } finally {
    if (key === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = key;
  }
}

async function main() {
  const handlers = await import('../src/cron/handlers');
```

(g) In `scripts/smoke-reminders.ts`, replace:

```ts
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
```

With:

```ts
  // ---- Secret rotation (spec section c): the cache holds each Google token sealed ----

  await check('the cache (reminders:users:v2) holds the Google token sealed after the sync and after a settings save, and Google still gets it in plain form', async () => {
    const { isEncrypted, openSecret } = await import('../src/utils/encryption');
    reset({ id: 22 });
    await fakeRedis.set(REDIS_KEYS.userTimezone(22), IL);
    googleEvents = [{ calendarId: kidsCal, id: 'k22', summary: 'Kindergarten', start: at('2026-10-13 08:00', IL), end: at('2026-10-13 16:00', IL) }];
    googleTokens = [];
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    const synced = cacheV2();
    assert(synced.raw !== '' && !synced.raw.includes('refresh-token'), `v2 after the sync: ${synced.raw || '(missing)'}`);
    const fromSync = synced.entries.find(u => u.id === 22);
    const syncToken = fromSync?.googleToken ?? '';
    assert(!!fromSync && isEncrypted(syncToken) && openSecret(syncToken) === 'refresh-token' && !('googleRefreshToken' in fromSync),
      `entry after the sync ${JSON.stringify(fromSync)}`);
    await saveSettings(at('2026-10-13 07:05', IL), 1022, { weatherEnabled: true });
    const saved = cacheV2();
    assert(saved.raw !== '' && !saved.raw.includes('refresh-token'), `v2 after a settings save: ${saved.raw || '(missing)'}`);
    const fromSave = saved.entries.find(u => u.id === 22);
    const saveToken = fromSave?.googleToken ?? '';
    assert(!!fromSave && isEncrypted(saveToken) && openSecret(saveToken) === 'refresh-token' && !('googleRefreshToken' in fromSave),
      `entry after the save ${JSON.stringify(fromSave)}`);
    await runTicks(handlers, at('2026-10-13 07:05', IL), at('2026-10-13 08:00', IL));
    assert(sentLines(IL).join(' | ') === '07:45 🤖 Auto-Reminder: Kindergarten', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
    assert(googleTokens.length > 0 && googleTokens.every(token => token === 'refresh-token'),
      `Google was given ${googleTokens.length} token(s), ${googleTokens.filter(token => token === 'refresh-token').length} of them the plain one`);
  });

  await check('a row whose token no key opens: the sync still caches both users, and each run fails only that user', async () => {
    reset({ id: 23 });
    userRows.push({ ...userRows[0], id: 27, telegramId: BigInt(1027), googleRefreshToken: await foreignCipher('another-deployments-token') });
    for (const id of [23, 27]) await fakeRedis.set(REDIS_KEYS.userTimezone(id), IL);
    googleEvents = [{ calendarId: kidsCal, id: 'k23', summary: 'Kindergarten', start: at('2026-10-13 08:00', IL), end: at('2026-10-13 16:00', IL) }];
    const error = console.error;
    console.error = () => {};
    try {
      await syncCache(handlers, at('2026-10-13 07:00', IL));
      const ids = cacheV2().entries.map(u => u.id).sort((a, b) => a - b);
      assert(ids.join(',') === '23,27', `cached ${ids.join(',') || '(nothing)'}; captured ${captured.join(', ') || '(nothing)'}`);
      await runTicks(handlers, at('2026-10-13 07:40', IL), at('2026-10-13 07:50', IL));
    } finally {
      console.error = error;
    }
    assert(sent.length === 1 && sent[0].chatId === 1023, `sent to ${JSON.stringify(sent.map(s => s.chatId))}`);
    // One per run: the runs at 07:40 and 07:45
    assert(captured.filter(c => c === 'cron-reminders-process-user').length === 2, `captured ${captured.join(', ')}`);
  });

  await check('a plaintext row is cached sealed, and an empty-cipher row (iv:tag: with no token) as no token: no capture, and nothing written to the row', async () => {
    const { isEncrypted, openSecret } = await import('../src/utils/encryption');
    const emptyCipher = `${'0'.repeat(32)}:${'a'.repeat(32)}:`;
    reset({ id: 28 });
    userRows.push({ ...userRows[0], id: 29, telegramId: BigInt(1029), googleRefreshToken: emptyCipher, calendarSource: 'NATIVE', calendarAssignments: null });
    for (const id of [28, 29]) await fakeRedis.set(REDIS_KEYS.userTimezone(id), IL);
    googleEvents = [{ calendarId: kidsCal, id: 'k28', summary: 'Kindergarten', start: at('2026-10-13 08:00', IL), end: at('2026-10-13 16:00', IL) }];
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    const { entries } = cacheV2();
    const plain = entries.find(u => u.id === 28)?.googleToken ?? '';
    assert(isEncrypted(plain) && openSecret(plain) === 'refresh-token', `plaintext row cached as ${JSON.stringify(entries.find(u => u.id === 28))}`);
    const empty = entries.find(u => u.id === 29);
    assert(empty?.googleToken === '', `empty-cipher row cached as ${JSON.stringify(empty)}`);
    await runTicks(handlers, at('2026-10-13 07:40', IL), at('2026-10-13 07:50', IL));
    assert(sent.length === 1 && sent[0].chatId === 1028, `sent to ${JSON.stringify(sent.map(s => s.chatId))}`);
    assert(!captured.includes('cron-reminders-process-user') && !captured.includes('token-undecryptable'), `captured ${captured.join(', ')}`);
    assert(userRows.find(r => r.id === 29)?.googleRefreshToken === emptyCipher, 'the empty-cipher row was written');
  });

  await check('the legacy reminders:users key is never read: alone in Redis the run waits for a sync; bootReminderCache() deletes it and builds v2', async () => {
    reset({ id: 24 });
    await fakeRedis.set(REDIS_KEYS.userTimezone(24), IL);
    googleEvents = [{ calendarId: kidsCal, id: 'k24', summary: 'Kindergarten', start: at('2026-10-13 08:00', IL), end: at('2026-10-13 16:00', IL) }];
    store.set('reminders:users', JSON.stringify([{
      id: 24, telegramId: '1024', googleRefreshToken: 'refresh-token', calendarAssignments: userRows[0].calendarAssignments,
      calendarSource: 'GOOGLE', pairingId: null, defaultReminderMinutes: 15, language: 'en', name: 'Dana', pickupRemindersEnabled: true, location: 'Tel Aviv',
    }]));
    clock = at('2026-10-13 07:45', IL).getTime();
    const log = console.log;
    console.log = () => {};
    try {
      const waited = await handlers.handleReminders(5);
      assert(waited.message === 'No cached users - waiting for daily sync' && sent.length === 0, `run ${JSON.stringify(waited)}; sent ${sent.length}`);
      await handlers.bootReminderCache();
    } finally {
      console.log = log;
    }
    assert(!store.has('reminders:users'), 'the legacy key is still there');
    assert(cacheV2().entries.some(u => u.id === 24), `v2 ${cacheV2().raw || '(missing)'}`);
    await runTicks(handlers, at('2026-10-13 07:40', IL), at('2026-10-13 07:50', IL));
    assert(sentLines(IL).join(' | ') === '07:45 🤖 Auto-Reminder: Kindergarten', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
  });

  await check('the hourly sync deletes the legacy key too', async () => {
    reset({ id: 25 });
    store.set('reminders:users', JSON.stringify([{ id: 25, telegramId: '1025', googleRefreshToken: 'refresh-token' }]));
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    assert(!store.has('reminders:users'), 'the legacy key is still there');
    assert(cacheV2().entries.some(u => u.id === 25), `v2 ${cacheV2().raw || '(missing)'}`);
  });

  await check('bootReminderCache never throws: a database failure at boot is logged and captured as boot-reminder-cache', async () => {
    reset({ id: 30 });
    const findMany = fakePrisma.user.findMany;
    fakePrisma.user.findMany = async () => { throw new Error('database down (smoke)'); };
    const error = console.error;
    console.error = () => {};
    try {
      await handlers.bootReminderCache();
    } finally {
      fakePrisma.user.findMany = findMany;
      console.error = error;
    }
    assert(captured.includes('boot-reminder-cache'), `captured ${captured.join(', ') || '(nothing)'}`);
  });

  await check('a failed delete of the legacy key is logged and captured as reminder-cache-purge, and bootReminderCache still builds v2', async () => {
    reset({ id: 31 });
    store.set('reminders:users', JSON.stringify([{ id: 31, telegramId: '1031', googleRefreshToken: 'refresh-token' }]));
    const del = fakeRedis.del;
    fakeRedis.del = async (key: string) => {
      if (key === 'reminders:users') throw new Error('redis down (smoke)');
      return del(key);
    };
    const error = console.error;
    const log = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      await handlers.bootReminderCache();
    } finally {
      fakeRedis.del = del;
      console.error = error;
      console.log = log;
    }
    assert(captured.includes('reminder-cache-purge') && !captured.includes('boot-reminder-cache'), `captured ${captured.join(', ') || '(nothing)'}`);
    assert(cacheV2().entries.some(u => u.id === 31), `v2 ${cacheV2().raw || '(missing)'}`);
  });

  await check('startScheduler rebuilds the cache at boot, not at the next hourly sync: the legacy key goes and v2 holds the users', async () => {
    reset({ id: 26 });
    store.set('reminders:users', JSON.stringify([{ id: 26, telegramId: '1026', googleRefreshToken: 'refresh-token' }]));
    const { startScheduler } = await import('../src/cron/scheduler');
    const log = console.log;
    console.log = () => {};
    try {
      startScheduler();
      // The boot step is fire-and-forget: give it up to a second of real time.
      for (let i = 0; i < 100 && !store.has('reminders:users:v2'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    } finally {
      console.log = log;
    }
    assert(!store.has('reminders:users'), 'the legacy key is still there');
    const entry = cacheV2().entries.find(u => u.id === 26);
    assert(!!entry && entry.googleToken !== 'refresh-token', `v2 ${cacheV2().raw || '(missing)'}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
```

- [ ] **Step 2: Move the other smokes to v2 and flip their plaintext-cache assertions**

(a) In `scripts/smoke-calendar-connection.ts` (C1, lines 588-590), replace:

```ts
    const cached = decode(redisStore.get('reminders:users')) as Row[] | null;
    const entry = cached?.find(c => c.id === 1);
    assert(entry && entry.googleRefreshToken === 'google-rt-new' && entry.calendarSource !== 'GOOGLE', `cache ${show(entry)}`);
```

With:

```ts
    const rawCache = redisStore.get('reminders:users:v2') ?? '';
    assert(rawCache !== '' && !rawCache.includes('google-rt-new'), 'the reminder cache holds the token in plain form');
    const cached = decode(rawCache) as Row[] | null;
    const entry = cached?.find(c => c.id === 1);
    const { isEncrypted, openSecret } = await load('src/utils/encryption.ts');
    assert(entry && isEncrypted(entry.googleToken) && openSecret(entry.googleToken) === 'google-rt-new' && entry.calendarSource !== 'GOOGLE', `cache ${show(entry)}`);
```

(b) In `scripts/smoke-calendar-connection.ts` (H1 at line 833 and H6 at line 886; after (a) these are the only two left), replace **all occurrences** (Edit with `replace_all: true`):

```ts
    const cached = decode(redisStore.get('reminders:users')) as Row[] | null;
```

With:

```ts
    const cached = decode(redisStore.get('reminders:users:v2')) as Row[] | null;
```

(c) In `scripts/smoke-google-connect.ts` (#6, lines 780-781), replace:

```ts
    const cached = decode(redisStore.get('reminders:users')) as Row[] | null;
    assert(cached?.some(u => u.id === 9 && u.googleRefreshToken === 'google-rt-new' && u.calendarSource === 'NATIVE'), `reminder cache ${show(cached)}`);
```

With:

```ts
    const rawCache = redisStore.get('reminders:users:v2') ?? '';
    assert(rawCache !== '' && !rawCache.includes('google-rt-new'), 'the reminder cache holds the token in plain form');
    const cached = decode(rawCache) as Row[] | null;
    const { openSecret } = await load('src/utils/encryption.ts');
    assert(cached?.some(u => u.id === 9 && openSecret(u.googleToken) === 'google-rt-new' && u.calendarSource === 'NATIVE'), `reminder cache ${show(cached)}`);
```

(d) In `scripts/smoke-google-connect.ts` (#23, line 1214), replace:

```ts
        if (/^(reminders:users|googleConnected:)/.test(k)) throw new Error('redis down (smoke)');
```

With:

```ts
        if (/^(reminders:users:v2$|googleConnected:)/.test(k)) throw new Error('redis down (smoke)');
```

(e) In `scripts/smoke-account-merge.ts` (the seed, lines 623-625), replace:

```ts
  redisStore.set('reminders:users', JSON.stringify([
    { id: T, telegramId: '5550010', googleRefreshToken: '', calendarAssignments: null, defaultReminderMinutes: null, language: 'en', name: 'Dana Cohen', pickupRemindersEnabled: true, calendarSource: 'NATIVE', pairingId: null, location: 'Tel Aviv' },
  ]));
```

With:

```ts
  redisStore.set('reminders:users:v2', JSON.stringify([
    { id: T, telegramId: '5550010', googleToken: '', calendarAssignments: null, defaultReminderMinutes: null, language: 'en', name: 'Dana Cohen', pickupRemindersEnabled: true, calendarSource: 'NATIVE', pairingId: null, location: 'Tel Aviv' },
  ]));
```

(f) In `scripts/smoke-account-merge.ts` (#5 line 957, #16 line 1025, #23 line 1191, #25 line 1251), replace **all occurrences** (Edit with `replace_all: true`):

```ts
    const cached = JSON.parse(redisStore.get('reminders:users') ?? '[]').find((u: Row) => u.id === T);
```

With:

```ts
    const cached = JSON.parse(redisStore.get('reminders:users:v2') ?? '[]').find((u: Row) => u.id === T);
```

(g) In `scripts/smoke-account-merge.ts` (#25, lines 1252-1253), replace:

```ts
    assert(cached?.googleRefreshToken === 'google-rt-w' && show(cached.calendarAssignments) === show(W_ASSIGNMENTS),
      `reminder cache entry for T ${show(cached)}`);
```

With:

```ts
    const { openSecret } = await load('src/utils/encryption.ts');
    assert(!!cached?.googleToken && openSecret(cached.googleToken) === 'google-rt-w' && show(cached.calendarAssignments) === show(W_ASSIGNMENTS),
      `reminder cache entry for T ${show(cached)}`);
```

(h) In `scripts/smoke-account-merge.ts` (#13, line 1821), replace:

```ts
    redisStore.set('reminders:users', JSON.stringify([{ id: W, telegramId: '5550020' }, { id: P, telegramId: '5550030' }]));
```

With:

```ts
    redisStore.set('reminders:users:v2', JSON.stringify([{ id: W, telegramId: '5550020' }, { id: P, telegramId: '5550030' }]));
```

(i) In `scripts/smoke-account-merge.ts` (#13, line 1835), replace:

```ts
    const cached = JSON.parse(redisStore.get('reminders:users') ?? '[]').map((u: Row) => u.id);
```

With:

```ts
    const cached = JSON.parse(redisStore.get('reminders:users:v2') ?? '[]').map((u: Row) => u.id);
```

(j) In `scripts/smoke-summary-retry.ts` (the reminder-cache stub, lines 329-336; leave the encryption stub on the next line as Task 2 left it), replace:

```ts
  [`${SRC}/services/reminder-cache.ts`]: {
    syncReminderCache: async (users: unknown[]) => {
      log.push(`housekeeping: ${users.length} reminder users synced`);
    },
    setGlobalRemindersEnabled: async () => {
      log.push('housekeeping: reminders switch set');
    },
  },
```

With:

```ts
  [`${SRC}/services/reminder-cache.ts`]: {
    syncReminderCache: async (users: unknown[]) => {
      log.push(`housekeeping: ${users.length} reminder users synced`);
    },
    setGlobalRemindersEnabled: async () => {
      log.push('housekeeping: reminders switch set');
    },
    // The sync builds each entry with toEntry (the sealing is smoke-reminders'), and the
    // hourly run deletes the legacy key; neither belongs to the housekeeping log.
    toEntry: (user: unknown) => user,
    purgeLegacyReminderCache: async () => {},
  },
```

- [ ] **Step 3: Run the smokes to verify they fail**

Run (from the repo root):
```bash
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-reminders.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-calendar-connection.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-google-connect.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-account-merge.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-summary-retry.ts
```

Expected:
- `smoke-reminders.ts`: every old check passes. The 8 new checks FAIL:
  - "holds the Google token sealed…": `v2 after the sync: (missing)`, because the sync still writes the legacy key, in plain form;
  - "a row whose token no key opens…": `cached (nothing)`, because the sync's `safeDecrypt` throws on that row and aborts the whole sync (`cron-daily-summary-cache-sync` captured);
  - "a plaintext row is cached sealed…": the v2 key is missing, so there's no `googleToken`;
  - "the legacy reminders:users key is never read…": the run reads the legacy key and returns `Reminders processed`, not "No cached users";
  - "the hourly sync deletes the legacy key too": the legacy key is still there (the sync writes it);
  - "bootReminderCache never throws…": `handlers.bootReminderCache is not a function`;
  - "a failed delete of the legacy key…": `handlers.bootReminderCache is not a function`;
  - "startScheduler rebuilds the cache at boot…": the legacy key is still there, and v2 is never written.
- `smoke-calendar-connection.ts`: C1 (`the reminder cache holds the token in plain form`, raw v2 is `''`), H1 and H6 FAIL, because the code still writes `reminders:users`.
- `smoke-google-connect.ts`: #6 FAILS the same way. #23 passes either way.
- `smoke-account-merge.ts`: #5, #16, #23, #25 and #13 FAIL. The code reads and writes the legacy key, while the seeds and reads use v2.
- `smoke-summary-retry.ts`: still passes. The added stub exports are unused before Step 6.

- [ ] **Step 4: Point the reminder-cache key at v2**

In `src/config/redis-keys.ts`, replace:

```ts
  // Reminder cache
  REMINDER_USERS: 'reminders:users',
```

With:

```ts
  // Reminder cache: the users the 5-minute run alerts, each Google token sealed (v2). The
  // legacy key held the tokens in plain form; it is only ever deleted (reminder-cache.ts).
  REMINDER_USERS: 'reminders:users:v2',
  REMINDER_USERS_LEGACY: 'reminders:users',
```

- [ ] **Step 5: Seal the cached token in `src/services/reminder-cache.ts`**

In `src/services/reminder-cache.ts`, replace (lines 1-98, from the file header through the end of `removeUserFromCache`):

```ts
/**
 * Redis cache for reminder users
 * Eliminates DB queries from 5-minute reminder cron to allow Neon auto-suspend
 */

import { redis } from '../utils/redis';
import { REDIS_KEYS } from '../config/redis-keys';
import { captureError } from '../lib/error-capture';

const CACHE_KEY = REDIS_KEYS.REMINDER_USERS;
const GLOBAL_KEY = REDIS_KEYS.REMINDERS_GLOBAL_ENABLED;
const EARLY_ADOPTION_KEY = REDIS_KEYS.EARLY_ADOPTION_GLOBAL;
const VOICE_AUTO_CREATE_KEY = REDIS_KEYS.VOICE_AUTO_CREATE_HIGH_CONF;
const VOICE_TTS_OUTCOME_KEY = REDIS_KEYS.VOICE_TTS_OUTCOME;

export interface CachedReminderUser {
  id: number;
  telegramId: string;
  googleRefreshToken: string; // Already decrypted
  calendarAssignments: unknown;
  defaultReminderMinutes: number | null;
  language: string;
  name: string;
  pickupRemindersEnabled: boolean;
  // calendarSource is legacy: the providers are chosen by calendar id ("Google as a connection");
  // it is read only as liveGoogleChoices' marker for the stored choices of a user with no token.
  // pairingId lets the FamCal half see the partner's shared calendars.
  calendarSource?: string;
  pairingId?: string | null;
  // The reminder run resolves the user's timezone from it, as the summaries do;
  // without it a NATIVE user fell back to Israel, and that fallback was cached for
  // the summaries too. Optional for entries written before it existed.
  location?: string;
}

/**
 * Read all reminder users from cache
 * Returns null if cache is empty or error occurs
 */
export async function getCachedReminderUsers(): Promise<CachedReminderUser[] | null> {
  try {
    return await redis.get<CachedReminderUser[]>(CACHE_KEY);
  } catch (error) {
    console.error('[Reminder Cache] Redis read error:', error);
    captureError(error, 'reminder-cache', {}, 'warning');
    return null;
  }
}

/**
 * Sync full user list to cache (called by daily-summary)
 * No TTL - cache is manually synced twice daily
 */
export async function syncReminderCache(users: CachedReminderUser[]): Promise<void> {
  try {
    await redis.set(CACHE_KEY, users);
    console.log(`[Reminder Cache] Synced ${users.length} users to cache`);
  } catch (error) {
    console.error('[Reminder Cache] Redis write error:', error);
    captureError(error, 'reminder-cache', {}, 'warning');
  }
}

/**
 * Update single user in cache (called on settings/oauth changes)
 * Adds user if not in cache, updates if exists
 */
export async function updateUserInCache(user: CachedReminderUser): Promise<void> {
  try {
    const users = await getCachedReminderUsers() ?? [];
    const index = users.findIndex(u => u.id === user.id);
    if (index >= 0) {
      users[index] = user;
    } else {
      users.push(user);
    }
    await redis.set(CACHE_KEY, users);
    console.log(`[Reminder Cache] Updated user ${user.id} in cache`);
  } catch (error) {
    console.error('[Reminder Cache] Redis update error:', error);
    captureError(error, 'reminder-cache', {}, 'warning');
  }
}

/**
 * Remove user from cache (if reminders disabled or no token)
 */
export async function removeUserFromCache(userId: number): Promise<void> {
  try {
    const users = await getCachedReminderUsers() ?? [];
    const filtered = users.filter(u => u.id !== userId);
    await redis.set(CACHE_KEY, filtered);
    console.log(`[Reminder Cache] Removed user ${userId} from cache`);
  } catch (error) {
    console.error('[Reminder Cache] Redis remove error:', error);
    captureError(error, 'reminder-cache', {}, 'warning');
  }
}
```

With:

```ts
/**
 * Redis cache for reminder users
 * Eliminates DB queries from 5-minute reminder cron to allow Neon auto-suspend
 *
 * Each Google token is cached sealed (sealSecret: ciphertext), never in plain form, and the
 * reminder run opens it per user (handlers.ts handleReminders). The pre-v2 key held the
 * tokens decrypted; it is only ever deleted (purgeLegacyReminderCache).
 */

import { redis } from '../utils/redis';
import { REDIS_KEYS } from '../config/redis-keys';
import { captureError } from '../lib/error-capture';
import { normalizeStored, sealSecret } from '../utils/encryption';

/** The reminder users, each Google token sealed: 'reminders:users:v2'. */
export const REMINDER_CACHE_KEY = REDIS_KEYS.REMINDER_USERS;
/** The pre-v2 key, which held every token in plain form: 'reminders:users'. Only ever deleted. */
export const LEGACY_REMINDER_CACHE_KEY = REDIS_KEYS.REMINDER_USERS_LEGACY;

const CACHE_KEY = REMINDER_CACHE_KEY;
const GLOBAL_KEY = REDIS_KEYS.REMINDERS_GLOBAL_ENABLED;
const EARLY_ADOPTION_KEY = REDIS_KEYS.EARLY_ADOPTION_GLOBAL;
const VOICE_AUTO_CREATE_KEY = REDIS_KEYS.VOICE_AUTO_CREATE_HIGH_CONF;
const VOICE_TTS_OUTCOME_KEY = REDIS_KEYS.VOICE_TTS_OUTCOME;

/**
 * What an entry is built from: the user's fields, with the Google token as the database
 * stores it (ciphertext, legacy plaintext, an empty cipher or '') or already decrypted.
 * toEntry seals it either way.
 */
export interface ReminderCacheSource {
  id: number;
  telegramId: string;
  googleRefreshToken: string;
  calendarAssignments: unknown;
  defaultReminderMinutes: number | null;
  language: string;
  name: string;
  pickupRemindersEnabled: boolean;
  calendarSource?: string;
  pairingId?: string | null;
  location?: string;
}

export interface CachedReminderUser {
  id: number;
  telegramId: string;
  // Sealed: ciphertext (under ENCRYPTION_KEY, or under ENCRYPTION_KEY_PREVIOUS until the
  // key sweep converts the row and rebuilds the cache), or '' for no token. The run opens
  // it with openSecret, per user.
  googleToken: string;
  calendarAssignments: unknown;
  defaultReminderMinutes: number | null;
  language: string;
  name: string;
  pickupRemindersEnabled: boolean;
  // calendarSource is legacy: the providers are chosen by calendar id ("Google as a connection");
  // it is read only as liveGoogleChoices' marker for the stored choices of a user with no token.
  // pairingId lets the FamCal half see the partner's shared calendars.
  calendarSource?: string;
  pairingId?: string | null;
  // The reminder run resolves the user's timezone from it, as the summaries do;
  // without it a NATIVE user fell back to Israel, and that fallback was cached for
  // the summaries too. Optional for entries written before it existed.
  location?: string;
}

/**
 * The one builder of a cache entry, for the hourly sync (rebuildReminderCache) and
 * updateUserInCache. The token is sealed: an empty cipher (iv:tag: with no token, from the
 * old select-calendars bug) becomes '', a stored ciphertext is kept as it is, and anything
 * else is encrypted with ENCRYPTION_KEY. It never decrypts, so a row that no key opens is
 * cached as it is and fails only its own user's run.
 */
export function toEntry(user: ReminderCacheSource): CachedReminderUser {
  const { googleRefreshToken, ...fields } = user;
  return { ...fields, googleToken: sealSecret(normalizeStored(googleRefreshToken)) };
}

/**
 * Read all reminder users from cache
 * Returns null if cache is empty or error occurs
 */
export async function getCachedReminderUsers(): Promise<CachedReminderUser[] | null> {
  try {
    return await redis.get<CachedReminderUser[]>(CACHE_KEY);
  } catch (error) {
    console.error('[Reminder Cache] Redis read error:', error);
    captureError(error, 'reminder-cache', {}, 'warning');
    return null;
  }
}

/**
 * Sync full user list to cache (called by daily-summary, the boot step and the key sweep)
 * No TTL - the cache is rebuilt hourly. Entries come from toEntry.
 */
export async function syncReminderCache(users: CachedReminderUser[]): Promise<void> {
  try {
    await redis.set(CACHE_KEY, users);
    console.log(`[Reminder Cache] Synced ${users.length} users to cache`);
  } catch (error) {
    console.error('[Reminder Cache] Redis write error:', error);
    captureError(error, 'reminder-cache', {}, 'warning');
  }
}

/**
 * Update single user in cache (called on settings/oauth changes)
 * Adds user if not in cache, updates if exists. The entry is built by toEntry (token sealed).
 */
export async function updateUserInCache(user: ReminderCacheSource): Promise<void> {
  try {
    const entry = toEntry(user);
    const users = await getCachedReminderUsers() ?? [];
    const index = users.findIndex(u => u.id === entry.id);
    if (index >= 0) {
      users[index] = entry;
    } else {
      users.push(entry);
    }
    await redis.set(CACHE_KEY, users);
    console.log(`[Reminder Cache] Updated user ${entry.id} in cache`);
  } catch (error) {
    console.error('[Reminder Cache] Redis update error:', error);
    captureError(error, 'reminder-cache', {}, 'warning');
  }
}

/**
 * Remove user from cache (if reminders disabled or no token)
 */
export async function removeUserFromCache(userId: number): Promise<void> {
  try {
    const users = await getCachedReminderUsers() ?? [];
    const filtered = users.filter(u => u.id !== userId);
    await redis.set(CACHE_KEY, filtered);
    console.log(`[Reminder Cache] Removed user ${userId} from cache`);
  } catch (error) {
    console.error('[Reminder Cache] Redis remove error:', error);
    captureError(error, 'reminder-cache', {}, 'warning');
  }
}

/**
 * Deletes the pre-v2 key, which held every remindable user's Google token in plain form.
 * Called at boot and by the hourly sync. Never throws: a failure is logged and captured,
 * and the next call tries again.
 */
export async function purgeLegacyReminderCache(): Promise<void> {
  try {
    const removed = await redis.del(LEGACY_REMINDER_CACHE_KEY);
    if (removed) console.log('[Reminder Cache] Deleted the legacy plaintext key reminders:users');
  } catch (error) {
    console.error('[Reminder Cache] Failed to delete the legacy key reminders:users:', error);
    captureError(error, 'reminder-cache-purge');
  }
}
```

- [ ] **Step 6: Sync without decrypting, open per user, add the rebuild and boot steps in `src/cron/handlers.ts`**

(a) In `src/cron/handlers.ts`, replace (lines 39-88):

```ts
/**
 * The daily run's housekeeping: the reminder-cache sync and, at 04:00 UTC, the clean-up of
 * expired OAuth state tokens. Each step catches its own failure, so this never rejects.
 */
async function syncRemindersAndCleanUp(): Promise<void> {
  // Sync reminder cache from DB (piggyback on existing run)
  try {
    const { syncReminderCache, setGlobalRemindersEnabled } = await import('../services/reminder-cache');
    const { safeDecrypt } = await import('../utils/encryption');

    const users = await prisma.user.findMany({
      where: {
        remindersEnabled: true,
        // Everyone has FamCal ("Google as a connection"), so a missing Google token
        // keeps nobody out: their FamCal events alert too.
        telegramId: { not: null },
        suspendedAt: null,
        // Telegram refuses delivery to these chats; reminders would 403 every 5 minutes.
        unreachableSince: null,
      },
      select: {
        id: true,
        telegramId: true,
        googleRefreshToken: true,
        calendarAssignments: true,
        calendarSource: true,
        pairingId: true,
        defaultReminderMinutes: true,
        pickupRemindersEnabled: true,
        language: true,
        name: true,
        location: true,
      }
    });

    const reminderUsers = users.map(u => ({
      id: u.id,
      telegramId: u.telegramId?.toString() ?? '',
      googleRefreshToken: safeDecrypt(u.googleRefreshToken),
      calendarAssignments: u.calendarAssignments,
      calendarSource: u.calendarSource,
      pairingId: u.pairingId,
      defaultReminderMinutes: u.defaultReminderMinutes,
      language: u.language,
      name: u.name,
      pickupRemindersEnabled: u.pickupRemindersEnabled ?? true,
      location: u.location,
    }));

    await syncReminderCache(reminderUsers);
```

With:

```ts
/**
 * Rebuilds the reminder cache (reminders:users:v2) from the database: every user the
 * 5-minute run alerts. Each Google token is copied as stored and sealed (toEntry), never
 * decrypted here, so a row that no key opens can't stop the sync; the run opens each token
 * per user. Used by the hourly run, the boot step and the key sweep. A database failure
 * throws to the caller; a Redis write failure is logged and captured by syncReminderCache.
 * Returns the number of users synced.
 */
export async function rebuildReminderCache(): Promise<number> {
  const { syncReminderCache, toEntry } = await import('../services/reminder-cache');

  const users = await prisma.user.findMany({
    where: {
      remindersEnabled: true,
      // Everyone has FamCal ("Google as a connection"), so a missing Google token
      // keeps nobody out: their FamCal events alert too.
      telegramId: { not: null },
      suspendedAt: null,
      // Telegram refuses delivery to these chats; reminders would 403 every 5 minutes.
      unreachableSince: null,
    },
    select: {
      id: true,
      telegramId: true,
      googleRefreshToken: true,
      calendarAssignments: true,
      calendarSource: true,
      pairingId: true,
      defaultReminderMinutes: true,
      pickupRemindersEnabled: true,
      language: true,
      name: true,
      location: true,
    }
  });

  const entries = users.map(u => toEntry({
    id: u.id,
    telegramId: u.telegramId?.toString() ?? '',
    googleRefreshToken: u.googleRefreshToken, // As stored; toEntry seals it
    calendarAssignments: u.calendarAssignments,
    calendarSource: u.calendarSource,
    pairingId: u.pairingId,
    defaultReminderMinutes: u.defaultReminderMinutes,
    language: u.language,
    name: u.name,
    pickupRemindersEnabled: u.pickupRemindersEnabled ?? true,
    location: u.location,
  }));

  await syncReminderCache(entries);
  return entries.length;
}

/**
 * The reminder cache's boot step (startScheduler): the legacy plaintext key goes, then v2
 * is built at once. An empty v2 reads as "No cached users" to the 5-minute run, so without
 * this, reminders would wait up to an hour after a deploy. One DB query per deploy. Never
 * throws: a failure is logged and captured, and the hourly sync tries again.
 */
export async function bootReminderCache(): Promise<void> {
  try {
    const { purgeLegacyReminderCache } = await import('../services/reminder-cache');
    await purgeLegacyReminderCache();
    const synced = await rebuildReminderCache();
    console.log(`[Reminder Cache] Rebuilt at boot: ${synced} users`);
  } catch (error) {
    console.error('[Reminder Cache] Boot rebuild failed:', error);
    captureError(error, 'boot-reminder-cache');
  }
}

/**
 * The daily run's housekeeping: the reminder-cache sync and, at 04:00 UTC, the clean-up of
 * expired OAuth state tokens. Each step catches its own failure, so this never rejects.
 */
async function syncRemindersAndCleanUp(): Promise<void> {
  // Sync reminder cache from DB (piggyback on existing run), and drop the legacy plaintext key
  try {
    const { setGlobalRemindersEnabled, purgeLegacyReminderCache } = await import('../services/reminder-cache');

    await rebuildReminderCache();
    await purgeLegacyReminderCache();
```

(b) In `src/cron/handlers.ts` (`handleReminders`), replace:

```ts
  const { processUserReminders } = await import('../services/reminders');

  let totalRemindersSent = 0;
```

With:

```ts
  const { processUserReminders } = await import('../services/reminders');
  const { openSecret } = await import('../utils/encryption');

  let totalRemindersSent = 0;
```

(c) In `src/cron/handlers.ts` (`handleReminders`), replace:

```ts
        language: cachedUser.language,
        googleRefreshToken: cachedUser.googleRefreshToken,
        calendarAssignments: cachedUser.calendarAssignments,
```

With:

```ts
        language: cachedUser.language,
        // Sealed in the cache (toEntry) and opened here, inside this user's try: an entry
        // that no key opens fails only this user ('cron-reminders-process-user' below).
        googleRefreshToken: openSecret(cachedUser.googleToken),
        calendarAssignments: cachedUser.calendarAssignments,
```

- [ ] **Step 7: Fire the boot step from `startScheduler()`**

In `src/cron/scheduler.ts`, replace:

```ts
export function startScheduler(): void {
  console.log('[Scheduler] Starting in-process cron scheduler...');

```

With:

```ts
export function startScheduler(): void {
  console.log('[Scheduler] Starting in-process cron scheduler...');

  // The reminder cache's boot step: the legacy plaintext key goes and v2 is built now, not
  // at the next hourly sync. Fire-and-forget; bootReminderCache never throws, so this catch
  // only covers loading the module.
  import('./handlers')
    .then(({ bootReminderCache }) => bootReminderCache())
    .catch(error => {
      console.error('[Scheduler] Reminder cache boot step failed:', error);
      captureError(error, 'boot-reminder-cache');
    });

```

- [ ] **Step 8: Run the smokes to verify they pass**

Run:
```bash
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-reminders.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-reminders.ts Asia/Jerusalem
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-calendar-connection.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-google-connect.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-account-merge.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-summary-retry.ts
```
Expected: each ends with `N/N passed`, exit 0. Check by hand: delete the `await purgeLegacyReminderCache();` line in `bootReminderCache` and run `smoke-reminders.ts`. "the legacy reminders:users key is never read…" and "startScheduler rebuilds the cache at boot…" must fail. Restore the line.

- [ ] **Step 9: Typecheck, lint and the regression smokes**

Run:
```bash
npx tsc --noEmit -p .
npm run -s lint
for s in smoke-encryption smoke-key-rotation smoke-calendar-read-google-cache smoke-location-timezone smoke-native-reminders smoke-google-sync-worker smoke-auth-identity smoke-auth-leftovers; do
  bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/$s.ts || echo "FAILED $s"
done
```
Expected:
- tsc and lint are clean.
- Every smoke ends `N/N passed`.
- The loop prints no `FAILED`.

Why these smokes:
- they load `reminder-cache.ts`, `src/cron/handlers.ts` or `src/cron/scheduler.ts`;
- `smoke-key-rotation.ts` (Task 2) runs `select-calendars`, which loads `reminder-cache.ts`.

`smoke-key-rotation.ts` needs no edit: its users have reminders off, it never stubs `reminder-cache.ts`, and its `#8` asserts that no `reminders:users*` key is written.

- [ ] **Step 10: Commit**

```bash
git add src/config/redis-keys.ts src/services/reminder-cache.ts src/cron/handlers.ts src/cron/scheduler.ts scripts/smoke-reminders.ts scripts/smoke-calendar-connection.ts scripts/smoke-google-connect.ts scripts/smoke-account-merge.ts scripts/smoke-summary-retry.ts
git commit -m "$(cat <<'EOF'
feat(security): reminder cache v2 holds Google tokens sealed, rebuilt at boot

reminders:users held every remindable user's decrypted Google token with no
TTL. The cache moves to reminders:users:v2:
- one toEntry builds every entry, with the token sealed (sealSecret over
  normalizeStored), for both the sync and updateUserInCache;
- the run opens each token inside its own per-user try, so a row that no key
  opens fails only that user;
- the sync no longer decrypts, so one bad row can't abort it.

rebuildReminderCache is shared by the hourly run, the new boot step and the
key sweep. startScheduler fires bootReminderCache (purge the legacy key, then
rebuild), so reminders don't pause for an hour after a deploy. The legacy key
is only ever deleted.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

### Task 4: Voice pending entries store the Google token sealed

**Deviation:**
- The spec says `webhook-handlers.ts:1202` calls "the shared `setPendingEvent()`", but no such setter exists today: `showEventConfirmation` writes Redis inline (`confirmations.ts:511`). This task adds `setPendingEvent` (and a `PendingEventData` type) to `confirmations.ts`. `showEventConfirmation` and the WhatsApp card both use it.
- `smoke-hebrew-repeats-bot.ts` only reads `raw.event` from a pending entry (`:912`), and events aren't sealed, so it needs no edit; it runs as a regression smoke.
- `smoke-native-reminder-edit.ts` already hand-seeds plaintext pending entries for a Google user (`confirm()`, `:448-461`). It gets the Review Focus 5 check for create, edit and delete.

**Files:**
- Create: `src/services/voice/pending-seal.ts`
- Modify: `src/services/voice/confirmations.ts:27` (import), `:48-68` (getter, new setter), `:97-108`, `:136-146`, `:511`, `:597`, `:678`
- Modify: `src/services/voice/bulk-confirmations.ts:24` (import), `:42-61`
- Modify: `src/services/webhook-handlers.ts:1196-1204`
- Test: `scripts/smoke-native-reminder-create-flow.ts` (env line, fake provider, reset, a helper, 7 new checks)
- Test: `scripts/smoke-native-reminder-edit.ts` (fake provider, 1 new check)

**Interfaces:**
- Consumes (Task 1, `src/utils/encryption.ts`):
  - `sealSecret(v: string): string`
  - `openSecret(v: string): string` (strict, throws `UndecryptableError`)
  - `isEncrypted(text: string): boolean`
  - `encrypt(text: string): string` (smoke only)
- Produces (`src/services/voice/pending-seal.ts`):
  - `export function sealUser<T extends { googleRefreshToken: string }>(user: T): T`
  - `export function openUser<T extends { googleRefreshToken: string }>(stored: T): T` (an empty token is returned unchanged; legacy plaintext is accepted with `console.warn('[voice-pending] legacy plaintext pending entry accepted')`; throws `UndecryptableError` when no key opens it)
- Produces (`src/services/voice/confirmations.ts`):
  - `export interface PendingEventData { event: ParsedEvent; user: UserConfig; transcription: string; inputModality?: 'voice' | 'text' | 'image' }`
  - `export async function setPendingEvent(pendingId: string, pending: PendingEventData): Promise<void>`
  - `getPendingEvent`, `getPendingEdit`, `getPendingDelete` and `getPendingBatch` keep their signatures and return the user with the token opened.

- [ ] **Step 1: Write the failing checks in `scripts/smoke-native-reminder-create-flow.ts`**

(a) In `scripts/smoke-native-reminder-create-flow.ts`, replace:

```ts
import type { PartnerSummary } from '../src/services/native-reminders/ownership';

type Result = { name: string; ok: boolean; reason?: string };
```

With:

```ts
import type { PartnerSummary } from '../src/services/native-reminders/ownership';

// No decrypt-only fallback key here (Prisma would load .env for an unset name).
process.env.ENCRYPTION_KEY_PREVIOUS = '';

type Result = { name: string; ok: boolean; reason?: string };
```

(b) In `scripts/smoke-native-reminder-create-flow.ts`, replace:

```ts
const fakeProvider = {
  fetchEventsInRange: async () => rangeEvents,
  createEvent: async (_user: unknown, calendarId: string, input: Record<string, unknown>) => {
    created.push({ calendarId, input });
```

With:

```ts
/** The Google token of the user each create was made for, in order. */
let providerTokens: string[] = [];
const fakeProvider = {
  fetchEventsInRange: async () => rangeEvents,
  createEvent: async (user: { googleRefreshToken: string }, calendarId: string, input: Record<string, unknown>) => {
    providerTokens.push(user.googleRefreshToken);
    created.push({ calendarId, input });
```

(c) In `scripts/smoke-native-reminder-create-flow.ts` (`reset()`), replace:

```ts
  created = [];
  rangeEvents = [];
```

With:

```ts
  created = [];
  providerTokens = [];
  rangeEvents = [];
```

(d) In `scripts/smoke-native-reminder-create-flow.ts`, replace:

```ts
async function main() {
  const { getBotMessage, getBotMessages } = await import('../src/lib/bot-messages');
```

With:

```ts
/** `text` encrypted under a key this deployment has neither as ENCRYPTION_KEY nor as PREVIOUS. */
async function foreignCipher(text: string): Promise<string> {
  const { encrypt } = await import('../src/utils/encryption');
  const key = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = key === 'f0'.repeat(32) ? '0f'.repeat(32) : 'f0'.repeat(32);
  try {
    return encrypt(text);
  } finally {
    if (key === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = key;
  }
}

/** The one stored entry whose key starts with `prefix`: its raw JSON and its pending id. */
function storedEntry(prefix: string): { raw: string; id: string } {
  const keys = [...store.keys()].filter(k => k.startsWith(prefix));
  assert(keys.length === 1, `stored under ${prefix}: ${JSON.stringify(keys)}`);
  return { raw: store.get(keys[0])!, id: keys[0].slice(prefix.length) };
}

/** Which tokens the provider got, without printing them: plain 'rt-dana' or something else. */
const tokenKinds = (tokens: string[]) => JSON.stringify(tokens.map(token => (token === 'rt-dana' ? 'plain' : 'other')));

async function main() {
  const { getBotMessage, getBotMessages } = await import('../src/lib/bot-messages');
```

(e) In `scripts/smoke-native-reminder-create-flow.ts`, replace:

```ts
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
```

With:

```ts
  // ---- Secret rotation (spec section c): pending entries hold the Google token sealed ----

  const danaWithToken = { ...dana, googleRefreshToken: 'rt-dana' } as UserConfig;
  const { isEncrypted } = await import('../src/utils/encryption');
  const dentist: ParsedEvent = { title: 'Dentist', startTime: at('2026-10-15 10:00'), endTime: at('2026-10-15 11:00'), allDay: false, calendarId: 'native:main-1', calendarName: 'Dana', confidence: 'high' };

  await check('sealed pending: an event card stores no Google token in plain form; the getter and the Create tap give it back', async () => {
    await showEventConfirmation(555, undefined, dentist, 'dentist', danaWithToken);
    const { raw, id } = storedEntry('voice:pending:event:');
    assert(!raw.includes('rt-dana'), 'the pending event holds the token in plain form');
    assert(isEncrypted(JSON.parse(raw).user.googleRefreshToken), 'the stored token is not sealed');
    const pending = await confirmations.getPendingEvent(id);
    assert(pending?.user.googleRefreshToken === 'rt-dana', 'the getter did not open the token');
    await handleEventCallback(555, 701, 'q1', 'create', id);
    assert(created.length === 1 && tokenKinds(providerTokens) === '["plain"]', `creates ${created.length}; tokens ${tokenKinds(providerTokens)}`);
  });

  await check('sealed pending: edit and delete cards store no Google token in plain form, and their getters give it back', async () => {
    const original = calendarEvent('Dentist', iso('2026-10-15 10:00'), iso('2026-10-15 11:00'), { eventId: 'd1' });
    await confirmations.showEditConfirmation(555, undefined, original, 'native:main-1', { title: 'Dentist (Dr. Cohen)' }, 'rename the dentist', danaWithToken);
    await confirmations.showDeleteConfirmation(555, undefined, original, 'native:main-1', 'delete the dentist', danaWithToken);
    const edit = storedEntry('voice:pending:edit:');
    const del = storedEntry('voice:pending:delete:');
    assert(!edit.raw.includes('rt-dana') && !del.raw.includes('rt-dana'), 'a pending edit or delete holds the token in plain form');
    const pendingEdit = await confirmations.getPendingEdit(edit.id);
    const pendingDelete = await confirmations.getPendingDelete(del.id);
    assert(pendingEdit?.user.googleRefreshToken === 'rt-dana' && pendingDelete?.user.googleRefreshToken === 'rt-dana', 'a getter did not open the token');
  });

  await check('sealed pending: a bulk batch stores no Google token in plain form, and "Confirm all" gives the provider the plain token', async () => {
    const plumber = await resolved(parsedReminder());
    await showBulkConfirmation(555, [createIntent(dentist), createIntent(plumber)], danaWithToken, 'x', t, fakeService as never, IL);
    const { raw, id } = storedEntry('voice:pending:batch:');
    assert(!raw.includes('rt-dana'), 'the pending batch holds the token in plain form');
    const result = await handleBulkConfirmAll(id);
    assert(result.successCount === 2 && result.user.googleRefreshToken === 'rt-dana', `ok ${result.successCount}, failed ${result.failureCount}`);
    assert(tokenKinds(providerTokens) === '["plain","plain"]', `tokens ${tokenKinds(providerTokens)}`);
  });

  await check('sealed pending: the WhatsApp card goes through the shared setter (no plain token in Redis), and its Create tap gives the provider the plain token', async () => {
    currentUser = danaWithToken;
    extracted = [createIntent(dentist)];
    await whatsappVoice();
    const { raw, id } = storedEntry('voice:pending:event:');
    assert(id.startsWith('wa:'), `pending id ${id}`);
    assert(!raw.includes('rt-dana'), 'the WhatsApp pending event holds the token in plain form');
    await handleWhatsAppWebhook(
      { body: { entry: [{ changes: [{ value: { messages: [{ from: '972500000008', id: 'wamid.tap.create', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: `event_create:${id}`, title: 'Create' } } }] } }] }] } },
      { status: () => ({ json: () => {} }) }
    );
    assert(created.length === 1 && tokenKinds(providerTokens) === '["plain"]', `creates ${created.length}; tokens ${tokenKinds(providerTokens)}; WhatsApp ${JSON.stringify(waCalls.map(c => c.text))}`);
  });

  // Review focus 5: an entry written in plain form before the deploy (at most ten minutes old)
  await check('legacy pending: an event entry stored in plain form before the deploy still creates, with its token, and logs one warning', async () => {
    await fakeRedis.set('voice:pending:event:legacy1', { event: dentist, user: danaWithToken, transcription: 'dentist' });
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      await handleEventCallback(555, 701, 'q1', 'create', 'legacy1');
    } finally {
      console.warn = warn;
    }
    assert(created.length === 1 && tokenKinds(providerTokens) === '["plain"]', `creates ${created.length}; tokens ${tokenKinds(providerTokens)}`);
    assert(warnings.filter(w => w.includes('[voice-pending] legacy plaintext')).length === 1, `warnings ${JSON.stringify(warnings)}`);
  });

  await check('sealed pending: an entry that no key opens reads as expired, and nothing is created', async () => {
    const foreign = await foreignCipher('rt-other');
    await fakeRedis.set('voice:pending:event:foreign1', { event: dentist, user: { ...dana, googleRefreshToken: foreign }, transcription: 'dentist' });
    const error = console.error;
    console.error = () => {};
    try {
      await handleEventCallback(555, 701, 'q1', 'create', 'foreign1');
    } finally {
      console.error = error;
    }
    assert(created.length === 0, `created ${JSON.stringify(created)}`);
    assert(lastBot()?.text === t.voice.expiredMessage, JSON.stringify(lastBot()));
  });

  await check('sealed pending: a batch that no key opens reads as expired: "Confirm all" is refused with bulk_pending_expired, and nothing is created', async () => {
    const foreign = await foreignCipher('rt-other');
    await fakeRedis.set('voice:pending:batch:foreign2', { intents: [createIntent(dentist)], user: { ...dana, googleRefreshToken: foreign }, transcription: 'dentist' });
    const error = console.error;
    console.error = () => {};
    let rejection = '';
    try {
      await handleBulkConfirmAll('foreign2');
    } catch (err) {
      rejection = err instanceof Error ? err.message : String(err);
    } finally {
      console.error = error;
    }
    assert(rejection === 'bulk_pending_expired', `rejection ${rejection || '(none)'}`);
    assert(created.length === 0, `created ${JSON.stringify(created)}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
```

- [ ] **Step 2: Write the failing legacy check in `scripts/smoke-native-reminder-edit.ts`**

(a) In `scripts/smoke-native-reminder-edit.ts`, replace:

```ts
let deleteResult: { success: boolean; error?: string } = { success: true };
const fakeProvider = {
```

With:

```ts
let deleteResult: { success: boolean; error?: string } = { success: true };
/** The Google token of the user each provider write was made for, in order. */
const providerTokens: string[] = [];
const fakeProvider = {
```

(b) In `scripts/smoke-native-reminder-edit.ts`, replace:

```ts
  createEvent: async () => createResult,
  updateEvent: async () => updateResult,
  deleteEvent: async () => deleteResult,
};
```

With:

```ts
  createEvent: async (u: UserConfig) => { providerTokens.push(u.googleRefreshToken); return createResult; },
  updateEvent: async (u: UserConfig) => { providerTokens.push(u.googleRefreshToken); return updateResult; },
  deleteEvent: async (u: UserConfig) => { providerTokens.push(u.googleRefreshToken); return deleteResult; },
};
```

(c) In `scripts/smoke-native-reminder-edit.ts`, replace:

```ts
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
```

With:

```ts
  // Secret rotation (spec, Review focus 5): an entry written in plain form before the deploy
  // that seals them (at most ten minutes old) still confirms, with its token.
  await check('a pending create, edit or delete stored in plain form before the deploy still confirms on Google: the provider gets the token, with one warning each', async () => {
    const meeting = { ...event('Standup', '2026-10-20T07:00:00.000Z', '2026-10-20T07:30:00.000Z'), calendarId: 'primary', eventId: 'g8' } as UnifiedEvent;
    providerTokens.length = 0;
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      for (const kind of ['create', 'edit', 'delete'] as const) {
        reset();
        createResult = { success: false, error: 'FORBIDDEN' };
        updateResult = { success: false, error: 'FORBIDDEN' };
        deleteResult = { success: false, error: 'FORBIDDEN' };
        await confirm(kind, meeting, googleUser, { title: 'Standup 2' });
      }
    } finally {
      console.warn = warn;
    }
    assert(JSON.stringify(providerTokens) === '["token","token","token"]', `provider tokens ${JSON.stringify(providerTokens)}`);
    assert(warnings.filter(w => w.includes('[voice-pending] legacy plaintext')).length === 3, `warnings ${JSON.stringify(warnings)}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
```

- [ ] **Step 3: Run the smokes to verify they fail**

Run:
```bash
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-native-reminder-create-flow.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-native-reminder-edit.ts
```

Expected:
- `smoke-native-reminder-create-flow.ts`: every old check passes. The 7 new checks FAIL:
  - "an event card stores no Google token…": `the pending event holds the token in plain form`; today `showEventConfirmation` stores the whole `UserConfig` as is;
  - "edit and delete cards…": `a pending edit or delete holds the token in plain form`;
  - "a bulk batch…": `the pending batch holds the token in plain form`;
  - "the WhatsApp card…": `the WhatsApp pending event holds the token in plain form` (the direct `redis.set` in `webhook-handlers.ts:1202`);
  - "legacy pending…": `warnings []`; the create succeeds, but nothing warns about a plaintext entry;
  - "an entry that no key opens…": `created [...]`; today the getter hands the ciphertext on as the token, and the create goes ahead;
  - "a batch that no key opens…": `rejection (none)`; today `getPendingBatch` hands the ciphertext on and "Confirm all" goes ahead.
- `smoke-native-reminder-edit.ts`: every old check passes. The new check FAILS on `warnings []` (0 of 3). The provider tokens are already `["token","token","token"]`.

- [ ] **Step 4: Create `src/services/voice/pending-seal.ts`**

```ts
/**
 * Voice pending entries (voice:pending:event|edit|delete|batch:*) keep the user's whole
 * UserConfig in Redis for ten minutes, until the confirm or cancel tap. Its Google token
 * goes in sealed (sealSecret: ciphertext) and comes out opened, so Redis never holds it in
 * plain form (secret rotation spec, section c). Only the pending setters and getters in
 * confirmations.ts and bulk-confirmations.ts call these; their callers see the plain
 * UserConfig as before.
 */

import { isEncrypted, openSecret, sealSecret } from '../../utils/encryption';

/** The user with its Google token sealed, for a pending entry's write. No token: unchanged. */
export function sealUser<T extends { googleRefreshToken: string }>(user: T): T {
  if (!user.googleRefreshToken) return user;
  return { ...user, googleRefreshToken: sealSecret(user.googleRefreshToken) };
}

/**
 * The user of a pending entry with its Google token opened. Throws UndecryptableError when
 * no key opens it; the getters treat that as any failed read. An entry written in plain
 * form before this release (at most ten minutes before the deploy) is accepted with a
 * warning; remove that branch in a later release.
 */
export function openUser<T extends { googleRefreshToken: string }>(stored: T): T {
  const token = stored.googleRefreshToken;
  if (!token) return stored;
  if (!isEncrypted(token)) {
    console.warn('[voice-pending] legacy plaintext pending entry accepted');
    return stored;
  }
  return { ...stored, googleRefreshToken: openSecret(token) };
}
```

- [ ] **Step 5: Seal and open in `src/services/voice/confirmations.ts`**

(a) In `src/services/voice/confirmations.ts`, replace:

```ts
import { liveGoogleChoices } from '../../lib/google-state';
```

With:

```ts
import { liveGoogleChoices } from '../../lib/google-state';
import { openUser, sealUser } from './pending-seal';
```

(b) In `src/services/voice/confirmations.ts`, replace:

```ts
/**
 * Get a pending event by ID (used by callbacks)
 */
export async function getPendingEvent(pendingId: string) {
  try {
    const data = await redis.get<{
      event: ParsedEvent;
      user: UserConfig;
      transcription: string;
      inputModality?: 'voice' | 'text' | 'image';
    }>(REDIS_KEYS.pendingEvent(pendingId));
    if (!data) return undefined;
    // Reconstruct Date objects that were serialized as strings
    reviveDates(data.event, ['startTime', 'endTime']);
    return data;
  } catch (error) {
```

With:

```ts
/**
 * A pending event: what its confirmation card's Create tap creates
 */
export interface PendingEventData {
  event: ParsedEvent;
  user: UserConfig;
  transcription: string;
  inputModality?: 'voice' | 'text' | 'image';
}

/**
 * Store a pending event for its card's Create tap (10 minutes). The one writer of
 * voice:pending:event:*, for the Telegram card and the WhatsApp one: the user's Google
 * token is stored sealed (pending-seal.ts).
 */
export async function setPendingEvent(pendingId: string, pending: PendingEventData): Promise<void> {
  await redis.set(REDIS_KEYS.pendingEvent(pendingId), { ...pending, user: sealUser(pending.user) }, { ex: PENDING_TTL_SECONDS });
}

/**
 * Get a pending event by ID (used by callbacks), its user's Google token opened
 */
export async function getPendingEvent(pendingId: string) {
  try {
    const data = await redis.get<PendingEventData>(REDIS_KEYS.pendingEvent(pendingId));
    if (!data) return undefined;
    // Reconstruct Date objects that were serialized as strings
    reviveDates(data.event, ['startTime', 'endTime']);
    return { ...data, user: openUser(data.user) };
  } catch (error) {
```

(c) In `src/services/voice/confirmations.ts`, replace:

```ts
    const data = await redis.get<PendingEdit>(REDIS_KEYS.pendingEdit(pendingId));
    if (!data) return undefined;
    reviveDates(data.updates, ['startTime', 'endTime']);
    return data;
```

With:

```ts
    const data = await redis.get<PendingEdit>(REDIS_KEYS.pendingEdit(pendingId));
    if (!data) return undefined;
    reviveDates(data.updates, ['startTime', 'endTime']);
    return { ...data, user: openUser(data.user) };
```

(d) In `src/services/voice/confirmations.ts`, replace:

```ts
    const data = await redis.get<PendingDelete>(REDIS_KEYS.pendingDelete(pendingId));
    if (!data) return undefined;
    return data;
```

With:

```ts
    const data = await redis.get<PendingDelete>(REDIS_KEYS.pendingDelete(pendingId));
    if (!data) return undefined;
    return { ...data, user: openUser(data.user) };
```

(e) In `src/services/voice/confirmations.ts` (`showEventConfirmation`), replace:

```ts
  await redis.set(REDIS_KEYS.pendingEvent(pendingId), { event: shown, user, transcription, inputModality }, { ex: PENDING_TTL_SECONDS });
```

With:

```ts
  await setPendingEvent(pendingId, { event: shown, user, transcription, inputModality });
```

(f) In `src/services/voice/confirmations.ts` (`showEditConfirmation`), replace:

```ts
  await redis.set(REDIS_KEYS.pendingEdit(pendingId), { originalEvent, calendarId, updates, user, transcription, scope }, { ex: PENDING_TTL_SECONDS });
```

With:

```ts
  // The user's Google token is stored sealed (pending-seal.ts); getPendingEdit opens it
  await redis.set(REDIS_KEYS.pendingEdit(pendingId), { originalEvent, calendarId, updates, user: sealUser(user), transcription, scope }, { ex: PENDING_TTL_SECONDS });
```

(g) In `src/services/voice/confirmations.ts` (`showDeleteConfirmation`), replace:

```ts
  await redis.set(REDIS_KEYS.pendingDelete(pendingId), { event, calendarId, user, transcription, scope }, { ex: PENDING_TTL_SECONDS });
```

With:

```ts
  // The user's Google token is stored sealed (pending-seal.ts); getPendingDelete opens it
  await redis.set(REDIS_KEYS.pendingDelete(pendingId), { event, calendarId, user: sealUser(user), transcription, scope }, { ex: PENDING_TTL_SECONDS });
```

- [ ] **Step 6: Seal and open the bulk batch in `src/services/voice/bulk-confirmations.ts`**

(a) In `src/services/voice/bulk-confirmations.ts`, replace:

```ts
import { captureError } from '../../lib/error-capture';
```

With:

```ts
import { captureError } from '../../lib/error-capture';
import { openUser, sealUser } from './pending-seal';
```

(b) In `src/services/voice/bulk-confirmations.ts`, replace:

```ts
  await redis.set(REDIS_KEYS.pendingBatch(pendingId), payload, { ex: BATCH_TTL_SECONDS });
}
```

With:

```ts
  // The user's Google token is stored sealed (pending-seal.ts); getPendingBatch opens it
  await redis.set(REDIS_KEYS.pendingBatch(pendingId), { ...payload, user: sealUser(payload.user) }, { ex: BATCH_TTL_SECONDS });
}
```

(c) In `src/services/voice/bulk-confirmations.ts`, replace:

```ts
  for (const intent of data.intents) {
    if (intent.event) {
      intent.event.startTime = new Date(intent.event.startTime);
      intent.event.endTime = new Date(intent.event.endTime);
    }
  }
  return data;
}
```

With:

```ts
  for (const intent of data.intents) {
    if (intent.event) {
      intent.event.startTime = new Date(intent.event.startTime);
      intent.event.endTime = new Date(intent.event.endTime);
    }
  }
  // A token no key opens reads as an expired batch (callers answer bulk_pending_expired)
  let user: UserConfig;
  try {
    user = openUser(data.user);
  } catch (error) {
    console.error('[Voice] Pending batch token does not decrypt:', error);
    captureError(error, 'voice-confirmations', { pending_id: pendingId }, 'warning');
    return null;
  }
  return { ...data, user };
}
```

- [ ] **Step 7: Route the WhatsApp card through the shared setter in `src/services/webhook-handlers.ts`**

In `src/services/webhook-handlers.ts` (`handleWhatsAppVoice`, lines 1196-1204), replace:

```ts
      // MEDIUM confidence — fall through to the existing confirmation card.
      const { REDIS_KEYS } = await import('../config/redis-keys');
      const { redis } = await import('../utils/redis');

      const pendingId = `wa:${phone}:${Date.now()}`;
      const pendingEvent = reminder ? refreshReminderNotice(intentResult.event, timezone) : intentResult.event;
      await redis.set(REDIS_KEYS.pendingEvent(pendingId), { event: pendingEvent, user, transcription }, { ex: 600 });

      const { formatEventDateTime, formatReminderCard, hebrewCardParts } = await import('./voice/confirmations');
```

With:

```ts
      // MEDIUM confidence — fall through to the existing confirmation card.
      const { setPendingEvent, formatEventDateTime, formatReminderCard, hebrewCardParts } = await import('./voice/confirmations');

      const pendingId = `wa:${phone}:${Date.now()}`;
      const pendingEvent = reminder ? refreshReminderNotice(intentResult.event, timezone) : intentResult.event;
      // The shared setter, as on Telegram: the user's Google token is stored sealed
      await setPendingEvent(pendingId, { event: pendingEvent, user, transcription });
```

- [ ] **Step 8: Run the smokes to verify they pass**

Run:
```bash
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-native-reminder-create-flow.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-native-reminder-create-flow.ts Asia/Jerusalem
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-native-reminder-edit.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-native-reminder-edit.ts Asia/Jerusalem
```
Expected: each ends `N/N passed`, exit 0. The hand-seeded plaintext edit at `smoke-native-reminder-create-flow.ts:926` (`user: dana`, empty token) still passes as before, with no warning.

Check by hand:
- In `openUser`, replace the legacy branch's `return stored;` with `throw new Error('plaintext')`, and run both smokes. "legacy pending…" and the edit smoke's new check must fail. Restore the line.
- Revert Step 7 only (`git stash push src/services/webhook-handlers.ts`). "the WhatsApp card…" must fail. Then `git stash pop`.

- [ ] **Step 9: Typecheck, lint and the regression smokes**

Run:
```bash
npx tsc --noEmit -p .
npm run -s lint
for s in smoke-hebrew-repeats-bot smoke-calendar-routing smoke-native-reminder-buttons smoke-native-reminder-creation smoke-native-reminder-support smoke-native-reminder-typed smoke-pairing-accept smoke-voice-dates smoke-google-connect smoke-account-merge smoke-encryption; do
  bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/$s.ts || echo "FAILED $s"
done
```
Expected: tsc and lint are clean, every smoke ends `N/N passed`, and the loop prints no `FAILED`. These smokes load `voice/confirmations.ts`, `voice/callbacks.ts`, `voice/bulk-confirmations.ts` or `webhook-handlers.ts`. `smoke-hebrew-repeats-bot.ts` reads `voice:pending:*` and needs no edit (only `raw.event` is read, and events aren't sealed).

- [ ] **Step 10: Commit**

```bash
git add src/services/voice/pending-seal.ts src/services/voice/confirmations.ts src/services/voice/bulk-confirmations.ts src/services/webhook-handlers.ts scripts/smoke-native-reminder-create-flow.ts scripts/smoke-native-reminder-edit.ts
git commit -m "$(cat <<'EOF'
feat(security): voice pending entries store the Google token sealed

voice:pending:* kept the user's whole UserConfig, plaintext Google token
included, for ten minutes. sealUser/openUser seal the token in the pending
setters and open it in the getters (event, edit, delete, batch). The
WhatsApp card now writes through the shared setPendingEvent. None of the
consumers change.

An entry written in plain form before the deploy is still accepted, with a
warning; remove that branch in a later release. An entry that no key opens
reads as expired.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```


### Task 5: Key sweep re-encrypts stored tokens under the current key, announces SAFE, and the docs carry the rotation rule

**Deviations from the spec (read first):**
- **The sweep goes idle once it has nothing left to do in this process.** The spec runs a full DB walk every 10 minutes forever and logs a line on every tick. A Neon query every 10 minutes keeps the compute awake about half the time (roughly 90 of the free 100 CU-hours a month), which is the cost the spec itself rules out in (c). So a tick returns `null` with no Prisma or Redis call when (i) SAFE was already logged in this process, or (ii) the last pass found nothing to write (no rows under PREVIOUS, no plaintext, no raced) **and** either `ENCRYPTION_KEY_PREVIOUS` is not valid (unset, invalid or equal to the key) or that pass left unreadable rows (SAFE cannot follow them in this process; the alert already went out). Every other spec rule is kept: gate, lock, baseline, CAS, SAFE condition, dedup. In steady state each process walks the tables 2 or 3 times, then stops until the next deploy.
- **The link counts carry `plaintext` / `plaintext_encrypted` and `empty_cipher` too.** `GoogleSyncLink.unlinkToken` is a raw copy of a user's column (`account-linking.ts:493`), so it can hold legacy plaintext or an empty cipher like the user column. The spec's log lines leave those fields out for links; hiding them would hide rows that block SAFE. Both lines use the same fields for both columns.
- **`CLAUDE.md` does not exist at b765741.** The task creates it with a short header and the one rule line.
- **Docs for behaviour that Tasks 6 and 7 ship:** the `.env.example` and README `SESSION_SECRET` text and the README `WHATSAPP_APP_SECRET` row describe the fail-closed behaviour (no fallback; unset means refused). The spec puts the docs here, and the whole branch ships at once. `.env.example` also gets a commented `# ENCRYPTION_KEY=your_encryption_key_here` line, because the file never named the key that `ENCRYPTION_KEY_PREVIOUS` refers to. It stays commented, like `SESSION_SECRET`: a copied invalid placeholder would make every encrypt throw.
- **The lock is released** at the end of a tick, with a get-and-compare first so it only deletes its own lock. **A Redis error on the lock** gets `captureError(..., 'key-sweep-lock', {}, 'warning')` as well as the spec's `console.warn` (Global Constraints: no silent failures).

**Files:**
- Create: `src/services/key-rotation.ts`
- Create: `scripts/smoke-key-sweep.ts`
- Create: `CLAUDE.md`
- Modify: `src/cron/scheduler.ts` (after the health-check job, `:94-105` at b765741, and the registered-jobs log list, `:107-114`; Task 3 has already added the boot step, so the line numbers shift)
- Modify: `.env.example:38-43`
- Modify: `README.md:78` (`WHATSAPP_APP_SECRET` row), `:86` (`SESSION_SECRET` row, plus two new rows), and a new subsection between `:90` and `:92`
- Test: `scripts/smoke-key-sweep.ts`

**Interfaces:**
- Consumes:
  - from Task 1, `src/utils/encryption.ts`: `encrypt(text: string): string`, `decryptDetailed(text: string): { value: string; key: 'current' | 'previous' }`, `isEncrypted(text: string): boolean`, `isEmptyCipher(raw: string): boolean`, `keyFingerprint(which: 'current' | 'previous'): string | null`, `previousKeyStatus(): PreviousKeyStatus`, `type PreviousKeyStatus = 'unset' | 'valid' | 'invalid' | 'same'`;
  - from Task 3, `src/services/reminder-cache.ts`: `REMINDER_CACHE_KEY = 'reminders:users:v2'`, `LEGACY_REMINDER_CACHE_KEY = 'reminders:users'`, and each v2 entry's `googleToken` (sealed ciphertext or `''`);
  - from Task 3, `src/cron/handlers.ts`: `rebuildReminderCache(): Promise<number>`, `bootReminderCache(): Promise<void>` (only the smoke's stub names it);
  - existing: `captureError(error, context, extra?, severity?)` (`src/lib/error-capture.ts`), `notifyAdminWarning(context, message)` and `getAdminUserIds(): Promise<number[]>` (`src/utils/error-notifier.ts`), `getBot()` (`src/services/telegram/bot.ts`), `prisma`, `redis`.
- Produces (`src/services/key-rotation.ts`):
  - `export interface KeySweepCounts { current: number; previous: number; converted: number; plaintext: number; plaintextEncrypted: number; emptyCipher: number; raced: number; unreadable: number; unreadableIds: string[] }`
  - `export interface KeySweepReport { baseline: boolean; previousKey: PreviousKeyStatus; users: KeySweepCounts; links: KeySweepCounts; legacyCache: boolean | null; cacheRebuilt: boolean; safe: boolean }`
  - `export async function runKeySweep(opts?: { uptimeSeconds?: number }): Promise<KeySweepReport | null>`. It returns `null` when gated (uptime < 600 s), idle, skipped for a missing or invalid `ENCRYPTION_KEY`, locked, or when Redis fails on the lock.
  - Once-per-process state on `globalThis.__famcalKeySweep`. The smoke deletes it to simulate a new process.
  - Scheduled `'*/10 * * * *'` in `src/cron/scheduler.ts`, with `captureError(error, 'cron-key-sweep')`.

- [ ] **Step 1: Write the failing smoke `scripts/smoke-key-sweep.ts`**

```ts
// Smoke test for the key sweep (src/services/key-rotation.ts; secret rotation spec
// 2026-10-22, (a) "Key sweep"). After ENCRYPTION_KEY is replaced and the old value is put
// in ENCRYPTION_KEY_PREVIOUS, the sweep re-encrypts User.googleRefreshToken and
// GoogleSyncLink.unlinkToken under the current key with compare-and-set writes. It also
// encrypts legacy plaintext. It leaves current, empty-cipher, unreadable and no-token rows
// alone, logs SAFE once nothing needs the old key, and goes idle when nothing is left to
// do, so Neon can scale to zero. The scheduler runs it every 10 minutes, and the docs
// carry the rotation rule.
//
// The real key-rotation, encryption, reminder-cache and scheduler modules run. Faked:
// Prisma (two in-memory tables), Redis (in memory), node-cron (records the jobs), the
// reminder-cache rebuild, error capture, the admin notifier and the Telegram bot. No
// network, no DB.
//
// Run with the fake env (no dotenv):
//   npx tsx scripts/smoke-key-sweep.ts

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { format } from 'util';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

// A is the old key, B the new one, and C a key neither side knows.
const KEY_A = 'a1'.repeat(32);
const KEY_B = 'b2'.repeat(32);
const KEY_C = 'c3'.repeat(32);
process.env.ENCRYPTION_KEY = KEY_B;
// Empty, not deleted: @prisma/client loads a .env file into every variable that is unset
process.env.ENCRYPTION_KEY_PREVIOUS = '';

const V2_KEY = 'reminders:users:v2';
const LEGACY_KEY = 'reminders:users';
const LOCK_KEY = 'keysweep:lock';
const ADMIN_ID = 42;
const SAFE_TEMPLATE = '[key-sweep] SAFE: every stored token is under ENCRYPTION_KEY (fp XXXXXXXX); nothing needs ENCRYPTION_KEY_PREVIOUS. You can remove it at the next deploy.';

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

const show = (value: unknown) => JSON.stringify(value);

// ---- AES-256-GCM under a given key, in the iv:tag:data hex format encrypt() writes ----

function sealWith(keyHex: string, text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('hex');
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data}`;
}

/** The plaintext under that key, or null when the key doesn't open it. */
function openWith(keyHex: string, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const [iv, tag, data] = value.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(iv, 'hex'), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return null; // a wrong key fails GCM's tag check: that is the answer, not an error
  }
}

/** keyFingerprint(): the first 8 hex characters of sha256 over the 32 key bytes. */
const fp = (keyHex: string) => crypto.createHash('sha256').update(Buffer.from(keyHex, 'hex')).digest('hex').slice(0, 8);
const safeLine = (currentKey: string) => SAFE_TEMPLATE.replace('XXXXXXXX', fp(currentKey));

function setKeys(current: string, previous: string) {
  process.env.ENCRYPTION_KEY = current;
  process.env.ENCRYPTION_KEY_PREVIOUS = previous;
}

// ---- Fake Prisma: User and GoogleSyncLink, with the where shapes the sweep uses ----

const DB: Record<'user' | 'googleSyncLink', Row[]> = { user: [], googleSyncLink: [] };
const prismaCalls: string[] = [];
const finds: { model: string; args: Row }[] = [];
const writes: { model: string; where: Row; data: Row; count: number }[] = [];
/** Runs before each updateMany applies: a test's write landing between the sweep's read and its write. */
let beforeWrite: ((model: string, where: Row) => void) | null = null;
/** findMany throws while set, as a database outage does. */
let prismaDown = false;

const order = (a: unknown, b: unknown) =>
  typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k] ?? null;
    if (cond !== null && typeof cond === 'object') {
      if ('not' in cond && v === cond.not) return false;
      if ('gt' in cond && !(v !== null && order(v, cond.gt) > 0)) return false;
      return true;
    }
    return v === cond;
  });
}

function model(name: 'user' | 'googleSyncLink'): Row {
  return {
    findMany: async (args: Row = {}) => {
      prismaCalls.push(`${name}.findMany`);
      if (prismaDown) throw new Error('smoke: database is down');
      finds.push({ model: name, args });
      let rows = DB[name].filter(r => matches(r, args.where));
      if (args.orderBy?.id === 'asc') rows = [...rows].sort((x, y) => order(x.id, y.id));
      if (args.take) rows = rows.slice(0, args.take);
      return rows.map(r => (args.select ? Object.fromEntries(Object.keys(args.select).map(k => [k, r[k] ?? null])) : { ...r }));
    },
    // Checks and sets in one step, as a single UPDATE ... WHERE does.
    updateMany: async (args: Row) => {
      prismaCalls.push(`${name}.updateMany`);
      beforeWrite?.(name, args.where);
      const rows = DB[name].filter(r => matches(r, args.where));
      rows.forEach(r => Object.assign(r, args.data));
      writes.push({ model: name, where: { ...args.where }, data: { ...args.data }, count: rows.length });
      return { count: rows.length };
    },
  };
}

const models: Row = { user: model('user'), googleSyncLink: model('googleSyncLink') };
const fakePrisma = new Proxy(models, {
  get(t, p) {
    if (typeof p !== 'string' || p === 'then') return undefined;
    if (p in t) return t[p];
    prismaCalls.push(p);
    throw new Error(`smoke: unexpected prisma.${p}`);
  },
});

// ---- Fake Redis (Upstash parses JSON on read); TTLs and set options are recorded ----

const store = new Map<string, string>();
const ttls = new Map<string, number>();
const redisCalls: string[] = [];
const setOptions: { key: string; opts?: Row }[] = [];
/** Every command throws while set, as a Redis outage does. */
let redisDown = false;
const decode = (raw: string | undefined) => {
  if (raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return raw; }
};
const encode = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
function touch(command: string) {
  redisCalls.push(command);
  if (redisDown) throw new Error('smoke: Redis is down');
}
const redisImpl: Row = {
  get: async (k: string) => { touch('get'); return decode(store.get(k)); },
  set: async (k: string, v: unknown, opts?: Row) => {
    touch('set');
    setOptions.push({ key: k, opts });
    if (opts?.nx && store.has(k)) return null;
    store.set(k, encode(v));
    if (opts?.ex) ttls.set(k, opts.ex);
    return 'OK';
  },
  del: async (...ks: unknown[]) => { touch('del'); return ks.flat().reduce((n: number, k) => n + (store.delete(String(k)) ? 1 : 0), 0); },
  exists: async (...ks: unknown[]) => { touch('exists'); return ks.flat().filter(k => store.has(String(k))).length; },
};
const fakeRedis = new Proxy(redisImpl, {
  get: (t, p) =>
    typeof p !== 'string' || p === 'then'
      ? undefined
      : t[p] ?? (async () => { touch(p); throw new Error(`smoke: unexpected redis.${p}`); }),
});

// ---- Recorders ----

const captured: { context: string; message: string; extra?: Row }[] = [];
const adminNotes: string[] = [];
const botSends: { chatId: unknown; text: string }[] = [];
const cronJobs: { expr: string; fn: () => unknown }[] = [];
let rebuilds = 0;
const logs: string[] = [];

// ---- Boundaries: stubs in require's cache, served to import() by a load hook ----

const NODE_CRON_STUB = path.join(ROOT, 'scripts', '.smoke-node-cron-stub.js');
const Module = nodeRequire('module');
const stubs: Record<string, Row> = {};
(globalThis as Row).__smokeStubs = stubs;
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  resolve(specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === 'node-cron') return { url: pathToFileURL(NODE_CRON_STUB).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs)) return nextLoad(url, context);
    const names = Object.keys(stubs[file]).filter(n => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
    const source = [
      `const s = globalThis.__smokeStubs[${JSON.stringify(file)}];`,
      ...names.map(n => `export const ${n} = s[${JSON.stringify(n)}];`),
      'export default (s.__esModule ? s.default : s);',
    ].join('\n');
    return { format: 'module', source, shortCircuit: true };
  },
});
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'node-cron') return NODE_CRON_STUB;
  return resolveFilename.call(this, request, ...rest);
};

function stubFile(filename: string, exports: Row) {
  stubs[filename] = exports;
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  Module._cache[filename] = mod;
}
const stub = (rel: string, exports: Row) => stubFile(path.join(ROOT, rel), exports);

function installStubs() {
  stub('src/utils/prisma.ts', { prisma: fakePrisma });
  stub('src/utils/redis.ts', { redis: fakeRedis });
  const capture = (e: unknown, context: string, extra?: Row) => {
    captured.push({ context, message: e instanceof Error ? e.message : String(e), extra });
  };
  stub('src/lib/error-capture.ts', {
    captureError: capture,
    captureWarning: (message: string, context: string, extra?: Row) => capture(new Error(message), context, extra),
    captureInfo: () => undefined,
  });
  stub('src/utils/error-notifier.ts', {
    notifyAdminWarning: async (title: string, message: string) => { adminNotes.push(`${title}: ${message}`); },
    notifyAdminError: async () => undefined,
    notifyAdminFeedback: async () => undefined,
    getAdminUserIds: async () => [ADMIN_ID],
  });
  const bot = { sendMessage: async (chatId: unknown, text: string) => { botSends.push({ chatId, text }); return { message_id: 1 }; } };
  stub('src/services/telegram/bot.ts', { getBot: () => bot, initBot: () => bot });
  stub('src/cron/handlers.ts', {
    rebuildReminderCache: async () => { rebuilds++; return 2; },
    bootReminderCache: async () => undefined,
  });
  stubFile(NODE_CRON_STUB, {
    schedule: (expr: string, fn: () => unknown) => { cronJobs.push({ expr, fn }); return { stop: () => undefined }; },
  });
}

// The sweep and the scheduler log through console; the lines are the record.
const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
function captureConsole() {
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => { logs.push(format(...args)); };
  }
}
function restoreConsole() {
  Object.assign(console, realConsole);
}

function reset() {
  DB.user = [];
  DB.googleSyncLink = [];
  prismaCalls.length = 0;
  finds.length = 0;
  writes.length = 0;
  beforeWrite = null;
  prismaDown = false;
  store.clear();
  ttls.clear();
  redisCalls.length = 0;
  setOptions.length = 0;
  redisDown = false;
  captured.length = 0;
  adminNotes.length = 0;
  botSends.length = 0;
  rebuilds = 0;
  logs.length = 0;
  // A fresh process for the sweep: its once-per-process state lives on globalThis
  delete (globalThis as Row).__famcalKeySweep;
}

type Sweep = typeof import('../src/services/key-rotation');
let sweepModule: Promise<Sweep> | null = null;
const loadSweep = () => (sweepModule ??= import('../src/services/key-rotation'));
async function run(uptimeSeconds: number) {
  return (await loadSweep()).runKeySweep({ uptimeSeconds });
}
const lines = (prefix: string) => logs.filter(l => l.startsWith(prefix));
const userRow = (id: number) => DB.user.find(r => r.id === id) as Row;
const linkRow = (id: string) => DB.googleSyncLink.find(r => r.id === id) as Row;
const snapshot = () => JSON.stringify(DB);
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** One row of every kind, in both columns. */
function seedMixed() {
  DB.user = [
    { id: 1, googleRefreshToken: sealWith(KEY_A, 'rt-one') }, // under PREVIOUS
    { id: 2, googleRefreshToken: sealWith(KEY_B, 'rt-two') }, // current
    { id: 3, googleRefreshToken: 'plain-rt-three' }, // legacy plaintext
    { id: 4, googleRefreshToken: sealWith(KEY_A, '') }, // empty cipher (no token), even under PREVIOUS
    { id: 5, googleRefreshToken: sealWith(KEY_C, 'rt-five') }, // neither key
    { id: 6, googleRefreshToken: '' }, // no token
  ];
  DB.googleSyncLink = [
    { id: 'link-a', unlinkToken: sealWith(KEY_A, 'rt-link-a') },
    { id: 'link-b', unlinkToken: sealWith(KEY_C, 'rt-link-b') },
    { id: 'link-c', unlinkToken: null },
    { id: 'link-d', unlinkToken: sealWith(KEY_B, 'rt-link-d') },
  ];
}
const MIXED_PLAINTEXTS = ['rt-one', 'rt-two', 'plain-rt-three', 'rt-five', 'rt-link-a', 'rt-link-b', 'rt-link-d'];

async function main() {
  installStubs();
  captureConsole();

  await check('#1 before 600 s of uptime the sweep returns null with no Prisma or Redis call', async () => {
    reset();
    setKeys(KEY_B, KEY_A);
    seedMixed();
    const before = snapshot();
    const report = await run(599);
    assert(report === null, `returned ${show(report)}`);
    assert(prismaCalls.length === 0 && redisCalls.length === 0, `calls: prisma ${show(prismaCalls)}, redis ${show(redisCalls)}`);
    assert(snapshot() === before, 'a row changed');
  });

  // #2-#5 are one story: the same rows and the same process.
  let mixedOriginal: Row = {};

  await check('#2 the first tick after the gate is a read-only baseline that logs every count', async () => {
    reset();
    setKeys(KEY_B, KEY_A);
    seedMixed();
    mixedOriginal = JSON.parse(snapshot());
    const report = await run(600);
    assert(report?.baseline === true, `report: ${show(report)}`);
    assert(writes.length === 0 && snapshot() === JSON.stringify(mixedOriginal), `the baseline wrote: ${show(writes)}`);
    const want = '[key-sweep] baseline: users current=1 previous=1 plaintext=1 empty_cipher=1 unreadable=1; links current=1 previous=1 plaintext=0 empty_cipher=0 unreadable=1';
    assert(show(lines('[key-sweep] baseline:')) === show([want]), `baseline lines: ${show(lines('[key-sweep] baseline:'))}`);
    assert(rebuilds === 0, 'the baseline rebuilt the reminder cache');
  });

  await check('#3 the next tick moves both columns to ENCRYPTION_KEY with compare-and-set writes, encrypts legacy plaintext, and rebuilds the reminder cache', async () => {
    writes.length = 0;
    const report = await run(1200);
    assert(report && !report.baseline, `report: ${show(report)}`);
    assert(openWith(KEY_B, userRow(1).googleRefreshToken) === 'rt-one' && openWith(KEY_A, userRow(1).googleRefreshToken) === null, 'user 1 is not under ENCRYPTION_KEY alone');
    assert(openWith(KEY_B, userRow(3).googleRefreshToken) === 'plain-rt-three', 'user 3\'s plaintext was not encrypted under ENCRYPTION_KEY');
    assert(openWith(KEY_B, linkRow('link-a').unlinkToken) === 'rt-link-a', 'link-a is not under ENCRYPTION_KEY');
    const cas = writes.map(w => `${w.model}:${w.where.id}:${w.where.googleRefreshToken ?? w.where.unlinkToken}`).sort();
    const want = [
      `googleSyncLink:link-a:${mixedOriginal.googleSyncLink[0].unlinkToken}`,
      `user:1:${mixedOriginal.user[0].googleRefreshToken}`,
      'user:3:plain-rt-three',
    ].sort();
    assert(show(cas) === show(want), `writes (id and the value each compared against): ${show(cas)}`);
    assert(writes.every(w => w.count === 1), `a write missed: ${show(writes)}`);
    assert(report.users.converted === 1 && report.users.plaintextEncrypted === 1 && report.links.converted === 1, `counts: ${show(report)}`);
    assert(rebuilds === 1 && report.cacheRebuilt === true, `rebuilds ${rebuilds}`);
    const line = '[key-sweep] users current=1 converted=1 raced=0 unreadable=1 plaintext_encrypted=1 empty_cipher=1; links current=1 converted=1 raced=0 unreadable=1 plaintext_encrypted=0 empty_cipher=0; legacy_cache=0';
    assert(show(lines('[key-sweep] users ')) === show([line]), `tick lines: ${show(lines('[key-sweep] users '))}`);
  });

  await check('#4 [RF1] current, empty-cipher, unreadable and no-token rows stay byte-for-byte; unreadable ids are reported once, by id only, and no value reaches a log', async () => {
    for (const id of [2, 4, 5, 6]) {
      assert(userRow(id).googleRefreshToken === mixedOriginal.user[id - 1].googleRefreshToken, `user ${id} changed`);
    }
    for (const [i, id] of ['link-a', 'link-b', 'link-c', 'link-d'].entries()) {
      if (id !== 'link-a') assert(linkRow(id).unlinkToken === mixedOriginal.googleSyncLink[i].unlinkToken, `${id} changed`);
    }
    const unreadable = captured.filter(c => c.context === 'key-sweep-unreadable');
    assert(unreadable.length === 1, `key-sweep-unreadable captures over two ticks: ${unreadable.length}`);
    assert(show(unreadable[0].extra).includes('"5"') && show(unreadable[0].extra).includes('"link-b"'), `capture extra: ${show(unreadable[0].extra)}`);
    assert(captured.length === 1, `other captures: ${show(captured)}`);
    assert(adminNotes.length === 1 && adminNotes[0].includes('link-b'), `admin notes: ${show(adminNotes)}`);
    const idLines = lines('[key-sweep] 2 stored tokens decrypt with neither key');
    assert(idLines.length === 2 && idLines.every(l => l.includes('users 5') && l.includes('links link-b')), `id lines: ${show(idLines)}`);
    const values = [
      ...MIXED_PLAINTEXTS,
      ...[...mixedOriginal.user, ...DB.user].map(r => r.googleRefreshToken),
      ...[...mixedOriginal.googleSyncLink, ...DB.googleSyncLink].map(r => r.unlinkToken),
    ].filter((v): v is string => typeof v === 'string' && v.length > 0);
    const said = [...logs, ...captured.map(c => `${c.message} ${show(c.extra)}`), ...adminNotes].join('\n');
    for (const v of values) assert(!said.includes(v), `a token value reached a log: ${v.slice(0, 12)}...`);
  });

  await check('#5 a second run writes nothing; with unreadable rows left there is no SAFE, and the sweep then goes idle with no Prisma or Redis call', async () => {
    writes.length = 0;
    logs.length = 0;
    const before = snapshot();
    const report = await run(1900);
    assert(report && writes.length === 0 && snapshot() === before, `wrote: ${show(writes)}`);
    assert(rebuilds === 1, `rebuilt again: ${rebuilds}`);
    const line = '[key-sweep] users current=3 converted=0 raced=0 unreadable=1 plaintext_encrypted=0 empty_cipher=1; links current=2 converted=0 raced=0 unreadable=1 plaintext_encrypted=0 empty_cipher=0; legacy_cache=0';
    assert(show(lines('[key-sweep] users ')) === show([line]), `tick lines: ${show(lines('[key-sweep] users '))}`);
    assert(report.safe === false && lines('[key-sweep] SAFE:').length === 0, 'SAFE with unreadable rows left');
    prismaCalls.length = 0;
    redisCalls.length = 0;
    const idle = await run(2000);
    assert(idle === null && prismaCalls.length === 0 && redisCalls.length === 0, `idle tick: ${show(idle)}, prisma ${show(prismaCalls)}, redis ${show(redisCalls)}`);
  });

  await check('#6 [RF3] a token Google refreshes mid-sweep survives: the compare-and-set write loses, counts as raced, blocks SAFE, and the next tick is clean', async () => {
    reset();
    setKeys(KEY_B, KEY_A);
    const old = sealWith(KEY_A, 'rt-old');
    const fresh = sealWith(KEY_B, 'rt-fresh');
    DB.user = [{ id: 1, googleRefreshToken: old }];
    await run(600);
    beforeWrite = (m, where) => {
      if (m === 'user' && where.id === 1 && userRow(1).googleRefreshToken === old) userRow(1).googleRefreshToken = fresh;
    };
    const raced = await run(1900);
    assert(raced?.users.raced === 1 && raced.users.converted === 0, `report: ${show(raced)}`);
    assert(userRow(1).googleRefreshToken === fresh, 'the fresh token was overwritten');
    assert(writes.length === 1 && writes[0].count === 0 && writes[0].where.googleRefreshToken === old, `writes: ${show(writes)}`);
    assert(rebuilds === 0, 'a raced tick rebuilt the cache');
    assert(lines('[key-sweep] users ').some(l => l.includes('raced=1')), `tick lines: ${show(lines('[key-sweep] users '))}`);
    assert(raced.safe === false && lines('[key-sweep] SAFE:').length === 0, 'SAFE on a raced tick');
    beforeWrite = null;
    writes.length = 0;
    const next = await run(2000);
    assert(next?.users.current === 1 && writes.length === 0, `next tick: ${show(next)}, writes ${show(writes)}`);
    assert(next.safe === true && show(lines('[key-sweep] SAFE:')) === show([safeLine(KEY_B)]), `SAFE lines: ${show(lines('[key-sweep] SAFE:'))}`);
  });

  await check('#7 [RF1] SAFE: logged once per process at >= 1800 s with the legacy key gone and v2 clean; one admin message, deduplicated in Redis; idle afterwards', async () => {
    reset();
    setKeys(KEY_B, KEY_A);
    DB.user = [
      { id: 1, googleRefreshToken: sealWith(KEY_B, 'rt') },
      { id: 2, googleRefreshToken: sealWith(KEY_A, '') },
      { id: 3, googleRefreshToken: '' },
    ];
    DB.googleSyncLink = [{ id: 'link-1', unlinkToken: null }];
    store.set(V2_KEY, JSON.stringify([{ id: 1, googleToken: sealWith(KEY_B, 'rt') }, { id: 3, googleToken: '' }]));
    await run(600);
    const early = await run(1200);
    assert(early?.safe === false && lines('[key-sweep] SAFE:').length === 0, `SAFE before 1800 s: ${show(early)}`);
    const at = await run(1800);
    assert(at?.safe === true, `report: ${show(at)}`);
    assert(show(lines('[key-sweep] SAFE:')) === show([safeLine(KEY_B)]), `SAFE lines: ${show(lines('[key-sweep] SAFE:'))}`);
    assert(botSends.length === 1 && botSends[0].chatId === ADMIN_ID, `bot sends: ${show(botSends)}`);
    assert(botSends[0].text.includes(fp(KEY_B)) && botSends[0].text.includes('ENCRYPTION_KEY_PREVIOUS'), `message: ${botSends[0].text}`);
    const dedup = `keysweep:safe:${fp(KEY_A)}`;
    assert(store.has(dedup) && ttls.get(dedup) === 2592000, `dedup key ${dedup}: ${store.has(dedup)}, ttl ${ttls.get(dedup)}`);
    prismaCalls.length = 0;
    redisCalls.length = 0;
    const after = await run(2400);
    assert(after === null && prismaCalls.length === 0 && redisCalls.length === 0, `tick after SAFE: ${show(after)}, prisma ${show(prismaCalls)}, redis ${show(redisCalls)}`);
    assert(lines('[key-sweep] SAFE:').length === 1 && botSends.length === 1, 'SAFE said twice in one process');
    // A new process (the next deploy, or the other container) logs SAFE again, but the message went already
    delete (globalThis as Row).__famcalKeySweep;
    await run(600);
    await run(2400);
    assert(lines('[key-sweep] SAFE:').length === 2 && botSends.length === 1, `SAFE lines ${lines('[key-sweep] SAFE:').length}, sends ${botSends.length}`);
    assert(writes.length === 0 && captured.length === 0, `writes ${show(writes)}, captures ${show(captured)}`);
  });

  await check('#8 no SAFE while the legacy reminders:users key exists or a v2 entry is not under the current key', async () => {
    const cases: [string, () => void][] = [
      ['legacy key present', () => store.set(LEGACY_KEY, '[]')],
      ['a v2 token under the old key', () => store.set(V2_KEY, JSON.stringify([{ id: 1, googleToken: sealWith(KEY_A, 'rt') }]))],
      ['a plaintext v2 token', () => store.set(V2_KEY, JSON.stringify([{ id: 1, googleToken: 'rt-plain' }]))],
      ['a v2 entry with no googleToken', () => store.set(V2_KEY, JSON.stringify([{ id: 1, googleRefreshToken: 'rt-plain' }]))],
    ];
    for (const [name, arrange] of cases) {
      reset();
      setKeys(KEY_B, KEY_A);
      DB.user = [{ id: 1, googleRefreshToken: sealWith(KEY_B, 'rt') }];
      arrange();
      await run(600);
      const report = await run(1800);
      assert(report?.safe === false && lines('[key-sweep] SAFE:').length === 0 && botSends.length === 0, `${name}: SAFE (${show(report)})`);
      if (name === 'legacy key present') {
        assert(lines('[key-sweep] users ').some(l => l.endsWith('legacy_cache=1')), `${name}: ${show(lines('[key-sweep] users '))}`);
      }
    }
  });

  await check('#9 without ENCRYPTION_KEY_PREVIOUS legacy plaintext is still encrypted after the baseline; SAFE is neither logged nor sent, then the sweep goes idle', async () => {
    reset();
    setKeys(KEY_B, '');
    DB.user = [
      { id: 1, googleRefreshToken: 'plain-rt' },
      { id: 2, googleRefreshToken: sealWith(KEY_B, 'rt-2') },
    ];
    const base = await run(600);
    assert(base?.baseline === true && userRow(1).googleRefreshToken === 'plain-rt' && writes.length === 0, 'the baseline wrote');
    const tick = await run(1200);
    assert(tick?.users.plaintextEncrypted === 1 && openWith(KEY_B, userRow(1).googleRefreshToken) === 'plain-rt', `report: ${show(tick)}`);
    assert(tick.previousKey === 'unset', `previousKey: ${tick.previousKey}`);
    assert((writes.length as number) === 1 && writes[0].where.googleRefreshToken === 'plain-rt', `not a compare-and-set write: ${show(writes)}`);
    assert(rebuilds === 1, `rebuilds ${rebuilds}`);
    const clean = await run(1800);
    assert(clean?.safe === false, `report: ${show(clean)}`);
    prismaCalls.length = 0;
    const idle = await run(2400);
    assert(idle === null && prismaCalls.length === 0, `idle tick: ${show(idle)}, prisma ${show(prismaCalls)}`);
    assert(lines('[key-sweep] SAFE:').length === 0 && botSends.length === 0, 'SAFE without a PREVIOUS key');
  });

  await check('#10 [RF4] ENCRYPTION_KEY_PREVIOUS equal to ENCRYPTION_KEY: no writes, no SAFE, no message, nothing breaks', async () => {
    reset();
    setKeys(KEY_B, KEY_B);
    DB.user = [
      { id: 1, googleRefreshToken: sealWith(KEY_B, 'rt') },
      { id: 2, googleRefreshToken: sealWith(KEY_B, '') },
      { id: 3, googleRefreshToken: '' },
    ];
    DB.googleSyncLink = [{ id: 'link-1', unlinkToken: sealWith(KEY_B, 'rt-l') }];
    const before = snapshot();
    await run(600);
    const pass = await run(1200);
    assert(pass?.previousKey === 'same', `report: ${show(pass)}`);
    assert(pass.users.current === 1 && pass.users.emptyCipher === 1 && pass.links.current === 1, `counts: ${show(pass)}`);
    assert(pass.safe === false, 'SAFE with equal keys');
    prismaCalls.length = 0;
    const later = [await run(1800), await run(2400)];
    assert(later.every(r => r === null) && prismaCalls.length === 0, `later ticks: ${show(later)}, prisma ${show(prismaCalls)}`);
    assert(writes.length === 0 && snapshot() === before && rebuilds === 0, `writes ${show(writes)}, rebuilds ${rebuilds}`);
    assert(lines('[key-sweep] SAFE:').length === 0 && botSends.length === 0, 'SAFE said');
    assert(!captured.some(c => c.context.startsWith('key-sweep')), `captures: ${show(captured)}`);
  });

  await check('#11 the Redis lock: taken with NX EX 300 and released; a held lock skips the tick quietly; a Redis error skips it with a warning', async () => {
    reset();
    setKeys(KEY_B, KEY_A);
    DB.user = [{ id: 1, googleRefreshToken: sealWith(KEY_A, 'rt') }];
    await run(600);
    const lockSets = setOptions.filter(s => s.key === LOCK_KEY);
    assert(lockSets.length === 1 && lockSets[0].opts?.nx === true && lockSets[0].opts?.ex === 300, `lock sets: ${show(lockSets)}`);
    assert(!store.has(LOCK_KEY), 'the lock was not released');
    store.set(LOCK_KEY, 'other-container');
    prismaCalls.length = 0;
    logs.length = 0;
    const held = await run(1200);
    assert(held === null && prismaCalls.length === 0 && store.get(LOCK_KEY) === 'other-container', `held: ${show(held)}, prisma ${show(prismaCalls)}`);
    assert(!logs.some(l => l.startsWith('[key-sweep]')), `a held lock logged: ${show(logs)}`);
    store.delete(LOCK_KEY);
    redisDown = true;
    const down = await run(1200);
    redisDown = false;
    assert(down === null && prismaCalls.length === 0, `Redis down: ${show(down)}, prisma ${show(prismaCalls)}`);
    assert(logs.some(l => l.startsWith('[key-sweep] Redis lock failed')), `logs: ${show(logs)}`);
    const after = await run(1200);
    assert(after?.users.converted === 1, `the next tick did not run: ${show(after)}`);
  });

  await check('#12 rows are walked in batches of 100 by id, so all 250 tokens move', async () => {
    reset();
    setKeys(KEY_B, KEY_A);
    DB.user = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, googleRefreshToken: sealWith(KEY_A, `rt-${i + 1}`) }));
    await run(600);
    finds.length = 0;
    const report = await run(1200);
    const userFinds = finds.filter(f => f.model === 'user');
    assert(userFinds.length === 3 && userFinds.every(f => f.args.take === 100), `user reads: ${show(userFinds.map(f => f.args))}`);
    assert(report?.users.converted === 250, `report: ${show(report)}`);
    assert(DB.user.every(r => openWith(KEY_B, r.googleRefreshToken) === `rt-${r.id}`), 'a row was not moved');
  });

  await check('#13 the scheduler runs runKeySweep every 10 minutes; a failing tick is captured as cron-key-sweep and leaves no lock', async () => {
    reset();
    setKeys(KEY_B, KEY_A);
    DB.user = [{ id: 1, googleRefreshToken: sealWith(KEY_A, 'rt') }];
    cronJobs.length = 0;
    const { startScheduler } = await import('../src/cron/scheduler');
    startScheduler();
    const job = cronJobs.find(j => j.expr === '*/10 * * * *');
    assert(job, `schedules: ${show(cronJobs.map(j => j.expr))}`);
    const realUptime = process.uptime;
    process.uptime = () => 5000;
    prismaDown = true;
    try {
      await job.fn();
    } finally {
      process.uptime = realUptime;
      prismaDown = false;
    }
    assert(captured.some(c => c.context === 'cron-key-sweep' && c.message.includes('smoke: database is down')), `captures: ${show(captured)}`);
    assert(!store.has(LOCK_KEY), 'the lock outlived the failed tick');
  });

  await check('#14 docs: .env.example has a commented ENCRYPTION_KEY_PREVIOUS and SESSION_SECRET as required with no fallback; README has the rule and the SAFE line; CLAUDE.md has the rule', () => {
    const example = read('.env.example').split('\n');
    assert(example.some(l => l.startsWith('# ENCRYPTION_KEY_PREVIOUS=')), '.env.example has no commented ENCRYPTION_KEY_PREVIOUS line');
    assert(!example.some(l => l.startsWith('ENCRYPTION_KEY_PREVIOUS=')), '.env.example sets ENCRYPTION_KEY_PREVIOUS uncommented');
    const sessionAt = example.findIndex(l => l.startsWith('# SESSION_SECRET='));
    const sessionNote = example.slice(Math.max(0, sessionAt - 4), Math.max(0, sessionAt)).join('\n');
    assert(sessionAt > 0 && /required, no fallback/i.test(sessionNote) && !/falls back/i.test(sessionNote), `SESSION_SECRET note: ${show(sessionNote)}`);
    const rule = /never replace `ENCRYPTION_KEY` without setting `ENCRYPTION_KEY_PREVIOUS`/i;
    const readme = read('README.md');
    assert(readme.includes(SAFE_TEMPLATE), 'README has no SAFE line');
    assert(rule.test(readme), 'README has no rotation rule');
    assert(/^\|[^\n]*`ENCRYPTION_KEY_PREVIOUS`/m.test(readme), 'README\'s env table has no ENCRYPTION_KEY_PREVIOUS row');
    const claude = fs.existsSync(path.join(ROOT, 'CLAUDE.md')) ? read('CLAUDE.md') : '';
    assert(rule.test(claude), 'CLAUDE.md has no rotation rule');
  });

  restoreConsole();
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  restoreConsole();
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the smoke and see it fail**

Run: `bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-key-sweep.ts`

Expected: `0/14 passed`, exit 1.
- #1-#3 and #5-#12 fail with tsx's "Cannot find module" error for `../src/services/key-rotation`, which doesn't exist yet. Every check that runs a tick imports it through `loadSweep()`.
- #4 runs no tick of its own, so it fails with `key-sweep-unreadable captures over two ticks: 0` (no tick ran in #3).
- #13 fails with `schedules: [...]`: the scheduler has no `'*/10 * * * *'` job.
- #14 fails with `.env.example has no commented ENCRYPTION_KEY_PREVIOUS line`.

If anything else fails (a stub or loader error), fix the smoke before going on.

- [ ] **Step 3: Create `src/services/key-rotation.ts`**

```ts
/**
 * Key sweep (secret rotation spec 2026-10-22, (a) "Key sweep").
 *
 * After ENCRYPTION_KEY is replaced and the old value is put in ENCRYPTION_KEY_PREVIOUS,
 * every stored Google token still decrypts through the fallback. This moves each one to the
 * current key, so the old key can go. Runs every 10 minutes from the scheduler:
 * - nothing before 10 minutes of uptime: during a deploy the old container may still serve;
 * - one tick at a time across containers (a Redis lock);
 * - the first tick only counts (the baseline line);
 * - every write is a compare-and-set on the value read, so a token Google refreshed in
 *   between is never overwritten: the row counts as raced and is retried next tick;
 * - legacy plaintext is encrypted too, with or without a PREVIOUS key;
 * - empty ciphers (a user with no token) and tokens neither key opens are never written.
 * When nothing needs the PREVIOUS key any more, it logs SAFE once per process and tells the
 * admins once (Redis dedup). Once it has nothing left to do in this process, it stops
 * reading the database, so Neon can scale to zero. It logs ids, counts and fingerprints,
 * never values.
 */

import { randomUUID } from 'crypto';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { captureError } from '../lib/error-capture';
import {
  decryptDetailed,
  encrypt,
  isEmptyCipher,
  isEncrypted,
  keyFingerprint,
  previousKeyStatus,
  type PreviousKeyStatus,
} from '../utils/encryption';
import { LEGACY_REMINDER_CACHE_KEY, REMINDER_CACHE_KEY } from './reminder-cache';

/** The old container may still serve during a deploy's first minutes: nothing runs before this. */
const GATE_UPTIME_S = 600;
/** SAFE waits this long, so it is said well after any overlap with the old container. */
const SAFE_UPTIME_S = 1800;
const LOCK_KEY = 'keysweep:lock';
const LOCK_TTL_S = 300;
const SAFE_DEDUP_PREFIX = 'keysweep:safe:';
const SAFE_DEDUP_TTL_S = 30 * 24 * 60 * 60;
const BATCH_SIZE = 100;
const MAX_IDS_IN_ALERT = 30;

export interface KeySweepCounts {
  /** Under ENCRYPTION_KEY already. */
  current: number;
  /** Found under ENCRYPTION_KEY_PREVIOUS (then converted or raced). */
  previous: number;
  /** Moved to ENCRYPTION_KEY by a compare-and-set write. */
  converted: number;
  /** Legacy plaintext found (then encrypted or raced). */
  plaintext: number;
  /** Legacy plaintext encrypted by a compare-and-set write. */
  plaintextEncrypted: number;
  /** `iv:tag:` with no data: a user with no token. Never written. */
  emptyCipher: number;
  /** Compare-and-set writes that found a newer value. Retried next tick. */
  raced: number;
  /** Opens with neither key. Never written. */
  unreadable: number;
  /** Row ids of the unreadable ones, never their values. */
  unreadableIds: string[];
}

export interface KeySweepReport {
  /** The first tick after the uptime gate: it counted and wrote nothing. */
  baseline: boolean;
  previousKey: PreviousKeyStatus;
  /** User.googleRefreshToken */
  users: KeySweepCounts;
  /** GoogleSyncLink.unlinkToken */
  links: KeySweepCounts;
  /** Whether the legacy `reminders:users` key still exists; null on the baseline tick. */
  legacyCache: boolean | null;
  /** rebuildReminderCache() ran after a write and finished. */
  cacheRebuilt: boolean;
  /** The SAFE condition held on this tick. */
  safe: boolean;
}

interface SweepState {
  /** The read-only baseline tick ran. */
  baselineDone: boolean;
  /** The last pass found nothing to write: no PREVIOUS-key, plaintext or raced rows. */
  settled: boolean;
  /** The unreadable rows that pass left. SAFE can't follow them in this process. */
  settledUnreadable: number;
  safeLogged: boolean;
  unreadableReported: boolean;
  keyProblemReported: boolean;
}

/**
 * Once-per-process state. It lives on globalThis because Next 16 gives the scheduler
 * bundle and the route bundles separate copies of this module.
 */
function sweepState(): SweepState {
  const g = globalThis as { __famcalKeySweep?: SweepState };
  return (g.__famcalKeySweep ??= {
    baselineDone: false,
    settled: false,
    settledUnreadable: 0,
    safeLogged: false,
    unreadableReported: false,
    keyProblemReported: false,
  });
}

type Classified =
  | { kind: 'current' | 'empty_cipher' | 'unreadable' }
  | { kind: 'previous' | 'plaintext'; plain: string };

/** What a stored value is; null for no token (''). Never throws. */
function classify(raw: string): Classified | null {
  if (!raw) return null;
  // A user with no token, whose row the old select-calendars save wrote as encrypt('')
  if (isEmptyCipher(raw)) return { kind: 'empty_cipher' };
  if (!isEncrypted(raw)) return { kind: 'plaintext', plain: raw };
  try {
    // 'previous' comes back only while ENCRYPTION_KEY_PREVIOUS is valid and differs from
    // the key (encryption.ts), so conversion runs only then.
    const { value, key } = decryptDetailed(raw);
    return key === 'current' ? { kind: 'current' } : { kind: 'previous', plain: value };
  } catch {
    // Neither key opens it (UndecryptableError) or it is malformed. It is counted by id,
    // logged and reported once per process in reportUnreadable(), and never written.
    return { kind: 'unreadable' };
  }
}

interface TokenColumn<Id extends number | string> {
  read(after: Id | null): Promise<Array<{ id: Id; value: string }>>;
  /** Compare-and-set: writes only while the row still holds `old`. Returns the rows written (0 or 1). */
  write(id: Id, old: string, next: string): Promise<number>;
}

const USER_TOKENS: TokenColumn<number> = {
  async read(after) {
    const rows = await prisma.user.findMany({
      where: after === null ? { googleRefreshToken: { not: '' } } : { googleRefreshToken: { not: '' }, id: { gt: after } },
      select: { id: true, googleRefreshToken: true },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    });
    return rows.map(r => ({ id: r.id, value: r.googleRefreshToken }));
  },
  async write(id, old, next) {
    const { count } = await prisma.user.updateMany({
      where: { id, googleRefreshToken: old },
      data: { googleRefreshToken: next },
    });
    return count;
  },
};

const LINK_TOKENS: TokenColumn<string> = {
  async read(after) {
    const rows = await prisma.googleSyncLink.findMany({
      where: after === null ? { unlinkToken: { not: null } } : { unlinkToken: { not: null }, id: { gt: after } },
      select: { id: true, unlinkToken: true },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    });
    return rows.map(r => ({ id: r.id, value: r.unlinkToken ?? '' }));
  },
  async write(id, old, next) {
    const { count } = await prisma.googleSyncLink.updateMany({
      where: { id, unlinkToken: old },
      data: { unlinkToken: next },
    });
    return count;
  },
};

function emptyCounts(): KeySweepCounts {
  return { current: 0, previous: 0, converted: 0, plaintext: 0, plaintextEncrypted: 0, emptyCipher: 0, raced: 0, unreadable: 0, unreadableIds: [] };
}

/** Walks one column in batches by id. With `write`, moves PREVIOUS-key and plaintext values to the current key. */
async function sweepColumn<Id extends number | string>(column: TokenColumn<Id>, write: boolean): Promise<KeySweepCounts> {
  const counts = emptyCounts();
  let after: Id | null = null;
  for (;;) {
    const rows = await column.read(after);
    for (const row of rows) {
      const found = classify(row.value);
      if (!found) continue;
      switch (found.kind) {
        case 'current':
          counts.current++;
          break;
        case 'empty_cipher':
          counts.emptyCipher++;
          break;
        case 'unreadable':
          counts.unreadable++;
          counts.unreadableIds.push(String(row.id));
          break;
        case 'previous':
          counts.previous++;
          if (write) {
            if ((await column.write(row.id, row.value, encrypt(found.plain))) > 0) counts.converted++;
            else counts.raced++;
          }
          break;
        case 'plaintext':
          counts.plaintext++;
          if (write) {
            if ((await column.write(row.id, row.value, encrypt(found.plain))) > 0) counts.plaintextEncrypted++;
            else counts.raced++;
          }
          break;
      }
    }
    if (rows.length < BATCH_SIZE) return counts;
    after = rows[rows.length - 1].id;
  }
}

const baselineCounts = (c: KeySweepCounts) =>
  `current=${c.current} previous=${c.previous} plaintext=${c.plaintext} empty_cipher=${c.emptyCipher} unreadable=${c.unreadable}`;
const tickCounts = (c: KeySweepCounts) =>
  `current=${c.current} converted=${c.converted} raced=${c.raced} unreadable=${c.unreadable} plaintext_encrypted=${c.plaintextEncrypted} empty_cipher=${c.emptyCipher}`;
/** The pass found a row to write (or one it lost to a newer write). */
const hasWork = (c: KeySweepCounts) => c.previous + c.plaintext + c.raced > 0;

/** Ids only, never values. Logged every tick; captured and sent to the admins once per process. */
async function reportUnreadable(users: KeySweepCounts, links: KeySweepCounts, state: SweepState): Promise<void> {
  const total = users.unreadable + links.unreadable;
  if (total === 0) return;
  const all = (ids: string[]) => (ids.length ? ids.join(', ') : 'none');
  console.error(`[key-sweep] ${total} stored tokens decrypt with neither key (ids only): users ${all(users.unreadableIds)}; links ${all(links.unreadableIds)}`);
  if (state.unreadableReported) return;
  state.unreadableReported = true;
  captureError(
    new Error(`key sweep: ${total} stored Google tokens decrypt with neither ENCRYPTION_KEY nor ENCRYPTION_KEY_PREVIOUS`),
    'key-sweep-unreadable',
    { ids: { users: users.unreadableIds, links: links.unreadableIds } },
  );
  const some = (ids: string[]) =>
    ids.length <= MAX_IDS_IN_ALERT ? all(ids) : `${ids.slice(0, MAX_IDS_IN_ALERT).join(', ')} and ${ids.length - MAX_IDS_IN_ALERT} more`;
  try {
    const { notifyAdminWarning } = await import('../utils/error-notifier');
    await notifyAdminWarning(
      'key-sweep',
      `${total} stored Google tokens decrypt with neither ENCRYPTION_KEY nor ENCRYPTION_KEY_PREVIOUS, so those users count as not connected. Nothing was overwritten. Check that ENCRYPTION_KEY_PREVIOUS holds the old key.\n\nUsers: ${some(users.unreadableIds)}\nCopy links: ${some(links.unreadableIds)}`,
    );
  } catch (error) {
    console.error('[key-sweep] Unreadable-token alert failed:', error);
    captureError(error, 'key-sweep-alert', {}, 'warning');
  }
}

/** After a write: the Redis copy of the tokens moves to the current key too. */
async function rebuildCache(): Promise<boolean> {
  try {
    const { rebuildReminderCache } = await import('../cron/handlers');
    const synced = await rebuildReminderCache();
    console.log(`[key-sweep] Reminder cache rebuilt under the current key (${synced} users)`);
    return true;
  } catch (error) {
    console.error('[key-sweep] Reminder cache rebuild failed:', error);
    captureError(error, 'key-sweep-cache-rebuild');
    return false;
  }
}

/** Every reminders:users:v2 entry's googleToken is '' or opens with the current key. */
async function reminderCacheIsCurrent(): Promise<boolean> {
  const entries = await redis.get<unknown>(REMINDER_CACHE_KEY);
  if (entries === null) return true;
  if (!Array.isArray(entries)) return false;
  return entries.every(entry => {
    const token = (entry as { googleToken?: unknown } | null)?.googleToken;
    if (token === '') return true;
    if (typeof token !== 'string' || !isEncrypted(token)) return false;
    try {
      return decryptDetailed(token).key === 'current';
    } catch {
      // Opens with neither key: not current, so no SAFE. The hourly rebuild rewrites it.
      return false;
    }
  });
}

/** One Telegram message per PREVIOUS key, across processes and deploys (Redis dedup). */
async function announceSafe(fpCurrent: string, fpPrevious: string): Promise<void> {
  let first: unknown;
  try {
    first = await redis.set(`${SAFE_DEDUP_PREFIX}${fpPrevious}`, '1', { nx: true, ex: SAFE_DEDUP_TTL_S });
  } catch (error) {
    console.error('[key-sweep] SAFE message dedup failed; not sending it:', error);
    captureError(error, 'key-sweep-safe-dedup', {}, 'warning');
    return;
  }
  if (first !== 'OK') {
    console.log('[key-sweep] SAFE message already sent for this ENCRYPTION_KEY_PREVIOUS');
    return;
  }
  try {
    const { getAdminUserIds } = await import('../utils/error-notifier');
    const { getBot } = await import('./telegram/bot');
    const bot = getBot();
    const text =
      `<b>Key rotation finished</b>\n\nEvery stored Google token is under ENCRYPTION_KEY (fp <code>${fpCurrent}</code>). ` +
      `Nothing needs ENCRYPTION_KEY_PREVIOUS (fp <code>${fpPrevious}</code>) any more: remove it at the next deploy.`;
    for (const adminId of await getAdminUserIds()) {
      try {
        await bot.sendMessage(adminId, text, { parse_mode: 'HTML' });
      } catch (error) {
        console.error(`[key-sweep] SAFE message to admin ${adminId} failed:`, error);
        captureError(error, 'key-sweep-safe-notify', { admin_id: adminId }, 'warning');
      }
    }
  } catch (error) {
    console.error('[key-sweep] SAFE message failed:', error);
    captureError(error, 'key-sweep-safe-notify', {}, 'warning');
  }
}

/** Only the lock this tick took; it expires on its own within 5 minutes anyway. */
async function releaseLock(token: string): Promise<void> {
  try {
    if ((await redis.get<string>(LOCK_KEY)) === token) await redis.del(LOCK_KEY);
  } catch (error) {
    console.warn('[key-sweep] Lock release failed (it expires in 5 minutes):', error);
    captureError(error, 'key-sweep-unlock', {}, 'warning');
  }
}

async function sweep(uptime: number, state: SweepState): Promise<KeySweepReport> {
  const previousKey = previousKeyStatus();
  const baseline = !state.baselineDone;
  const users = await sweepColumn(USER_TOKENS, !baseline);
  const links = await sweepColumn(LINK_TOKENS, !baseline);
  const report: KeySweepReport = { baseline, previousKey, users, links, legacyCache: null, cacheRebuilt: false, safe: false };

  if (baseline) {
    console.log(`[key-sweep] baseline: users ${baselineCounts(users)}; links ${baselineCounts(links)}`);
    state.baselineDone = true;
    await reportUnreadable(users, links, state);
    return report;
  }

  if (users.converted + users.plaintextEncrypted + links.converted + links.plaintextEncrypted > 0) {
    report.cacheRebuilt = await rebuildCache();
  }
  report.legacyCache = (await redis.exists(LEGACY_REMINDER_CACHE_KEY)) > 0;
  console.log(`[key-sweep] users ${tickCounts(users)}; links ${tickCounts(links)}; legacy_cache=${report.legacyCache ? 1 : 0}`);
  await reportUnreadable(users, links, state);

  const work = hasWork(users) || hasWork(links);
  const unreadable = users.unreadable + links.unreadable;
  state.settled = !work;
  state.settledUnreadable = work ? 0 : unreadable;

  report.safe =
    previousKey === 'valid' &&
    uptime >= SAFE_UPTIME_S &&
    !work &&
    unreadable === 0 &&
    !report.legacyCache &&
    (await reminderCacheIsCurrent());
  if (report.safe && !state.safeLogged) {
    state.safeLogged = true;
    const fpCurrent = keyFingerprint('current') ?? 'unknown';
    const fpPrevious = keyFingerprint('previous') ?? 'unknown';
    console.log(`[key-sweep] SAFE: every stored token is under ENCRYPTION_KEY (fp ${fpCurrent}); nothing needs ENCRYPTION_KEY_PREVIOUS. You can remove it at the next deploy.`);
    await announceSafe(fpCurrent, fpPrevious);
  }
  return report;
}

/**
 * One sweep tick. Returns null when gated (under 10 minutes of uptime), idle (nothing left
 * to do in this process), skipped (ENCRYPTION_KEY missing or invalid, the lock held
 * elsewhere, or Redis failing on the lock). Database errors propagate to the scheduler,
 * which captures them as cron-key-sweep.
 */
export async function runKeySweep(opts: { uptimeSeconds?: number } = {}): Promise<KeySweepReport | null> {
  const uptime = opts.uptimeSeconds ?? process.uptime();
  if (uptime < GATE_UPTIME_S) return null;

  const state = sweepState();
  // Idle: SAFE was said, or the last pass found nothing to write and nothing more can
  // come of a pass in this process (no PREVIOUS key to retire, or rows neither key opens,
  // already reported). No database read every 10 minutes, so Neon can scale to zero.
  if (state.safeLogged) return null;
  if (state.settled && (previousKeyStatus() !== 'valid' || state.settledUnreadable > 0)) return null;

  if (keyFingerprint('current') === null) {
    console.error('[key-sweep] ENCRYPTION_KEY is missing or invalid: skipping the sweep');
    if (!state.keyProblemReported) {
      state.keyProblemReported = true;
      captureError(new Error('ENCRYPTION_KEY is missing or invalid'), 'key-sweep-no-key');
    }
    return null;
  }

  const lockToken = randomUUID();
  try {
    const taken = await redis.set(LOCK_KEY, lockToken, { nx: true, ex: LOCK_TTL_S });
    if (taken !== 'OK') return null; // another container's tick holds it
  } catch (error) {
    console.warn('[key-sweep] Redis lock failed; skipping this tick:', error);
    captureError(error, 'key-sweep-lock', {}, 'warning');
    return null;
  }
  try {
    return await sweep(uptime, state);
  } finally {
    await releaseLock(lockToken);
  }
}
```

- [ ] **Step 4: Run the smoke: the sweep checks pass, the scheduler and docs checks still fail**

Run: `bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-key-sweep.ts`

Expected: `12/14 passed`. #13 still fails (no `'*/10 * * * *'` job) and so does #14 (no `# ENCRYPTION_KEY_PREVIOUS=` line).

- [ ] **Step 5: Schedule the sweep in `src/cron/scheduler.ts`**

Task 3 has already added the boot step. These two snippets are untouched by it.

Replace:

```ts
      console.error('[Scheduler] Health check failed:', error);
      captureError(error, 'cron-health-check');
      notifyAdmin('Health Check', error);
    }
  });
```

with:

```ts
      console.error('[Scheduler] Health check failed:', error);
      captureError(error, 'cron-health-check');
      notifyAdmin('Health Check', error);
    }
  });

  // Key sweep — every 10 minutes. After an ENCRYPTION_KEY rotation it re-encrypts the stored
  // Google tokens under the new key and says SAFE once ENCRYPTION_KEY_PREVIOUS can go. Idle for
  // the first 10 minutes of uptime and once nothing is left to do (src/services/key-rotation.ts).
  cron.schedule('*/10 * * * *', async () => {
    try {
      const { runKeySweep } = await import('../services/key-rotation');
      await runKeySweep();
    } catch (error) {
      console.error('[Scheduler] Key sweep failed:', error);
      captureError(error, 'cron-key-sweep');
      notifyAdmin('Key Sweep', error);
    }
  });
```

Replace:

```ts
  console.log('  0 3 * * *    Health check (UTC 3:00 = Israel ~6:00)');
```

with:

```ts
  console.log('  0 3 * * *    Health check (UTC 3:00 = Israel ~6:00)');
  console.log('  */10 * * * * Key sweep (re-encrypts stored Google tokens after a key rotation; idle in the first 10 min)');
```

Run the smoke again. Expected: `13/14 passed`; only #14 (docs) fails.

- [ ] **Step 6: Docs: `.env.example`, `README.md`, and a new `CLAUDE.md`**

In `.env.example`, replace:

```
# Signs the WhatsApp session cookie set by magic links (a random value of its own;
# falls back to CRON_SECRET when unset)
# SESSION_SECRET=your_random_session_secret_here
```

with:

```
# Required, no fallback: a random value of its own (openssl rand -hex 32). The WhatsApp
# session cookie and the share-story image links are signed with keys derived from it;
# unset, both are refused.
# SESSION_SECRET=your_random_session_secret_here

# Encrypts the stored Google tokens: 64 hex characters (openssl rand -hex 32). Never
# replace it without setting ENCRYPTION_KEY_PREVIOUS (README: Rotating ENCRYPTION_KEY).
# ENCRYPTION_KEY=your_encryption_key_here
# Decrypt-only: the old ENCRYPTION_KEY while a rotation runs; delete it once the key sweep logs SAFE
# ENCRYPTION_KEY_PREVIOUS=your_old_encryption_key_here
```

The `# SESSION_SECRET=` line itself is unchanged: `smoke-auth-leftovers.ts` #9 and `smoke-google-connect.ts` #24 match it.

In `README.md`, replace:

```markdown
| `WHATSAPP_APP_SECRET` | The Meta app secret, which verifies WhatsApp webhook signatures (`X-Hub-Signature-256`); production logs a warning when it is unset |
```

with:

```markdown
| `WHATSAPP_APP_SECRET` | Required. The Meta app secret, which verifies WhatsApp webhook signatures (`X-Hub-Signature-256`); unset, every WhatsApp webhook is refused (500) and production startup logs an error |
```

Replace:

```markdown
| `SESSION_SECRET` | Signs the WhatsApp session cookie set by magic links; use its own random value (unset, `CRON_SECRET` signs it and production logs a warning) |
```

with:

```markdown
| `SESSION_SECRET` | Required, no fallback: its own random value (`openssl rand -hex 32`), never `CRON_SECRET`'s. The WhatsApp session cookie and the share-story image links are signed with keys derived from it; unset, both are refused and production startup logs an error. Changing it signs WhatsApp web users out once |
| `ENCRYPTION_KEY` | Encrypts the stored Google tokens: 64 hex characters (`openssl rand -hex 32`). See [Rotating `ENCRYPTION_KEY`](#rotating-encryption_key) |
| `ENCRYPTION_KEY_PREVIOUS` | Optional and decrypt-only: the old `ENCRYPTION_KEY` while a rotation runs; delete it once the key sweep logs SAFE |
```

Replace:

```markdown
The models are not configurable: text and TTS are fixed in `src/config/ai-models.ts` and `src/config/tts-models.ts`, and the voices per language in `src/services/voice-generator.ts`.

### Install & run
```

with:

```markdown
The models are not configurable: text and TTS are fixed in `src/config/ai-models.ts` and `src/config/tts-models.ts`, and the voices per language in `src/services/voice-generator.ts`.

### Rotating `ENCRYPTION_KEY`

`ENCRYPTION_KEY` encrypts every stored Google token. **Never replace `ENCRYPTION_KEY` without setting `ENCRYPTION_KEY_PREVIOUS` to the old value in the same deploy.** Without it, every Google-connected user counts as not connected until the old key is back.

1. Generate the new key with `openssl rand -hex 32`.
2. In one deploy, set `ENCRYPTION_KEY_PREVIOUS` to the current key and `ENCRYPTION_KEY` to the new one. The startup log prints both fingerprints (`[startup] ENCRYPTION_KEY fp …; ENCRYPTION_KEY_PREVIOUS fp …`). The PREVIOUS fingerprint must equal the `ENCRYPTION_KEY` fingerprint the deploy before printed.
3. The key sweep (`src/services/key-rotation.ts`) runs every 10 minutes and is idle for the first 10 minutes of uptime. It logs a `[key-sweep] baseline:` line first. Then it re-encrypts every stored token under the new key with compare-and-set writes and rebuilds the reminder cache.
4. Once nothing needs the old key, after at least 30 minutes of uptime, it logs this line once per process and tells the admins on Telegram once:

   `[key-sweep] SAFE: every stored token is under ENCRYPTION_KEY (fp XXXXXXXX); nothing needs ENCRYPTION_KEY_PREVIOUS. You can remove it at the next deploy.`

5. Delete `ENCRYPTION_KEY_PREVIOUS` at a later deploy. If it is removed before SAFE, the tokens not yet converted can't be read; put it back and they read again.

To roll back, swap the two values: the sweep converts back. The sweep stops reading the database until the next deploy once SAFE is logged, or, with no `ENCRYPTION_KEY_PREVIOUS`, once nothing is left to encrypt. That way Neon can still scale to zero.

### Install & run
```

Create `CLAUDE.md` at the repo root:

```markdown
# CLAUDE.md

Rules for coding agents in this repo. Setup, env vars and deployment are in README.md.

- Never replace `ENCRYPTION_KEY` without setting `ENCRYPTION_KEY_PREVIOUS` to the old value in the same deploy, and remove `ENCRYPTION_KEY_PREVIOUS` only after the key sweep logs `[key-sweep] SAFE` (README, "Rotating `ENCRYPTION_KEY`").
```

- [ ] **Step 7: Run the smoke: all pass**

Run: `bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-key-sweep.ts`

Expected: `14/14 passed`, exit 0.

- [ ] **Step 8: Typecheck, lint, and the smokes this change can break**

Run, from the repo root:

```bash
npx tsc --noEmit -p .
npm run -s lint
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-key-sweep.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-encryption.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-key-rotation.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-reminders.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-auth-leftovers.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-google-connect.ts
```

Expected: tsc and lint are clean (no new warnings), and every smoke ends with `N/N passed`. Why each one:
- `smoke-auth-leftovers.ts` #9 and `smoke-google-connect.ts` #24 read README's env table and `.env.example`.
- `smoke-reminders.ts` and `smoke-key-rotation.ts` cover the scheduler, the cache and the encryption paths the sweep shares.

- [ ] **Step 9: Commit**

```bash
git add src/services/key-rotation.ts src/cron/scheduler.ts scripts/smoke-key-sweep.ts .env.example README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
feat(security): key sweep moves stored Google tokens to the current ENCRYPTION_KEY and says when PREVIOUS can go

Every 10 minutes after 10 minutes of uptime, under a Redis lock: a read-only
baseline, then compare-and-set re-encryption of User.googleRefreshToken and
GoogleSyncLink.unlinkToken (PREVIOUS-key values and legacy plaintext), a
reminder-cache rebuild after any write, and a SAFE line plus one admin
message once nothing needs ENCRYPTION_KEY_PREVIOUS. Idle once nothing is left
to do in the process, so Neon can scale to zero. Docs: the rotation rule in
README and CLAUDE.md, ENCRYPTION_KEY_PREVIOUS and a required SESSION_SECRET
in .env.example.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```


### Task 6: Image links and app keys derived from SESSION_SECRET

**Deviation:** the spec puts these checks in `scripts/smoke-secret-hygiene.ts`; per the interface contract they live in a new `scripts/smoke-image-link.ts` (Task 9 owns smoke-secret-hygiene). The sign route's 500 relies on `appKey`'s own `captureError('app-key-missing', {purpose: 'image-link'})`, once per process, plus a `console.error` on every refused request, rather than one Sentry event per request. The weather-image route also requires `ts` to be plain digits (at most 16) before it becomes a number; the signed payload string is unchanged.

**Files:**
- Create: `src/lib/app-keys.ts`
- Create: `src/lib/image-link.ts`
- Modify: `app/api/weather-image/route.ts` (lines 1-3 imports, 8-31 `validateSignature`, 47 the check)
- Modify: `app/api/weather-image/sign/route.ts` (lines 5-6 imports, 34 after `source`, 77-84 the signing)
- Test: `scripts/smoke-image-link.ts` (new)

**Interfaces:**
- Consumes: `captureError(error: unknown, context: string, extra?: ErrorContext)` from `src/lib/error-capture.ts`.
- Produces:
  - `export type AppKeyPurpose = 'session-cookie' | 'image-link'`
  - `export function appKey(purpose: AppKeyPurpose): Buffer | null` (`hkdfSync('sha256', SESSION_SECRET, '', 'famcal/<purpose>/v1', 32)`; null when `SESSION_SECRET` is unset or `''`, reported once per process per purpose with `captureError(err, 'app-key-missing', { purpose })`; the once-set is `globalThis.__famcalAppKeyMissing: Set<AppKeyPurpose>`)
  - `export interface ImageLinkParams { userId: string; source: string; msgId?: string | null; ts: number }`
  - `export function signImageLink(p: ImageLinkParams): string | null`
  - `export function verifyImageLink(p: ImageLinkParams, sig: string, nowMs?: number): boolean`

- [ ] **Step 1: Write the failing smoke**

Create `scripts/smoke-image-link.ts`:

```ts
// Smoke test for the share-story image links (secret rotation, spec section b). The links
// were signed with ENCRYPTION_KEY || CRON_SECRET, so one secret did another's job and
// rotating ENCRYPTION_KEY also changed the image links. Now they are signed with their own
// key, derived from SESSION_SECRET by HKDF (src/lib/app-keys.ts), with no fallback:
// without SESSION_SECRET no link is signed or accepted, and sign refuses before it builds
// an image. A link's time may run at most 60 s ahead of the server's clock.
//
// Real: app-keys, image-link and both weather-image routes. Faked at the boundaries:
// Redis (in memory), the user auth (a proved user 9 with a location), the rate limiter,
// error capture (recorded) and the weather services (every build recorded). No network,
// no DB.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-image-link.ts

import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
const env = process.env as Record<string, string | undefined>;

// Every value this smoke depends on is set here, never taken from the fake env.
const SESSION = 'test-session-secret-image';
const ENC_KEY = '0'.repeat(64);
const CRON = 'test-cron-image';
Object.assign(env, {
  TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || 'test',
  SESSION_SECRET: SESSION,
  ENCRYPTION_KEY: ENC_KEY,
  ENCRYPTION_KEY_PREVIOUS: '',
  CRON_SECRET: CRON,
  NEXT_PUBLIC_APP_URL: 'https://famcal.test',
});

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

const show = (value: unknown) => JSON.stringify(value);
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));
/** A second copy of a module, as another Next bundle holds it (require's cache dropped). */
function freshCopy(rel: string): Row {
  const file = path.join(ROOT, rel);
  delete nodeRequire.cache[file];
  return nodeRequire(file);
}

/** Runs fn with `vars` set in process.env, then puts the old values back. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, env[k]]));
  Object.assign(env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
}

// ---- Boundaries: stubs in require's cache, served to import() by a load hook ----

const Module = nodeRequire('module');
const stubs: Record<string, Row> = {};
(globalThis as Row).__smokeStubs = stubs;
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs)) return nextLoad(url, context);
    const names = Object.keys(stubs[file]).filter(n => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
    const source = [
      `const s = globalThis.__smokeStubs[${JSON.stringify(file)}];`,
      ...names.map(n => `export const ${n} = s[${JSON.stringify(n)}];`),
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

const redisStore = new Map<string, string>();
/** Every captureError: its context, its extra and the error's message. */
const captured: { ctx: string; extra?: Row; message: string }[] = [];
/** Every weather image build step that ran. */
const builds: string[] = [];

const USER = { id: 9, telegramId: 111111111, location: 'Tel Aviv', language: 'en', culture: 'default', name: 'Tal' };

function installStubs() {
  stub('src/utils/redis.ts', {
    redis: {
      get: async (k: string) => redisStore.get(k) ?? null,
      set: async (k: string, v: string) => { redisStore.set(k, v); return 'OK'; },
    },
  });
  stub('src/lib/rate-limit.ts', {
    generalRateLimiter: { name: 'general' },
    checkRateLimit: async () => ({ success: true, limit: 99, remaining: 99, reset: 0 }),
    getRateLimitHeaders: () => ({}),
  });
  const { NextResponse } = nodeRequire('next/server');
  // The proved user is 9 (auth itself is covered by smoke-oauth-weather.ts and smoke-initdata-header.ts)
  stub('src/lib/api-auth.ts', {
    verifyUserAuth: async (_req: unknown, userId: string | null) => (userId === '9'
      ? { success: true, via: 'telegram', user: USER }
      : { success: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }),
  });
  const capture = (e: unknown, ctx: string, extra?: Row) => {
    captured.push({ ctx, extra, message: e instanceof Error ? e.message : String(e) });
  };
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
  stub('src/services/weather/open-meteo.ts', { fetchWeather: async () => { builds.push('fetchWeather'); return {}; } });
  stub('src/services/weather/air-quality.ts', { fetchAirQuality: async () => { builds.push('fetchAirQuality'); return null; } });
  stub('src/services/weather/geocoding.ts', { getTimezone: async () => { builds.push('getTimezone'); return 'Asia/Jerusalem'; } });
  stub('src/services/weather/formatter.ts', { buildInfographicConfig: () => { builds.push('buildInfographicConfig'); return {}; } });
  stub('src/services/weather/infographic.tsx', {
    generateWeatherInfographic: async () => { builds.push('generateWeatherInfographic'); return Buffer.from('built image'); },
  });
}

// ---- Fixtures ----

const hmacHex = (key: crypto.BinaryLike, payload: string) => crypto.createHmac('sha256', key).update(payload).digest('hex');
const hkdf = (secret: string, purpose: string) => Buffer.from(crypto.hkdfSync('sha256', secret, '', `famcal/${purpose}/v1`, 32));
const linkPayload = (userId: string, source: string, msgId: string | null, ts: number | string) => `${userId}:${source}:${msgId ?? ''}:${ts}`;
/** The weather-image query for a link signed with `key` (source 'cached', the cached image). */
const linkQuery = (key: crypto.BinaryLike, ts: number | string = Date.now()) =>
  `user_id=9&ts=${ts}&sig=${hmacHex(key, linkPayload('9', 'cached', null, ts))}&source=cached`;

function resetState() {
  redisStore.clear();
  captured.length = 0;
  builds.length = 0;
  redisStore.set('story:img:9', Buffer.from('cached image').toString('base64'));
}

/** The once-per-process set app-keys keeps on globalThis, emptied so a check sees its own first report. */
function forgetMissingReports() {
  delete (globalThis as Row).__famcalAppKeyMissing;
}

const appKeyCaptures = (purpose: string) => captured.filter(c => c.ctx === 'app-key-missing' && c.extra?.purpose === purpose);

async function main() {
  installStubs();
  const { NextRequest } = nodeRequire('next/server');

  const fetchImage = async (query: string): Promise<Response> => {
    const { GET } = await load('app/api/weather-image/route.ts');
    return GET(new NextRequest(`http://localhost/api/weather-image?${query}`));
  };
  const sign = async (query: string): Promise<Response> => {
    const { GET } = await load('app/api/weather-image/sign/route.ts');
    return GET(new NextRequest(`http://localhost/api/weather-image/sign?${query}`));
  };
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const { log, warn, error } = console;
    Object.assign(console, { log: () => undefined, warn: () => undefined, error: () => undefined });
    try {
      return await fn();
    } finally {
      Object.assign(console, { log, warn, error });
    }
  };

  // ---- app-keys ----

  await check('#1 appKey is HKDF-SHA256 of SESSION_SECRET with info famcal/<purpose>/v1: 32 bytes, one key per purpose, never the secret itself', async () => {
    const { appKey } = await load('src/lib/app-keys.ts');
    const image = appKey('image-link');
    const session = appKey('session-cookie');
    assert(Buffer.isBuffer(image) && image.length === 32, `image-link key: ${show(image)}`);
    assert(image.equals(hkdf(SESSION, 'image-link')), 'the image-link key is not HKDF(SESSION_SECRET, famcal/image-link/v1)');
    assert(Buffer.isBuffer(session) && session.equals(hkdf(SESSION, 'session-cookie')), 'the session-cookie key is not HKDF(SESSION_SECRET, famcal/session-cookie/v1)');
    assert(!image.equals(session), 'the two purposes share a key');
    assert(!image.equals(Buffer.from(SESSION)), 'the key is the raw secret');
    // Env is read on each call
    const other = await withEnv({ SESSION_SECRET: 'another-session-secret' }, () => appKey('image-link'));
    assert(Buffer.isBuffer(other) && other.equals(hkdf('another-session-secret', 'image-link')), 'a changed SESSION_SECRET was not seen');
  });

  await check('#2 with SESSION_SECRET unset or empty, appKey is null and reports app-key-missing once per process per purpose, across two module copies', async () => {
    resetState();
    forgetMissingReports();
    const first = await load('src/lib/app-keys.ts');
    const second = freshCopy('src/lib/app-keys.ts');
    assert(first.appKey !== second.appKey, 'the second copy is the same module instance; the check proves nothing');
    const keys = await withEnv({ SESSION_SECRET: '' }, () => [
      first.appKey('image-link'), first.appKey('image-link'), second.appKey('image-link'), second.appKey('session-cookie'),
    ]);
    const unset = await withEnv({ SESSION_SECRET: '' }, () => {
      delete env.SESSION_SECRET;
      return first.appKey('session-cookie');
    });
    assert([...keys, unset].every(k => k === null), `keys: ${show(keys)} ${show(unset)}`);
    assert(appKeyCaptures('image-link').length === 1, `image-link reports: ${show(captured)}`);
    assert(appKeyCaptures('session-cookie').length === 1, `session-cookie reports: ${show(captured)}`);
    assert(captured.every(c => !c.message.includes(SESSION) && !show(c.extra).includes(SESSION)), 'a report carries the secret');
  });

  // ---- image-link ----

  await check('#3 signImageLink is HMAC-SHA256 under the image-link key over userId:source:msgId:ts; verifyImageLink takes it within the window only', async () => {
    const { signImageLink, verifyImageLink } = await load('src/lib/image-link.ts');
    const now = 1_760_000_000_000;
    const p = { userId: '9', source: 'summary', msgId: '5', ts: now };
    const sig = signImageLink(p);
    assert(sig === hmacHex(hkdf(SESSION, 'image-link'), '9:summary:5:1760000000000'), `sig ${sig}`);
    assert(signImageLink({ ...p, msgId: null }) === hmacHex(hkdf(SESSION, 'image-link'), '9:summary::1760000000000'), 'a null msg is not signed as an empty field');
    const verdicts = {
      now: verifyImageLink(p, sig, now),
      fiftyNineMinutesOld: verifyImageLink(p, sig, now + 59 * 60_000),
      thirtySecondsAhead: verifyImageLink(p, sig, now - 30_000),
      twoHoursAhead: verifyImageLink(p, sig, now - 2 * 3600_000),
      ninetySecondsAhead: verifyImageLink(p, sig, now - 90_000),
      twoHoursOld: verifyImageLink(p, sig, now + 2 * 3600_000),
      otherMsg: verifyImageLink({ ...p, msgId: '7' }, sig, now),
      otherSource: verifyImageLink({ ...p, source: 'cached' }, sig, now),
      otherUser: verifyImageLink({ ...p, userId: '42' }, sig, now),
      shortSig: verifyImageLink(p, sig.slice(0, 10), now),
      nanTs: verifyImageLink({ ...p, ts: NaN }, sig, now),
    };
    const want = {
      now: true, fiftyNineMinutesOld: true, thirtySecondsAhead: true, twoHoursAhead: false, ninetySecondsAhead: false,
      twoHoursOld: false, otherMsg: false, otherSource: false, otherUser: false, shortSig: false, nanTs: false,
    };
    assert(show(verdicts) === show(want), `verdicts ${show(verdicts)}`);
    const noKey = await withEnv({ SESSION_SECRET: '' }, () => ({ sign: signImageLink(p), verify: verifyImageLink(p, sig, now) }));
    assert(noKey.sign === null && noKey.verify === false, `with no key: ${show(noKey)}`);
  });

  // ---- weather-image: no other secret signs a link ----

  await check('#4 weather-image refuses a link signed with ENCRYPTION_KEY (401) and serves one signed with the image-link key (200)', async () => {
    resetState();
    const legacy = await quiet(() => fetchImage(linkQuery(ENC_KEY)));
    const current = await quiet(() => fetchImage(linkQuery(hkdf(SESSION, 'image-link'))));
    assert(legacy.status === 401, `ENCRYPTION_KEY-signed link: ${legacy.status}`);
    assert(current.status === 200, `image-link-key-signed link: ${current.status}`);
  });

  await check('#5 weather-image: a link whose ts is 2 h ahead is 401, and a ts that is not plain digits is 401 (the same link at now is 200)', async () => {
    resetState();
    const key = hkdf(SESSION, 'image-link');
    const now = Date.now();
    const ok = await quiet(() => fetchImage(linkQuery(key, now)));
    const ahead = await quiet(() => fetchImage(linkQuery(key, now + 2 * 3600_000)));
    const padded = await quiet(() => fetchImage(linkQuery(key, `${now}.0`)));
    assert(ok.status === 200, `ts now: ${ok.status}`);
    assert(ahead.status === 401, `ts now + 2 h: ${ahead.status}`);
    assert(padded.status === 401, `ts "${now}.0": ${padded.status}`);
  });

  // ---- sign: the key first ----

  await check('#6 sign returns a URL signed with the image-link key, and weather-image serves it', async () => {
    resetState();
    const res = await quiet(() => sign('user_id=9&source=cached'));
    assert(res.status === 200, `sign: ${res.status}`);
    const { url } = await res.json();
    const u = new URL(url);
    const ts = u.searchParams.get('ts') ?? '';
    const sig = u.searchParams.get('sig') ?? '';
    assert(u.origin === 'https://famcal.test' && u.searchParams.get('user_id') === '9' && u.searchParams.get('source') === 'cached', `url ${url}`);
    assert(sig === hmacHex(hkdf(SESSION, 'image-link'), linkPayload('9', 'cached', null, ts)), 'the URL is not signed with the image-link key');
    const served = await quiet(() => fetchImage(u.searchParams.toString()));
    assert(served.status === 200, `weather-image on the signed URL: ${served.status}`);
    assert(builds.length === 0, `a cached image was rebuilt: ${show(builds)}`);
  });

  await check('#7 ENCRYPTION_KEY="" SESSION_SECRET="" CRON_SECRET=C: a C-signed link is 401, and sign is 500 with an app-key-missing report and no image built', async () => {
    resetState();
    forgetMissingReports();
    const { link, signed } = await withEnv({ ENCRYPTION_KEY: '', SESSION_SECRET: '', CRON_SECRET: CRON }, async () => ({
      link: await quiet(() => fetchImage(linkQuery(CRON))),
      signed: await quiet(() => sign('user_id=9&source=fresh')),
    }));
    assert(link.status === 401, `CRON_SECRET-signed link: ${link.status}`);
    assert(signed.status === 500, `sign: ${signed.status}`);
    assert(builds.length === 0, `an image was built for a link that can't be signed: ${show(builds)}`);
    assert(appKeyCaptures('image-link').length === 1, `reports: ${show(captured)}`);
  });

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

- [ ] **Step 2: Run it to verify it fails**

Run: `bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-image-link.ts`

Expected: `0/7 passed`, exit 1:
- #1 and #2 fail with `Cannot find module '.../src/lib/app-keys.ts'`; #3 with `Cannot find module '.../src/lib/image-link.ts'`.
- #4 fails with `ENCRYPTION_KEY-signed link: 200` (today's route signs with `ENCRYPTION_KEY || CRON_SECRET`).
- #5 fails with `ts now: 401` (today's route doesn't know the HKDF key).
- #6 fails with `the URL is not signed with the image-link key`.
- #7 fails with `CRON_SECRET-signed link: 200` (the `CRON_SECRET` fallback).

- [ ] **Step 3: Create `src/lib/app-keys.ts`**

```ts
/**
 * Keys the app derives from SESSION_SECRET, one per purpose. HKDF (RFC 5869) turns the one
 * secret into independent keys, each bound to its own label, so a session-cookie signature
 * can never pass as an image-link signature, and neither key is SESSION_SECRET itself.
 *
 * There is no fallback to another secret: with SESSION_SECRET unset or '' every key is
 * null, and its callers refuse (no session cookie, no image link).
 */

import crypto from 'crypto';
import { captureError } from './error-capture';

export type AppKeyPurpose = 'session-cookie' | 'image-link';

/**
 * The purposes already reported missing in this process. On globalThis: the scheduler and
 * the route bundles each load their own copy of this module (Next 16).
 */
function reportedMissing(): Set<AppKeyPurpose> {
  const g = globalThis as { __famcalAppKeyMissing?: Set<AppKeyPurpose> };
  g.__famcalAppKeyMissing ??= new Set();
  return g.__famcalAppKeyMissing;
}

/**
 * The 32-byte key for `purpose`, or null when SESSION_SECRET is unset or ''. Reads the env
 * on each call, so a changed value is seen at once. A missing secret is reported once per
 * process per purpose (app-key-missing), never with a value.
 */
export function appKey(purpose: AppKeyPurpose): Buffer | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    const reported = reportedMissing();
    if (!reported.has(purpose)) {
      reported.add(purpose);
      captureError(new Error(`SESSION_SECRET is not set: no ${purpose} key, so ${purpose} requests are refused`), 'app-key-missing', { purpose });
    }
    return null;
  }
  return Buffer.from(crypto.hkdfSync('sha256', secret, '', `famcal/${purpose}/v1`, 32));
}
```

- [ ] **Step 4: Create `src/lib/image-link.ts`**

```ts
/**
 * Share-story image links. weather-image/sign signs a URL for the proved user, and
 * weather-image checks it. The signature covers the user, the source, the msg and the
 * time, so a signed URL can't be pointed at another summary or another kind of image.
 * The key is the image-link key from app-keys.ts; no other secret signs a link.
 */

import crypto from 'crypto';
import { appKey } from './app-keys';

/** A link is good for an hour, and its time may run at most a minute ahead of this server's clock. */
const MAX_AGE_MS = 3600_000;
const MAX_AHEAD_MS = 60_000;

export interface ImageLinkParams {
  /** The DB id, as the URL's user_id carries it */
  userId: string;
  /** 'summary', 'cached' or 'fresh' (the URL leaves out 'fresh') */
  source: string;
  /** The summary's message id, when the link is for one */
  msgId?: string | null;
  /** When the link was signed, in ms since the epoch */
  ts: number;
}

function payload(p: ImageLinkParams): string {
  return `${p.userId}:${p.source}:${p.msgId ?? ''}:${p.ts}`;
}

/** The hex signature for a link, or null when there is no image-link key (SESSION_SECRET unset). */
export function signImageLink(p: ImageLinkParams): string | null {
  const key = appKey('image-link');
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(payload(p)).digest('hex');
}

/**
 * True when `sig` signs these params under the image-link key and the link's time is
 * within the window. False with no key. Constant-time compare.
 */
export function verifyImageLink(p: ImageLinkParams, sig: string, nowMs: number = Date.now()): boolean {
  if (!Number.isSafeInteger(p.ts)) return false;
  if (p.ts - nowMs > MAX_AHEAD_MS || nowMs - p.ts > MAX_AGE_MS) return false;
  const expected = signImageLink(p);
  if (!expected) return false;
  const want = Buffer.from(expected);
  const given = Buffer.from(sig);
  // timingSafeEqual throws on different lengths
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
```

- [ ] **Step 5: Verify links in `app/api/weather-image/route.ts`**

In `app/api/weather-image/route.ts`, replace:

```ts
import { redis } from '@/src/utils/redis';
import crypto from 'crypto';
```

with:

```ts
import { redis } from '@/src/utils/redis';
import { verifyImageLink } from '@/src/lib/image-link';
```

Then delete this whole block (the doc comment and the function; keep the `GET` doc comment that follows it):

```ts
/**
 * The signature covers the user, the source and the msg (see weather-image/sign), so
 * a signed URL cannot be pointed at another summary or another kind of image.
 */
function validateSignature(
  userId: string,
  source: string,
  msgId: string | null,
  timestamp: string,
  signature: string
): boolean {
  const secret = process.env.ENCRYPTION_KEY || process.env.CRON_SECRET;
  if (!secret) return false;

  const age = Date.now() - parseInt(timestamp);
  if (isNaN(age) || age > 3600_000) return false;

  const expected = Buffer.from(
    crypto.createHmac('sha256', secret).update(`${userId}:${source}:${msgId ?? ''}:${timestamp}`).digest('hex')
  );
  const given = Buffer.from(signature);
  return given.length === expected.length && crypto.timingSafeEqual(expected, given);
}

```

Then replace:

```ts
  if (!validateSignature(userId, source ?? 'fresh', msgId, ts, sig)) {
```

with:

```ts
  // The link's time in ms: plain digits only, so the signed string can't be padded or reworded
  const tsMs = /^\d{1,16}$/.test(ts) ? Number(ts) : NaN;
  // The signature covers the user, the source and the msg (see weather-image/sign)
  if (!verifyImageLink({ userId, source: source ?? 'fresh', msgId, ts: tsMs }, sig)) {
```

- [ ] **Step 6: Check the key first and sign with `signImageLink` in `app/api/weather-image/sign/route.ts`**

In `app/api/weather-image/sign/route.ts`, replace:

```ts
import { redis } from '@/src/utils/redis';
import crypto from 'crypto';
```

with:

```ts
import { redis } from '@/src/utils/redis';
import { appKey } from '@/src/lib/app-keys';
import { signImageLink } from '@/src/lib/image-link';
```

Then replace:

```ts
  const source = request.nextUrl.searchParams.get('source') || 'fresh';
  // source=summary: always generate fresh card from stashed text
```

with:

```ts
  const source = request.nextUrl.searchParams.get('source') || 'fresh';

  // The key first: with no image-link key no link can be signed, so build no image for it.
  // appKey reports the missing SESSION_SECRET (once per process).
  if (!appKey('image-link')) {
    console.error('[weather-image/sign] SESSION_SECRET is not set; no image link signed');
    return NextResponse.json({ error: 'Server config error' }, { status: 500 });
  }

  // source=summary: always generate fresh card from stashed text
```

Then replace:

```ts
  const secret = process.env.ENCRYPTION_KEY || process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Server config error' }, { status: 500 });
  }

  // weather-image recomputes this same string from the URL (source defaults to 'fresh')
  const ts = Date.now().toString();
  const sig = crypto.createHmac('sha256', secret).update(`${dbUserId}:${source}:${msgId ?? ''}:${ts}`).digest('hex');
```

with:

```ts
  // weather-image verifies the same params from the URL (source defaults to 'fresh')
  const ts = Date.now();
  const sig = signImageLink({ userId: dbUserId, source, msgId, ts });
  if (!sig) {
    // SESSION_SECRET went away while the image was built
    console.error('[weather-image/sign] SESSION_SECRET is not set; no image link signed');
    return NextResponse.json({ error: 'Server config error' }, { status: 500 });
  }
```

The lines after it (`const appUrl = ...` through `return NextResponse.json({ url });`) stay as they are; `ts` is now a number and the template literal prints it the same way.

- [ ] **Step 7: Run the smoke to verify it passes**

Run: `bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-image-link.ts`

Expected: `7/7 passed`, exit 0.

- [ ] **Step 8: Typecheck, lint and the smokes this change can break**

```bash
npx tsc --noEmit -p .
npm run -s lint
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-image-link.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-oauth-weather.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-initdata-header.ts
```

Expected: tsc and lint print nothing; the smokes end `7/7 passed`, `14/14 passed` (its #6-#8 sign a link and fetch it) and `9/9 passed` (it calls the sign route). Both older smokes set `SESSION_SECRET ||= 'test-session-secret'`, so they sign with the derived key.

- [ ] **Step 9: Commit**

```bash
git add src/lib/app-keys.ts src/lib/image-link.ts app/api/weather-image/route.ts app/api/weather-image/sign/route.ts scripts/smoke-image-link.ts
git commit -m "$(cat <<'EOF'
fix(security): image links signed with their own key derived from SESSION_SECRET, never ENCRYPTION_KEY or CRON_SECRET

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

### Task 7: Fail closed on SESSION_SECRET and WHATSAPP_APP_SECRET; startup checks

**Deviation:**
- `startupSecretProblems` returns `StartupProblem[]` (`{ name, message }`, per the interface contract), not the spec's `string[]`. The deploy message's `missing:` line lists the names of problems whose variable is unset or `''`; the "equals CRON_SECRET" problem is logged and captured but is not "missing".
- The Telegram line reads `TELEGRAM_WEBHOOK_SECRET is not set: every Telegram update is refused (500)`. Checked: with the secret unset, `app/api/webhook/route.ts:43-47` answers every non-WhatsApp POST with a 500 `Webhook not configured` before reading the header.
- The magic route's missing-key report is `appKey`'s own `captureError('app-key-missing', {purpose: 'session-cookie'})`, once per process, plus a `console.error` on every refused tap.
- The checks live in a new `scripts/smoke-fail-closed.ts` (interface contract), not in `smoke-secret-hygiene.ts`.
- `smoke-fail-closed.ts` #12 is the spec's source scan (no `process.env.<SECRET> || process.env.<OTHER>`). It lives here rather than in Task 9's `smoke-secret-hygiene.ts` because this task removes the last such fallback (`session-auth.ts:14`), so the scan is seen failing before Step 4 and passing after it.
- `README.md` is not touched here: Task 5 Step 6 already rewrote the `WHATSAPP_APP_SECRET` and `SESSION_SECRET` rows for the fail-closed behaviour this task ships.

**Files:**
- Modify: `src/lib/session-auth.ts` (lines 7-19 imports and `getSecret`, 30-43 `createSessionToken`, 49-77 `validateSessionToken`)
- Modify: `app/api/auth/magic/route.ts` (lines 3, 8, 20-33)
- Modify: `src/lib/whatsapp-signature.ts` (lines 7-16, 27-43)
- Modify: `app/api/webhook/route.ts` (lines 37-40 only; Task 8 changes lines 13 and 48-49 later)
- Create: `src/lib/startup-checks.ts`
- Modify: `instrumentation.ts` (whole file, 42 lines)
- Test: `scripts/smoke-fail-closed.ts` (new); `scripts/smoke-google-connect.ts` #17 (lines 1008-1020) and #22 (lines 1199-1203); `scripts/smoke-auth-leftovers.ts` #5 (lines 198-203)

**Interfaces:**
- Consumes: `appKey(purpose: AppKeyPurpose): Buffer | null` and `globalThis.__famcalAppKeyMissing` (Task 6); `describeKeys(): string` from `src/utils/encryption.ts` (Task 1), which returns `[startup] ENCRYPTION_KEY fp <8 hex>; ENCRYPTION_KEY_PREVIOUS unset` with PREVIOUS `''`, and `[startup] ENCRYPTION_KEY missing or invalid; ENCRYPTION_KEY_PREVIOUS unset` with `ENCRYPTION_KEY=''`, and never throws; `captureError` from `src/lib/error-capture.ts`.
- Produces:
  - `export interface StartupProblem { name: string; message: string }`
  - `export function startupSecretProblems(env: Record<string, string | undefined>): StartupProblem[]`
  - `checkWhatsAppSignature(rawBody: string, header: string | null): 'verified' | 'rejected' | 'unconfigured'` (the `'unverified'` result and `ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS` are gone)
  - `createSessionToken(userId: number): string` throws when `SESSION_SECRET` is unset; `validateSessionToken(token: string): SessionPayload | null` returns null then
  - capture contexts: `startup-secret` (extra `{ variable: <name> }`; not `secret`, which Sentry's default scrubber filters), `startup-checks`, `deploy-notify-send` (extra `{ admin_id }`), `deploy-notify`, `whatsapp-webhook-unconfigured` (once per process, flag `globalThis.__famcalWhatsAppUnconfiguredReported`)

- [ ] **Step 1: Write the failing smoke**

Create `scripts/smoke-fail-closed.ts`:

```ts
// Smoke test for fail-closed secrets (secret rotation, spec section d). Session cookies
// were signed with SESSION_SECRET || CRON_SECRET, and unsigned WhatsApp webhooks were
// accepted while WHATSAPP_APP_SECRET was unset. Now:
// - the session cookie is signed with its own key, derived from SESSION_SECRET by HKDF
//   (src/lib/app-keys.ts); without SESSION_SECRET no cookie is made or accepted;
// - the magic link checks that key before it uses the link up (GETDEL), so a link refused
//   for a missing key still works once the key is set;
// - an unset WHATSAPP_APP_SECRET refuses every WhatsApp webhook ('unconfigured');
// - startup names every missing or reused secret in production (log, Sentry and the deploy
//   message), logs the encryption key fingerprints in every environment, and never throws;
// - the deploy message's failures are logged and captured, not swallowed;
// - no `process.env.<SECRET> || process.env.<OTHER>` fallback is left anywhere (#12).
//
// Real: app-keys, session-auth, the magic route, whatsapp-signature, startup-checks,
// encryption's describeKeys and instrumentation's register(). Faked at the boundaries:
// Prisma (a user that is not suspended), magic-link (records each use), error capture,
// Sentry's server config, the scheduler, the admin list and the Telegram bot (all
// recorded). No network, no DB.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-fail-closed.ts

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
const SELF = path.relative(ROOT, __filename);
const env = process.env as Record<string, string | undefined>;

// Every value this smoke depends on is set here, never taken from the fake env.
const SESSION = 'VALUE-SESSION-fc1';
const CRON = 'VALUE-CRON-fc2';
const ENC_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
Object.assign(env, {
  TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || 'test',
  SESSION_SECRET: SESSION,
  CRON_SECRET: CRON,
  ENCRYPTION_KEY: ENC_KEY,
  ENCRYPTION_KEY_PREVIOUS: '',
  WHATSAPP_APP_SECRET: 'VALUE-APP-fc3',
  TELEGRAM_WEBHOOK_SECRET: 'VALUE-TG-fc4',
  NEXT_PUBLIC_APP_URL: 'https://famcal.test',
});

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

const show = (value: unknown) => JSON.stringify(value);
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Runs fn with `vars` set in process.env, then puts the old values back. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, env[k]]));
  Object.assign(env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
}

/** Runs fn with the console recorded instead of printed. */
async function recordingConsole<T>(fn: () => Promise<T> | T): Promise<{ value: T; lines: { level: string; text: string }[] }> {
  const lines: { level: string; text: string }[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const rec = (level: string) => (...args: unknown[]) => { lines.push({ level, text: args.map(a => String(a)).join(' ') }); };
  Object.assign(console, { log: rec('log'), info: rec('info'), warn: rec('warn'), error: rec('error') });
  try {
    return { value: await fn(), lines };
  } finally {
    Object.assign(console, original);
  }
}

/** Waits for fire-and-forget work (the deploy message) until `done` holds, up to 2 s. */
async function settle(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 10));
}

// ---- Boundaries: stubs in require's cache, served to import() by a load hook ----

const Module = nodeRequire('module');
const stubs: Record<string, Row> = {};
(globalThis as Row).__smokeStubs = stubs;
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs)) return nextLoad(url, context);
    const names = Object.keys(stubs[file]).filter(n => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
    const source = [
      `const s = globalThis.__smokeStubs[${JSON.stringify(file)}];`,
      ...names.map(n => `export const ${n} = s[${JSON.stringify(n)}];`),
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

/** Every captureError: its context, its extra and the error's message. */
const captured: { ctx: string; extra?: Row; message: string }[] = [];
/** Every magic token the route used up. */
const magicUses: string[] = [];
/** What the next magic token holds (null: invalid or used). */
let magicData: Row | null = null;
const schedulerStarts: number[] = [];
const sends: { chatId: unknown; text: string }[] = [];
let adminIds: () => Promise<number[]> = async () => [1001, 1002];
let sendFails = false;

function installStubs() {
  stub('src/utils/prisma.ts', {
    prisma: { user: { findUnique: async () => ({ suspendedAt: null }) } },
    withRetry: (fn: () => unknown) => fn(),
  });
  stub('src/utils/redis.ts', { redis: {} });
  stub('src/services/magic-link.ts', {
    validateMagicToken: async (token: string) => { magicUses.push(token); return magicData; },
  });
  const capture = (e: unknown, ctx: string, extra?: Row) => {
    captured.push({ ctx, extra, message: e instanceof Error ? e.message : String(e) });
  };
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
  stub('sentry.server.config.ts', {});
  stub('src/cron/scheduler.ts', { startScheduler: () => { schedulerStarts.push(Date.now()); } });
  stub('src/utils/error-notifier.ts', { getAdminUserIds: () => adminIds() });
  const bot = {
    sendMessage: async (chatId: unknown, text: string) => {
      if (sendFails) throw new Error('telegram down (smoke)');
      sends.push({ chatId, text });
      return {};
    },
  };
  stub('src/services/telegram/bot.ts', { getBot: () => bot });
}

// ---- Fixtures ----

const hkdf = (secret: string, purpose: string) => Buffer.from(crypto.hkdfSync('sha256', secret, '', `famcal/${purpose}/v1`, 32));
/** A session token in session-auth's format, signed with `key`. */
function sessionToken(key: crypto.BinaryLike, payload: Row | string): string {
  const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url')}`;
}
const now = () => Math.floor(Date.now() / 1000);
const live = (userId: number) => ({ userId, iat: now(), exp: now() + 3600 });

/** The once-per-process set app-keys keeps on globalThis, emptied so a check sees its own first report. */
function forgetMissingReports() {
  delete (globalThis as Row).__famcalAppKeyMissing;
}
const appKeyCaptures = (purpose: string) => captured.filter(c => c.ctx === 'app-key-missing' && c.extra?.purpose === purpose);

/** register() as the nodejs runtime with these vars set; what it logged and captured. */
async function registerWith(vars: Record<string, string>) {
  captured.length = 0;
  sends.length = 0;
  const { register } = await load('instrumentation.ts');
  return withEnv({ NEXT_RUNTIME: 'nodejs', RAILWAY_GIT_COMMIT_SHA: '', ...vars }, () => recordingConsole(async () => {
    let threw: string | null = null;
    try {
      await register();
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    return threw;
  }));
}

const PROBLEM = {
  session: 'SESSION_SECRET is not set: WhatsApp sign-in and share-story image links are refused',
  app: 'WHATSAPP_APP_SECRET is not set: every WhatsApp webhook is refused (500)',
  telegram: 'TELEGRAM_WEBHOOK_SECRET is not set: every Telegram update is refused (500)',
  reused: 'SESSION_SECRET equals CRON_SECRET: give it its own value',
};

async function main() {
  installStubs();
  const { NextRequest } = nodeRequire('next/server');

  const magic = async (query: string, cookie?: string) => {
    const { GET } = await load('app/api/auth/magic/route.ts');
    const { value: res, lines } = await recordingConsole<Response>(() => GET(new NextRequest(`http://localhost/api/auth/magic?${query}`, {
      headers: { 'accept-language': 'ru', ...(cookie ? { cookie } : {}) },
    })));
    const to = new URL(res.headers.get('location') ?? 'http://x/none');
    return { to: `${to.pathname}${to.search}`, setCookie: res.headers.get('set-cookie') ?? '', lines };
  };

  // ---- Session cookie ----

  await check('#1 the session cookie is signed with the HKDF session-cookie key: a raw-SESSION_SECRET signature is refused', async () => {
    const { createSessionToken, validateSessionToken } = await load('src/lib/session-auth.ts');
    const made = createSessionToken(42);
    const [body, sig] = made.split('.');
    assert(sig === crypto.createHmac('sha256', hkdf(SESSION, 'session-cookie')).update(body).digest('base64url'), 'createSessionToken does not sign with the HKDF key');
    assert(validateSessionToken(made)?.userId === 42, 'its own token is refused');
    assert(validateSessionToken(sessionToken(hkdf(SESSION, 'session-cookie'), live(7)))?.userId === 7, 'an HKDF-signed token is refused');
    assert(validateSessionToken(sessionToken(SESSION, live(7))) === null, 'a token signed with the raw SESSION_SECRET is accepted');
    assert(validateSessionToken(sessionToken(hkdf(SESSION, 'image-link'), live(7))) === null, 'a token signed with the image-link key is accepted');
  });

  await check('#2 SESSION_SECRET="" with CRON_SECRET set: createSessionToken throws, no cookie is accepted (CRON-signed included), one app-key-missing report', async () => {
    captured.length = 0;
    forgetMissingReports();
    const { createSessionToken, validateSessionToken } = await load('src/lib/session-auth.ts');
    const out = await withEnv({ SESSION_SECRET: '' }, () => {
      let thrown = '';
      try {
        createSessionToken(42);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      return {
        thrown,
        cronRaw: validateSessionToken(sessionToken(CRON, live(7))),
        cronHkdf: validateSessionToken(sessionToken(hkdf(CRON, 'session-cookie'), live(7))),
      };
    });
    assert(out.thrown !== '', 'createSessionToken signed a cookie with no SESSION_SECRET');
    assert(!out.thrown.includes(CRON), 'the error names a secret value');
    assert(out.cronRaw === null && out.cronHkdf === null, `CRON-signed tokens: ${show(out)}`);
    assert(appKeyCaptures('session-cookie').length === 1, `reports: ${show(captured)}`);
  });

  await check('#3 a correctly signed cookie that is not JSON is refused with one "[session] malformed session cookie" warning that carries no part of it', async () => {
    const { validateSessionToken } = await load('src/lib/session-auth.ts');
    const token = sessionToken(hkdf(SESSION, 'session-cookie'), 'not-json-PAYLOAD-x9');
    const { value, lines } = await recordingConsole(() => validateSessionToken(token));
    assert(value === null, `accepted: ${show(value)}`);
    const warnings = lines.filter(l => l.level === 'warn');
    assert(warnings.length === 1 && warnings[0].text === '[session] malformed session cookie', `logged ${show(lines)}`);
    assert(!lines.some(l => l.text.includes('PAYLOAD') || l.text.includes(token.split('.')[0])), 'the log carries the cookie');
  });

  // ---- Magic link ----

  await check('#4 magic link with SESSION_SECRET="": the fresh-link card, the link is not used up, no cookie, one app-key-missing report over two taps', async () => {
    captured.length = 0;
    magicUses.length = 0;
    forgetMissingReports();
    magicData = { userId: 42, locale: 'he', page: 'dashboard' };
    const taps = await withEnv({ SESSION_SECRET: '' }, async () => [
      await magic('token=tok-1&locale=he'),
      await magic('token=tok-1&locale=he'),
    ]);
    for (const tap of taps) {
      assert(tap.to === '/he/dashboard', `redirect ${tap.to}`);
      assert(!tap.setCookie.includes('famcal_session='), 'a session cookie was set');
    }
    assert(magicUses.length === 0, `the link was used up: ${show(magicUses)}`);
    assert(appKeyCaptures('session-cookie').length === 1, `reports: ${show(captured)}`);
  });

  await check('#5 magic link with SESSION_SECRET set: signs in with a cookie under the HKDF session-cookie key', async () => {
    magicUses.length = 0;
    magicData = { userId: 42, locale: 'ru', page: 'dashboard' };
    const tap = await magic('token=tok-2&locale=ru');
    assert(tap.to === '/ru/dashboard?user_id=42', `redirect ${tap.to}`);
    assert(magicUses.length === 1, `uses ${show(magicUses)}`);
    const cookie = tap.setCookie.match(/famcal_session=([^;]+)/)?.[1] ?? '';
    const [body, sig] = cookie.split('.');
    assert(body && sig === crypto.createHmac('sha256', hkdf(SESSION, 'session-cookie')).update(body).digest('base64url'),
      'the cookie is not signed with the HKDF session-cookie key');
  });

  // ---- WhatsApp ----

  await check('#6 whatsapp-signature: no accept-unsigned switch; an unset or empty WHATSAPP_APP_SECRET is "unconfigured" for every post', async () => {
    const mod = await load('src/lib/whatsapp-signature.ts');
    assert(!('ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS' in mod), 'ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS is still exported');
    const raw = '{"object":"whatsapp_business_account"}';
    const signed = `sha256=${crypto.createHmac('sha256', 'VALUE-APP-fc3').update(raw).digest('hex')}`;
    const verdicts = await withEnv({ WHATSAPP_APP_SECRET: '' }, () => [
      mod.checkWhatsAppSignature(raw, null),
      mod.checkWhatsAppSignature(raw, signed),
    ]);
    assert(show(verdicts) === show(['unconfigured', 'unconfigured']), `verdicts ${show(verdicts)}`);
    const withSecret = [mod.checkWhatsAppSignature(raw, signed), mod.checkWhatsAppSignature(raw, null)];
    assert(show(withSecret) === show(['verified', 'rejected']), `with the secret: ${show(withSecret)}`);
  });

  // ---- Startup ----

  await check('#7 startupSecretProblems names each missing or reused secret, never a value', async () => {
    const { startupSecretProblems } = await load('src/lib/startup-checks.ts');
    const full = { SESSION_SECRET: SESSION, CRON_SECRET: CRON, WHATSAPP_APP_SECRET: 'VALUE-APP-fc3', TELEGRAM_WEBHOOK_SECRET: 'VALUE-TG-fc4' };
    const cases: [string, Record<string, string | undefined>, { name: string; message: string }[]][] = [
      ['all set', full, []],
      ['all empty', { SESSION_SECRET: '', CRON_SECRET: '', WHATSAPP_APP_SECRET: '', TELEGRAM_WEBHOOK_SECRET: '' }, [
        { name: 'SESSION_SECRET', message: PROBLEM.session },
        { name: 'WHATSAPP_APP_SECRET', message: PROBLEM.app },
        { name: 'TELEGRAM_WEBHOOK_SECRET', message: PROBLEM.telegram },
      ]],
      ['all unset', {}, [
        { name: 'SESSION_SECRET', message: PROBLEM.session },
        { name: 'WHATSAPP_APP_SECRET', message: PROBLEM.app },
        { name: 'TELEGRAM_WEBHOOK_SECRET', message: PROBLEM.telegram },
      ]],
      ['session reuses cron', { ...full, CRON_SECRET: SESSION }, [{ name: 'SESSION_SECRET', message: PROBLEM.reused }]],
      ['only the app secret missing', { ...full, WHATSAPP_APP_SECRET: undefined }, [{ name: 'WHATSAPP_APP_SECRET', message: PROBLEM.app }]],
    ];
    const problems: string[] = [];
    for (const [label, input, want] of cases) {
      const got = startupSecretProblems(input);
      if (show(got) !== show(want)) problems.push(`${label}: ${show(got)}`);
      if (/VALUE-/.test(show(got))) problems.push(`${label}: a value in ${show(got)}`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#8 production register() with every checked secret empty: one console.error line and one startup-secret capture each, no throw, scheduler started', async () => {
    schedulerStarts.length = 0;
    const { value: threw, lines } = await registerWith({
      NODE_ENV: 'production', SESSION_SECRET: '', WHATSAPP_APP_SECRET: '', TELEGRAM_WEBHOOK_SECRET: '',
    });
    assert(threw === null, `register() threw: ${threw}`);
    const errors = lines.filter(l => l.level === 'error' && l.text.startsWith('[startup] ')).map(l => l.text);
    assert(show(errors) === show([`[startup] ${PROBLEM.session}`, `[startup] ${PROBLEM.app}`, `[startup] ${PROBLEM.telegram}`]), `error lines ${show(errors)}`);
    const startup = captured.filter(c => c.ctx === 'startup-secret').map(c => c.extra?.variable);
    assert(show(startup) === show(['SESSION_SECRET', 'WHATSAPP_APP_SECRET', 'TELEGRAM_WEBHOOK_SECRET']), `captures ${show(captured)}`);
    assert(schedulerStarts.length === 1, 'the scheduler did not start');
    assert(![...lines.map(l => l.text), ...captured.map(c => c.message)].some(t => t.includes('VALUE-')), 'a secret value was logged');
  });

  await check('#9 register() logs the key fingerprint line in every environment, names no secret outside production, and survives a missing ENCRYPTION_KEY', async () => {
    const fp = crypto.createHash('sha256').update(Buffer.from(ENC_KEY, 'hex')).digest('hex').slice(0, 8);
    const dev = await registerWith({ NODE_ENV: 'development', SESSION_SECRET: '', WHATSAPP_APP_SECRET: '' });
    const devCaptures = captured.filter(c => c.ctx === 'startup-secret').length;
    const keyLine = dev.lines.filter(l => l.text.startsWith('[startup] ENCRYPTION_KEY')).map(l => l.text);
    assert(show(keyLine) === show([`[startup] ENCRYPTION_KEY fp ${fp}; ENCRYPTION_KEY_PREVIOUS unset`]), `development: ${show(dev.lines)}`);
    assert(!dev.lines.some(l => / is not set: /.test(l.text)) && devCaptures === 0, `development named a secret: ${show(dev.lines)}`);
    const noKey = await registerWith({ NODE_ENV: 'production', ENCRYPTION_KEY: '' });
    assert(noKey.value === null, `register() threw with no ENCRYPTION_KEY: ${noKey.value}`);
    assert(noKey.lines.some(l => l.text === '[startup] ENCRYPTION_KEY missing or invalid; ENCRYPTION_KEY_PREVIOUS unset'), `no ENCRYPTION_KEY: ${show(noKey.lines)}`);
  });

  await check('#10 the deploy message names the missing secrets ("missing: ..."), and a reused one is not "missing"', async () => {
    adminIds = async () => [1001, 1002];
    sendFails = false;
    await registerWith({ NODE_ENV: 'production', RAILWAY_GIT_COMMIT_SHA: 'abcdef1234567', SESSION_SECRET: '', WHATSAPP_APP_SECRET: '' });
    await settle(() => sends.length >= 2);
    const texts = sends.map(s => s.text);
    assert(sends.length === 2 && sends.every(s => s.text === '🚀 FamCal <code>abcdef1</code> deployed\nmissing: SESSION_SECRET, WHATSAPP_APP_SECRET'), `sent ${show(sends)}`);
    await registerWith({ NODE_ENV: 'production', RAILWAY_GIT_COMMIT_SHA: 'abcdef1234567', CRON_SECRET: SESSION });
    await settle(() => sends.length >= 2);
    assert(sends.length === 2 && sends.every(s => s.text === '🚀 FamCal <code>abcdef1</code> deployed'), `reused only: sent ${show(sends)} (before: ${show(texts)})`);
  });

  await check('#11 a deploy message that fails is logged and captured (deploy-notify-send per admin, deploy-notify for the admin list), never swallowed', async () => {
    sendFails = true;
    adminIds = async () => [1001];
    try {
      await registerWith({ NODE_ENV: 'production', RAILWAY_GIT_COMMIT_SHA: 'abcdef1234567' });
      await settle(() => captured.some(c => c.ctx === 'deploy-notify-send'));
      const send = captured.filter(c => c.ctx === 'deploy-notify-send');
      assert(send.length === 1 && send[0].extra?.admin_id === 1001, `send failure: ${show(captured)}`);
      adminIds = async () => { throw new Error('db down (smoke)'); };
      await registerWith({ NODE_ENV: 'production', RAILWAY_GIT_COMMIT_SHA: 'abcdef1234567' });
      await settle(() => captured.some(c => c.ctx === 'deploy-notify'));
      assert(captured.filter(c => c.ctx === 'deploy-notify').length === 1, `admin list failure: ${show(captured)}`);
    } finally {
      sendFails = false;
      adminIds = async () => [1001, 1002];
    }
  });

  // The spec's source scan: no secret stands in for another through an env fallback
  await check('#12 source scan: no `process.env.<SECRET> || process.env.<OTHER>` (or ??) fallback in app, src, components, scripts or the root config files', () => {
    const FALLBACK = /process\.env\.([A-Z0-9_]+)\s*(?:\|\||\?\?)\s*process\.env\.([A-Z0-9_]+)/g;
    const SECRET_NAME = /SECRET|KEY|TOKEN|PASSWORD|DSN/;
    const fallbacks = (text: string) => [...text.matchAll(FALLBACK)]
      .filter(m => SECRET_NAME.test(m[1]) || SECRET_NAME.test(m[2]))
      .map(m => `${m[1]} -> ${m[2]}`);
    // The scanner itself: it catches the three fallbacks this branch removed, in either spelling.
    const fixture = [
      'const a = process.env.SESSION_SECRET || process.env.CRON_SECRET;',
      'const b = process.env.ENCRYPTION_KEY ??',
      '  process.env.CRON_SECRET;',
      "const c = process.env.SESSION_SECRET || '';",
      'const d = process.env.NODE_ENV || process.env.VERCEL_ENV;',
    ].join('\n');
    assert(show(fallbacks(fixture)) === show(['SESSION_SECRET -> CRON_SECRET', 'ENCRYPTION_KEY -> CRON_SECRET']), `scanner self-test: ${show(fallbacks(fixture))}`);

    const files: string[] = [];
    const walk = (rel: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const child = path.join(rel, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) files.push(child);
      }
    };
    for (const dir of ['app', 'src', 'components', 'scripts']) walk(dir);
    for (const entry of fs.readdirSync(ROOT)) {
      if (/\.(ts|js|mjs)$/.test(entry) && fs.statSync(path.join(ROOT, entry)).isFile()) files.push(entry);
    }
    const hits = files.filter(f => f !== SELF).flatMap(f => fallbacks(readSource(f)).map(h => `${f}: ${h}`));
    assert(hits.length === 0, `fallbacks: ${hits.join('; ')}`);
  });

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

- [ ] **Step 2: Update the existing checks that pin the old behaviour**

In `scripts/smoke-google-connect.ts`, replace:

```ts
  await check('#17 WhatsApp with WHATSAPP_APP_SECRET unset: accepted, with one error log per process', async () => {
    seed();
    const WARNING = '[WhatsApp] WHATSAPP_APP_SECRET is not set; webhook signatures are NOT verified';
    const id = await pendingFor(42);
    const first = await postWebhook(JSON.stringify(waText(WA_BSUID, `gc_${id}`, { bsuid: WA_BSUID })));
    const second = await postWebhook(JSON.stringify(waText(WA_BSUID, 'hello', { bsuid: WA_BSUID })));
    assert(first.status === 200 && second.status === 200, `statuses ${first.status} ${second.status}`);
    assert(await savedToken(42) === 'google-rt-new', 'the unsigned claim was not handled');
    const warnings = [...first.errors, ...second.errors].filter(e => e.includes(WARNING));
    assert(warnings.length === 1, `warnings: ${show(warnings)}`);
    const { ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS } = await load('src/lib/whatsapp-signature.ts');
    assert(ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS === true, 'the unset-secret policy is not one named constant');
  });
```

with:

```ts
  await check('#17 WhatsApp with WHATSAPP_APP_SECRET unset: refused with a 500, nothing processed, one capture per process', async () => {
    seed();
    const id = await pendingFor(42);
    const first = await postWebhook(JSON.stringify(waText(WA_BSUID, `gc_${id}`, { bsuid: WA_BSUID })));
    const second = await postWebhook(JSON.stringify(waText(WA_BSUID, 'hello', { bsuid: WA_BSUID })));
    assert(first.status === 500 && second.status === 500, `statuses ${first.status} ${second.status}`);
    assert(pendingKeys().length === 1 && userWrites.length === 0 && sent.length === 0, 'an unsigned body was processed');
    const captures = captured.filter(c => c.startsWith('whatsapp-webhook-unconfigured:'));
    assert(captures.length === 1, `captures: ${show(captured)}`);
    const mod = await load('src/lib/whatsapp-signature.ts');
    assert(!('ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS' in mod), 'the accept-unsigned switch is still exported');
  });
```

#17 is the smoke's first WhatsApp post with no secret (#16 sets one), so it sees the process's one capture.

In #22 of the same file, replace:

```ts
    const waId = await pendingFor(42);
    failingSends.add('sendMessage');
    const wa = await postWebhook(JSON.stringify(waText(WA_BSUID, `gc_${waId}`, { bsuid: WA_BSUID })));
    failingSends.clear();
    assert(await savedToken(42) === 'google-rt-new', `no WhatsApp commit; ${captured.join(' | ')}`);
```

with:

```ts
    const waId = await pendingFor(42);
    const waRaw = JSON.stringify(waText(WA_BSUID, `gc_${waId}`, { bsuid: WA_BSUID }));
    // Signed: an unset WHATSAPP_APP_SECRET refuses every WhatsApp webhook (#17)
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    failingSends.add('sendMessage');
    let wa: { status: number };
    try {
      wa = await postWebhook(waRaw, { 'x-hub-signature-256': signWa(waRaw) });
    } finally {
      failingSends.clear();
      process.env.WHATSAPP_APP_SECRET = '';
    }
    assert(await savedToken(42) === 'google-rt-new', `no WhatsApp commit; ${captured.join(' | ')}`);
```

(The next line, `assert(wa.status === 200, ...)`, stays.) If Task 3 already edited lines near these in this file, it only touched the cache-key literals and the plaintext-cache assertions (lines 780-781, 833, 886, 1214), so both snippets above still match.

In `scripts/smoke-auth-leftovers.ts`, replace:

```ts
  await check('#5 production startup logs one line per missing SESSION_SECRET / WHATSAPP_APP_SECRET, naming the variable', async () => {
    const logged = await registerWith({ NODE_ENV: 'production' });
    const session = logged.filter(l => l.includes('SESSION_SECRET'));
    const app = logged.filter(l => l.includes('WHATSAPP_APP_SECRET'));
    assert(session.length === 1 && /signed with CRON_SECRET/.test(session[0]), `SESSION_SECRET lines: ${show(session)}`);
    assert(app.length === 1 && /signatures are not verified/.test(app[0]), `WHATSAPP_APP_SECRET lines: ${show(app)}`);
```

with:

```ts
  await check('#5 production startup logs one line per missing SESSION_SECRET / WHATSAPP_APP_SECRET, naming the variable and what is refused', async () => {
    const logged = await registerWith({ NODE_ENV: 'production' });
    const session = logged.filter(l => l.includes('SESSION_SECRET'));
    const app = logged.filter(l => l.includes('WHATSAPP_APP_SECRET'));
    assert(session.length === 1 && session[0] === '[startup] SESSION_SECRET is not set: WhatsApp sign-in and share-story image links are refused', `SESSION_SECRET lines: ${show(session)}`);
    assert(app.length === 1 && app[0] === '[startup] WHATSAPP_APP_SECRET is not set: every WhatsApp webhook is refused (500)', `WHATSAPP_APP_SECRET lines: ${show(app)}`);
```

- [ ] **Step 3: Run them to verify they fail**

```bash
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-fail-closed.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-google-connect.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-auth-leftovers.ts
```

Expected:
- `smoke-fail-closed.ts`: `0/12 passed`, exit 1.
  - #1 `createSessionToken does not sign with the HKDF key` (it signs with the raw `SESSION_SECRET`).
  - #2 `createSessionToken signed a cookie with no SESSION_SECRET` (the `CRON_SECRET` fallback).
  - #3 `logged []` (the catch at `session-auth.ts:75` is silent; the cookie also fails today's raw-key signature check before it is parsed).
  - #4 `redirect /he/dashboard?user_id=42` (the link is used up and a CRON-signed session is granted).
  - #5 `the cookie is not signed with the HKDF session-cookie key`.
  - #6 `ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS is still exported`.
  - #7 `Cannot find module '.../src/lib/startup-checks.ts'`.
  - #8 `error lines []` (today's lines are `console.warn` with other wording).
  - #9 `development: [...]` with no `[startup] ENCRYPTION_KEY fp` line (register() doesn't call `describeKeys` yet).
  - #10 `sent [...]` showing texts with no `missing:` line.
  - #11 `send failure: []` (the `.catch(() => {})` swallow the errors).
  - #12 `fallbacks: src/lib/session-auth.ts: SESSION_SECRET -> CRON_SECRET` (Task 6 removed the two weather-image fallbacks; this is the last one).
- `smoke-google-connect.ts`: `58/59 passed`; only #17 fails, with `statuses 200 200`.
- `smoke-auth-leftovers.ts`: `8/9 passed`; only #5 fails, with `SESSION_SECRET lines: ["[startup] SESSION_SECRET is not set: WhatsApp session cookies are signed with CRON_SECRET"]`.

- [ ] **Step 4: Session cookies under the derived key, with no fallback, in `src/lib/session-auth.ts`**

In `src/lib/session-auth.ts`, replace:

```ts
import crypto from 'crypto';
import { NextRequest } from 'next/server';

const COOKIE_NAME = 'famcal_session';
const SESSION_TTL = 24 * 60 * 60; // 24 hours in seconds

function getSecret(): string {
  const secret = process.env.SESSION_SECRET || process.env.CRON_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET or CRON_SECRET must be configured');
  }
  return secret;
}
```

with:

```ts
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { appKey } from './app-keys';

const COOKIE_NAME = 'famcal_session';
const SESSION_TTL = 24 * 60 * 60; // 24 hours in seconds
```

Then replace:

```ts
export function createSessionToken(userId: number): string {
  const payload: SessionPayload = {
```

with:

```ts
export function createSessionToken(userId: number): string {
  // The session-cookie key from SESSION_SECRET, with no fallback to another secret
  const key = appKey('session-cookie');
  if (!key) {
    throw new Error('SESSION_SECRET is not set: cannot sign a session cookie');
  }

  const payload: SessionPayload = {
```

Then replace:

```ts
  const signature = crypto
    .createHmac('sha256', getSecret())
    .update(payloadStr)
    .digest('base64url');
```

with:

```ts
  const signature = crypto
    .createHmac('sha256', key)
    .update(payloadStr)
    .digest('base64url');
```

Then replace:

```ts
export function validateSessionToken(token: string): SessionPayload | null {
  try {
```

with:

```ts
export function validateSessionToken(token: string): SessionPayload | null {
  // No key, no session: appKey reports the missing SESSION_SECRET once per process
  const key = appKey('session-cookie');
  if (!key) return null;

  try {
```

Then replace:

```ts
    const expectedSignature = crypto
      .createHmac('sha256', getSecret())
```

with:

```ts
    const expectedSignature = crypto
      .createHmac('sha256', key)
```

Then replace:

```ts
    return payload;
  } catch {
    return null;
  }
```

with:

```ts
    return payload;
  } catch {
    // Signed by us but not our JSON: deny. Never log the cookie.
    console.warn('[session] malformed session cookie');
    return null;
  }
```

- [ ] **Step 5: Check the key before the magic link is used up, in `app/api/auth/magic/route.ts`**

In `app/api/auth/magic/route.ts`, replace:

```ts
import { createSessionToken, SESSION_COOKIE, validateSessionFromRequest } from '@/src/lib/session-auth';
```

with:

```ts
import { createSessionToken, SESSION_COOKIE, validateSessionFromRequest } from '@/src/lib/session-auth';
import { appKey } from '@/src/lib/app-keys';
```

Then replace:

```ts
/**
 * Magic link auth handler
```

with:

```ts
/**
 * Invalid, expired or already used, or no key to sign a session with: the dashboard with
 * no user_id shows the card that offers a fresh link, in the language the link carries,
 * else the browser's. A browser still signed in goes to its own dashboard instead
 * (page-data re-checks the cookie).
 */
function freshLinkCard(request: NextRequest): NextResponse {
  const linkLocale = request.nextUrl.searchParams.get('locale') ?? '';
  const locale = (VALID_LOCALES as readonly string[]).includes(linkLocale)
    ? linkLocale
    : localeFromAcceptLanguage(request.headers.get('accept-language'));
  const sessionUserId = validateSessionFromRequest(request);
  const to = sessionUserId !== null ? `/${locale}/dashboard?user_id=${sessionUserId}` : `/${locale}/dashboard`;
  return NextResponse.redirect(new URL(to, getBaseUrl()));
}

/**
 * Magic link auth handler
```

Then replace:

```ts
  const data = await validateMagicToken(token);

  if (!data) {
    // Invalid, expired or already used: the dashboard with no user_id shows the card that
    // offers a fresh link, in the language the link carries, else the browser's. A browser
    // still signed in goes to its own dashboard instead (page-data re-checks the cookie).
    const linkLocale = request.nextUrl.searchParams.get('locale') ?? '';
    const locale = (VALID_LOCALES as readonly string[]).includes(linkLocale)
      ? linkLocale
      : localeFromAcceptLanguage(request.headers.get('accept-language'));
    const sessionUserId = validateSessionFromRequest(request);
    const to = sessionUserId !== null ? `/${locale}/dashboard?user_id=${sessionUserId}` : `/${locale}/dashboard`;
    return NextResponse.redirect(new URL(to, getBaseUrl()));
  }
```

with:

```ts
  // The session key before the token: validateMagicToken uses the link up (GETDEL), so a
  // link refused for a missing SESSION_SECRET still works once it is set. appKey reports
  // the missing secret (once per process).
  if (!appKey('session-cookie')) {
    console.error('[magic] SESSION_SECRET is not set; the magic link was left unused');
    return freshLinkCard(request);
  }

  const data = await validateMagicToken(token);

  if (!data) {
    return freshLinkCard(request);
  }
```

- [ ] **Step 6: No unsigned WhatsApp webhooks, in `src/lib/whatsapp-signature.ts`**

In `src/lib/whatsapp-signature.ts`, replace:

```ts
import crypto from 'crypto';

/**
 * What a WhatsApp POST gets while WHATSAPP_APP_SECRET is unset. true: processed
 * unverified, as before signatures were checked, with one error log per process. false:
 * refused. The owner hasn't chosen yet; flipping this line is the whole change.
 */
export const ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS = true;

const UNSIGNED_WARNING = '[WhatsApp] WHATSAPP_APP_SECRET is not set; webhook signatures are NOT verified';

```

with:

```ts
import crypto from 'crypto';

```

Then replace:

```ts
/**
 * verified: signed with WHATSAPP_APP_SECRET. rejected: the secret is set and the signature
 * is missing or wrong. unverified: no secret, accepted (ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS).
 * unconfigured: no secret, refused.
 */
export function checkWhatsAppSignature(rawBody: string, header: string | null): 'verified' | 'rejected' | 'unverified' | 'unconfigured' {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (secret) return isValidWhatsAppSignature(rawBody, header, secret) ? 'verified' : 'rejected';
  if (!ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS) return 'unconfigured';
  // Once per process: route bundles can each hold their own copy of this module
  const g = globalThis as { __famcalUnsignedWhatsAppWarned?: boolean };
  if (!g.__famcalUnsignedWhatsAppWarned) {
    g.__famcalUnsignedWhatsAppWarned = true;
    console.error(UNSIGNED_WARNING);
  }
  return 'unverified';
}
```

with:

```ts
/**
 * verified: signed with WHATSAPP_APP_SECRET. rejected: the secret is set and the signature
 * is missing or wrong. unconfigured: no secret (unset or ''), so nothing can be verified:
 * refused, never processed unsigned.
 */
export function checkWhatsAppSignature(rawBody: string, header: string | null): 'verified' | 'rejected' | 'unconfigured' {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return 'unconfigured';
  return isValidWhatsAppSignature(rawBody, header, secret) ? 'verified' : 'rejected';
}
```

`isValidWhatsAppSignature` and the file's header comment stay unchanged.

- [ ] **Step 7: One Sentry event per process for an unconfigured WhatsApp webhook, in `app/api/webhook/route.ts`**

In `app/api/webhook/route.ts`, replace:

```ts
      if (signature === 'unconfigured') {
        console.error('[Webhook] WHATSAPP_APP_SECRET not configured');
        return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
      }
```

with:

```ts
      if (signature === 'unconfigured') {
        console.error('[Webhook] WHATSAPP_APP_SECRET not configured');
        // Sentry once per process, not per webhook (globalThis: route bundles each hold their own copy of this module)
        const g = globalThis as { __famcalWhatsAppUnconfiguredReported?: boolean };
        if (!g.__famcalWhatsAppUnconfiguredReported) {
          g.__famcalWhatsAppUnconfiguredReported = true;
          captureError(new Error('WHATSAPP_APP_SECRET is not set: every WhatsApp webhook is refused'), 'whatsapp-webhook-unconfigured', { api_route: '/api/webhook' });
        }
        return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
      }
```

`captureError` is already imported in this file. Nothing else in the route changes here (Task 8 replaces the verify-token and Telegram-header compares).

- [ ] **Step 8: Create `src/lib/startup-checks.ts`**

```ts
/**
 * Secrets the app refuses to work without, checked once at startup (instrumentation.ts)
 * so a missing or reused one is named in the deploy log, in Sentry and in the deploy
 * message, instead of failing quietly request by request. Pure: env in, problems out.
 * A message names the variable, never its value.
 */

export interface StartupProblem {
  /** The variable at fault */
  name: string;
  /** One log line, without the [startup] prefix */
  message: string;
}

export function startupSecretProblems(env: Record<string, string | undefined>): StartupProblem[] {
  const problems: StartupProblem[] = [];
  if (!env.SESSION_SECRET) {
    problems.push({ name: 'SESSION_SECRET', message: 'SESSION_SECRET is not set: WhatsApp sign-in and share-story image links are refused' });
  }
  if (!env.WHATSAPP_APP_SECRET) {
    problems.push({ name: 'WHATSAPP_APP_SECRET', message: 'WHATSAPP_APP_SECRET is not set: every WhatsApp webhook is refused (500)' });
  }
  // app/api/webhook/route.ts answers every Telegram update with a 500 while it is unset
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    problems.push({ name: 'TELEGRAM_WEBHOOK_SECRET', message: 'TELEGRAM_WEBHOOK_SECRET is not set: every Telegram update is refused (500)' });
  }
  if (env.SESSION_SECRET && env.SESSION_SECRET === env.CRON_SECRET) {
    problems.push({ name: 'SESSION_SECRET', message: 'SESSION_SECRET equals CRON_SECRET: give it its own value' });
  }
  return problems;
}
```

- [ ] **Step 9: Replace `instrumentation.ts`**

Replace the whole file (today 42 lines: the two `console.warn` startup lines and the deploy block with two `.catch(() => {})`) with:

```ts
import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');

    // Start in-process cron scheduler (replaces QStash)
    const { startScheduler } = await import('./src/cron/scheduler');
    startScheduler();

    const { captureError } = await import('./src/lib/error-capture');

    // Startup never throws: a crash-looping container would take the bot down for everyone
    let missing: string[] = [];
    try {
      // Which encryption keys this process holds, by fingerprint only (every environment)
      const { describeKeys } = await import('./src/utils/encryption');
      console.log(describeKeys());

      // Name a missing or reused secret (production only), never its value
      if (process.env.NODE_ENV === 'production') {
        const { startupSecretProblems } = await import('./src/lib/startup-checks');
        const problems = startupSecretProblems(process.env);
        for (const problem of problems) {
          console.error(`[startup] ${problem.message}`);
          captureError(new Error(problem.message), 'startup-secret', { variable: problem.name });
        }
        missing = problems.filter(p => !process.env[p.name]).map(p => p.name);
      }
    } catch (err) {
      captureError(err, 'startup-checks');
    }

    // Notify admins of deploy (production only), naming any missing secret
    if (process.env.NODE_ENV === 'production' && process.env.RAILWAY_GIT_COMMIT_SHA) {
      const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7);
      const missingLine = missing.length ? `\nmissing: ${missing.join(', ')}` : '';
      import('./src/utils/error-notifier').then(({ getAdminUserIds }) =>
        import('./src/services/telegram/bot').then(({ getBot }) =>
          getAdminUserIds().then(adminIds => {
            const bot = getBot();
            for (const adminId of adminIds) {
              bot.sendMessage(adminId, `🚀 FamCal <code>${commitSha}</code> deployed${missingLine}`, { parse_mode: 'HTML' })
                .catch(err => captureError(err, 'deploy-notify-send', { admin_id: adminId }));
            }
          })
        )
      ).catch(err => captureError(err, 'deploy-notify'));
    }
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
```

- [ ] **Step 10: Run the smokes to verify they pass**

```bash
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-fail-closed.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-google-connect.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-auth-leftovers.ts
```

Expected: `12/12 passed`, `59/59 passed`, `9/9 passed`, each exit 0.

- [ ] **Step 11: Typecheck, lint and the smokes this change can break**

```bash
npx tsc --noEmit -p .
npm run -s lint
for s in smoke-fail-closed smoke-google-connect smoke-auth-leftovers smoke-image-link smoke-auth-identity smoke-calendar-range smoke-miniapp-gate smoke-oauth-weather smoke-page-auth smoke-account-merge smoke-calendar-connection smoke-initdata-header smoke-pairing-accept smoke-calendar-editor-api smoke-admin-panel-ssr; do
  bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/$s.ts | tail -1
done
```

Expected: tsc and lint print nothing; every smoke ends `N/N passed`. These smokes sign or check `famcal_session` cookies (createSessionToken, magic links) and all set `SESSION_SECRET ||= 'test-session-secret'`, so they pass under the derived key. smoke-miniapp-gate #11, #12 and #15 run the magic route's card and sign-in paths.

- [ ] **Step 12: Commit**

```bash
git add src/lib/session-auth.ts app/api/auth/magic/route.ts src/lib/whatsapp-signature.ts app/api/webhook/route.ts src/lib/startup-checks.ts instrumentation.ts scripts/smoke-fail-closed.ts scripts/smoke-google-connect.ts scripts/smoke-auth-leftovers.ts
git commit -m "$(cat <<'EOF'
fix(security): fail closed without SESSION_SECRET or WHATSAPP_APP_SECRET, and name missing secrets at startup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---


### Task 8: One constant-time secret compare; the cron routes take CRON_SECRET from the header only

**Deviation:** `scripts/smoke-auth-leftovers.ts` #4 is not in the spec's list of smokes to update. Its "no caller" search reads every file under `scripts/` for the text `subscription/usage`, and the new `scripts/smoke-secret-compare.ts` loads that route to test it. The search now skips `scripts/smoke-*` files (a smoke is not a caller). Nothing else in #4 changes.

**Caller audit (done while drafting, nothing to change):** nothing in the repo calls the six cron routes (`/api/daily-summary`, `/api/tomorrow-summary`, `/api/reminders`, `/api/native-reminders`, `/api/setup-reminders`, `/api/google-sync-worker`) over HTTP. `src/cron/scheduler.ts` calls the handlers directly, and no script, doc or package script uses `?secret=`. The only `?secret=` readers are `src/lib/cron-handler.ts:35-36` and `app/api/subscription/usage/route.ts:16`. The usage route keeps its query parameter: the spec keeps that route and gives it only the shared check, and it has no caller (smoke-auth-leftovers #4). `README.md:117` is the one doc line about the manual endpoints. It now names the header.

**Files:**
- Create: `src/lib/secret-compare.ts`
- Create: `scripts/smoke-secret-compare.ts`
- Modify: `src/lib/cron-handler.ts:7, 25, 34-39`
- Modify: `app/api/subscription/usage/route.ts:3, 18-19`
- Modify: `app/api/execute-command/route.ts:9, 31`
- Modify: `app/api/webhook/route.ts:4, 12-13, 16-17, 49` (as Task 7 left it; these snippets avoid the WhatsApp `'unconfigured'` branch Task 7 edits)
- Modify: `scripts/smoke-auth-leftovers.ts:191-192`
- Modify: `README.md:117`
- Test: `scripts/smoke-secret-compare.ts`; existing `scripts/smoke-auth-leftovers.ts`, `scripts/smoke-google-connect.ts`, `scripts/smoke-auth-identity.ts`, `scripts/smoke-initdata-header.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. It edits `app/api/webhook/route.ts` after Task 7.
- Produces: `export function matchesSecret(given: string | null | undefined, expected: string | null | undefined): boolean`. It returns false for an unset or empty `expected`, and for a missing, empty or non-string `given`. Otherwise it compares the sha256 digests with `crypto.timingSafeEqual`.

- [ ] **Step 1: Write the failing smoke `scripts/smoke-secret-compare.ts`**

Create `scripts/smoke-secret-compare.ts`:

```ts
// Smoke test for the shared-secret compares (secret rotation spec, section e.1).
//
// - matchesSecret (src/lib/secret-compare.ts) compares sha256 digests in constant time and
//   never matches an unset or empty expected value.
// - The cron routes (withCronHandler) take CRON_SECRET only as `Authorization: Bearer`.
//   With CRON_SECRET='' a bare `?secret=` opened every cron route, and a secret in a URL
//   ends up in logs.
// - /api/subscription/usage, /api/execute-command and /api/webhook (the Meta verify token
//   and the Telegram secret header) compare through matchesSecret. With
//   WHATSAPP_WEBHOOK_VERIFY_TOKEN='' an empty hub.verify_token passed the Meta check.
//
// Real: secret-compare, cron-handler, the usage route and the webhook route. Faked at the
// boundaries: Prisma and Redis (recorded, never answered), error capture, the subscription
// service, the messaging index and the webhook handlers. No network, no DB.
//
// Run: bash <scratchpad>/run-smoke.sh scripts/smoke-secret-compare.ts

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
const env = process.env as Record<string, string | undefined>;

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

const show = (value: unknown) => JSON.stringify(value);
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

// ---- Boundaries: stubs in require's cache, served to import() by a load hook ----

const Module = nodeRequire('module');
const stubs: Record<string, Row> = {};
(globalThis as Row).__smokeStubs = stubs;
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs)) return nextLoad(url, context);
    const names = Object.keys(stubs[file]).filter(n => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
    const source = [
      `const s = globalThis.__smokeStubs[${JSON.stringify(file)}];`,
      ...names.map(n => `export const ${n} = s[${JSON.stringify(n)}];`),
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

/** Every Prisma or Redis access, by path ("prisma.user.findUnique"). */
const dataCalls: string[] = [];
function recording(name: string): Row {
  return new Proxy({} as Row, {
    get: (_t, model) => {
      if (typeof model !== 'string' || model === 'then') return undefined;
      return new Proxy(async () => null, {
        get: (_f, method) => {
          if (typeof method !== 'string' || method === 'then') return undefined;
          return async () => { dataCalls.push(`${name}.${model}.${method}`); return null; };
        },
        apply: () => { dataCalls.push(`${name}.${model}()`); return Promise.resolve(null); },
      });
    },
  });
}

const captured: string[] = [];
const featureChecks: unknown[][] = [];
const handled: string[] = [];
function installStubs() {
  stub('src/utils/prisma.ts', { prisma: recording('prisma'), withRetry: (fn: () => unknown) => fn() });
  stub('src/utils/redis.ts', { redis: recording('redis') });
  const capture = (_err: unknown, context: string) => { captured.push(context); };
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
  stub('src/services/subscription-service.ts', {
    checkFeatureAccess: async (...args: unknown[]) => { featureChecks.push(args); return { allowed: true }; },
  });
  const MessagingPlatform = { TELEGRAM: 'telegram', WHATSAPP: 'whatsapp' };
  stub('src/services/messaging/index.ts', {
    MessagingPlatform,
    detectPlatform: (req: { body: Row }) =>
      req.body?.object === 'whatsapp_business_account' ? MessagingPlatform.WHATSAPP : MessagingPlatform.TELEGRAM,
  });
  stub('src/services/webhook-handlers.ts', {
    handleTelegramWebhook: async () => { handled.push('telegram'); },
    handleWhatsAppWebhook: async () => { handled.push('whatsapp'); },
  });
}

/** Source files under a folder, as repo-relative paths. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(child);
    }
  };
  walk(dir);
  return out;
}

async function main() {
  installStubs();
  const { NextRequest } = nodeRequire('next/server');
  const req = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
    new NextRequest(`http://localhost${url}`, init);

  // Missing before the change: each check that uses it then fails on its own.
  const compare = await load('src/lib/secret-compare.ts').catch(() => ({} as Row));

  await check('#1 matchesSecret: equal non-empty strings only; an unset or empty expected value, or a missing given value, never matches; no throw on a length mismatch', () => {
    const m = compare.matchesSecret;
    assert(typeof m === 'function', 'matchesSecret is not exported from src/lib/secret-compare.ts');
    const cases: [unknown, unknown, boolean][] = [
      ['c', 'c', true],
      ['סוד-1', 'סוד-1', true],
      ['c', 'C', false],
      ['c', 'cc', false],
      ['a-much-longer-given-value', 'c', false],
      ['', '', false],
      [null, '', false],
      [undefined, undefined, false],
      ['', 'c', false],
      [null, 'c', false],
      [undefined, 'c', false],
      ['c', '', false],
      ['c', null, false],
      ['c', undefined, false],
      [1, '1', false],
      [{ toString: () => 'c' }, 'c', false],
    ];
    const wrong = cases.filter(([given, expected, want]) => m(given, expected) !== want);
    assert(wrong.length === 0, `wrong results: ${show(wrong.map(([g, e, w]) => ({ given: String(g), expected: String(e), want: w })))}`);
  });

  const { withCronHandler } = await load('src/lib/cron-handler.ts');
  const cronCalls: string[] = [];
  const runCron = async (url: string, headers?: Record<string, string>) => {
    const res: Response = await withCronHandler(req(url, { method: 'POST', headers }), {
      jobName: 'Smoke Job',
      handler: async (_r: unknown, searchParams: URLSearchParams) => {
        cronCalls.push(searchParams.get('window') ?? '');
        return { success: true, message: 'ran' };
      },
    });
    return res.status;
  };

  await check('#2 cron: with CRON_SECRET unset or empty, no request opens a cron route (no header, ?secret=, an empty Bearer)', async () => {
    cronCalls.length = 0;
    const saved = env.CRON_SECRET;
    try {
      delete env.CRON_SECRET;
      const unsetNoAuth = await runCron('/api/reminders');
      const unsetEmptyQuery = await runCron('/api/reminders?secret=');
      env.CRON_SECRET = '';
      const emptyQuery = await runCron('/api/reminders?secret=');
      const emptyBearer = await runCron('/api/reminders', { authorization: 'Bearer ' });
      const statuses = { unsetNoAuth, unsetEmptyQuery, emptyQuery, emptyBearer };
      assert(Object.values(statuses).every(s => s === 401), `statuses ${show(statuses)}`);
      assert(cronCalls.length === 0, `the handler ran ${cronCalls.length} time(s)`);
    } finally {
      env.CRON_SECRET = saved;
    }
  });

  await check('#3 cron: CRON_SECRET only as `Authorization: Bearer`; ?secret=c, a bare header value and a wrong Bearer get 401; Bearer c runs the handler with its query', async () => {
    cronCalls.length = 0;
    const saved = env.CRON_SECRET;
    try {
      env.CRON_SECRET = 'c';
      const query = await runCron('/api/reminders?secret=c');
      const bare = await runCron('/api/reminders', { authorization: 'c' });
      const wrong = await runCron('/api/reminders', { authorization: 'Bearer wrong' });
      assert(query === 401 && bare === 401 && wrong === 401, `query ${query}, bare ${bare}, wrong ${wrong}`);
      assert(cronCalls.length === 0, `the handler ran on a refused request: ${show(cronCalls)}`);
      const good = await runCron('/api/reminders?window=7', { authorization: 'Bearer c' });
      assert(good === 200, `Bearer c: ${good}`);
      assert(show(cronCalls) === show(['7']), `handler calls ${show(cronCalls)}`);
    } finally {
      env.CRON_SECRET = saved;
    }
  });

  await check('#4 /api/subscription/usage: CRON_SECRET empty and ?secret= empty is 401 with no lookup; the right secret still answers', async () => {
    featureChecks.length = 0;
    const saved = env.CRON_SECRET;
    try {
      const { GET } = await load('app/api/subscription/usage/route.ts');
      env.CRON_SECRET = '';
      const open = await GET(req('/api/subscription/usage?user_id=1&feature=reminders&secret='));
      assert(open.status === 401, `empty secret: ${open.status}`);
      assert(featureChecks.length === 0, `checkFeatureAccess ran: ${show(featureChecks)}`);
      env.CRON_SECRET = 'c';
      const wrong = await GET(req('/api/subscription/usage?user_id=1&feature=reminders&secret=x'));
      const good = await GET(req('/api/subscription/usage?user_id=1&feature=reminders&secret=c'));
      assert(wrong.status === 401 && good.status === 200, `wrong ${wrong.status}, good ${good.status}`);
      assert(show(featureChecks) === show([[1, 'reminders']]), `checkFeatureAccess calls ${show(featureChecks)}`);
    } finally {
      env.CRON_SECRET = saved;
    }
  });

  await check('#5 GET /api/webhook (Meta verify): an empty WHATSAPP_WEBHOOK_VERIFY_TOKEN matches nothing; the right token echoes the challenge', async () => {
    const saved = env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    try {
      const { GET } = await load('app/api/webhook/route.ts');
      const verify = (token?: string) =>
        GET(req(`/api/webhook?hub.mode=subscribe&hub.challenge=ch-1${token === undefined ? '' : `&hub.verify_token=${token}`}`));
      env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = '';
      const empty = await verify('');
      delete env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
      const unset = await verify();
      env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'vt';
      const wrong = await verify('vX');
      const good = await verify('vt');
      assert(empty.status === 403 && unset.status === 403 && wrong.status === 403,
        `empty ${empty.status}, unset ${unset.status}, wrong ${wrong.status}`);
      assert(good.status === 200 && (await good.text()) === 'ch-1', `good ${good.status}`);
    } finally {
      env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = saved;
    }
  });

  await check('#6 POST /api/webhook (Telegram): the secret header is compared with matchesSecret; right handled, wrong or missing 401', async () => {
    handled.length = 0;
    const saved = env.TELEGRAM_WEBHOOK_SECRET;
    try {
      const src = readSource('app/api/webhook/route.ts');
      assert(/matchesSecret\(\s*providedSecret\s*,\s*webhookSecret\s*\)/.test(src), 'the Telegram header is not compared with matchesSecret(providedSecret, webhookSecret)');
      const { POST } = await load('app/api/webhook/route.ts');
      env.TELEGRAM_WEBHOOK_SECRET = 'tg-s1';
      const body = JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 9 }, text: 'hi' } });
      const post = (headers: Record<string, string>) => POST(req('/api/webhook', { method: 'POST', headers, body }));
      const missing = await post({});
      const wrong = await post({ 'x-telegram-bot-api-secret-token': 'tg-s2' });
      assert(missing.status === 401 && wrong.status === 401, `missing ${missing.status}, wrong ${wrong.status}`);
      assert(handled.length === 0, `handled a refused update: ${show(handled)}`);
      const good = await post({ 'x-telegram-bot-api-secret-token': 'tg-s1' });
      assert(good.status === 200 && show(handled) === show(['telegram']), `good ${good.status}, handled ${show(handled)}`);
    } finally {
      env.TELEGRAM_WEBHOOK_SECRET = saved;
    }
  });

  await check('#7 no code in app/ or src/ compares a secret env value with === or !==; the four call sites use matchesSecret', () => {
    // A check against a literal, undefined or null (is it set?) is not a secret compare
    const plainCompare = [
      /[!=]==\s*process\.env\.[A-Z0-9_]*(SECRET|TOKEN|KEY)\b/,
      /process\.env\.[A-Z0-9_]*(SECRET|TOKEN|KEY)\b\s*[!=]==\s*(?![\s'"`]|undefined\b|null\b)/,
      /[!=]==\s*webhookSecret\b/,
    ];
    const hits = [...sourceFiles('app'), ...sourceFiles('src')]
      .filter(f => plainCompare.some(re => re.test(readSource(f))));
    assert(hits.length === 0, `plain compares in ${hits.join(', ')}`);
    const sites = ['src/lib/cron-handler.ts', 'app/api/subscription/usage/route.ts', 'app/api/execute-command/route.ts', 'app/api/webhook/route.ts'];
    const missing = sites.filter(f => !/matchesSecret\(/.test(readSource(f)));
    assert(missing.length === 0, `no matchesSecret in ${missing.join(', ')}`);
  });

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

- [ ] **Step 2: Run it to verify it fails**

Run: `bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-secret-compare.ts`

Expected: `0/7 passed`, exit 1, failing for these reasons on the pre-task code:

- #1: `matchesSecret is not exported from src/lib/secret-compare.ts` (the module is missing).
- #2: `statuses {"unsetNoAuth":401,"unsetEmptyQuery":401,"emptyQuery":200,"emptyBearer":401}`. With `CRON_SECRET=''`, a bare `?secret=` gives `'' !== ''`, which is false, so the request is let in.
- #3: `query 200, bare 200, wrong 401`. Today `?secret=c` is accepted, and so is a header without `Bearer ` (`.replace('Bearer ', '')` leaves `c` as it is).
- #4: `empty secret: 200`. The usage route has the same `'' !== ''` hole.
- #5: `empty 200, unset 403, wrong 403`. With `WHATSAPP_WEBHOOK_VERIFY_TOKEN=''`, an empty `hub.verify_token` echoes the challenge.
- #6: `the Telegram header is not compared with matchesSecret(providedSecret, webhookSecret)`.
- #7: `plain compares in app/api/execute-command/route.ts, app/api/subscription/usage/route.ts, app/api/webhook/route.ts, src/lib/cron-handler.ts`.

- [ ] **Step 3: Create `src/lib/secret-compare.ts`**

```ts
/**
 * Constant-time compare for shared secrets: CRON_SECRET, the Telegram webhook secret
 * header and the Meta verify token. Both sides are hashed first, so the compare never
 * throws on a length mismatch and its timing says nothing about the secret. An unset or
 * empty expected value never matches: an empty env var must not open a route.
 */

import crypto from 'crypto';

const digest = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest();

/** True only when both are non-empty strings and equal. */
export function matchesSecret(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (typeof expected !== 'string' || expected === '') return false;
  if (typeof given !== 'string' || given === '') return false;
  return crypto.timingSafeEqual(digest(given), digest(expected));
}
```

- [ ] **Step 4: `src/lib/cron-handler.ts`: import matchesSecret**

Replace, in `src/lib/cron-handler.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
```

with:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { matchesSecret } from '@/src/lib/secret-compare';
```

- [ ] **Step 5: `src/lib/cron-handler.ts`: the doc comment names the header-only rule**

Replace, in `src/lib/cron-handler.ts`:

```ts
 * Requires CRON_SECRET via Authorization header or query parameter.
```

with:

```ts
 * Requires `Authorization: Bearer <CRON_SECRET>`. No query-string secret: URLs end up in
 * logs, and an empty CRON_SECRET must not open the route.
```

- [ ] **Step 6: `src/lib/cron-handler.ts`: header only, through matchesSecret, with a log line on refusal**

Replace, in `src/lib/cron-handler.ts`:

```ts
  // Validate CRON_SECRET
  const secret = request.headers.get('authorization')?.replace('Bearer ', '') ||
    searchParams.get('secret');
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
```

with:

```ts
  // CRON_SECRET from the Authorization header only
  const auth = request.headers.get('authorization');
  const given = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
  if (!matchesSecret(given, process.env.CRON_SECRET)) {
    console.warn(`[${jobName}] Refused a cron request without a valid Authorization: Bearer secret`);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
```

- [ ] **Step 7: `app/api/subscription/usage/route.ts`: import matchesSecret**

Replace, in `app/api/subscription/usage/route.ts`:

```ts
import { captureError } from '@/src/lib/error-capture';
```

with:

```ts
import { captureError } from '@/src/lib/error-capture';
import { matchesSecret } from '@/src/lib/secret-compare';
```

- [ ] **Step 8: `app/api/subscription/usage/route.ts`: compare through matchesSecret (the query parameter stays: the spec keeps this route as is apart from the shared check)**

Replace, in `app/api/subscription/usage/route.ts`:

```ts
    // Internal API - require cron secret
    if (secret !== process.env.CRON_SECRET) {
```

with:

```ts
    // Internal API - require cron secret (an unset or empty CRON_SECRET matches nothing)
    if (!matchesSecret(secret, process.env.CRON_SECRET)) {
```

- [ ] **Step 9: `app/api/execute-command/route.ts`: import matchesSecret**

Replace, in `app/api/execute-command/route.ts`:

```ts
import { captureError } from '@/src/lib/error-capture';
```

with:

```ts
import { captureError } from '@/src/lib/error-capture';
import { matchesSecret } from '@/src/lib/secret-compare';
```

- [ ] **Step 10: `app/api/execute-command/route.ts`: the operator path compares through matchesSecret (a non-string body `secret` never matches)**

Replace, in `app/api/execute-command/route.ts`:

```ts
    const hasServerSecret = secret && secret === process.env.CRON_SECRET;
```

with:

```ts
    const hasServerSecret = matchesSecret(secret, process.env.CRON_SECRET);
```

- [ ] **Step 11: `app/api/webhook/route.ts`: import matchesSecret**

Replace, in `app/api/webhook/route.ts`:

```ts
import { checkWhatsAppSignature } from '@/src/lib/whatsapp-signature';
```

with:

```ts
import { checkWhatsAppSignature } from '@/src/lib/whatsapp-signature';
import { matchesSecret } from '@/src/lib/secret-compare';
```

- [ ] **Step 12: `app/api/webhook/route.ts`: the Meta verify token through matchesSecret**

Replace, in `app/api/webhook/route.ts`:

```ts
  // WhatsApp webhook verification
  if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
```

with:

```ts
  // WhatsApp webhook verification (an unset or empty verify token matches nothing)
  if (mode === 'subscribe' && matchesSecret(token, process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN)) {
```

- [ ] **Step 13: `app/api/webhook/route.ts`: log a refused verification**

Replace, in `app/api/webhook/route.ts`:

```ts
  } else {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
```

with:

```ts
  } else {
    console.warn('[WhatsApp] Webhook verification refused: wrong mode or verify token');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
```

- [ ] **Step 14: `app/api/webhook/route.ts`: the Telegram secret header through matchesSecret**

Replace, in `app/api/webhook/route.ts`:

```ts
      if (providedSecret !== webhookSecret) {
```

with:

```ts
      if (!matchesSecret(providedSecret, webhookSecret)) {
```

- [ ] **Step 15: `scripts/smoke-auth-leftovers.ts`: #4 caller search skips smoke scripts (the new smoke loads the usage route to test it)**

Replace, in `scripts/smoke-auth-leftovers.ts`:

```ts
    const callers = sourceFiles().filter(f => f !== path.join('app', 'api', 'subscription', 'usage', 'route.ts')
      && readSource(f).includes('subscription/usage'));
```

with:

```ts
    // A smoke that loads the route to test it is not a caller
    const callers = sourceFiles().filter(f => f !== path.join('app', 'api', 'subscription', 'usage', 'route.ts')
      && !/^scripts[\\/]smoke-/.test(f)
      && readSource(f).includes('subscription/usage'));
```

- [ ] **Step 16: `README.md`: README: the manual cron endpoints take the header**

Replace, in `README.md`:

```md
every job but the health check also has an API endpoint guarded by `CRON_SECRET` for manual runs.
```

with:

```md
every job but the health check also has an API endpoint for manual runs, guarded by `CRON_SECRET` sent as `Authorization: Bearer <CRON_SECRET>` (a `?secret=` query is refused).
```

- [ ] **Step 17: Run the smoke to verify it passes**

Run: `bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-secret-compare.ts`

Expected: `7/7 passed`, exit 0. The log shows `[Smoke Job] Refused a cron request ...` lines and `[WhatsApp] Webhook verification refused ...` lines. These are the new refusal logs.

- [ ] **Step 18: Typecheck, lint, and the smokes this change can break**

Run each, from the repo root:

```bash
npx tsc --noEmit -p .
npm run -s lint
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-secret-compare.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-auth-leftovers.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-google-connect.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-auth-identity.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-initdata-header.ts
```

Expected: tsc and lint are clean, and every smoke ends with all checks passed.
- `smoke-auth-leftovers` #4 still gets a 401 from the usage route with no secret, and now ignores smoke files in its caller search.
- `smoke-google-connect` #18 and #22 exercise the Telegram secret header through `matchesSecret`.
- `smoke-auth-identity` #12/#24 and `smoke-initdata-header` exercise `execute-command`'s non-operator path.

- [ ] **Step 19: Commit**

```bash
git add src/lib/secret-compare.ts scripts/smoke-secret-compare.ts src/lib/cron-handler.ts app/api/subscription/usage/route.ts app/api/execute-command/route.ts app/api/webhook/route.ts scripts/smoke-auth-leftovers.ts README.md
git commit -F - <<'EOF'
fix(security): one constant-time secret compare; cron routes take CRON_SECRET from the Authorization header only

matchesSecret never matches an unset or empty secret, so CRON_SECRET='' no longer opens
the cron routes or the usage check through a bare ?secret=, and an empty Meta verify token
no longer verifies. The cron routes drop ?secret= (URLs end up in logs).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

---

### Task 9: Sentry scrubs shared secrets and bot tokens; a safe deploy-day setup-webhook

**Deviation:**
1. **The source scan for `process.env.<SECRET> || process.env.<OTHER>` lives in Task 7's `scripts/smoke-fail-closed.ts` (#12)**, where it can be seen failing: `src/lib/session-auth.ts:14` is the last such fallback, and Task 7 removes it.
2. **The other checks the spec lists under `smoke-secret-hygiene.ts` live elsewhere, per the interface contract:**
   - cron: `smoke-secret-compare.ts` (Task 8);
   - image links: `smoke-image-link.ts` (Task 6);
   - session, WhatsApp and startup: `smoke-fail-closed.ts` (Task 7).

   This smoke covers the Sentry scrub and `setup-webhook`.
3. **`setup-webhook` exports a testable `run()` as well as the pure `buildSetWebhookParams()`.** `run()` takes an injectable Bot API caller and loggers, so the smoke can check the getMe → setWebhook → getWebhookInfo order and that nothing printed holds the token or the secret, without network. The `require.main === module` guard works: `package.json` has no `"type"`, so tsx runs `scripts/*.ts` as CommonJS (`scripts/dev.ts:140` uses the same guard). Checked while drafting: an `import()` of such a file from a smoke does not run its main block.

**Files:**
- Modify: `src/lib/sentry-scrub.ts:7-8, 23-26, 31, 38-56, 83-93, 115-121`
- Modify: `sentry.server.config.ts:2, 16-19`
- Modify (full rewrite): `scripts/setup-webhook.ts`
- Create: `scripts/smoke-secret-hygiene.ts`
- Test: `scripts/smoke-secret-hygiene.ts`; existing `scripts/smoke-sentry-scrub.ts`, `scripts/smoke-initdata-header.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, in `src/lib/sentry-scrub.ts`:
  - `export function scrubServerBreadcrumb<B extends ScrubbableBreadcrumb>(breadcrumb: B): B` (new);
  - `scrubUrl`, `scrubServerEvent`, `scrubServerTransaction` and `scrubBreadcrumb` keep their signatures. They now also scrub the `secret` / `sig` / `hub.verify_token` query values and `/bot<id>:<token>`, and they drop the `authorization` and `x-telegram-bot-api-secret-token` headers.
- Produces, in `scripts/setup-webhook.ts`:
  - `export type TelegramCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>`
  - `export interface SetWebhookParams { url: string; secret_token: string }`
  - `export function readCredentials(env: Record<string, string | undefined>): { token: string; secret: string }`
  - `export function buildSetWebhookParams(env: Record<string, string | undefined>, url: string | undefined): SetWebhookParams`
  - `export function telegramCaller(token: string): TelegramCall`
  - `export async function run(args: string[], env: Record<string, string | undefined>, makeCall?: (token: string) => TelegramCall, log?: (line: string) => void, logError?: (line: string) => void): Promise<number>`

- [ ] **Step 1: Write the failing smoke `scripts/smoke-secret-hygiene.ts`**

Create `scripts/smoke-secret-hygiene.ts`:

```ts
// Smoke test for secret hygiene around the rotation (secret rotation spec, sections e.2
// and e.3; the source scan from its Testing section is in smoke-fail-closed.ts).
//
// - Sentry: the cron Authorization header and Telegram's webhook secret header, the
//   secret / sig / hub.verify_token query values, and the bot token Telegram API URLs
//   carry in their path (/bot<id>:<token>/) reached server events, transactions and
//   breadcrumbs. src/lib/sentry-scrub.ts now removes them, and the server config scrubs
//   breadcrumbs too.
// - scripts/setup-webhook.ts, the deploy-day command: no dotenv (the local .env is DEV),
//   both secrets required before any network call, the secret and the URL validated,
//   getMe first, getWebhookInfo after, and the token and the secret never printed. Its
//   parameter building is a pure export, and importing it runs nothing.
//
// Representative events go through the scrub functions; the Sentry configs are loaded
// with @sentry/nextjs replaced by a recorder of its init options; the Bot API is a fake
// caller and https.request is recorded. No network.
//
// Run: bash <scratchpad>/run-smoke.sh scripts/smoke-secret-hygiene.ts

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

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

const show = (value: unknown) => JSON.stringify(value);
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

// ---- @sentry/nextjs replaced by a recorder of Sentry.init's options ----

const inits: Row[] = [];
(globalThis as Row).__sentryInits = inits;
const Module = nodeRequire('module');
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!file.includes(`${path.sep}@sentry${path.sep}nextjs${path.sep}`)) return nextLoad(url, context);
    return { format: 'module', source: 'export const init = (o) => { globalThis.__sentryInits.push(o); };', shortCircuit: true };
  },
});
const sentryEntry = nodeRequire.resolve('@sentry/nextjs');
const sentryStub = new Module(sentryEntry);
Object.assign(sentryStub, { filename: sentryEntry, loaded: true, exports: { init: (o: Row) => { inits.push(o); } } });
Module._cache[sentryEntry] = sentryStub;

// ---- Network guard: every https.request is recorded and refused ----

const httpsRequests: string[] = [];
const https = nodeRequire('https');
https.request = (url: unknown) => {
  httpsRequests.push(String(url).replace(/bot[^/]+/, 'bot<token>'));
  throw new Error('network call in a smoke');
};

// ---- Fixtures ----

const CRON = 'cron-s3cr3t-value';
const TG_SECRET = 'tg-hook-secret-1';
const BOT_TOKEN = '123456789:AAHfake_Bot-Token_value0123456789';
const SIG = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const VERIFY = 'meta-verify-token-1';

const leaks = (value: unknown): string[] => {
  const text = show(value);
  const found: string[] = [];
  for (const [name, secret] of [['cron secret', CRON], ['webhook secret', TG_SECRET], ['bot token', BOT_TOKEN],
    ['bot token (encoded)', BOT_TOKEN.replace(':', '%3A')], ['sig', SIG], ['verify token', VERIFY]] as [string, string][]) {
    if (text.includes(secret)) found.push(name);
  }
  if (/AAHfake/.test(text)) found.push('part of the bot token');
  return found;
};

async function main() {
  // The scrubber exists before the change; its new rules are what the checks pin.
  const scrub = await load('src/lib/sentry-scrub.ts');

  await check('#1 server event: the Authorization and X-Telegram-Bot-Api-Secret-Token headers are dropped (any case); other headers kept', () => {
    const out = scrub.scrubServerEvent({
      request: {
        method: 'POST',
        url: 'https://famcal.bot/api/webhook',
        headers: {
          host: 'famcal.bot',
          Authorization: `Bearer ${CRON}`,
          'X-Telegram-Bot-Api-Secret-Token': TG_SECRET,
          'content-type': 'application/json',
        },
      },
    });
    assert(leaks(out).length === 0, `leaks ${leaks(out).join(', ')}: ${show(out)}`);
    assert(show(out.request.headers) === show({ host: 'famcal.bot', 'content-type': 'application/json' }), `headers ${show(out.request.headers)}`);
  });

  await check('#2 server event: secret, sig and hub.verify_token query values scrubbed in url, query_string (string, object, pairs) and the nextjs request path; other values kept', () => {
    const query = `user_id=9&secret=${CRON}&sig=${SIG}&ts=1760000000&hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=ch-1&signal=on`;
    const want = 'user_id=9&secret=[scrubbed]&sig=[scrubbed]&ts=1760000000&hub.mode=subscribe&hub.verify_token=[scrubbed]&hub.challenge=ch-1&signal=on';
    const out = scrub.scrubServerEvent({
      request: { url: `https://famcal.bot/api/weather-image?${query}`, query_string: query },
      contexts: { nextjs: { request_path: `/api/weather-image?${query}` } },
    });
    assert(out.request.url === `https://famcal.bot/api/weather-image?${want}`, `url ${out.request.url}`);
    assert(out.request.query_string === want, `query_string ${out.request.query_string}`);
    assert(out.contexts.nextjs.request_path === `/api/weather-image?${want}`, `request_path ${out.contexts.nextjs.request_path}`);
    const obj = scrub.scrubServerEvent({ request: { query_string: { user_id: '9', secret: CRON, sig: SIG, 'hub.verify_token': VERIFY, ts: '1' } } }).request.query_string;
    assert(show(obj) === show({ user_id: '9', secret: '[scrubbed]', sig: '[scrubbed]', 'hub.verify_token': '[scrubbed]', ts: '1' }), `object ${show(obj)}`);
    const pairs = scrub.scrubServerEvent({ request: { query_string: [['user_id', '9'], ['sig', SIG], ['hub.verify_token', VERIFY]] } }).request.query_string;
    assert(show(pairs) === show([['user_id', '9'], ['sig', '[scrubbed]'], ['hub.verify_token', '[scrubbed]']]), `pairs ${show(pairs)}`);
  });

  await check('#3 a bot token in a URL path becomes /bot[scrubbed]/ (plain and %3A-encoded colon); the method and query stay', () => {
    const plain = scrub.scrubServerEvent({ request: { url: `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=9` } }).request.url;
    assert(plain === 'https://api.telegram.org/bot[scrubbed]/sendMessage?chat_id=9', `plain ${plain}`);
    const encoded = scrub.scrubServerEvent({ request: { url: `https://api.telegram.org/bot${BOT_TOKEN.replace(':', '%3A')}/getMe` } }).request.url;
    assert(encoded === 'https://api.telegram.org/bot[scrubbed]/getMe', `encoded ${encoded}`);
    const untouched = scrub.scrubServerEvent({ request: { url: 'https://famcal.bot/robots.txt?about=bots' } }).request.url;
    assert(untouched === 'https://famcal.bot/robots.txt?about=bots', `untouched ${untouched}`);
  });

  await check('#4 server transaction: span descriptions and URL attributes scrubbed; the secret header attributes dropped, in the trace context and in each span', () => {
    const data = (): Row => ({
      'http.method': 'POST',
      'http.request.header.authorization': `Bearer ${CRON}`,
      'http.request.header.x_telegram_bot_api_secret_token': TG_SECRET,
      'http.request.header.x-telegram-bot-api-secret-token': TG_SECRET,
      'http.request.header.user_agent': 'TelegramBot',
      'url.full': `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      'http.url': `https://famcal.bot/api/reminders?secret=${CRON}`,
    });
    const out = scrub.scrubServerTransaction({
      type: 'transaction',
      contexts: { trace: { trace_id: 't', span_id: 's', data: data() } },
      spans: [{ span_id: 'a', description: `POST https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, data: data() }],
    });
    assert(leaks(out).length === 0, `leaks ${leaks(out).join(', ')}: ${show(out)}`);
    for (const [where, d] of [['trace', out.contexts.trace.data], ['span', out.spans[0].data]] as [string, Row][]) {
      const keys = Object.keys(d).sort();
      assert(show(keys) === show(['http.method', 'http.request.header.user_agent', 'http.url', 'url.full']), `${where} keys ${show(keys)}`);
      assert(d['url.full'] === 'https://api.telegram.org/bot[scrubbed]/sendMessage', `${where} url.full ${d['url.full']}`);
      assert(d['http.url'] === 'https://famcal.bot/api/reminders?secret=[scrubbed]', `${where} http.url ${d['http.url']}`);
    }
    assert(out.spans[0].description === 'POST https://api.telegram.org/bot[scrubbed]/sendMessage', `description ${out.spans[0].description}`);
  });

  await check('#5 the server config scrubs breadcrumbs: http/fetch URLs and messages lose the bot token and secret query values; other fields kept', async () => {
    inits.length = 0;
    await load('sentry.server.config.ts');
    assert(inits.length === 1, `Sentry.init calls: ${inits.length}`);
    const before = inits[0].beforeBreadcrumb;
    assert(typeof before === 'function', 'sentry.server.config.ts has no beforeBreadcrumb');
    const http = before({ category: 'http', type: 'http', data: { url: `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, method: 'POST', status_code: 200 } }, {});
    assert(show(http) === show({ category: 'http', type: 'http', data: { url: 'https://api.telegram.org/bot[scrubbed]/sendMessage', method: 'POST', status_code: 200 } }), `http ${show(http)}`);
    const fetchCrumb = before({ category: 'fetch', data: { url: `https://famcal.bot/api/weather-image?user_id=9&sig=${SIG}`, method: 'GET' } }, {});
    assert(fetchCrumb.data.url === 'https://famcal.bot/api/weather-image?user_id=9&sig=[scrubbed]', `fetch ${show(fetchCrumb)}`);
    const consoleCrumb = before({ category: 'console', message: `request to https://api.telegram.org/bot${BOT_TOKEN}/getMe failed`, data: { arguments: ['x'] } }, {});
    assert(consoleCrumb.message === 'request to https://api.telegram.org/bot[scrubbed]/getMe failed', `console ${show(consoleCrumb)}`);
    assert(show(consoleCrumb.data) === show({ arguments: ['x'] }), `console data ${show(consoleCrumb.data)}`);
  });

  // ---- scripts/setup-webhook.ts ----

  const exits: unknown[] = [];
  const realExit = process.exit;
  let hook: Row = {};
  try {
    process.exit = ((code?: number) => { exits.push(code); throw new Error(`process.exit(${code}) during import`); }) as typeof process.exit;
    hook = await load('scripts/setup-webhook.ts');
  } catch (err) {
    console.log(`(setup-webhook import failed: ${err instanceof Error ? err.message : String(err)})`);
  } finally {
    process.exit = realExit;
  }
  const importExits = [...exits];
  const importRequests = [...httpsRequests];

  await check('#6 setup-webhook: importing runs nothing (no exit, no request); no dotenv; buildSetWebhookParams validates the secret and the URL', () => {
    assert(importExits.length === 0, `the import called process.exit(${importExits.join(', ')})`);
    assert(importRequests.length === 0, `the import made requests: ${show(importRequests)}`);
    const src = readSource('scripts/setup-webhook.ts');
    assert(!/\bimport\b[^;]*['"]dotenv['"]|require\(\s*['"]dotenv|dotenv\.config\s*\(/.test(src), 'setup-webhook still loads dotenv');
    const build = hook.buildSetWebhookParams;
    assert(typeof build === 'function', 'buildSetWebhookParams is not exported');
    const ok = build({ TELEGRAM_WEBHOOK_SECRET: 'Ab_9-z' }, 'https://famcal.bot/api/webhook');
    assert(show(ok) === show({ url: 'https://famcal.bot/api/webhook', secret_token: 'Ab_9-z' }), `params ${show(ok)}`);
    const throwsFor = (env: Row, url: string | undefined) => { try { build(env, url); return false; } catch { return true; } };
    const bad: [string, Row, string | undefined][] = [
      ['secret unset', {}, 'https://famcal.bot/api/webhook'],
      ['secret empty', { TELEGRAM_WEBHOOK_SECRET: '' }, 'https://famcal.bot/api/webhook'],
      ['secret with a space', { TELEGRAM_WEBHOOK_SECRET: 'a b' }, 'https://famcal.bot/api/webhook'],
      ['secret with a colon', { TELEGRAM_WEBHOOK_SECRET: 'a:b' }, 'https://famcal.bot/api/webhook'],
      ['secret of 257 characters', { TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(257) }, 'https://famcal.bot/api/webhook'],
      ['no URL', { TELEGRAM_WEBHOOK_SECRET: 'abc' }, undefined],
      ['http URL', { TELEGRAM_WEBHOOK_SECRET: 'abc' }, 'http://famcal.bot/api/webhook'],
      ['another path', { TELEGRAM_WEBHOOK_SECRET: 'abc' }, 'https://famcal.bot/api/webhooks'],
      ['a trailing slash', { TELEGRAM_WEBHOOK_SECRET: 'abc' }, 'https://famcal.bot/api/webhook/'],
      ['a query', { TELEGRAM_WEBHOOK_SECRET: 'abc' }, 'https://famcal.bot/api/webhook?x=1'],
    ];
    const accepted = bad.filter(([, env, url]) => !throwsFor(env, url)).map(([name]) => name);
    assert(accepted.length === 0, `accepted: ${accepted.join(', ')}`);
    assert(!throwsFor({ TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(256) }, 'https://famcal.bot/api/webhook'), 'a 256-character secret was refused');
  });

  await check('#7 setup-webhook run(): a missing token or secret, or a bad URL, exits 1 before any call; set does getMe, setWebhook, getWebhookInfo and never prints the token or the secret', async () => {
    const run = hook.run;
    assert(typeof run === 'function', 'run is not exported');
    const env = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: TG_SECRET };
    const session = (fail?: string) => {
      const calls: { method: string; params?: Row }[] = [];
      const lines: string[] = [];
      const tokens: string[] = [];
      const makeCall = (token: string) => {
        tokens.push(token);
        return async (method: string, params?: Row) => {
          calls.push({ method, params });
          if (method === fail) throw new Error(`Telegram said no to bot${BOT_TOKEN} with ${TG_SECRET}`);
          if (method === 'getMe') return { id: 1, is_bot: true, username: 'FamCalTestBot' };
          if (method === 'getWebhookInfo') {
            return { url: 'https://famcal.bot/api/webhook', pending_update_count: 3, last_error_date: 1760000000, last_error_message: 'Wrong response from the webhook: 401 Unauthorized' };
          }
          return true;
        };
      };
      const log = (line: string) => { lines.push(line); };
      return { calls, lines, tokens, makeCall, log };
    };

    for (const [name, e, args] of [
      ['no token', { TELEGRAM_WEBHOOK_SECRET: TG_SECRET }, ['set', 'https://famcal.bot/api/webhook']],
      ['no secret', { TELEGRAM_BOT_TOKEN: BOT_TOKEN }, ['get']],
      ['bad URL', env, ['set', 'https://famcal.bot/api/other']],
      ['bad secret', { ...env, TELEGRAM_WEBHOOK_SECRET: 'has space' }, ['set', 'https://famcal.bot/api/webhook']],
    ] as [string, Row, string[]][]) {
      const s = session();
      const code = await run(args, e, s.makeCall, s.log, s.log);
      assert(code === 1, `${name}: exit ${code}`);
      assert(s.tokens.length === 0 && s.calls.length === 0, `${name}: calls ${show(s.calls.map(c => c.method))}`);
    }

    const set = session();
    const code = await run(['set', 'https://famcal.bot/api/webhook'], env, set.makeCall, set.log, set.log);
    assert(code === 0, `set: exit ${code}; ${show(set.lines)}`);
    assert(show(set.calls.map(c => c.method)) === show(['getMe', 'setWebhook', 'getWebhookInfo']), `calls ${show(set.calls.map(c => c.method))}`);
    assert(show(set.calls[1].params) === show({ url: 'https://famcal.bot/api/webhook', secret_token: TG_SECRET }), `setWebhook params ${show(set.calls[1].params)}`);
    const out = set.lines.join('\n');
    for (const want of ['@FamCalTestBot', 'https://famcal.bot/api/webhook', '3', 'Wrong response from the webhook: 401 Unauthorized']) {
      assert(out.includes(want), `output lacks ${want}: ${out}`);
    }
    assert(leaks(out).length === 0 && !out.includes(TG_SECRET), `output leaks: ${out}`);

    const failing = session('setWebhook');
    const failCode = await run(['set', 'https://famcal.bot/api/webhook'], env, failing.makeCall, failing.log, failing.log);
    const failOut = failing.lines.join('\n');
    assert(failCode === 1, `failed setWebhook: exit ${failCode}`);
    assert(/Telegram said no/.test(failOut) && leaks(failOut).length === 0 && !failOut.includes(TG_SECRET), `failure output: ${failOut}`);

    const del = session();
    assert(await run(['delete'], env, del.makeCall, del.log, del.log) === 0, 'delete: exit not 0');
    assert(show(del.calls.map(c => c.method)) === show(['getMe', 'deleteWebhook']), `delete calls ${show(del.calls.map(c => c.method))}`);
    assert(httpsRequests.length === 0, `https requests: ${show(httpsRequests)}`);
  });

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

- [ ] **Step 2: Run it to verify it fails**

Run: `bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-secret-hygiene.ts`

Expected: `0/7 passed`, exit 1.

The old `setup-webhook.ts` runs on import:
- It calls `dotenv.config()`, which prints `injecting env (0)`. The runner fakes every `.env` name, so nothing is injected.
- It prints its usage text, then calls `process.exit(0)`. The smoke intercepts that call and logs `(setup-webhook import failed: process.exit(0) during import)`.

Failures on the pre-task code:
- #1: `leaks cron secret, webhook secret`. The two headers are kept.
- #2: `url https://famcal.bot/api/weather-image?user_id=9&secret=cron-s3cr3t-value&sig=...`. The query values are kept.
- #3: `plain https://api.telegram.org/bot123456789:AAHfake_.../sendMessage?chat_id=9`. The token is kept.
- #4: `leaks cron secret, webhook secret, bot token, part of the bot token`.
- #5: `sentry.server.config.ts has no beforeBreadcrumb`.
- #6: `the import called process.exit(0)`.
- #7: `run is not exported`.

- [ ] **Step 3: Rewrite `scripts/setup-webhook.ts` (replace the whole file)**

```ts
/**
 * Telegram webhook setup: the command run on deploy day, and after the bot token or the
 * webhook secret changes.
 *
 *   npm run setup-webhook set https://<host>/api/webhook
 *   npm run setup-webhook get
 *   npm run setup-webhook delete
 *
 * TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET come from the environment only (no
 * dotenv: the local .env holds DEV values). Both are required for every command, and a
 * missing one stops the script before any network call. getMe runs first and prints the
 * bot's @username, so a wrong token shows before anything changes. Nothing printed
 * contains the token or the secret.
 */

import https from 'https';

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;
/** One Bot API call; resolves with `result`, rejects with Telegram's description. */
export type TelegramCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export interface SetWebhookParams {
  url: string;
  secret_token: string;
}

/** Telegram's rule for secret_token. */
const SECRET_FORMAT = /^[A-Za-z0-9_-]{1,256}$/;
const WEBHOOK_URL_FORMAT = /^https:\/\/[^/]+\/api\/webhook$/;

/** The bot token and the webhook secret; throws naming each missing variable, never a value. */
export function readCredentials(env: Env): { token: string; secret: string } {
  const token = env.TELEGRAM_BOT_TOKEN;
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !secret) {
    const missing = [token ? '' : 'TELEGRAM_BOT_TOKEN', secret ? '' : 'TELEGRAM_WEBHOOK_SECRET'].filter(Boolean);
    throw new Error(`${missing.join(' and ')} not set in the environment`);
  }
  return { token, secret };
}

/** setWebhook's parameters. Throws on a missing or malformed secret, or a URL other than https://<host>/api/webhook. */
export function buildSetWebhookParams(env: Env, url: string | undefined): SetWebhookParams {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) throw new Error('TELEGRAM_WEBHOOK_SECRET not set in the environment');
  if (!SECRET_FORMAT.test(secret)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must be 1-256 characters of A-Z, a-z, 0-9, _ and -');
  }
  if (!url || !WEBHOOK_URL_FORMAT.test(url)) {
    throw new Error('The webhook URL must be https://<host>/api/webhook');
  }
  return { url, secret_token: secret };
}

/** Bot API calls over https. An error names the method and Telegram's description, never the URL. */
export function telegramCaller(token: string): TelegramCall {
  return (method, params) => new Promise((resolve, reject) => {
    const body = params ? JSON.stringify(params) : undefined;
    const req = https.request(`https://api.telegram.org/bot${token}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(text);
          if (json.ok) resolve(json.result);
          else reject(new Error(`${method}: ${json.description || `HTTP ${res.statusCode}`}`));
        } catch (err) {
          reject(new Error(`${method}: unreadable reply (HTTP ${res.statusCode}): ${err instanceof Error ? err.message : String(err)}`));
        }
      });
    });
    req.on('error', (err) => reject(new Error(`${method}: ${err.message}`)));
    if (body) req.write(body);
    req.end();
  });
}

interface WebhookInfo {
  url?: string;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
}

/** The webhook's URL, pending update count and last error, in Israel time. */
async function printWebhookInfo(call: TelegramCall, log: Log) {
  const info = (await call('getWebhookInfo')) as WebhookInfo;
  log(`Webhook URL: ${info.url || '(none)'}`);
  log(`Pending updates: ${info.pending_update_count ?? 0}`);
  if (info.last_error_message) {
    const when = info.last_error_date
      ? ` (${new Date(info.last_error_date * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' })})`
      : '';
    log(`Last error: ${info.last_error_message}${when}`);
  } else {
    log('Last error: none');
  }
}

const USAGE = [
  'Usage (TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET set in the environment):',
  '  npm run setup-webhook set https://<host>/api/webhook   - point the bot at this webhook, with the secret',
  '  npm run setup-webhook get                              - show the current webhook',
  '  npm run setup-webhook delete                           - remove the webhook (local polling only)',
];

/** Runs one command and returns the exit code. */
export async function run(
  args: string[],
  env: Env,
  makeCall: (token: string) => TelegramCall = telegramCaller,
  log: Log = console.log,
  logError: Log = console.error,
): Promise<number> {
  const [command, url] = args;
  if (command !== 'set' && command !== 'get' && command !== 'info' && command !== 'delete') {
    USAGE.forEach((line) => log(line));
    return command ? 1 : 0;
  }

  let credentials: { token: string; secret: string };
  let params: SetWebhookParams | null = null;
  try {
    credentials = readCredentials(env);
    if (command === 'set') params = buildSetWebhookParams(env, url);
  } catch (err) {
    logError(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const { token, secret } = credentials;
  const redact = (text: string) => text.split(token).join('[token]').split(secret).join('[secret]');

  const call = makeCall(token);
  try {
    const me = (await call('getMe')) as { username?: string };
    log(`Bot: @${me.username ?? '(no username)'}`);
    if (params) {
      await call('setWebhook', { ...params });
      log(`Webhook set to ${params.url}, with the secret token`);
      await printWebhookInfo(call, log);
    } else if (command === 'delete') {
      await call('deleteWebhook');
      log('Webhook deleted: production gets no updates until `set` runs again');
    } else {
      await printWebhookInfo(call, log);
    }
    return 0;
  } catch (err) {
    logError(`Error: ${redact(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
}

// Only when run as a script (npm run setup-webhook), never on import
if (require.main === module) {
  run(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
```

- [ ] **Step 4: `src/lib/sentry-scrub.ts`: the module comment names the secrets**

Replace, in `src/lib/sentry-scrub.ts`:

```ts
 * navigation breadcrumbs carry the launch fragment (#tgWebAppData=<initData>).
 *
```

with:

```ts
 * navigation breadcrumbs carry the launch fragment (#tgWebAppData=<initData>).
 *
 * Shared secrets too: the cron Authorization header, Telegram's webhook secret header, the
 * secret / sig / hub.verify_token query values, and the bot token a Telegram Bot API URL
 * carries in its path (/bot<id>:<token>/), also in server breadcrumbs and span descriptions.
 *
```

- [ ] **Step 5: `src/lib/sentry-scrub.ts`: a breadcrumb message and a span description in the structural types**

Replace, in `src/lib/sentry-scrub.ts`:

```ts
interface ScrubbableBreadcrumb {
  category?: string;
  data?: Dict;
}
```

with:

```ts
interface ScrubbableBreadcrumb {
  category?: string;
  message?: string;
  data?: Dict;
}
```

- [ ] **Step 6: `src/lib/sentry-scrub.ts`: spans carry a description**

Replace, in `src/lib/sentry-scrub.ts`:

```ts
  spans?: { data?: Dict }[];
```

with:

```ts
  spans?: { description?: string; data?: Dict }[];
```

- [ ] **Step 7: `src/lib/sentry-scrub.ts`: the new headers, query names and the bot-token path; one text scrubber; scrubUrl and scrubQuery use it**

Replace, in `src/lib/sentry-scrub.ts`:

```ts
/** Request headers that carry a credential, lower-cased. */
const SECRET_HEADERS = new Set(['x-telegram-init-data', 'cookie']);
/** The same headers as span attribute names: http.request.header.<name>, '-' as '_'. */
const SECRET_HEADER_ATTRIBUTE = /^http\.request\.header\.(x_telegram_init_data|cookie)(\..*)?$/;

/** A URL or path with initData scrubbed from its query and no #fragment. */
export function scrubUrl(url: string): string {
  const hash = url.indexOf('#');
  return (hash === -1 ? url : url.slice(0, hash)).replace(INIT_DATA_PARAM, `initData=${SCRUBBED}`);
}

function scrubQuery(query: unknown): unknown {
  if (typeof query === 'string') return query.replace(INIT_DATA_PARAM, `initData=${SCRUBBED}`);
  if (Array.isArray(query)) {
    return query.map((pair) => (Array.isArray(pair) && pair[0] === 'initData' ? [pair[0], SCRUBBED] : pair));
  }
  if (query && typeof query === 'object' && 'initData' in query) return { ...query, initData: SCRUBBED };
  return query;
}
```

with:

```ts
/** Query names whose value is a secret: the cron secret, image-link signatures, Meta's verify token. */
const SECRET_PARAM_NAMES = ['secret', 'sig', 'hub.verify_token'];
const SECRET_PARAM = /(^|[?&])(secret|sig|hub\.verify_token)=[^&#]*/gi;
/** A Telegram Bot API path, /bot<id>:<token> ('%3A' when the colon is encoded). */
const BOT_TOKEN_PATH = /\/bot\d+(?::|%3A)[A-Za-z0-9_-]+/gi;
/** Request headers that carry a credential, lower-cased. */
const SECRET_HEADERS = new Set(['x-telegram-init-data', 'cookie', 'authorization', 'x-telegram-bot-api-secret-token']);
/** The same headers as span attribute names: http.request.header.<name>, '-' as '_'. */
const SECRET_HEADER_ATTRIBUTE = /^http\.request\.header\.(x_telegram_init_data|cookie|authorization|x_telegram_bot_api_secret_token)(\..*)?$/;

/** initData, the secret query values and a bot token scrubbed from a URL, a path or a description. */
function scrubSecrets(text: string): string {
  return text
    .replace(INIT_DATA_PARAM, `initData=${SCRUBBED}`)
    .replace(SECRET_PARAM, `$1$2=${SCRUBBED}`)
    .replace(BOT_TOKEN_PATH, `/bot${SCRUBBED}`);
}

/** A URL or path with initData, the secret query values and a bot token scrubbed, and no #fragment. */
export function scrubUrl(url: string): string {
  const hash = url.indexOf('#');
  return scrubSecrets(hash === -1 ? url : url.slice(0, hash));
}

const isSecretParam = (name: unknown) =>
  name === 'initData' || (typeof name === 'string' && SECRET_PARAM_NAMES.includes(name.toLowerCase()));

function scrubQuery(query: unknown): unknown {
  if (typeof query === 'string') return scrubSecrets(query);
  if (Array.isArray(query)) {
    return query.map((pair) => (Array.isArray(pair) && isSecretParam(pair[0]) ? [pair[0], SCRUBBED] : pair));
  }
  if (query && typeof query === 'object') {
    const secretKeys = Object.keys(query).filter(isSecretParam);
    if (secretKeys.length === 0) return query;
    const scrubbed: Dict = { ...(query as Dict) };
    for (const key of secretKeys) scrubbed[key] = SCRUBBED;
    return scrubbed;
  }
  return query;
}
```

- [ ] **Step 8: `src/lib/sentry-scrub.ts`: span attribute strings go through the same scrubber**

Replace, in `src/lib/sentry-scrub.ts`:

```ts
/** Drops the credential header attributes; scrubs initData from any URL-like string. */
function scrubSpanData(data: Dict | undefined) {
  if (!data) return;
  for (const key of Object.keys(data)) {
    if (SECRET_HEADER_ATTRIBUTE.test(key.toLowerCase().replace(/-/g, '_'))) {
      delete data[key];
    } else if (typeof data[key] === 'string') {
      data[key] = (data[key] as string).replace(INIT_DATA_PARAM, `initData=${SCRUBBED}`);
    }
  }
}
```

with:

```ts
/** Drops the credential header attributes; scrubs initData, secret query values and a bot token from any string. */
function scrubSpanData(data: Dict | undefined) {
  if (!data) return;
  for (const key of Object.keys(data)) {
    if (SECRET_HEADER_ATTRIBUTE.test(key.toLowerCase().replace(/-/g, '_'))) {
      delete data[key];
    } else if (typeof data[key] === 'string') {
      data[key] = scrubSecrets(data[key] as string);
    }
  }
}
```

- [ ] **Step 9: `src/lib/sentry-scrub.ts`: span descriptions, and a new server breadcrumb scrubber**

Replace, in `src/lib/sentry-scrub.ts`:

```ts
/** Server and edge `beforeSendTransaction`: the span header attributes, and the request. */
export function scrubServerTransaction<E extends ScrubbableEvent>(event: E): E {
  scrubServerEvent(event);
  scrubSpanData(event.contexts?.trace?.data as Dict | undefined);
  for (const span of event.spans ?? []) scrubSpanData(span.data);
  return event;
}
```

with:

```ts
/** Server and edge `beforeSendTransaction`: the span header attributes and descriptions, and the request. */
export function scrubServerTransaction<E extends ScrubbableEvent>(event: E): E {
  scrubServerEvent(event);
  scrubSpanData(event.contexts?.trace?.data as Dict | undefined);
  for (const span of event.spans ?? []) {
    scrubSpanData(span.data);
    if (typeof span.description === 'string') span.description = scrubSecrets(span.description);
  }
  return event;
}

/**
 * Server `beforeBreadcrumb`: outgoing http and fetch breadcrumbs carry the full URL, and a
 * Telegram Bot API call has the bot token in its path. Scrubs the message and every string
 * in the data.
 */
export function scrubServerBreadcrumb<B extends ScrubbableBreadcrumb>(breadcrumb: B): B {
  if (typeof breadcrumb.message === 'string') breadcrumb.message = scrubSecrets(breadcrumb.message);
  const data = breadcrumb.data;
  if (data) {
    for (const key of Object.keys(data)) {
      if (typeof data[key] === 'string') data[key] = scrubSecrets(data[key] as string);
    }
  }
  return breadcrumb;
}
```

- [ ] **Step 10: `sentry.server.config.ts`: import the breadcrumb scrubber**

Replace, in `sentry.server.config.ts`:

```ts
import { scrubServerEvent, scrubServerTransaction } from './src/lib/sentry-scrub';
```

with:

```ts
import { scrubServerBreadcrumb, scrubServerEvent, scrubServerTransaction } from './src/lib/sentry-scrub';
```

- [ ] **Step 11: `sentry.server.config.ts`: a server beforeBreadcrumb**

Replace, in `sentry.server.config.ts`:

```ts
  // No Telegram initData or WhatsApp session cookie in events (both are 24h credentials)
  beforeSend: (event) => scrubServerEvent(event),
  beforeSendTransaction: (event) => scrubServerTransaction(event),
});
```

with:

```ts
  // No Telegram initData or WhatsApp session cookie in events (both are 24h credentials),
  // and no shared secret or bot token
  beforeSend: (event) => scrubServerEvent(event),
  beforeSendTransaction: (event) => scrubServerTransaction(event),
  // Outgoing request breadcrumbs: a Telegram Bot API URL carries the bot token in its path
  beforeBreadcrumb: (breadcrumb) => scrubServerBreadcrumb(breadcrumb),
});
```

- [ ] **Step 12: Run the smoke to verify it passes**

Run: `bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-secret-hygiene.ts`

Expected: `7/7 passed`, exit 0.

- [ ] **Step 13: Typecheck, lint, and the smokes this change can break**

```bash
npx tsc --noEmit -p .
npm run -s lint
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-secret-hygiene.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-sentry-scrub.ts
bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/run-smoke.sh scripts/smoke-initdata-header.ts
```

Expected: tsc and lint are clean, and every smoke ends with all checks passed.
- `smoke-sentry-scrub` (6/6): initData scrubbing and the three configs are unchanged. #6 still sees one `Sentry.init` per config, and the server config keeps its options.
- `smoke-initdata-header` #8: `src/lib/sentry-scrub.ts` is the one file allowed to name `initData=`.

- [ ] **Step 14: Check the deploy-day command by hand, with no network**

Run `npm run -s setup-webhook` with no arguments and no Telegram variables:

```bash
env -u TELEGRAM_BOT_TOKEN -u TELEGRAM_WEBHOOK_SECRET npm run -s setup-webhook; echo "exit $?"
env -u TELEGRAM_BOT_TOKEN -u TELEGRAM_WEBHOOK_SECRET npm run -s setup-webhook get; echo "exit $?"
```

Expected:
- The first command prints the usage lines and `exit 0`.
- The second prints `Error: TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET not set in the environment` and `exit 1`, with no network call.

Do not run `set`, `get` or `delete` with real values: that reaches Telegram, and the owner runs it on deploy day.

- [ ] **Step 15: Commit**

```bash
git add src/lib/sentry-scrub.ts sentry.server.config.ts scripts/setup-webhook.ts scripts/smoke-secret-hygiene.ts
git commit -F - <<'EOF'
fix(security): Sentry scrubs shared secrets and bot tokens; setup-webhook reads only the environment

Sentry drops the Authorization and Telegram webhook secret headers, scrubs secret, sig and
hub.verify_token query values and /bot<id>:<token> from URLs, span descriptions and server
breadcrumbs. setup-webhook no longer loads the DEV .env, requires both secrets before any
call, validates the secret and the URL, prints @username first and the webhook state after,
and never prints the token or the secret.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

---

### Task 10: Branch gate before push (spec "Gate before push")

**Files:**
- None created or modified. Verification only. A failure is fixed in the task that owns the file, as a new commit (`fix(<area>): ...` with the two attribution lines), and this task runs again from Step 1.

**Interfaces:**
- Consumes: everything Tasks 1-9 produced, as committed on `feat/secret-rotation`.
- Produces: nothing.

- [ ] **Step 1: Typecheck and lint the whole tree**

```bash
npx tsc --noEmit -p .
npm run -s lint
```

Expected: both print nothing and exit 0.

- [ ] **Step 2: Every smoke, through the runner (UTC)**

Every smoke goes through `run-smoke.sh`, which sets `ENCRYPTION_KEY_PREVIOUS=''` and fakes every `.env` name, so no smoke picks up a local value (spec "Smoke hygiene").

```bash
S=/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad
for f in scripts/smoke-*.ts; do bash $S/run-smoke.sh "$f" > /dev/null 2>&1 || echo "FAILED $f"; done; echo "all smokes done"
```

Expected: `all smokes done` and no `FAILED` line. For any `FAILED` line, rerun that one smoke without the redirect to see its failing checks.

- [ ] **Step 3: The timezone-sensitive smokes in Israel time**

```bash
S=/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad
for s in smoke-reminders smoke-reminder-actions smoke-google-sync-worker smoke-native-reminder-create-flow smoke-native-reminder-edit; do
  bash $S/run-smoke.sh scripts/$s.ts Asia/Jerusalem > /dev/null 2>&1 || echo "FAILED $s (Asia/Jerusalem)"
done; echo "tz smokes done"
```

Expected: `tz smokes done` and no `FAILED` line.

- [ ] **Step 4: Production build of the working tree**

Never `npm run build`: it runs `prisma migrate deploy` against prod.

```bash
npx next build
```

Expected: exit 0 and the route table printed. This is the only check that bundles the new imports: `encryption.ts` importing `error-capture` (and Sentry), the new `instrumentation.ts` imports, and `app-keys` / `image-link` in the weather-image routes.

- [ ] **Step 5: Fresh-clone build and smokes on Node 22**

Local checks have passed before while the host's fresh install failed (a stray local `node_modules`). `fresh.sh` clones the committed branch into the scratchpad, runs `npm ci`, `prisma generate` and `next build` under Node 22, runs every smoke under Node 22 (Asia/Jerusalem), then deletes the clone. It only writes inside the scratchpad.

```bash
git status --short
S=/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad
bash $S/fresh.sh feat/secret-rotation $S/fresh-secret-rotation
```

Expected:
- `git status --short` prints nothing (everything is committed; the clone sees only commits).
- `ci exit 0`, `generate exit 0`, `build exit 0`.
- No `node22 exit=` line.
- The last line is `node22 smokes done: N`, where N is the number of `scripts/smoke-*.ts` files (`ls scripts/smoke-*.ts | wc -l`).

- [ ] **Step 6: Nothing to commit**

```bash
git status --short
```

Expected: no output. The branch is ready to merge to main and push.



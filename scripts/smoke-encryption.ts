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

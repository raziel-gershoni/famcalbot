// Smoke test for src/utils/encryption.ts. decrypt() accepted any GCM tag length Node
// allowed, and Node 22 (engines.node) still takes tags down to 4 bytes (DEP0182), so a
// forged token only had to match 32 bits. It now insists on the 16 bytes encrypt()
// writes; tokens already stored must keep decrypting. No network.
//
// Run: npx tsx scripts/smoke-encryption.ts

// encryption.ts reads ENCRYPTION_KEY once, when it loads, so the test key goes in first
// and the module is imported in main(). The stored sample below was written with it.
process.env.ENCRYPTION_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

// No static imports, so mark this a module or tsc puts its names in the global scope.
export {};

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

// What encrypt() wrote before the tag length was enforced, with the key above.
const STORED = 'e8020bf86da8073ffc540848f664ecfc:66fab8a94d7179dc738f10b52a27047d:f7e601aece3c96078dc5d12d8c6ce8fc50b7d84529d882e77caab2448f59fc0c30';
const STORED_PLAIN = '1//0gTestRefreshToken-abc_XYZ.123';
const MALFORMED = 'Invalid encrypted text format';

async function main() {
  const { encrypt, decrypt, isEncrypted, safeDecrypt } = await import('../src/utils/encryption');

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

  // Print results
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });

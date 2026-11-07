// Smoke test for the Jewish times API's keys (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.5, §4; plan
// docs/superpowers/plans/2026-11-07-zmanim-api.md, Tasks 2 and 3): src/services/api-keys/{mirror,store,lookup}.ts, the
// ApiKey table and its migration, and the admin route app/api/admin/api-keys/route.ts.
//
// What it pins:
//   - K1 a created key: fcj_ and 43 base64url characters; only its SHA-256 and its first 10 characters reach the table, and
//     the mirror holds the hash; the memory copy has it; one log line, by ids only;
//   - K2 the app name and origin rules; K3 at most 50 active keys;
//   - K4 revoke: the table, then Redis's mirror, then the memory copy, and the key is refused here at once; K5 again: no
//     error, the list written again; no such key: NOT_FOUND;
//   - K6 a failed mirror write deletes the mirror (a create still returns its key); a failed delete too is MIRROR_FAILED for a
//     revoke, and the copy here is still right;
//   - K7 the lookup: a warm copy costs nothing, an unknown key nothing, a cold start one Redis GET (shared by requests at
//     once), a missing or corrupt mirror one database read and one SET, an old copy one GET in the background (and another
//     instance's revoke lands then), a failing Redis keeps the copy and waits 5 minutes, and with nothing at all
//     KeysUnavailable;
//   - K8 the schema, the hand-written migration (additions only, safe twice) and the generated client;
//   - A1-A5 (Task 3) the admin route and the fence on the table;
//   - Z1 no console line or Sentry field holds a key, its hash, its prefix, an app name or an origin.
//
// Real: mirror.ts, store.ts, lookup.ts (and, from Task 3, the admin route, admin-auth and user-service). Faked at the
// boundaries (scripts/lib/api-world.ts over scripts/lib/signin-world.ts): Prisma and Redis in memory, every Redis command
// counted, error capture. No network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh:
//   npx tsx scripts/smoke-api-keys.ts

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { advanceClock, installApiWorld, prismaFails, redisBefore, redisCalls, redisFails, resetApiWorld, setClock } from './lib/api-world';
import { assert, baseUser, body, captured, check, DB, everyCapture, everyLog, initDataFor, load, logs, prismaCalls, redisStore, report, request, ROOT, show, type Row } from './lib/signin-world';

const MIGRATION = '20261107010000_api_keys';
const MIRROR = 'api:keys:v1';
const ADMIN = 9;
const ADMIN_TG = 5550009;
const OTHER_TG = 5550010;
/** One second into a minute (the rate smokes rely on it too). */
const T0 = Date.UTC(2026, 10, 13, 8, 0, 1);

const sha = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Everything of the run that no log may hold: each key, its hash and its prefix, and the app names and origins used. */
const SECRETS: string[] = ['Shabbat site', 'Candle app', 'One more', 'shabbat.example.test', 'candles.example.test'];
const remember = (key: string): string => {
  SECRETS.push(key, sha(key), key.slice(0, 10));
  return key;
};
const mirrorOf = (): Row[] | null => {
  const raw = redisStore.get(MIRROR);
  return raw === undefined ? null : JSON.parse(raw);
};
const forgetCopy = () => {
  delete (globalThis as Row).__apiKeys;
};
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'none';
  } catch (error) {
    return String((error as Row).code ?? (error as Error).name);
  }
}
function codeOfSync(fn: () => unknown): string {
  try {
    fn();
    return 'none';
  } catch (error) {
    return String((error as Row).code ?? (error as Error).name);
  }
}

/** Every .ts/.tsx file under the folders, relative to the repo. */
function codeFiles(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) out.push(rel);
    }
  };
  for (const root of roots) walk(root);
  return out.sort();
}

async function main() {
  await installApiWorld();
  const store = await load('src/services/api-keys/store.ts');
  const lookup = await load('src/services/api-keys/lookup.ts');
  const mirror = await load('src/services/api-keys/mirror.ts');

  await check('K1 a created key is fcj_ and 43 base64url characters, returned once; the table holds its SHA-256 and its first 10 characters, never the key; the mirror and the memory copy hold the hash; one log line by ids', async () => {
    resetApiWorld();
    const made = await store.createApiKey('  Shabbat site ', 'https://shabbat.example.test\n\nhttps://shabbat.example.test/', ADMIN);
    remember(made.key);
    assert(/^fcj_[A-Za-z0-9_-]{43}$/.test(made.key) && made.key.length === 47, `the key: ${made.key.length} characters`);
    assert(made.id === 1 && made.prefix === made.key.slice(0, 10), `the answer: ${show({ id: made.id, prefix: made.prefix === made.key.slice(0, 10) })}`);
    const [row] = DB.apiKey;
    const kept = { appName: row.appName, keyHash: row.keyHash, prefix: row.prefix, origins: row.origins, createdBy: row.createdBy };
    assert(show(kept) === show({ appName: 'Shabbat site', keyHash: sha(made.key), prefix: made.key.slice(0, 10), origins: ['https://shabbat.example.test'], createdBy: ADMIN }), 'the row is not the hash, the prefix, the trimmed name and one origin');
    assert(!JSON.stringify(row).includes(made.key), 'the key itself is in the table');
    assert(show(mirrorOf()) === show([{ id: 1, app: 'Shabbat site', hash: sha(made.key), origins: ['https://shabbat.example.test'] }]), 'the mirror');
    const copy = mirror.keyCopy();
    assert(copy?.byHash.get(sha(made.key))?.id === 1 && copy.origins.has('https://shabbat.example.test') && copy.count === 1, 'the memory copy');
    assert(show(logs) === show(['[api-keys] key 1 created by admin 9']), `the logs: ${show(logs)}`);
    const second = remember((await store.createApiKey('Candle app', '', ADMIN)).key);
    assert(second !== made.key && DB.apiKey.length === 2, 'two keys are two');
  });

  await check('K2 the app name is trimmed, 1 to 40 characters and no control character; an origin is https://host[:port] or http://localhost:port, read as the browser sends it (lower case, no default port, no slash), each once', () => {
    for (const bad of ['', '   ', 'x'.repeat(41), 'a\u0007b', 42, null, undefined]) assert(codeOfSync(() => store.checkAppName(bad)) === 'INVALID_NAME', `the name ${show(bad)} was taken`);
    assert(store.checkAppName(' Shabbat site ') === 'Shabbat site' && store.checkAppName('ש'.repeat(40)) === 'ש'.repeat(40), 'a good name');
    const read1 = store.readOrigins('https://a.example.test\nhttps://a.example.test/\n\n  http://localhost:3000  \r\nhttps://b.example.test:8443\nhttps://A.Example.test\nhttps://c.example.test:443');
    assert(show(read1) === show(['https://a.example.test', 'http://localhost:3000', 'https://b.example.test:8443', 'https://c.example.test']), `the origins: ${show(read1)}`);
    assert(show(store.readOrigins(['https://a.example.test'])) === show(['https://a.example.test']), 'a list');
    assert(show(store.readOrigins('')) === '[]' && show(store.readOrigins(undefined)) === '[]' && show(store.readOrigins(null)) === '[]', 'none');
    for (const bad of ['http://a.example.test', 'https://a.example.test/path', 'https://a.example.test?x=1', 'https://a.example.test#x', 'http://localhost', 'ftp://a.example.test', 'https://user@a.example.test', 'not a url', 'https://', 'https://a.example.test x']) {
      assert(codeOfSync(() => store.readOrigins(bad)) === 'INVALID_ORIGIN', `${bad} was taken`);
    }
    assert(codeOfSync(() => store.readOrigins(42)) === 'INVALID_ORIGIN' && codeOfSync(() => store.readOrigins([7])) === 'INVALID_ORIGIN', 'not text');
  });

  await check('K3 at most 50 active keys: the 51st is TOO_MANY_KEYS and writes nothing; a revoked one makes room', async () => {
    resetApiWorld();
    DB.apiKey = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, appName: `app ${i}`, keyHash: sha(`k${i}`), prefix: 'fcj_aaaaaa', origins: [], createdAt: new Date(T0), createdBy: ADMIN, revokedAt: null }));
    assert((await codeOf(() => store.createApiKey('One more', '', ADMIN))) === 'TOO_MANY_KEYS' && DB.apiKey.length === 50, 'the 51st active key was made');
    DB.apiKey[0].revokedAt = new Date(T0);
    remember((await store.createApiKey('One more', '', ADMIN)).key);
    assert((DB.apiKey as Row[]).length === 51, 'a revoked key does not count');
  });

  await check('K4 revoke writes the table, then the mirror (Redis SET while the copy here still has the key), then the copy; the key is refused here at once and the other still works; one log line', async () => {
    resetApiWorld();
    const a = remember((await store.createApiKey('Shabbat site', '', ADMIN)).key);
    const b = remember((await store.createApiKey('Candle app', 'https://candles.example.test', ADMIN)).key);
    const seen: string[] = [];
    redisBefore.set('set', () => seen.push(`table ${DB.apiKey[0].revokedAt ? 'revoked' : 'active'}, copy ${mirror.keyCopy()?.byHash.has(sha(a)) ? 'has it' : 'without it'}`));
    logs.length = 0;
    await store.revokeApiKey(1, ADMIN);
    redisBefore.clear();
    assert(show(seen) === show(['table revoked, copy has it']), `the order: ${show(seen)}`);
    assert(DB.apiKey[0].revokedAt instanceof Date && DB.apiKey[1].revokedAt == null, 'the table');
    assert(show(mirrorOf()?.map((e) => e.id)) === '[2]' && !mirror.keyCopy()?.byHash.has(sha(a)) && mirror.keyCopy()?.byHash.has(sha(b)), 'the mirror and the copy');
    assert((await lookup.findApiKey(a)) === null && (await lookup.findApiKey(b))?.id === 2, 'refused here at once');
    assert(show(logs) === show(['[api-keys] key 1 revoked by admin 9']), `the logs: ${show(logs)}`);
  });

  await check('K5 revoking a revoked key succeeds and writes the key list again (the retry after MIRROR_FAILED); a key that is not there is NOT_FOUND', async () => {
    logs.length = 0;
    redisCalls.length = 0;
    await store.revokeApiKey(1, ADMIN);
    assert(redisCalls.includes('set') && show(logs) === show(['[api-keys] key 1 was already revoked (admin 9): the key list is written again']), `${show(redisCalls)} ${show(logs)}`);
    assert((await codeOf(() => store.revokeApiKey(999, ADMIN))) === 'NOT_FOUND', 'no such key');
  });

  await check('K6 a failed mirror SET deletes the mirror and reports it (the next cold read rebuilds it); a create still returns its key; SET and DEL both failing is MIRROR_FAILED for a revoke, and the table and the copy here are right', async () => {
    resetApiWorld();
    redisFails.add('set');
    const first = await store.createApiKey('Shabbat site', '', ADMIN);
    const a = remember(first.key);
    assert(first.id === 1 && mirror.keyCopy()?.byHash.has(sha(a)) && !redisStore.has(MIRROR) && show(redisCalls) === show(['set', 'del']), `a create with Redis refusing the SET: ${show(redisCalls)}`);
    assert(captured.some((c) => c.context === 'api-keys' && /the mirror was not written/.test(c.message)), 'the failed SET is reported');
    redisFails.clear();
    const b = remember((await store.createApiKey('Candle app', '', ADMIN)).key);
    redisFails.add('set');
    await store.revokeApiKey(1, ADMIN);
    assert(!redisStore.has(MIRROR) && !mirror.keyCopy()?.byHash.has(sha(a)) && mirror.keyCopy()?.byHash.has(sha(b)), 'after a failed SET: no mirror, the copy right');
    redisFails.clear();
    forgetCopy();
    redisCalls.length = 0;
    prismaCalls.length = 0;
    assert((await lookup.findApiKey(a)) === null && (await lookup.findApiKey(b))?.id === 2, 'the cold read after it');
    assert(show(redisCalls) === show(['get', 'set']) && show(prismaCalls) === show(['apiKey.findMany']) && show(mirrorOf()?.map((e) => e.id)) === '[2]', `rebuilt: ${show(redisCalls)} ${show(prismaCalls)}`);
    redisFails.add('set');
    redisFails.add('del');
    assert((await codeOf(() => store.revokeApiKey(2, ADMIN))) === 'MIRROR_FAILED', 'both failing');
    assert(DB.apiKey[1].revokedAt instanceof Date && mirror.keyCopy()?.byHash.size === 0, 'the table and the copy are right');
    assert(captured.some((c) => c.context === 'api-keys' && /not deleted either/.test(c.message)), 'the failed DEL is reported');
  });

  await check('K7 the lookup: memory only while the copy is under 5 minutes old (an unknown or malformed key costs nothing); a cold start is one Redis GET, shared by requests at once; an old copy serves and refreshes in the background (another instance\'s revoke lands then); a missing or corrupt mirror is one table read and one SET; a failing Redis keeps the copy and waits 5 minutes; with no copy, no Redis and no table it is KeysUnavailable', async () => {
    resetApiWorld();
    setClock(T0);
    const a = remember((await store.createApiKey('Shabbat site', 'https://shabbat.example.test', ADMIN)).key);
    const unknown = `fcj_${'A'.repeat(43)}`;
    redisCalls.length = 0;
    prismaCalls.length = 0;
    assert((await lookup.findApiKey(a))?.id === 1 && (await lookup.findApiKey(unknown)) === null && (await lookup.findApiKey('fcj_short')) === null && (await lookup.findApiKey('')) === null, 'warm answers');
    assert(show((await lookup.findApiKey(a))?.origins) === show(['https://shabbat.example.test']) && (await lookup.anyKeyListsOrigin('https://shabbat.example.test')) && !(await lookup.anyKeyListsOrigin('https://other.example.test')), 'the origins');
    assert(redisCalls.length === 0 && prismaCalls.length === 0, `warm: ${show(redisCalls)} ${show(prismaCalls)}`);

    forgetCopy();
    await lookup.findApiKey(a);
    await lookup.findApiKey(unknown);
    assert(show(redisCalls) === show(['get']) && prismaCalls.length === 0, `cold: ${show(redisCalls)} ${show(prismaCalls)}`);
    forgetCopy();
    redisCalls.length = 0;
    await Promise.all([lookup.findApiKey(a), lookup.findApiKey(a), lookup.anyKeyListsOrigin('https://shabbat.example.test')]);
    assert(show(redisCalls) === show(['get']), `three at once: ${show(redisCalls)}`);

    redisCalls.length = 0;
    advanceClock(5 * 60_000);
    assert((await lookup.findApiKey(a))?.id === 1, 'an old copy serves');
    await lookup.__pendingKeyRefreshForTests();
    await lookup.findApiKey(a);
    assert(show(redisCalls) === show(['get']), `one background GET: ${show(redisCalls)}`);

    // Another instance revoked it: the table and the mirror changed, not this copy
    DB.apiKey[0].revokedAt = new Date(T0);
    redisStore.set(MIRROR, '[]');
    assert((await lookup.findApiKey(a))?.id === 1, 'a fresh copy still serves it');
    advanceClock(5 * 60_000);
    assert((await lookup.findApiKey(a))?.id === 1, 'the request that finds the copy old is served from it');
    await lookup.__pendingKeyRefreshForTests();
    assert((await lookup.findApiKey(a)) === null, 'refused after the refresh');

    resetApiWorld();
    setClock(T0);
    const c = remember((await store.createApiKey('Candle app', '', ADMIN)).key);
    redisStore.delete(MIRROR);
    forgetCopy();
    redisCalls.length = 0;
    prismaCalls.length = 0;
    logs.length = 0;
    assert((await lookup.findApiKey(c))?.id === 1, 'a missing mirror');
    assert(show(redisCalls) === show(['get', 'set']) && show(prismaCalls) === show(['apiKey.findMany']) && logs.includes('[api-keys] rebuilt the key list from the database: 1 active'), `${show(redisCalls)} ${show(prismaCalls)} ${show(logs)}`);
    redisCalls.length = 0;
    prismaCalls.length = 0;
    await lookup.findApiKey(c);
    assert(redisCalls.length === 0 && prismaCalls.length === 0, 'then nothing');
    redisStore.set(MIRROR, '{"not":"a list"}');
    forgetCopy();
    logs.length = 0;
    assert((await lookup.findApiKey(c))?.id === 1 && logs.some((l) => l.includes('the key list in Redis is not one')) && show(mirrorOf()?.map((e) => e.id)) === '[1]', `a corrupt mirror: ${show(logs)}`);

    redisFails.add('get');
    advanceClock(5 * 60_000);
    captured.length = 0;
    redisCalls.length = 0;
    prismaCalls.length = 0;
    assert((await lookup.findApiKey(c))?.id === 1, 'a failing Redis: the old copy serves');
    await lookup.__pendingKeyRefreshForTests();
    assert(show(redisCalls) === show(['get']) && prismaCalls.length === 0 && captured.filter((x) => x.context === 'api-keys').length === 1, `a failed refresh: ${show(redisCalls)} ${show(prismaCalls)} ${captured.length}`);
    advanceClock(60_000);
    redisCalls.length = 0;
    await lookup.findApiKey(c);
    assert(redisCalls.length === 0, 'a new attempt within 5 minutes of the failed one');

    forgetCopy();
    prismaFails.add('apiKey.findMany');
    captured.length = 0;
    assert((await codeOf(() => lookup.findApiKey(c))) === 'KeysUnavailable', 'nothing to read');
    assert(captured.some((x) => x.context === 'api-keys' && /could not be read/.test(x.message)), 'reported');
    prismaFails.clear();
    assert((await lookup.findApiKey(c))?.id === 1, 'the table back, Redis still down: the cold read reads the table');
  });

  await check('K8 the schema has the ApiKey model; the hand-written migration makes the table and its unique hash, only adds and is safe to run twice; the generated client knows the model', () => {
    const schema = read('prisma/schema.prisma');
    const model = /model ApiKey \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? '';
    const lines = model.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim().replace(/\s+/g, ' ')).filter(Boolean);
    for (const want of ['id Int @id @default(autoincrement())', 'appName String', 'keyHash String @unique', 'prefix String', 'origins String[] @default([])', 'createdAt DateTime @default(now())', 'createdBy Int', 'revokedAt DateTime?']) {
      assert(lines.includes(want), `ApiKey lacks "${want}": ${show(lines)}`);
    }
    const dirs = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).filter((d) => /^\d{14}_/.test(d)).sort();
    assert(dirs.includes(MIGRATION) && MIGRATION > '20261107000000_voice_format', `the migration folder: ${MIGRATION}`);
    const sql = read(`prisma/migrations/${MIGRATION}/migration.sql`).split('\n').filter((l) => !l.trim().startsWith('--')).join(' ').replace(/\s+/g, ' ').trim();
    for (const want of [
      'CREATE TABLE IF NOT EXISTS "ApiKey" ( "id" SERIAL NOT NULL, "appName" TEXT NOT NULL, "keyHash" TEXT NOT NULL, "prefix" TEXT NOT NULL, "origins" TEXT[] DEFAULT ARRAY[]::TEXT[], "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdBy" INTEGER NOT NULL, "revokedAt" TIMESTAMP(3), CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id") );',
      'CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_keyHash_key" ON "ApiKey"("keyHash");',
    ]) assert(sql.includes(want), `the migration lacks: ${want}`);
    assert(!/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE|ALTER)\b/i.test(sql), `the migration does more than add: ${sql}`);
    assert((sql.match(/\bCREATE\b/g) ?? []).length === (sql.match(/IF NOT EXISTS/g) ?? []).length, 'a CREATE without IF NOT EXISTS');
    const fields = Object.values((Prisma as unknown as Record<string, Record<string, string> | undefined>).ApiKeyScalarFieldEnum ?? {});
    assert(show(fields) === show(['id', 'appName', 'keyHash', 'prefix', 'origins', 'createdAt', 'createdBy', 'revokedAt']), `the generated client's ApiKey: ${show(fields)} (run npx prisma generate)`);
  });

  const seedAdmin = () => {
    DB.user = [baseUser({ id: ADMIN, name: 'Admin', telegramId: BigInt(ADMIN_TG), isAdmin: true }), baseUser({ id: 10, name: 'Someone', telegramId: BigInt(OTHER_TG) })];
  };
  const route = await load('app/api/admin/api-keys/route.ts');
  const adminInit = () => initDataFor(ADMIN_TG);
  const post = async (b: Row, initData: string | null = adminInit()) => {
    const res: Response = await route.POST(request('/api/admin/api-keys', { body: initData ? { ...b, initData } : b, ...(initData ? { initData } : {}) }));
    return { status: res.status, body: await body(res), cache: res.headers.get('cache-control') };
  };

  await check('A1 GET: no initData is 401, a person who is not an admin 403; an admin gets every key newest first, a revoked one with its date, and never a hash', async () => {
    resetApiWorld();
    seedAdmin();
    assert((await route.GET(request('/api/admin/api-keys'))).status === 401, 'no initData');
    assert((await route.GET(request('/api/admin/api-keys', { initData: initDataFor(OTHER_TG) }))).status === 403, 'not an admin');
    const first = await post({ action: 'create', appName: 'Shabbat site', origins: '' });
    const second = await post({ action: 'create', appName: 'Candle app', origins: 'https://candles.example.test' });
    remember(first.body.key);
    remember(second.body.key);
    await post({ action: 'revoke', id: first.body.id });
    const res: Response = await route.GET(request('/api/admin/api-keys', { initData: adminInit() }));
    const listed = await body(res);
    assert(res.status === 200 && listed.success === true && res.headers.get('cache-control') === 'no-store', `${res.status} ${show(listed)}`);
    assert(show(listed.keys.map((k: Row) => Object.keys(k).sort())) === show([['appName', 'createdAt', 'id', 'origins', 'prefix', 'revokedAt'], ['appName', 'createdAt', 'id', 'origins', 'prefix', 'revokedAt']]), 'the fields');
    assert(show(listed.keys.map((k: Row) => [k.id, k.appName, k.origins, k.revokedAt === null])) === show([[2, 'Candle app', ['https://candles.example.test'], true], [1, 'Shabbat site', [], false]]), `the list: ${show(listed.keys)}`);
    assert(!JSON.stringify(listed).includes(sha(first.body.key)) && !JSON.stringify(listed).includes(first.body.key), 'a hash or a key in the list');
  });

  await check('A2 POST create answers { success, key, id, prefix } once, not stored by a cache; a bad name, a bad origin and the 51st active key are refused by their codes', async () => {
    resetApiWorld();
    seedAdmin();
    const made = await post({ action: 'create', appName: 'Shabbat site', origins: 'https://shabbat.example.test' });
    remember(made.body.key);
    assert(made.status === 200 && made.cache === 'no-store' && show(Object.keys(made.body).sort()) === show(['id', 'key', 'prefix', 'success']) && /^fcj_/.test(made.body.key) && made.body.prefix === made.body.key.slice(0, 10), `${made.status} ${show(Object.keys(made.body))}`);
    assert(show(await post({ action: 'create', appName: ' ', origins: '' })) === show({ status: 400, body: { error: 'INVALID_NAME' }, cache: null }), 'a blank name');
    assert(show(await post({ action: 'create', appName: 'One more', origins: 'http://shabbat.example.test' })) === show({ status: 400, body: { error: 'INVALID_ORIGIN' }, cache: null }), 'a plain http origin');
    DB.apiKey.push(...Array.from({ length: 49 }, (_, i) => ({ id: 100 + i, appName: `app ${i}`, keyHash: sha(`k${i}`), prefix: 'fcj_aaaaaa', origins: [], createdAt: new Date(T0), createdBy: ADMIN, revokedAt: null })));
    assert(show(await post({ action: 'create', appName: 'One more', origins: '' })) === show({ status: 400, body: { error: 'TOO_MANY_KEYS' }, cache: null }), 'the 51st');
    assert((await post({ action: 'create', appName: 'One more', origins: '' }, null)).status === 401, 'a POST with no initData');
  });

  await check('A3 POST revoke answers { success }; again succeeds; no such key is 404 NOT_FOUND; a bad id, an unknown action or a body that is no JSON is 400 INVALID_REQUEST; a mirror that could be neither written nor deleted is 503 MIRROR_FAILED', async () => {
    resetApiWorld();
    seedAdmin();
    const made = await post({ action: 'create', appName: 'Shabbat site', origins: '' });
    remember(made.body.key);
    assert(show(await post({ action: 'revoke', id: made.body.id })) === show({ status: 200, body: { success: true }, cache: null }), 'revoke');
    assert((await post({ action: 'revoke', id: made.body.id })).status === 200, 'again');
    assert(show(await post({ action: 'revoke', id: 999 })) === show({ status: 404, body: { error: 'NOT_FOUND' }, cache: null }), 'no such key');
    for (const bad of [{ action: 'revoke', id: '1' }, { action: 'revoke', id: 0 }, { action: 'revoke' }, { action: 'delete', id: 1 }, {}]) {
      assert(show(await post(bad)) === show({ status: 400, body: { error: 'INVALID_REQUEST' }, cache: null }), `${show(bad)} was taken`);
    }
    const { NextRequest } = await import('next/server');
    const notJson = await route.POST(new NextRequest('https://famcal.bot/api/admin/api-keys', { method: 'POST', headers: { 'x-telegram-init-data': adminInit() }, body: '{"action":' }));
    assert(notJson.status === 400 && show(await body(notJson)) === show({ error: 'INVALID_REQUEST' }), 'a body that is no JSON');
    const other = await post({ action: 'create', appName: 'Candle app', origins: '' });
    remember(other.body.key);
    redisFails.add('set');
    redisFails.add('del');
    assert(show(await post({ action: 'revoke', id: other.body.id })) === show({ status: 503, body: { error: 'MIRROR_FAILED' }, cache: null }), 'the mirror stuck');
  });

  await check('A4 the route logs by ids and codes only: the created and revoked lines, a refusal by its code', async () => {
    resetApiWorld();
    seedAdmin();
    const made = await post({ action: 'create', appName: 'Shabbat site', origins: '' });
    remember(made.body.key);
    await post({ action: 'revoke', id: made.body.id });
    await post({ action: 'create', appName: '', origins: '' });
    assert(logs.includes(`[api-keys] key ${made.body.id} created by admin ${ADMIN}`) && logs.includes(`[api-keys] key ${made.body.id} revoked by admin ${ADMIN}`) && logs.includes('[api-keys] refused: INVALID_NAME'), show(logs));
  });

  await check('A5 the fence: only src/services/api-keys/store.ts reads or writes the API key table (no other prisma delegate use in src/, app/ or scripts/, and no raw "ApiKey" SQL in src/ or app/)', () => {
    const ALLOWED = 'src/services/api-keys/store.ts';
    const delegate = new RegExp(['\\bprisma', 'apiKey\\b'].join('\\.'));
    const touching = codeFiles(['src', 'app', 'scripts']).filter((rel) => delegate.test(read(rel)));
    assert(show(touching) === show([ALLOWED]), `the table is used outside store.ts: ${show(touching)}`);
    const raw = codeFiles(['src', 'app']).filter((rel) => /"ApiKey"/.test(read(rel)));
    assert(raw.length === 0, `raw SQL on the table: ${show(raw)}`);
  });

  await check('Z1 no console line or Sentry field of the run holds a key, its hash, its prefix, an app name or an origin', () => {
    const text = [...everyLog, ...everyCapture.map((c) => `${c.message} ${show(c.extra)}`)].join('\n');
    const leaks = SECRETS.filter((s) => text.includes(s));
    assert(leaks.length === 0, `leaked: ${show(leaks.map((s) => (s.length > 12 ? `${s.slice(0, 6)}…` : s)))}`);
  });

  report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

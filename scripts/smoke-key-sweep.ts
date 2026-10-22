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
    assert(adminNotes[0].includes('ENCRYPTION_KEY_PREVIOUS holds the old key'), `admin note with a valid PREVIOUS: ${adminNotes[0]}`);
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

  await check('#9b an unreadable row with ENCRYPTION_KEY_PREVIOUS unset: the admin note says the row was stored under a key this server does not have, not "check ENCRYPTION_KEY_PREVIOUS"', async () => {
    reset();
    setKeys(KEY_B, '');
    DB.user = [
      { id: 1, googleRefreshToken: sealWith(KEY_B, 'rt-1') },
      { id: 5, googleRefreshToken: sealWith(KEY_C, 'rt-five') },
    ];
    const base = await run(600);
    assert(base?.baseline === true, `report: ${show(base)}`);
    assert(adminNotes.length === 1, `admin notes: ${show(adminNotes)}`);
    assert(!adminNotes[0].includes('ENCRYPTION_KEY_PREVIOUS holds the old key'), `advice with PREVIOUS unset: ${adminNotes[0]}`);
    assert(adminNotes[0].includes("doesn't have") && adminNotes[0].includes('ENCRYPTION_KEY_PREVIOUS is unset'), `note: ${adminNotes[0]}`);
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

  await check('#15 a missing or invalid ENCRYPTION_KEY is logged and captured once per process, then the tick returns null quietly', async () => {
    reset();
    setKeys('not-a-key', KEY_A);
    DB.user = [{ id: 1, googleRefreshToken: sealWith(KEY_A, 'rt') }];
    const first = await run(600);
    const second = await run(1200);
    setKeys(KEY_B, '');
    assert(first === null && second === null, `ticks: ${show([first, second])}`);
    const errorLines = lines('[key-sweep] ENCRYPTION_KEY is missing or invalid');
    assert(errorLines.length === 1, `error lines over two ticks: ${errorLines.length}`);
    const keyCaptures = captured.filter(c => c.context === 'key-sweep-no-key');
    assert(keyCaptures.length === 1 && captured.length === 1, `captures: ${show(captured)}`);
    assert(prismaCalls.length === 0 && redisCalls.length === 0, `calls: prisma ${show(prismaCalls)}, redis ${show(redisCalls)}`);
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
    assert(readme.includes('unreadable=0'), 'README does not say the baseline must show unreadable=0');
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

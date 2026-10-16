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

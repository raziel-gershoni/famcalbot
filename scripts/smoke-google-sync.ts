// Smoke test for the FamCal → Google one-way sync (docs/superpowers/specs/2026-10-20-google-sync-design.md).
//
// Marks part (plan Task S1, spec §2):
//   - every FamCal writer marks the series it touched (GoogleSyncItem.dirtySeq + 1) inside the
//     write's own transaction: the store's create, update and delete, their 3b scope paths and
//     Hebrew paths (shared by the bot, the home and the move), createNativeSeries, and the
//     calendar PATCH (a rename marks the link) and DELETE (Remove/Keep) routes;
//   - marks are per link: only an enabled link whose user owns the calendar is marked, so a
//     reminder, a calendar with no link, a turned-off link or a calendar the link's user
//     doesn't own gets nothing, and a calendar with no link costs one lookup;
//   - a write that lands while a push runs leaves the item dirty (dirtySeq ≠ pushedSeq);
//   - a mark opens the gate (globalThis, like the reminders' due gate), and the gate opens
//     again once the write commits, so a worker pass that read before the commit can't close it;
//   - the plan feature googleSync is on the same plans as reminders.
// The WhatsApp → Telegram merge and the hard delete are checked in smoke-account-merge.ts,
// which has the merge's fixtures.
//
// The event store, the calendar route, the marks, the gate and the subscription service run
// for real. Faked at the boundaries: Prisma (in memory; it keeps the schema's foreign keys,
// unique keys and defaults, rolls a failed transaction back, refuses the root client inside an
// interactive transaction, and logs which transaction each write ran in), Redis, auth, the
// rate limiter, error capture and analytics. No network, no database.
//
// Run with the fake env from the task brief (no dotenv), under both clocks:
//   TZ=UTC npx tsx scripts/smoke-google-sync.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-google-sync.ts

import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { fromZonedTime } from 'date-fns-tz';
import { Prisma } from '@prisma/client';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret';
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

// ---- Fake Prisma: in-memory tables that keep the schema's constraints ----

let DB: Record<string, Row[]> = {};
const table = (name: string) => (DB[name] ??= []);

type FK = { from: string; field: string; to: string; onDelete: 'Restrict' | 'Cascade' | 'SetNull' };
const FKS: FK[] = [
  { from: 'user', field: 'pairingId', to: 'pairing', onDelete: 'SetNull' },
  { from: 'nativeCalendar', field: 'ownerUserId', to: 'user', onDelete: 'Restrict' },
  { from: 'nativeEvent', field: 'calendarId', to: 'nativeCalendar', onDelete: 'Cascade' },
  { from: 'nativeEvent', field: 'creatorUserId', to: 'user', onDelete: 'Restrict' },
  { from: 'nativeEvent', field: 'forUserId', to: 'user', onDelete: 'SetNull' },
  { from: 'nativeEventInstance', field: 'seriesEventId', to: 'nativeEvent', onDelete: 'Cascade' },
  { from: 'nativeReminderState', field: 'seriesEventId', to: 'nativeEvent', onDelete: 'Cascade' },
  { from: 'subscription', field: 'userId', to: 'user', onDelete: 'Restrict' },
  { from: 'usageCounter', field: 'userId', to: 'user', onDelete: 'Restrict' },
  { from: 'userFeatureOverride', field: 'userId', to: 'user', onDelete: 'Restrict' },
  // The sync tables, as prisma/migrations/20261020000001_google_sync declares them.
  { from: 'googleSyncLink', field: 'userId', to: 'user', onDelete: 'Cascade' },
  { from: 'googleSyncLink', field: 'nativeCalendarId', to: 'nativeCalendar', onDelete: 'SetNull' },
  { from: 'googleSyncItem', field: 'linkId', to: 'googleSyncLink', onDelete: 'Cascade' },
];
/** Unique keys (a key with a null part never clashes, as in Postgres). */
const UNIQUE: Record<string, string[][]> = {
  nativeEventInstance: [['seriesEventId', 'originalStartsAt']],
  nativeReminderState: [['seriesEventId', 'originalStartsAt']],
  googleSyncLink: [['userId', 'nativeCalendarId']],
  googleSyncItem: [['linkId', 'nativeEventId']],
  subscription: [['userId']],
  usageCounter: [['userId']],
  userFeatureOverride: [['userId']],
};
const COMPOUND_KEYS: Record<string, string[]> = {
  seriesEventId_originalStartsAt: ['seriesEventId', 'originalStartsAt'],
  userId_nativeCalendarId: ['userId', 'nativeCalendarId'],
  linkId_nativeEventId: ['linkId', 'nativeEventId'],
};
/** The to-one relations a select can read. */
const RELATIONS: Record<string, Record<string, (row: Row) => Row | undefined>> = {
  googleSyncLink: { nativeCalendar: (r) => table('nativeCalendar').find((c) => c.id === r.nativeCalendarId) },
};
const DEFAULTS: Record<string, () => Row> = {
  nativeCalendar: () => ({ color: '#039BE5', labels: [], rules: [], personName: null, privacy: 'PRIVATE', isDeleted: false }),
  nativeEvent: () => ({
    description: null, location: null, allDay: false, rrule: null, hebrewRule: null, hebrewAnchor: null, exdates: [],
    reminderMinutes: null, isDeleted: false, kind: 'EVENT', forUserId: null, armedAt: null,
  }),
  nativeEventInstance: () => ({ title: null, description: null, location: null, startsAt: null, endsAt: null, allDay: null }),
  nativeReminderState: () => ({ doneAt: null, doneByUserId: null, snoozedUntil: null, lastPingedAt: null, pingAttempts: 0, pingChatId: null, pingMessageId: null }),
  googleSyncLink: () => ({
    googleCalendarId: null, googleAccount: null, enabled: true, state: 'creating', unlinkChoice: null, dirtySeq: 0, pushedSeq: 0,
    pushedName: null, lastError: null, lastSyncedAt: null, backfilledAt: null,
  }),
  googleSyncItem: () => ({
    googleEventId: null, generation: 0, masterHash: null, slotHashes: {}, dirtySeq: 0, pushedSeq: 0, attempts: 0,
    nextAttemptAt: null, status: 'ok', lastError: null,
  }),
};

const dbError = (code: string, message: string) => Object.assign(new Error(message), { code });
const num = (x: unknown) => (x instanceof Date ? x.getTime() : Number(x));
function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') return a != null && b != null && String(a) === String(b);
  return (a ?? null) === (b ?? null);
}
const isPlain = (v: unknown): v is Row => v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);

function matches(row: Row, where?: Row): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    if (k === 'AND') return ([] as Row[]).concat(cond).every((c) => matches(row, c));
    if (k === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    if (k === 'NOT') return !([] as Row[]).concat(cond).some((c) => matches(row, c));
    if (k in COMPOUND_KEYS) return matches(row, cond as Row);
    const v = row[k];
    if (isPlain(cond)) {
      return Object.entries(cond).every(([op, arg]) => {
        switch (op) {
          case 'equals': return same(v, arg);
          case 'in': return (arg as unknown[]).some((x) => same(v, x));
          case 'notIn': return !(arg as unknown[]).some((x) => same(v, x));
          case 'not': return isPlain(arg) ? !matches(row, { [k]: arg }) : !same(v, arg);
          case 'gt': return v != null && num(v) > num(arg);
          case 'gte': return v != null && num(v) >= num(arg);
          case 'lt': return v != null && num(v) < num(arg);
          case 'lte': return v != null && num(v) <= num(arg);
          case 'has': return Array.isArray(v) && v.includes(arg);
          default: throw new Error(`fake prisma: no operator ${op}`);
        }
      });
    }
    return same(v, cond);
  });
}

function pick(name: string, row: Row | undefined, select?: Row): Row | null {
  if (!row) return null;
  if (!select) return structuredClone(row);
  const out: Row = {};
  for (const [k, sel] of Object.entries(select)) {
    if (!sel) continue;
    if (isPlain(sel)) {
      const related = RELATIONS[name]?.[k];
      if (!related) throw new Error(`fake prisma: no relation ${name}.${k}`);
      out[k] = pick(k, related(row), sel.select);
    } else {
      out[k] = structuredClone(row[k]);
    }
  }
  return out;
}

function sorted(rows: Row[], orderBy?: Row | Row[]): Row[] {
  const keys = ([] as Row[]).concat(orderBy ?? []).flatMap((o) => Object.entries(o));
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const d = num(a[k]) - num(b[k]);
      if (d) return dir === 'desc' ? -d : d;
    }
    return 0;
  });
}

function applyData(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (isPlain(v) && 'increment' in v) row[k] = (row[k] ?? 0) + v.increment;
    else if (isPlain(v) && 'push' in v) row[k] = [...(row[k] ?? []), v.push];
    else if (isPlain(v) && 'set' in v) row[k] = v.set;
    else row[k] = v;
  }
}

function validate(name: string, row: Row) {
  for (const cols of UNIQUE[name] ?? []) {
    if (cols.some((c) => row[c] == null)) continue;
    if (table(name).some((r) => r !== row && r.id !== row.id && cols.every((c) => same(r[c], row[c])))) {
      throw dbError('P2002', `Unique constraint failed on ${name}(${cols.join(', ')})`);
    }
  }
  for (const fk of FKS.filter((f) => f.from === name)) {
    if (row[fk.field] == null) continue;
    if (!table(fk.to).some((r) => same(r.id, row[fk.field]))) {
      throw dbError('P2003', `Foreign key constraint failed on ${name}.${fk.field} (no ${fk.to} ${row[fk.field]})`);
    }
  }
}

function removeRows(name: string, rows: Row[]) {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  const refsOf = (fk: FK) => table(fk.from).filter((r) => ids.some((id) => same(r[fk.field], id)));
  for (const fk of FKS.filter((f) => f.to === name && f.onDelete === 'Restrict')) {
    if (refsOf(fk).length) throw dbError('P2003', `Foreign key constraint failed on ${fk.from}.${fk.field}`);
  }
  DB[name] = table(name).filter((r) => !ids.includes(r.id));
  for (const fk of FKS.filter((f) => f.to === name && f.onDelete !== 'Restrict')) {
    const refs = refsOf(fk);
    if (fk.onDelete === 'Cascade') removeRows(fk.from, refs);
    else refs.forEach((r) => { r[fk.field] = null; });
  }
}

let seq = 0;
/** Every call, as "<model>.<method>". */
let calls: string[] = [];
/** Every write: the table, the method and the interactive transaction it ran in (null = none). */
let writes: { name: string; method: string; tx: number | null }[] = [];
/** Set by a check: throws from the next call of this "<model>.<method>". */
let failNext: string | null = null;
/** Set by a check: runs after a transaction's callback returns, before it commits. */
let beforeCommit: (() => void) | null = null;

const WRITE = /^(create|update|upsert|delete|\$executeRaw)/;
let txSeq = 0;
let openTx: number | null = null;
const strayCalls: string[] = [];

function model(name: string): Row {
  const t = () => table(name);
  const create = (data: Row): Row => {
    const now = new Date();
    const row: Row = { id: name === 'user' ? Math.max(0, ...t().map((r) => Number(r.id))) + 1 : `${name}-${++seq}`, createdAt: now, updatedAt: now, ...(DEFAULTS[name]?.() ?? {}) };
    applyData(row, data);
    validate(name, row);
    t().push(row);
    return row;
  };
  const updateRow = (row: Row, data: Row) => {
    const next = { ...row };
    applyData(next, data);
    validate(name, next);
    Object.assign(row, next, { updatedAt: new Date() });
    return row;
  };
  const impl: Record<string, (a: Row) => unknown> = {
    findUnique: (a = {}) => pick(name, t().find((r) => matches(r, a.where)), a.select),
    findUniqueOrThrow: (a = {}) => {
      const r = t().find((x) => matches(x, a.where));
      if (!r) throw dbError('P2025', `No ${name} found`);
      return pick(name, r, a.select);
    },
    findFirst: (a = {}) => pick(name, sorted(t().filter((r) => matches(r, a.where)), a.orderBy)[0], a.select),
    findMany: (a = {}) => sorted(t().filter((r) => matches(r, a.where)), a.orderBy).map((r) => pick(name, r, a.select)),
    count: (a = {}) => t().filter((r) => matches(r, a.where)).length,
    create: (a) => pick(name, create(a.data), a.select),
    update: (a) => {
      const row = t().find((r) => matches(r, a.where));
      if (!row) throw dbError('P2025', `No ${name} record was found for an update.`);
      return pick(name, updateRow(row, a.data), a.select);
    },
    updateMany: (a) => {
      const rows = t().filter((r) => matches(r, a.where));
      rows.forEach((r) => updateRow(r, a.data));
      return { count: rows.length };
    },
    upsert: (a) => {
      const row = t().find((r) => matches(r, a.where));
      if (row) return pick(name, updateRow(row, a.update), a.select);
      const keys = Object.entries(a.where).flatMap(([k, v]) => (k in COMPOUND_KEYS ? Object.entries(v as Row) : [[k, v]]));
      return pick(name, create({ ...Object.fromEntries(keys), ...a.create }), a.select);
    },
    delete: (a) => {
      const row = t().find((r) => matches(r, a.where));
      if (!row) throw dbError('P2025', `No ${name} record to delete`);
      removeRows(name, [row]);
      return row;
    },
    deleteMany: (a = {}) => {
      const rows = t().filter((r) => matches(r, a.where));
      removeRows(name, rows);
      return { count: rows.length };
    },
  };
  return Object.fromEntries(Object.entries(impl).map(([method, fn]) => [method, async (a: Row) => run(name, method, () => fn(a))]));
}

function run<T>(name: string, method: string, fn: () => T): T {
  const label = `${name}.${method}`;
  calls.push(label);
  if (failNext === label) {
    failNext = null;
    throw dbError('P1001', `fake prisma: ${label} failed`);
  }
  const out = fn();
  if (WRITE.test(method)) writes.push({ name, method, tx: openTx });
  return out;
}

/**
 * The mark's upsert, the one raw statement the sync code sends: INSERT … ON CONFLICT
 * ("linkId", "nativeEventId") DO UPDATE SET "dirtySeq" = "dirtySeq" + 1, one row per
 * (id, linkId, nativeEventId) triple. One call is atomic here, as one statement is.
 */
function executeRaw(strings: TemplateStringsArray, ...values: unknown[]): number {
  const query = Prisma.sql(strings, ...values);
  return run('googleSyncItem', '$executeRaw', () => {
    const sql = query.sql.replace(/\s+/g, ' ');
    assert(
      /INSERT INTO "GoogleSyncItem" \("id", "linkId", "nativeEventId", "dirtySeq"\) VALUES .* ON CONFLICT \("linkId", "nativeEventId"\) DO UPDATE SET "dirtySeq" = "GoogleSyncItem"\."dirtySeq" \+ 1$/.test(sql.trim()),
      `unexpected raw SQL: ${sql}`
    );
    const vals = query.values as string[];
    assert(vals.length % 3 === 0, `values ${show(vals)}`);
    for (let i = 0; i < vals.length; i += 3) {
      const [id, linkId, nativeEventId] = vals.slice(i, i + 3);
      const existing = table('googleSyncItem').find((r) => r.linkId === linkId && r.nativeEventId === nativeEventId);
      if (existing) {
        existing.dirtySeq += 1;
        continue;
      }
      const row = { ...DEFAULTS.googleSyncItem(), id, linkId, nativeEventId, dirtySeq: 1 };
      validate('googleSyncItem', row);
      table('googleSyncItem').push(row);
    }
    return vals.length / 3;
  });
}

const models: Record<string, Row> = {};
function client(isTx: boolean): Row {
  return new Proxy({} as Row, {
    get(_t, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (!isTx && openTx !== null) {
        strayCalls.push(`prisma.${prop}`);
        throw new Error(`prisma.${prop} used inside an interactive transaction (use tx)`);
      }
      if (prop === '$transaction') {
        if (isTx) return undefined;
        return async (arg: unknown) => {
          const before = structuredClone(DB);
          try {
            if (typeof arg !== 'function') throw new Error('fake prisma: only interactive transactions');
            openTx = ++txSeq;
            try {
              const out = await (arg as (tx: Row) => Promise<unknown>)(txClient);
              beforeCommit?.();
              return out;
            } finally {
              openTx = null;
            }
          } catch (err) {
            DB = before;
            throw err;
          }
        };
      }
      if (prop === '$executeRaw') return executeRaw;
      if (prop.startsWith('$')) return async () => undefined;
      return (models[prop] ??= model(prop));
    },
  });
}
const fakePrisma = client(false);
const txClient = client(true);

// ---- Fake Redis ----

const redisStore = new Map<string, string>();
const redisImpl: Row = {
  get: async (k: string) => {
    const raw = redisStore.get(k);
    if (raw === undefined) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  },
  set: async (k: string, v: unknown) => { redisStore.set(k, typeof v === 'string' ? v : JSON.stringify(v)); return 'OK'; },
  del: async (...ks: unknown[]) => ks.flat().reduce((n: number, k) => n + (redisStore.delete(String(k)) ? 1 : 0), 0),
  scan: async () => [0, []],
};
const fakeRedis = new Proxy(redisImpl, { get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? (async () => null)) });

// ---- Boundaries ----

const captured: string[] = [];
const tracked: string[] = [];
let authUserId = 1;
let earlyAdoption = false;

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
// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-google-connect.ts).
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.join(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};

function stub(rel: string, exports: Row) {
  const filename = path.join(ROOT, rel);
  stubs[filename] = exports;
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  Module._cache[filename] = mod;
}

function installStubs() {
  stub('src/utils/prisma.ts', { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() });
  stub('src/utils/redis.ts', { redis: fakeRedis });
  const capture = (e: unknown, ctx: string) => { captured.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`); };
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
  stub('src/lib/api-auth.ts', {
    verifyUserAuth: async () => ({ success: true, user: { ...table('user').find((u) => u.id === authUserId) } }),
  });
  stub('src/lib/rate-limit.ts', { settingsRateLimiter: { name: 'settings' } });
  stub('src/services/analytics-service.ts', {
    trackActivity: async (userId: number, action: string, meta: Row) => { tracked.push(`${userId}:${action}:${meta?.feature ?? ''}`); },
    trackActivityAsync: () => undefined,
  });
  stub('src/services/reminder-cache.ts', { getEarlyAdoptionMode: async () => earlyAdoption });
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`network blocked in smoke: ${String(input)}`);
  }) as typeof fetch;
}

// ---- Fixtures ----

const IL = 'Asia/Jerusalem';
const at = (local: string, tz = IL) => fromZonedTime(`${local}:00`, tz);
const HOUR = 3_600_000;
const TAL = 1; // owner of the linked calendars
const NOA = 2; // Tal's partner
const DAN = 3; // nobody's partner

const LINK = 'link-own'; // Tal's copy of "own"
const LINK2 = 'link-own2'; // Tal's copy of "own2"

function user(id: number, name: string, pairingId: string | null): Row {
  return { id, name, englishName: name, gender: 'female', language: 'en', calendarSource: 'NATIVE', googleRefreshToken: '', telegramId: BigInt(1000 + id), pairingId };
}
function calendar(id: string, ownerUserId: number, privacy = 'PRIVATE', name = id): Row {
  const created = new Date('2026-01-01T00:00:00Z');
  return { ...DEFAULTS.nativeCalendar(), id, ownerUserId, name, privacy, labels: [], createdAt: created, updatedAt: created };
}
function link(id: string, userId: number, nativeCalendarId: string, o: Row = {}): Row {
  return { ...DEFAULTS.googleSyncLink(), id, userId, nativeCalendarId, state: 'ok', googleCalendarId: `g-${id}`, pushedName: nativeCalendarId, createdAt: new Date(), updatedAt: new Date(), ...o };
}
function series(id: string, calendarId: string, o: Row = {}): Row {
  const startsAt = o.startsAt ?? at('2026-11-02 10:00');
  const row: Row = {
    ...DEFAULTS.nativeEvent(), id, calendarId, creatorUserId: TAL, title: id, timeZone: IL, startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR), createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'), ...o,
  };
  if (row.kind === 'REMINDER') Object.assign(row, { endsAt: row.startsAt, armedAt: row.armedAt ?? new Date('2026-10-01T00:00:00Z') });
  table('nativeEvent').push(row);
  return row;
}

/**
 * Tal and Noa are paired. Tal owns "own" (shared with Noa as editor) and "own2", both copied
 * to Google; "plain" (no copy) and "off" (a copy turned off). Noa owns "noa", shared with Tal,
 * which carries a link of Tal's, a row no route makes: Tal doesn't own "noa".
 */
function seed() {
  DB = {};
  seq = 0;
  calls = [];
  writes = [];
  failNext = null;
  beforeCommit = null;
  captured.length = 0;
  tracked.length = 0;
  redisStore.clear();
  authUserId = TAL;
  earlyAdoption = false;
  DB.user = [user(TAL, 'Tal', 'pair'), user(NOA, 'Noa', 'pair'), user(DAN, 'Dan', null)];
  DB.pairing = [{ id: 'pair', status: 'ACTIVE', inviterUserId: TAL, inviteeUserId: NOA }];
  DB.nativeCalendar = [
    calendar('own', TAL, 'SHARED_EDITOR', 'Home'),
    calendar('own2', TAL, 'PRIVATE', 'Work'),
    calendar('plain', TAL),
    calendar('off', TAL),
    calendar('noa', NOA, 'SHARED_EDITOR', 'Noa'),
  ];
  DB.googleSyncLink = [
    link(LINK, TAL, 'own', { pushedName: 'Home' }),
    link(LINK2, TAL, 'own2', { pushedName: 'Work' }),
    link('link-off', TAL, 'off', { enabled: false, unlinkChoice: 'keep' }),
    link('link-forged', TAL, 'noa'),
  ];
  DB.googleSyncItem = [];
  DB.nativeEvent = [];
  DB.nativeEventInstance = [];
  DB.nativeReminderState = [];
  series('one', 'own');
  series('weekly', 'own', { startsAt: at('2026-10-05 10:00'), rrule: 'FREQ=WEEKLY' });
  series('rem', 'own', { kind: 'REMINDER', title: 'Call mom' });
  series('plain-ev', 'plain');
  series('off-ev', 'off');
  series('noa-ev', 'noa', { creatorUserId: NOA });
}

const itemOf = (linkId: string, seriesId: string) => table('googleSyncItem').find((r) => r.linkId === linkId && r.nativeEventId === seriesId);
const items = () => table('googleSyncItem').map((r) => `${r.linkId}/${r.nativeEventId}=${r.dirtySeq}`).sort();
const linkRow = (id: string) => table('googleSyncLink').find((r) => r.id === id)!;

/** Runs a write with a fresh log. */
async function logged(write: () => Promise<unknown>) {
  calls = [];
  writes = [];
  await write();
  return { calls: [...calls], writes: [...writes] };
}

/** The write's rows and its marks went in one interactive transaction, and nothing outside it. */
function oneTransaction(log: { writes: typeof writes }, what: string) {
  const txs = [...new Set(log.writes.map((w) => w.tx))];
  assert(txs.length === 1 && txs[0] !== null, `${what}: writes in ${show(txs)}: ${show(log.writes)}`);
  assert(log.writes.some((w) => w.name === 'googleSyncItem' || w.name === 'googleSyncLink'), `${what}: no mark among ${show(log.writes)}`);
  assert(log.writes.some((w) => !w.name.startsWith('googleSync')), `${what}: no FamCal write among ${show(log.writes)}`);
}

const lookups = (log: { calls: string[] }) => log.calls.filter((c) => c.startsWith('googleSyncLink.')).length;

const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

async function main() {
  installStubs();
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;

  const store = await load('src/services/native-calendar/event-store.ts');
  const gateMod = await load('src/services/google-sync/gate.ts');
  const { createNativeEvent, createNativeSeries, updateNativeEvent, deleteNativeEvent } = store;
  const { openSyncGate, shouldRunSync, setNextSync, __resetSyncGateForTests, SYNC_GATE_CEILING_MS } = gateMod;
  const { NextRequest } = nodeRequire('next/server');
  const calendarRoute = await load('app/api/native-calendars/[id]/route.ts');
  const subs = await load('src/services/subscription-service.ts');
  const plans = await load('src/config/plans.ts');

  /** The gate as a pass leaves it: closed for the full ceiling. */
  const closeGate = () => {
    __resetSyncGateForTests();
    const now = new Date();
    assert(shouldRunSync(now), 'a fresh gate is open');
    setNextSync(null, now);
    assert(!shouldRunSync(new Date()), 'the gate did not close');
  };
  const gateOpen = () => shouldRunSync(new Date());

  const create = (o: Row = {}) =>
    createNativeEvent({ calendarCuid: 'own', creatorUserId: TAL, title: 'Dentist', startsAt: at('2026-11-03 09:00'), endsAt: at('2026-11-03 10:00'), timeZone: IL, ...o });

  // ---- The gate ----

  await check('gate: a fresh process starts open, a pass closes it for the ceiling (60 min), then it opens', async () => {
    __resetSyncGateForTests();
    const now = new Date('2026-10-20T10:00:00Z');
    assert(shouldRunSync(now), 'fresh: closed');
    setNextSync(null, now);
    assert(SYNC_GATE_CEILING_MS === 60 * 60_000, `ceiling ${SYNC_GATE_CEILING_MS}`);
    assert(!shouldRunSync(new Date(now.getTime() + 59 * 60_000)), 'open before the ceiling');
    assert(shouldRunSync(new Date(now.getTime() + 60 * 60_000)), 'closed after the ceiling');
  });

  await check('gate: it opens at the earliest retry when that is sooner than the ceiling, and never later than the ceiling', async () => {
    __resetSyncGateForTests();
    const now = new Date('2026-10-20T10:00:00Z');
    shouldRunSync(now);
    setNextSync(new Date(now.getTime() + 5 * 60_000), now);
    assert(!shouldRunSync(new Date(now.getTime() + 4 * 60_000)) && shouldRunSync(new Date(now.getTime() + 5 * 60_000)), 'not at the retry');
    shouldRunSync(now);
    setNextSync(new Date(now.getTime() + 5 * HOUR), now);
    assert(shouldRunSync(new Date(now.getTime() + HOUR)), 'later than the ceiling');
  });

  await check('gate: openSyncGate opens it, and a mark during a pass keeps the pass from closing it', async () => {
    closeGate();
    openSyncGate();
    assert(gateOpen(), 'openSyncGate did not open it');
    // The pass went through (gateOpen above); a mark lands while it runs.
    openSyncGate();
    setNextSync(null, new Date());
    assert(gateOpen(), 'the pass closed the gate over a mark it never read');
  });

  await check('gate: it lives on globalThis, shared by the scheduler bundle and the route bundles', async () => {
    const state = (globalThis as Row).__googleSyncGate;
    assert(state && typeof state.nextRunAt === 'number', `globalThis.__googleSyncGate ${show(state)}`);
    closeGate();
    state.nextRunAt = 0;
    assert(gateOpen(), 'the module does not read the shared object');
  });

  // ---- The store: create ----

  await check('create: an event on a copied calendar marks it on that link (dirtySeq 1, pushedSeq 0), in the create\'s transaction, and opens the gate', async () => {
    seed();
    closeGate();
    let id = '';
    const log = await logged(async () => { id = (await create()).id; });
    const item = itemOf(LINK, id);
    assert(item?.dirtySeq === 1 && item.pushedSeq === 0 && item.status === 'ok', `item ${show(item)}`);
    oneTransaction(log, 'create');
    assert(items().length === 1, `items ${show(items())}`);
    assert(gateOpen(), 'the gate stayed closed');
  });

  await check('create: on a calendar with no copy, nothing is marked, it costs one link lookup, and the gate stays closed', async () => {
    seed();
    closeGate();
    const log = await logged(() => create({ calendarCuid: 'plain' }));
    assert(items().length === 0, `items ${show(items())}`);
    assert(lookups(log) === 1, `link lookups ${show(log.calls)}`);
    assert(!gateOpen(), 'the gate opened');
  });

  await check('create: a reminder is never marked, costs no link lookup and is written as before (no transaction)', async () => {
    seed();
    closeGate();
    const log = await logged(() => create({ kind: 'REMINDER', title: 'Pills' }));
    assert(items().length === 0, `items ${show(items())}`);
    assert(lookups(log) === 0, `link lookups ${show(log.calls)}`);
    assert(log.writes.every((w) => w.tx === null), `writes ${show(log.writes)}`);
    assert(!gateOpen(), 'the gate opened');
  });

  await check('create: a turned-off copy is not marked', async () => {
    seed();
    await create({ calendarCuid: 'off' });
    assert(items().length === 0, `items ${show(items())}`);
  });

  await check('create: the partner\'s event in the owner\'s shared calendar is marked on the owner\'s link; a link whose user doesn\'t own the calendar never is', async () => {
    seed();
    const mine = await create({ creatorUserId: NOA });
    assert(itemOf(LINK, mine.id)?.dirtySeq === 1, `owner's link: ${show(items())}`);
    const theirs = await create({ calendarCuid: 'noa', creatorUserId: NOA });
    assert(!itemOf('link-forged', theirs.id), `the non-owner's link was marked: ${show(items())}`);
    // Tal writes into Noa's shared calendar: still not Tal's to copy.
    const byTal = await create({ calendarCuid: 'noa', creatorUserId: TAL });
    assert(!itemOf('link-forged', byTal.id), `the non-owner's link was marked: ${show(items())}`);
  });

  await check('create: a Hebrew-date series is marked', async () => {
    seed();
    const ev = await create({ title: 'Birthday', allDay: true, startsAt: at('2026-11-03 00:00'), endsAt: at('2026-11-03 23:59'), rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary' });
    assert(itemOf(LINK, ev.id)?.dirtySeq === 1, `items ${show(items())}`);
  });

  await check('create: a mark that fails undoes the write (one transaction), and the write fails as before', async () => {
    seed();
    const before = table('nativeEvent').length;
    failNext = 'googleSyncItem.$executeRaw';
    const outcome = await create().then(() => 'saved', (e: Error) => e.message);
    assert(/failed/.test(outcome), `outcome ${outcome}`);
    assert(table('nativeEvent').length === before, 'the event was kept without its mark');
  });

  await check('createNativeSeries (the move): the series and its overrides are marked in their transaction', async () => {
    seed();
    let id = '';
    const log = await logged(async () => {
      id = (await createNativeSeries({
        calendarCuid: 'own', creatorUserId: TAL, title: 'Moved', description: null, location: null,
        startsAt: at('2026-11-02 08:00'), endsAt: at('2026-11-02 09:00'), allDay: false, timeZone: IL, rrule: 'FREQ=DAILY;COUNT=5',
        exdates: [at('2026-11-03 08:00')],
        overrides: [{ originalStartsAt: at('2026-11-04 08:00'), title: 'Later', description: null, location: null, startsAt: at('2026-11-04 12:00'), endsAt: at('2026-11-04 13:00'), allDay: null }],
      })).id;
    });
    assert(itemOf(LINK, id)?.dirtySeq === 1, `items ${show(items())}`);
    oneTransaction(log, 'createNativeSeries');
  });

  // ---- The store: update ----

  await check('update: a write that lands while a push runs leaves the item dirty (dirtySeq goes past the pushed one)', async () => {
    seed();
    table('googleSyncItem').push({ ...DEFAULTS.googleSyncItem(), id: 'it-one', linkId: LINK, nativeEventId: 'one', googleEventId: 'g1', dirtySeq: 3, pushedSeq: 3 });
    await updateNativeEvent({ seriesCuid: 'one', scope: 'single', actingUserId: TAL, title: 'Renamed' });
    const item = itemOf(LINK, 'one')!;
    assert(item.dirtySeq === 4 && item.pushedSeq === 3, `after one write ${show(item)}`);
    await updateNativeEvent({ seriesCuid: 'one', scope: 'single', actingUserId: TAL, title: 'Again' });
    assert(item.dirtySeq === 5 && item.pushedSeq === 3 && item.googleEventId === 'g1', `after two ${show(item)}`);
    assert(table('googleSyncItem').length === 1, `items ${show(items())}`);
  });

  const scopes: Array<[string, () => Promise<unknown>, string[]]> = [
    ['one occurrence of a series (an OVERRIDE row)', () => updateNativeEvent({ seriesCuid: 'weekly', instanceStartsAt: at('2026-10-12 10:00'), scope: 'single', actingUserId: TAL, title: 'Once' }), ['weekly']],
    ['a one-off', () => updateNativeEvent({ seriesCuid: 'one', scope: 'single', actingUserId: TAL, location: 'Clinic' }), ['one']],
    ['every occurrence, the start moved', () => updateNativeEvent({ seriesCuid: 'weekly', scope: 'all', actingUserId: TAL, startsAt: at('2026-10-05 11:00'), endsAt: at('2026-10-05 12:00') }), ['weekly']],
    ['every occurrence, the title only', () => updateNativeEvent({ seriesCuid: 'weekly', scope: 'all', actingUserId: TAL, title: 'Gym' }), ['weekly']],
    ['this and the ones after (a split)', () => updateNativeEvent({ seriesCuid: 'weekly', instanceStartsAt: at('2026-10-19 10:00'), scope: 'following', actingUserId: TAL, title: 'Later gym' }), ['weekly', 'NEW']],
    ['this and the ones after, from the first (in place)', () => updateNativeEvent({ seriesCuid: 'weekly', instanceStartsAt: at('2026-10-05 10:00'), scope: 'following', actingUserId: TAL, title: 'All gym' }), ['weekly']],
    ['this and the ones after on a one-off (the fallback)', () => updateNativeEvent({ seriesCuid: 'one', scope: 'following', actingUserId: TAL, title: 'Fallback' }), ['one']],
    ['stop repeating from a later occurrence', () => updateNativeEvent({ seriesCuid: 'weekly', instanceStartsAt: at('2026-10-19 10:00'), scope: 'following', actingUserId: TAL, rrule: null }), ['weekly', 'NEW']],
    ['stop repeating from the first', () => updateNativeEvent({ seriesCuid: 'weekly', instanceStartsAt: at('2026-10-05 10:00'), scope: 'following', actingUserId: TAL, rrule: null }), ['weekly']],
    ['a one-off starts repeating', () => updateNativeEvent({ seriesCuid: 'one', scope: 'following', actingUserId: TAL, rrule: 'FREQ=DAILY;COUNT=3' }), ['one']],
    ['a new rule from an occurrence (a split)', () => updateNativeEvent({ seriesCuid: 'weekly', instanceStartsAt: at('2026-10-19 10:00'), scope: 'following', actingUserId: TAL, rrule: 'FREQ=DAILY' }), ['weekly', 'NEW']],
    ['a Gregorian series becomes a Hebrew-date one (a split)', () => updateNativeEvent({ seriesCuid: 'weekly', instanceStartsAt: at('2026-10-19 10:00'), scope: 'following', actingUserId: TAL, rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary' }), ['weekly', 'NEW']],
  ];
  for (const [label, write, marked] of scopes) {
    await check(`update: ${label} is marked in the write's transaction`, async () => {
      seed();
      const before = new Set(table('nativeEvent').map((e) => e.id));
      closeGate();
      const log = await logged(write);
      const ids = marked.map((id) => (id === 'NEW' ? table('nativeEvent').find((e) => !before.has(e.id))?.id : id));
      for (const id of ids) assert(id && itemOf(LINK, id)?.dirtySeq === 1, `${id} not marked: ${show(items())}`);
      assert(items().length === ids.length, `items ${show(items())}`);
      oneTransaction(log, label);
      assert(gateOpen(), 'the gate stayed closed');
    });
  }

  await check('update: an event moved to another copied calendar is marked on both links (one deletes, one inserts)', async () => {
    seed();
    const log = await logged(() => updateNativeEvent({ seriesCuid: 'one', scope: 'single', actingUserId: TAL, calendarId: 'own2' }));
    assert(itemOf(LINK, 'one')?.dirtySeq === 1 && itemOf(LINK2, 'one')?.dirtySeq === 1, `items ${show(items())}`);
    oneTransaction(log, 'move');
  });

  await check('update: a series moved from a copied calendar to one with no copy is marked on the old link only; "this and the ones after" moves mark the new series on the new calendar', async () => {
    seed();
    await updateNativeEvent({ seriesCuid: 'weekly', scope: 'all', actingUserId: TAL, calendarId: 'plain' });
    assert(show(items()) === show([`${LINK}/weekly=1`]), `items ${show(items())}`);
    seed();
    const before = new Set(table('nativeEvent').map((e) => e.id));
    await updateNativeEvent({ seriesCuid: 'weekly', instanceStartsAt: at('2026-10-19 10:00'), scope: 'following', actingUserId: TAL, calendarId: 'own2' });
    const tail = table('nativeEvent').find((e) => !before.has(e.id))!.id;
    assert(show(items()) === show([`${LINK}/weekly=1`, `${LINK2}/${tail}=1`].sort()), `items ${show(items())}`);
  });

  await check('update: a refused edit writes and marks nothing', async () => {
    seed();
    const outcome = await updateNativeEvent({ seriesCuid: 'one', scope: 'single', actingUserId: DAN, title: 'Nope' }).then(() => 'saved', (e: Error) => e.name);
    assert(outcome === 'NativePermissionDeniedError', `outcome ${outcome}`);
    assert(items().length === 0, `items ${show(items())}`);
  });

  await check('update and delete: a reminder is never marked and costs no link lookup', async () => {
    seed();
    closeGate();
    const log = await logged(async () => {
      await updateNativeEvent({ seriesCuid: 'rem', scope: 'single', actingUserId: TAL, title: 'Call dad' });
      await updateNativeEvent({ seriesCuid: 'rem', scope: 'all', actingUserId: TAL, startsAt: at('2026-11-02 12:00') });
      await deleteNativeEvent({ seriesCuid: 'rem', scope: 'single', actingUserId: TAL });
    });
    assert(items().length === 0, `items ${show(items())}`);
    assert(lookups(log) === 0, `link lookups ${show(log.calls)}`);
    assert(!gateOpen(), 'the gate opened');
  });

  // ---- The store: delete ----

  const deletes: Array<[string, () => Promise<unknown>, string]> = [
    ['one occurrence of a series (an exdate)', () => deleteNativeEvent({ seriesCuid: 'weekly', instanceStartsAt: at('2026-10-12 10:00'), scope: 'single', actingUserId: TAL }), 'weekly'],
    ['a one-off', () => deleteNativeEvent({ seriesCuid: 'one', scope: 'single', actingUserId: TAL }), 'one'],
    ['a whole series', () => deleteNativeEvent({ seriesCuid: 'weekly', scope: 'all', actingUserId: TAL }), 'weekly'],
    ['this and the ones after (a cut)', () => deleteNativeEvent({ seriesCuid: 'weekly', instanceStartsAt: at('2026-10-19 10:00'), scope: 'following', actingUserId: TAL }), 'weekly'],
    ['this and the ones after, from the first', () => deleteNativeEvent({ seriesCuid: 'weekly', instanceStartsAt: at('2026-10-05 10:00'), scope: 'following', actingUserId: TAL }), 'weekly'],
    ['this and the ones after on a one-off (the fallback)', () => deleteNativeEvent({ seriesCuid: 'one', scope: 'following', actingUserId: TAL }), 'one'],
  ];
  for (const [label, write, id] of deletes) {
    await check(`delete: ${label} is marked in the delete's transaction`, async () => {
      seed();
      const log = await logged(write);
      assert(show(items()) === show([`${LINK}/${id}=1`]), `items ${show(items())}`);
      oneTransaction(log, label);
    });
  }

  await check('delete: one occurrence that was moved on its own (CANCELLED) is marked', async () => {
    seed();
    await updateNativeEvent({ seriesCuid: 'weekly', instanceStartsAt: at('2026-10-12 10:00'), scope: 'single', actingUserId: TAL, title: 'Moved' });
    const log = await logged(() => deleteNativeEvent({ seriesCuid: 'weekly', instanceStartsAt: at('2026-10-12 10:00'), scope: 'single', actingUserId: TAL }));
    assert(itemOf(LINK, 'weekly')?.dirtySeq === 2, `items ${show(items())}`);
    oneTransaction(log, 'cancel');
  });

  await check('gate: a pass that went through the gate before the write committed can\'t close it over the mark', async () => {
    seed();
    closeGate();
    // The worker ticks between the mark and the commit: it reads the database (without the
    // uncommitted mark) and closes the gate for the ceiling.
    beforeCommit = () => {
      beforeCommit = null;
      const now = new Date();
      assert(shouldRunSync(now), 'the mark did not open the gate');
      setNextSync(null, now);
    };
    await create();
    assert(beforeCommit === null, 'the worker tick never ran');
    assert(gateOpen(), 'the gate stayed closed after the commit');
  });

  // ---- The calendar route ----

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const request = (method: string, id: string, body: Row | null) =>
    new NextRequest(`http://localhost/api/native-calendars/${id}?user_id=${TAL}`, {
      method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const patch = async (id: string, body: Row) => calendarRoute.PATCH(request('PATCH', id, body), params(id));
  const del = async (id: string, body: Row | null) => calendarRoute.DELETE(request('DELETE', id, body), params(id));

  await check('PATCH: a rename marks the copy\'s link (dirtySeq + 1) in the rename\'s transaction, and opens the gate', async () => {
    seed();
    closeGate();
    let res: Response | undefined;
    const log = await logged(async () => { res = await patch('own', { name: 'Family' }); });
    assert(res?.status === 200, `status ${res?.status}`);
    const row = linkRow(LINK);
    assert(row.dirtySeq === 1 && row.pushedSeq === 0 && row.pushedName === 'Home', `link ${show(row)}`);
    assert(table('nativeCalendar').find((c) => c.id === 'own')!.name === 'Family', 'not renamed');
    oneTransaction(log, 'rename');
    assert(gateOpen(), 'the gate stayed closed');
  });

  await check('PATCH: a colour change, or the same name sent again, marks nothing, costs no link lookup and is written as before', async () => {
    seed();
    const log = await logged(async () => {
      await patch('own', { color: '#123456' });
      await patch('own', { name: 'Home' });
    });
    assert(linkRow(LINK).dirtySeq === 0, `link ${show(linkRow(LINK))}`);
    assert(lookups(log) === 0, `link lookups ${show(log.calls)}`);
    assert(log.writes.every((w) => w.tx === null), `writes ${show(log.writes)}`);
  });

  await check('PATCH: a rename of a calendar with no copy, or a turned-off one, marks nothing', async () => {
    seed();
    await patch('plain', { name: 'Plain 2' });
    await patch('off', { name: 'Off 2' });
    assert(linkRow('link-off').dirtySeq === 0 && linkRow(LINK).dirtySeq === 0, `links ${show(table('googleSyncLink'))}`);
  });

  await check('DELETE with googleCopy "remove": the calendar goes and its copy turns off with Remove queued (dirtySeq + 1), in one transaction', async () => {
    seed();
    closeGate();
    let res: Response | undefined;
    const log = await logged(async () => { res = await del('own', { googleCopy: 'remove' }); });
    assert(res?.status === 200, `status ${res?.status}`);
    const row = linkRow(LINK);
    assert(row.enabled === false && row.unlinkChoice === 'remove' && row.dirtySeq === 1, `link ${show(row)}`);
    assert(row.googleCalendarId === `g-${LINK}` && row.nativeCalendarId === 'own', `link kept ${show(row)}`);
    assert(table('nativeCalendar').find((c) => c.id === 'own')!.isDeleted === true, 'not deleted');
    oneTransaction(log, 'delete');
    assert(gateOpen(), 'the gate stayed closed');
  });

  await check('DELETE without the flag keeps the Google calendar (Keep queued); "keep" does the same', async () => {
    seed();
    const res = await del('own', null);
    assert(res.status === 200, `status ${res.status}`);
    assert(linkRow(LINK).enabled === false && linkRow(LINK).unlinkChoice === 'keep', `link ${show(linkRow(LINK))}`);
    const res2 = await del('own2', { googleCopy: 'keep' });
    assert(res2.status === 200 && linkRow(LINK2).unlinkChoice === 'keep', `link ${show(linkRow(LINK2))}`);
  });

  await check('DELETE with an unknown googleCopy answers 400 and deletes nothing', async () => {
    seed();
    const res = await del('own', { googleCopy: 'everything' });
    assert(res.status === 400, `status ${res.status}`);
    assert(table('nativeCalendar').find((c) => c.id === 'own')!.isDeleted === false && linkRow(LINK).enabled === true, 'something was written');
  });

  await check('DELETE: a calendar with no copy is deleted as before; an earlier Keep is not changed by a later Remove', async () => {
    seed();
    const res = await del('plain', { googleCopy: 'remove' });
    assert(res.status === 200 && table('nativeCalendar').find((c) => c.id === 'plain')!.isDeleted === true, `status ${res.status}`);
    const res2 = await del('off', { googleCopy: 'remove' });
    assert(res2.status === 200 && linkRow('link-off').unlinkChoice === 'keep' && linkRow('link-off').dirtySeq === 0, `link ${show(linkRow('link-off'))}`);
  });

  // ---- The plan feature ----

  await check('plans: googleSync is on exactly the plans reminders are (Pro), and planHasFeature knows it', async () => {
    for (const id of ['FREE', 'BASIC', 'PRO']) {
      const limits = plans.getPlanLimits(id);
      assert(limits.googleSync === limits.reminders, `${id}: googleSync ${limits.googleSync}, reminders ${limits.reminders}`);
      assert(plans.planHasFeature(id, 'googleSync') === (id === 'PRO'), `${id}: planHasFeature`);
    }
  });

  const day = 86_400_000;
  const sub = (o: Row) => ({
    id: 'sub-1', userId: TAL, plan: 'FREE', status: 'EXPIRED', trialStartedAt: new Date(Date.now() - 30 * day), trialEndsAt: new Date(Date.now() - 16 * day),
    currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, compedBy: null, compedAt: null, compReason: null, telegramPaymentChargeId: null,
    createdAt: new Date(), updatedAt: new Date(), ...o,
  });
  const tiers: Array<[string, () => void, boolean]> = [
    ['Free', () => { DB.subscription = [sub({})]; }, false],
    ['Basic', () => { DB.subscription = [sub({ plan: 'BASIC', status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 10 * day) })]; }, false],
    ['Pro', () => { DB.subscription = [sub({ plan: 'PRO', status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 10 * day) })]; }, true],
    ['a running trial', () => { DB.subscription = [sub({ status: 'TRIALING', trialEndsAt: new Date(Date.now() + 3 * day) })]; }, true],
    ['an early adopter on Free', () => { DB.subscription = [sub({})]; earlyAdoption = true; }, true],
    ['an admin grant (the reminders grant) on Free', () => {
      DB.subscription = [sub({})];
      DB.userFeatureOverride = [{ id: 'ovr', userId: TAL, unlimitedSummaries: null, remindersEnabled: true, voiceEventsEnabled: null, unlimitedCalendars: null, earlyAdopter: false }];
    }, true],
  ];
  for (const [label, setup, allowed] of tiers) {
    await check(`plan feature: ${label} ${allowed ? 'has' : 'lacks'} google_sync, as it ${allowed ? 'has' : 'lacks'} reminders`, async () => {
      seed();
      DB.usageCounter = [{ id: 'use-1', userId: TAL, textSummariesUsed: 0, voiceSummariesUsed: 0, voiceEventsCreated: 0, remindersTriggered: 0, cycleStartDate: new Date(), updatedAt: new Date() }];
      DB.userFeatureOverride = [];
      setup();
      const sync = await subs.checkFeatureAccess(TAL, 'google_sync');
      redisStore.clear();
      const reminders = await subs.checkFeatureAccess(TAL, 'reminders');
      assert(sync.allowed === allowed && reminders.allowed === allowed, `google_sync ${show(sync)}, reminders ${show(reminders)}`);
      if (!allowed) assert(sync.reason === 'upgrade_required' && tracked.includes(`${TAL}:feature_blocked:google_sync`), `blocked ${show(sync)} ${show(tracked)}`);
    });
  }

  await check('plan feature: a plan change clears the cached google_sync answer', async () => {
    seed();
    redisStore.set(`feature:access:${TAL}:google_sync`, JSON.stringify({ allowed: true }));
    await subs.invalidateFeatureAccessCache(TAL);
    assert(![...redisStore.keys()].some((k) => k.endsWith(':google_sync')), `keys ${show([...redisStore.keys()])}`);
  });

  Object.assign(console, quiet);
  if (strayCalls.length) results.push({ name: 'inside an interactive transaction only tx is used', ok: false, reason: show(strayCalls) });
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

// Smoke test for the FamCal → Google sync worker (plan Task S3; docs/superpowers/specs/
// 2026-10-20-google-sync-design.md §3, §4, §6). The marks and the gate are in
// smoke-google-sync.ts; the hard delete's Remove before its transaction in smoke-account-merge.ts.
//
// Covered here:
//   - calendars: create with 'creating', the token in the description, the bidi-isolated name
//     with " (2)" and the zone, and no calendarList write (Google answers it 401 for this grant);
//     adopt on retry; rename; Remove both forms
//     and its safety check; Keep; a queued turn-off with link.unlinkToken; re-enable; recreate;
//   - push: the deterministic id and the 409 adopt, the full master write with instance replay,
//     slot-only patches, structural delete and reinsert, deletes (404/410 done), reminder and
//     moved-out removal, the owner re-check, old one-offs, unsupported items (and their retry
//     after a FamCal change), the Hebrew RDATE horizon, no alerts on copies, the dirtySeq race;
//   - failures: the 404 split (calendars.get), a second 404, backoff with jitter, the rate-limit
//     pause, token, scopes, otherAccount and plan states, the reconnect message once per
//     outage, suspended users, the admin alert after 10 attempts once per link per day; a
//     copy's own steps (account check, create, rename, turn-off) backed off per link with the
//     same alert, one copy's failure never holding back the others; a rename on a deleted
//     calendar going 'gone'; a commit re-checking 'otherAccount'; a turned-off copy with no
//     stored calendar id looked up by its token; a 409 on a deleted event's id taking the next
//     generation, and a Remove that keeps the calendar keeping each item's generation;
//     googleAccountOf's 403 reasons; a bare 401 on one request while the token works (one
//     check per run, on a fresh client) backing off only that copy, and the outage when the
//     check fails too;
//   - pace: the lock (NX, TTL, renew, release, fail-closed, owned by the run's token), 100
//     calls per user per run, 3 users at a time, serial calendar creation, backfill with
//     progress counts (what it marked, before push drains);
//   - the cron handler's gate, and no titles in logs.
//
// The worker, push, calendars, hebrew, the marks, the mapper and the recurrence code run for
// real. Faked: Prisma (in memory, with the schema's keys, relations, field references and
// interactive transactions), Redis, Google (client.ts's test seam), error capture, the admin
// notifier, Telegram/WhatsApp, the plan check and the zone lookup. No network, no database.
//
// Run with the fake env from the task brief (no dotenv), under both clocks:
//   TZ=UTC npx tsx scripts/smoke-google-sync-worker.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-google-sync-worker.ts

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
const show = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Map ? [...v.entries()] : v));

// ---- Fake Prisma ----

let DB: Record<string, Row[]> = {};
const table = (name: string) => (DB[name] ??= []);

type FK = { from: string; field: string; to: string; onDelete: 'Restrict' | 'Cascade' | 'SetNull' };
const FKS: FK[] = [
  { from: 'nativeCalendar', field: 'ownerUserId', to: 'user', onDelete: 'Restrict' },
  { from: 'nativeEvent', field: 'calendarId', to: 'nativeCalendar', onDelete: 'Cascade' },
  { from: 'nativeEventInstance', field: 'seriesEventId', to: 'nativeEvent', onDelete: 'Cascade' },
  { from: 'googleSyncLink', field: 'userId', to: 'user', onDelete: 'Cascade' },
  { from: 'googleSyncLink', field: 'nativeCalendarId', to: 'nativeCalendar', onDelete: 'SetNull' },
  { from: 'googleSyncItem', field: 'linkId', to: 'googleSyncLink', onDelete: 'Cascade' },
];
const UNIQUE: Record<string, string[][]> = {
  nativeEventInstance: [['seriesEventId', 'originalStartsAt']],
  googleSyncLink: [['userId', 'nativeCalendarId']],
  googleSyncItem: [['linkId', 'nativeEventId']],
};
/** Relations a select, an include or a where can follow: to-one (a row) or to-many (rows). */
const RELATIONS: Record<string, Record<string, { to: string; many?: boolean; of: (row: Row) => Row | Row[] | undefined }>> = {
  googleSyncLink: { nativeCalendar: { to: 'nativeCalendar', of: (r) => table('nativeCalendar').find((c) => c.id === r.nativeCalendarId) } },
  nativeEvent: {
    calendar: { to: 'nativeCalendar', of: (r) => table('nativeCalendar').find((c) => c.id === r.calendarId) },
    instances: { to: 'nativeEventInstance', many: true, of: (r) => table('nativeEventInstance').filter((i) => i.seriesEventId === r.id) },
  },
};
const DEFAULTS: Record<string, () => Row> = {
  nativeCalendar: () => ({ color: '#039BE5', labels: [], rules: [], personName: null, privacy: 'PRIVATE', isDeleted: false }),
  nativeEvent: () => ({ description: null, location: null, allDay: false, rrule: null, hebrewRule: null, hebrewAnchor: null, exdates: [], reminderMinutes: null, isDeleted: false, kind: 'EVENT', forUserId: null, armedAt: null }),
  nativeEventInstance: () => ({ title: null, description: null, location: null, startsAt: null, endsAt: null, allDay: null }),
  googleSyncLink: () => ({
    googleCalendarId: null, googleAccount: null, enabled: true, state: 'creating', unlinkChoice: null, unlinkToken: null, dirtySeq: 0, pushedSeq: 0,
    pushedName: null, lastError: null, lastSyncedAt: null, backfilledAt: null,
  }),
  googleSyncItem: () => ({ googleEventId: null, generation: 0, masterHash: null, slotHashes: {}, dirtySeq: 0, pushedSeq: 0, attempts: 0, nextAttemptAt: null, status: 'ok', lastError: null }),
};

const dbError = (code: string, message: string) => Object.assign(new Error(message), { code });
const num = (x: unknown) => (x instanceof Date ? x.getTime() : Number(x));
function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') return a != null && b != null && String(a) === String(b);
  return (a ?? null) === (b ?? null);
}
const isPlain = (v: unknown): v is Row => v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);
/** prisma.<model>.fields.<name>: a column compared with another column of the same row. */
const FIELD_REF = Symbol('fieldRef');
const fieldRef = (name: string) => ({ [FIELD_REF]: name });
const valueOf = (row: Row, arg: unknown) => (isPlain(arg) && FIELD_REF in arg ? row[(arg as Record<symbol, string>)[FIELD_REF]] : arg);

function matches(name: string, row: Row, where?: Row): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    if (k === 'AND') return ([] as Row[]).concat(cond).every((c) => matches(name, row, c));
    if (k === 'OR') return (cond as Row[]).some((c) => matches(name, row, c));
    if (k === 'NOT') return !([] as Row[]).concat(cond).some((c) => matches(name, row, c));
    const rel = RELATIONS[name]?.[k];
    if (rel && isPlain(cond)) {
      const related = rel.of(row);
      return !Array.isArray(related) && related !== undefined && matches(rel.to, related, cond);
    }
    const v = row[k];
    if (isPlain(cond) && !(FIELD_REF in cond)) {
      return Object.entries(cond).every(([op, rawArg]) => {
        const arg = valueOf(row, rawArg);
        switch (op) {
          case 'equals': return same(v, arg);
          case 'in': return (arg as unknown[]).some((x) => same(v, x));
          case 'notIn': return !(arg as unknown[]).some((x) => same(v, x));
          case 'not': return isPlain(arg) ? !matches(name, row, { [k]: arg }) : !same(v, arg);
          case 'gt': return v != null && num(v) > num(arg);
          case 'gte': return v != null && num(v) >= num(arg);
          case 'lt': return v != null && num(v) < num(arg);
          case 'lte': return v != null && num(v) <= num(arg);
          default: throw new Error(`fake prisma: no operator ${op}`);
        }
      });
    }
    return same(v, valueOf(row, cond));
  });
}

function pick(name: string, row: Row | undefined, args: { select?: Row; include?: Row } = {}): Row | null {
  if (!row) return null;
  const follow = (k: string, sub: Row | true) => {
    const rel = RELATIONS[name]?.[k];
    if (!rel) throw new Error(`fake prisma: no relation ${name}.${k}`);
    const related = rel.of(row);
    const subArgs = sub === true ? {} : { select: sub.select, include: sub.include };
    return Array.isArray(related) ? related.map((r) => pick(rel.to, r, subArgs)) : pick(rel.to, related, subArgs);
  };
  if (args.select) {
    const out: Row = {};
    for (const [k, sel] of Object.entries(args.select)) {
      if (!sel) continue;
      out[k] = RELATIONS[name]?.[k] ? follow(k, sel as Row | true) : structuredClone(row[k]);
    }
    return out;
  }
  const out = structuredClone(row);
  for (const [k, inc] of Object.entries(args.include ?? {})) if (inc) out[k] = follow(k, inc as Row | true);
  return out;
}

function sorted(rows: Row[], orderBy?: Row | Row[]): Row[] {
  const keys = ([] as Row[]).concat(orderBy ?? []).flatMap((o) => Object.entries(o));
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const d = typeof a[k] === 'string' ? String(a[k]).localeCompare(String(b[k])) : num(a[k]) - num(b[k]);
      if (d) return dir === 'desc' ? -d : d;
    }
    return 0;
  });
}

function applyData(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (isPlain(v) && 'increment' in v) row[k] = (row[k] ?? 0) + v.increment;
    else if (isPlain(v) && 'set' in v) row[k] = v.set;
    else row[k] = structuredClone(v);
  }
}

function validate(name: string, row: Row) {
  for (const cols of UNIQUE[name] ?? []) {
    if (cols.some((c) => row[c] == null)) continue;
    if (table(name).some((r) => r !== row && r.id !== row.id && cols.every((c) => same(r[c], row[c])))) throw dbError('P2002', `Unique constraint failed on ${name}(${cols.join(', ')})`);
  }
  for (const fk of FKS.filter((f) => f.from === name)) {
    if (row[fk.field] == null) continue;
    if (!table(fk.to).some((r) => same(r.id, row[fk.field]))) throw dbError('P2003', `Foreign key constraint failed on ${name}.${fk.field}`);
  }
}

function removeRows(name: string, rows: Row[]) {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  DB[name] = table(name).filter((r) => !ids.includes(r.id));
  for (const fk of FKS.filter((f) => f.to === name)) {
    const refs = table(fk.from).filter((r) => ids.some((id) => same(r[fk.field], id)));
    if (fk.onDelete === 'Cascade') removeRows(fk.from, refs);
    else if (fk.onDelete === 'SetNull') refs.forEach((r) => { r[fk.field] = null; });
    else if (refs.length) throw dbError('P2003', `Foreign key constraint failed on ${fk.from}.${fk.field}`);
  }
}

let seq = 0;
let calls: string[] = [];
/** Runs before every Prisma call ("<model>.<method>"); a check may throw or change rows from it. */
let beforePrismaCall: ((label: string, args: Row) => void) | null = null;
let openTx: number | null = null;
let txSeq = 0;
const strayCalls: string[] = [];

function model(name: string): Row {
  const t = () => table(name);
  const create = (data: Row): Row => {
    const now = new Date();
    const row: Row = { id: `${name}-${++seq}`, createdAt: now, updatedAt: now, ...(DEFAULTS[name]?.() ?? {}) };
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
    findUnique: (a = {}) => pick(name, t().find((r) => matches(name, r, a.where)), a),
    findFirst: (a = {}) => pick(name, sorted(t().filter((r) => matches(name, r, a.where)), a.orderBy)[0], a),
    findMany: (a = {}) => {
      const rows = sorted(t().filter((r) => matches(name, r, a.where)), a.orderBy);
      return (a.take !== undefined ? rows.slice(0, a.take) : rows).map((r) => pick(name, r, a));
    },
    count: (a = {}) => t().filter((r) => matches(name, r, a.where)).length,
    groupBy: (a) => {
      const groups = new Map<string, Row[]>();
      for (const r of t().filter((x) => matches(name, x, a.where))) {
        const key = JSON.stringify(a.by.map((b: string) => r[b]));
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      return [...groups.values()].map((rows) => {
        const out: Row = Object.fromEntries(a.by.map((b: string) => [b, rows[0][b]]));
        if (a._count) out._count = { _all: rows.length };
        if (a._min) {
          out._min = Object.fromEntries(Object.keys(a._min).map((k) => {
            const vals = rows.map((r) => r[k]).filter((v) => v != null);
            return [k, vals.length ? vals.reduce((m, v) => (num(v) < num(m) ? v : m)) : null];
          }));
        }
        return out;
      });
    },
    create: (a) => pick(name, create(a.data), a),
    update: (a) => {
      const row = t().find((r) => matches(name, r, a.where));
      if (!row) throw dbError('P2025', `No ${name} record was found for an update.`);
      return pick(name, updateRow(row, a.data), a);
    },
    updateMany: (a) => {
      const rows = t().filter((r) => matches(name, r, a.where));
      rows.forEach((r) => updateRow(r, a.data));
      return { count: rows.length };
    },
    delete: (a) => {
      const row = t().find((r) => matches(name, r, a.where));
      if (!row) throw dbError('P2025', `No ${name} record to delete`);
      removeRows(name, [row]);
      return row;
    },
    deleteMany: (a = {}) => {
      const rows = t().filter((r) => matches(name, r, a.where));
      removeRows(name, rows);
      return { count: rows.length };
    },
  };
  const methods = Object.fromEntries(Object.entries(impl).map(([method, fn]) => [method, async (a: Row) => run(name, method, a, () => fn(a))]));
  return { ...methods, fields: new Proxy({}, { get: (_t, p) => fieldRef(String(p)) }) };
}

async function run<T>(name: string, method: string, args: Row, fn: () => T): Promise<T> {
  const label = `${name}.${method}`;
  calls.push(label);
  beforePrismaCall?.(label, args ?? {});
  return fn();
}

/** The mark's upsert (marks.ts): INSERT … ON CONFLICT ("linkId","nativeEventId") DO UPDATE dirtySeq + 1. */
function executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
  const query = Prisma.sql(strings, ...values);
  return run('googleSyncItem', '$executeRaw', {}, () => {
    const sql = query.sql.replace(/\s+/g, ' ');
    assert(/INSERT INTO "GoogleSyncItem" .* ON CONFLICT \("linkId", "nativeEventId"\) DO UPDATE SET "dirtySeq" = "GoogleSyncItem"\."dirtySeq" \+ 1$/.test(sql.trim()), `unexpected raw SQL: ${sql}`);
    const vals = query.values as string[];
    for (let i = 0; i < vals.length; i += 3) {
      const [id, linkId, nativeEventId] = vals.slice(i, i + 3);
      const existing = table('googleSyncItem').find((r) => r.linkId === linkId && r.nativeEventId === nativeEventId);
      if (existing) existing.dirtySeq += 1;
      else table('googleSyncItem').push({ ...DEFAULTS.googleSyncItem(), id, linkId, nativeEventId, dirtySeq: 1 });
    }
    return vals.length / 3;
  });
}

const models: Record<string, Row> = {};
function client(isTx: boolean): Row {
  return new Proxy({} as Row, {
    get(_t, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (!isTx && openTx !== null && prop !== '$transaction') {
        strayCalls.push(`prisma.${prop}`);
      }
      if (prop === '$transaction') {
        if (isTx) return undefined;
        return async (arg: unknown) => {
          if (typeof arg !== 'function') throw new Error('fake prisma: only interactive transactions');
          const before = structuredClone(DB);
          openTx = ++txSeq;
          try {
            return await (arg as (tx: Row) => Promise<unknown>)(txClient);
          } catch (err) {
            DB = before;
            throw err;
          } finally {
            openTx = null;
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

const redisStore = new Map<string, { value: string; ex?: number }>();
const redisLog: string[] = [];
let redisFail: string | null = null;
const fakeRedis: Row = {
  get: async (k: string) => redisStore.get(k)?.value ?? null,
  set: async (k: string, v: unknown, o?: { nx?: boolean; ex?: number }) => {
    redisLog.push(`set ${k}${o?.nx ? ' nx' : ''}${o?.ex ? ` ex ${o.ex}` : ''}`);
    if (redisFail === 'set') throw new Error('redis down');
    if (o?.nx && redisStore.has(k)) return null;
    redisStore.set(k, { value: String(v), ex: o?.ex });
    return 'OK';
  },
  expire: async (k: string, s: number) => {
    redisLog.push(`expire ${k} ${s}`);
    if (redisFail === 'expire') throw new Error('redis down');
    const e = redisStore.get(k);
    if (!e) return 0;
    e.ex = s;
    return 1;
  },
  del: async (...ks: unknown[]) => {
    redisLog.push(`del ${ks.flat().join(',')}`);
    return ks.flat().reduce((n: number, k) => n + (redisStore.delete(String(k)) ? 1 : 0), 0);
  },
  /** The links' retries (retries.ts): read once per pass, so not in redisLog (which tracks the lock). */
  mget: async (...ks: unknown[]) => {
    if (redisFail === 'mget') throw new Error('redis down');
    return ks.flat().map((k) => redisStore.get(String(k))?.value ?? null);
  },
  /** The lock's two scripts (worker.ts RENEW_LOCK, RELEASE_LOCK): act only while the key holds the run's token. */
  eval: async (script: string, keys: string[], args: unknown[]) => {
    const [k] = keys;
    const renew = /'expire'/.test(script);
    assert(renew || /'del'/.test(script), `unexpected script ${script}`);
    assert(/redis\.call\('get', KEYS\[1\]\) == ARGV\[1\]/.test(script), `the script doesn't check the owner: ${script}`);
    if (redisFail === 'expire' && renew) {
      redisLog.push(`expire ${k} ${args[1]}`);
      throw new Error('redis down');
    }
    const e = redisStore.get(k);
    if (!e || e.value !== String(args[0])) {
      redisLog.push(`${renew ? 'expire' : 'del'} ${k} refused (not the owner)`);
      return 0;
    }
    if (renew) {
      redisLog.push(`expire ${k} ${args[1]}`);
      e.ex = Number(args[1]);
    } else {
      redisLog.push(`del ${k}`);
      redisStore.delete(k);
    }
    return 1;
  },
};

// ---- Fake Google ----

/** A Google API error as gaxios shapes it. */
function gErr(status: number, reason?: string, domain = 'global'): Error {
  return Object.assign(new Error(`Google HTTP ${status}${reason ? ` ${reason}` : ''}`), {
    response: { status, data: { error: { code: status, errors: reason ? [{ domain, reason, message: reason }] : [] } } },
    config: { data: 'REQUEST BODY WITH TITLES' },
  });
}

/** Google's answer to a request this grant may not make, as it came in production: 401 authError "Invalid Credentials". */
function prodRefusal(method: string, path: string): Error {
  return Object.assign(new Error('Invalid Credentials'), {
    config: { method, url: new URL(`https://www.googleapis.com/calendar/v3/${path}?alt=json`), data: 'REQUEST BODY' },
    response: { status: 401, data: { error: { code: 401, message: 'Invalid Credentials', errors: [{ domain: 'global', reason: 'authError', message: 'Invalid Credentials' }] } } },
  });
}

type GEvent = Row & { id: string; status: string; exceptions: Map<string, Row> };
type GCal = { id: string; account: string; summary: string; description: string; timeZone?: string; events: Map<string, GEvent> };
const google = {
  calendars: new Map<string, GCal>(),
  accounts: new Map<string, string>(), // token → account
  calls: [] as string[], // "<op> <token>"
  failures: [] as Array<{ op: string; error: Error; left: number; when?: (args: Row) => boolean }>,
  missingInstances: new Set<string>(),
  inflight: 0,
  maxInflight: 0,
  inserting: 0,
  maxInserting: 0,
  /** Runs inside every call, after it is counted (a check may land a FamCal write mid-push). */
  during: null as ((op: string, args: Row) => void) | null,
  seq: 0,
  /** Clients made (each syncGoogle call): a fresh client mints a fresh access token. */
  clients: 0,
};
const stampOf = (originalStart: string) => originalStart.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

function fakeGoogle(token: string): Row {
  google.clients += 1;
  const account = () => {
    const a = google.accounts.get(token);
    if (!a) throw Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant' } } });
    return a;
  };
  const op = async (name: string, args: Row, body: () => unknown) => {
    google.calls.push(`${name} ${token}`);
    google.inflight += 1;
    google.maxInflight = Math.max(google.maxInflight, google.inflight);
    try {
      await new Promise((r) => setImmediate(r));
      const f = google.failures.find((x) => x.op === name && x.left > 0 && (!x.when || x.when(args)));
      if (f) {
        f.left -= 1;
        throw f.error;
      }
      google.during?.(name, args);
      return { data: body() };
    } finally {
      google.inflight -= 1;
    }
  };
  const cal = (id: string) => {
    const c = google.calendars.get(id);
    if (!c || c.account !== account()) throw gErr(404, 'notFound');
    return c;
  };
  const ev = (c: GCal, id: string) => {
    const e = c.events.get(id.split('_')[0]);
    if (!e) throw gErr(404, 'notFound');
    if (e.status === 'cancelled') throw gErr(410, 'deleted');
    return e;
  };
  const listed = (c: GCal): Row[] => [...c.events.values()].filter((e) => e.status !== 'cancelled').flatMap((e) => [
    { ...e, exceptions: undefined },
    ...[...e.exceptions.entries()].map(([stamp, p]) => ({ id: `${e.id}_${stamp}`, recurringEventId: e.id, ...p, extendedProperties: e.extendedProperties })),
  ]);
  const api = {
    calendarList: {
      list: (a: Row) => op('calendarList.list', a, () => ({ items: [...google.calendars.values()].filter((c) => c.account === account()).map((c) => ({ id: c.id, summary: c.summary, description: c.description, accessRole: 'owner' })) })),
      // Production (2026-10-21): Google refuses a calendarList write for this grant (calendar.readonly +
      // calendar.events + calendar.app.created) with 401 authError, though the same token just listed.
      patch: (a: Row) => op('calendarList.patch', a, () => { throw prodRefusal('PATCH', `users/me/calendarList/${encodeURIComponent(String(a.calendarId))}`); }),
    },
    calendars: {
      insert: async (a: Row) => {
        google.inserting += 1;
        google.maxInserting = Math.max(google.maxInserting, google.inserting);
        try {
          return await op('calendars.insert', a, () => {
            const id = `gcal-${++google.seq}@group.calendar.google.com`;
            google.calendars.set(id, { id, account: account(), summary: a.requestBody.summary, description: a.requestBody.description ?? '', timeZone: a.requestBody.timeZone, events: new Map() });
            return { id };
          });
        } finally {
          google.inserting -= 1;
        }
      },
      get: (a: Row) => op('calendars.get', a, () => { const c = cal(a.calendarId); return { id: c.id, summary: c.summary, description: c.description }; }),
      patch: (a: Row) => op('calendars.patch', a, () => { const c = cal(a.calendarId); Object.assign(c, a.requestBody); return { id: c.id }; }),
      delete: (a: Row) => op('calendars.delete', a, () => { cal(a.calendarId); google.calendars.delete(a.calendarId); return {}; }),
    },
    events: {
      insert: (a: Row) => op('events.insert', a, () => {
        const c = cal(a.calendarId);
        const id = a.requestBody.id;
        assert(typeof id === 'string' && /^[a-v0-9]{5,1024}$/.test(id), `insert id ${id}`);
        if (c.events.has(id)) throw gErr(409, 'duplicate');
        c.events.set(id, { ...structuredClone(a.requestBody), id, status: a.requestBody.status ?? 'confirmed', exceptions: new Map() });
        return { id };
      }),
      get: (a: Row) => op('events.get', a, () => {
        const c = cal(a.calendarId);
        const e = c.events.get(a.eventId);
        if (!e) throw gErr(404, 'notFound');
        // Google returns a deleted event too, as 'cancelled'.
        return { ...e, exceptions: undefined };
      }),
      update: (a: Row) => op('events.update', a, () => {
        const c = cal(a.calendarId);
        const e = c.events.get(a.eventId);
        if (!e) throw gErr(404, 'notFound');
        c.events.set(a.eventId, { ...structuredClone(a.requestBody), id: a.eventId, status: a.requestBody.status ?? 'confirmed', exceptions: e.exceptions });
        return { id: a.eventId };
      }),
      patch: (a: Row) => op('events.patch', a, () => {
        const c = cal(a.calendarId);
        const e = ev(c, a.eventId);
        const stamp = a.eventId.split('_')[1];
        e.exceptions.set(stamp, { ...(e.exceptions.get(stamp) ?? {}), ...structuredClone(a.requestBody) });
        return { id: a.eventId };
      }),
      delete: (a: Row) => op('events.delete', a, () => {
        const c = cal(a.calendarId);
        const e = c.events.get(a.eventId);
        if (!e) throw gErr(404, 'notFound');
        if (e.status === 'cancelled') throw gErr(410, 'deleted');
        e.status = 'cancelled';
        e.exceptions = new Map();
        return {};
      }),
      list: (a: Row) => op('events.list', a, () => {
        const c = cal(a.calendarId);
        const filter = (a.privateExtendedProperty ?? [])[0] as string | undefined;
        const items = listed(c).filter((e) => !filter || `famcalSync=${e.extendedProperties?.private?.famcalSync}` === filter);
        return { items };
      }),
      instances: (a: Row) => op('events.instances', a, () => {
        const c = cal(a.calendarId);
        const e = ev(c, a.eventId);
        if (!a.originalStart || google.missingInstances.has(a.originalStart)) return { items: [] };
        const allDay = /^\d{4}-\d{2}-\d{2}$/.test(a.originalStart);
        return { items: [{ id: `${e.id}_${stampOf(a.originalStart)}`, originalStartTime: allDay ? { date: a.originalStart } : { dateTime: a.originalStart } }] };
      }),
    },
  };
  return {
    api,
    account: async () => {
      google.calls.push(`account ${token}`);
      await new Promise((r) => setImmediate(r));
      const f = google.failures.find((x) => x.op === 'account' && x.left > 0 && (!x.when || x.when({})));
      if (f) {
        f.left -= 1;
        throw f.error;
      }
      return account();
    },
  };
}

const gcalls = (prefix = '') => google.calls.map((c) => c.split(' ')[0]).filter((c) => c.startsWith(prefix));

// ---- Boundaries ----

const captured: Array<{ ctx: string; message: string; level?: string; extra?: Row }> = [];
const sent: Array<{ via: string; chatId: unknown; text?: unknown; options?: Row }> = [];
const adminWarnings: string[] = [];
const planAllowed = new Map<number, boolean>();
const logs: string[] = [];
/** Every log line and Sentry capture of the whole run; seed() never clears these, so the title check sees every scenario. */
const runLogs: string[] = [];
const runCaptured: Array<{ ctx: string; message: string; level?: string; extra?: Row }> = [];

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
  stub('src/utils/prisma.ts', { prisma: fakePrisma, withRetry: nodeRequire(path.join(ROOT, 'src/utils/db-retry.ts')).withRetry });
  stub('src/utils/redis.ts', { redis: fakeRedis });
  const capture = (e: unknown, ctx: string, extra?: Row, level?: string) => {
    const c = { ctx, message: e instanceof Error ? e.message : String(e), level, extra };
    captured.push(c);
    runCaptured.push(c);
  };
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
  stub('src/utils/error-notifier.ts', {
    notifyAdminWarning: async (_ctx: string, message: string) => { adminWarnings.push(message); },
    notifyAdminError: async (_ctx: string, e: unknown) => { adminWarnings.push(`error: ${e instanceof Error ? e.message : String(e)}`); },
    notifyAdminFeedback: async () => undefined,
    getAdminUserIds: async () => [],
  });
  const tg = { sendMessage: async (chatId: unknown, text: unknown, options: Row) => { sent.push({ via: 'telegram', chatId, text, options }); return 1; } };
  const wa = { sendMessage: async (chatId: unknown, text: unknown, options: Row) => { sent.push({ via: 'whatsapp', chatId, text, options }); return 1; } };
  stub('src/services/telegram/index.ts', { getMessagingService: () => tg, getBot: () => tg, initBot: () => tg });
  stub('src/services/messaging/factory.ts', { getMessagingService: () => tg, getWhatsAppService: () => wa, getTelegramService: () => tg });
  stub('src/lib/timezone.ts', { resolveUserTimezone: async () => 'Asia/Jerusalem' });
  stub('src/services/subscription-service.ts', {
    peekFeatureAccess: async (userId: number, feature: string) => {
      assert(feature === 'google_sync', `plan check for ${feature}`);
      return planAllowed.get(userId) === false ? { allowed: false, reason: 'upgrade_required' } : { allowed: true };
    },
    checkFeatureAccess: async () => { throw new Error('the worker must not log feature_blocked'); },
    invalidateFeatureAccessCache: async () => undefined,
  });
  stub('src/services/analytics-service.ts', { trackActivity: async () => undefined, trackActivityAsync: () => undefined });
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`network blocked in smoke: ${String(input)}`);
  }) as typeof fetch;
}

// ---- Fixtures ----

const IL = 'Asia/Jerusalem';
const at = (local: string, tz = IL) => fromZonedTime(`${local}:00`, tz);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = new Date('2026-10-20T08:00:00Z');
const TAL = 1;
const NOA = 2;
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.app.created'];
const ACCOUNT = 'tal@example.com';
const TITLES = ['Dentist at noon', 'Weekly swim', 'Grandma birthday', 'Secret party'];

function userRow(id: number, o: Row = {}): Row {
  return {
    id, name: `U${id}`, language: 'en', location: 'Tel Aviv', telegramId: BigInt(1000 + id), whatsappPhone: null, whatsappBsuid: null,
    suspendedAt: null, unreachableSince: null, googleRefreshToken: `tok-${id}`, googleScopes: SCOPES, googleSyncNotifiedAt: null, ...o,
  };
}
function calendarRow(id: string, ownerUserId: number, name: string, o: Row = {}): Row {
  return { ...DEFAULTS.nativeCalendar(), id, ownerUserId, name, createdAt: NOW, updatedAt: NOW, ...o };
}
function linkRow(id: string, userId: number, nativeCalendarId: string, o: Row = {}): Row {
  return { ...DEFAULTS.googleSyncLink(), id, userId, nativeCalendarId, state: 'ok', googleAccount: ACCOUNT, backfilledAt: NOW, createdAt: NOW, updatedAt: NOW, ...o };
}
function seriesRow(id: string, calendarId: string, o: Row = {}): Row {
  const startsAt = o.startsAt ?? at('2026-11-02 10:00');
  const row: Row = { ...DEFAULTS.nativeEvent(), id, calendarId, creatorUserId: TAL, title: TITLES[0], timeZone: IL, startsAt, endsAt: new Date(startsAt.getTime() + HOUR), createdAt: NOW, updatedAt: NOW, ...o };
  table('nativeEvent').push(row);
  return row;
}
function itemRow(linkId: string, nativeEventId: string, o: Row = {}): Row {
  const row = { ...DEFAULTS.googleSyncItem(), id: `item-${nativeEventId}`, linkId, nativeEventId, dirtySeq: 1, ...o };
  table('googleSyncItem').push(row);
  return row;
}
function override(seriesEventId: string, originalStartsAt: Date, o: Row = {}): Row {
  const row = { ...DEFAULTS.nativeEventInstance(), id: `inst-${++seq}`, seriesEventId, originalStartsAt, status: 'OVERRIDE', createdAt: NOW, updatedAt: NOW, ...o };
  table('nativeEventInstance').push(row);
  return row;
}
/** Tal's calendar in Google, holding the token of `linkId`. */
function googleCalendar(id: string, linkId: string | null, o: Partial<GCal> = {}): GCal {
  const c: GCal = { id, account: ACCOUNT, summary: 'FamCal · Home', description: `Managed.\n\n${linkId ? `[famcal:${linkId}]` : ''}`, events: new Map(), ...o };
  google.calendars.set(id, c);
  return c;
}

function seed() {
  DB = {};
  seq = 0;
  calls = [];
  beforePrismaCall = null;
  captured.length = 0;
  sent.length = 0;
  adminWarnings.length = 0;
  planAllowed.clear();
  redisStore.clear();
  redisLog.length = 0;
  redisFail = null;
  logs.length = 0;
  Object.assign(google, { calendars: new Map(), accounts: new Map([['tok-1', ACCOUNT]]), calls: [], failures: [], missingInstances: new Set(), inflight: 0, maxInflight: 0, inserting: 0, maxInserting: 0, during: null, seq: 0, clients: 0 });
  DB.user = [userRow(TAL), userRow(NOA)];
  DB.nativeCalendar = [calendarRow('home', TAL, 'Home'), calendarRow('work', TAL, 'Work'), calendarRow('noa', NOA, 'Noa')];
  DB.nativeEvent = [];
  DB.nativeEventInstance = [];
  DB.googleSyncLink = [];
  DB.googleSyncItem = [];
}

/** The usual start: Tal's "Home" copied, its Google calendar there and backfilled. */
function seedCopy(o: Row = {}) {
  seed();
  googleCalendar('g-home', 'L');
  DB.googleSyncLink.push(linkRow('L', TAL, 'home', { googleCalendarId: 'g-home', pushedName: 'Home', ...o }));
}

const item = (id: string) => table('googleSyncItem').find((r) => r.nativeEventId === id);
const link = (id: string) => table('googleSyncLink').find((r) => r.id === id)!;
const gEvents = (calId = 'g-home') => [...(google.calendars.get(calId)?.events.values() ?? [])];
const liveEvents = (calId = 'g-home') => gEvents(calId).filter((e) => e.status !== 'cancelled');

const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

async function main() {
  installStubs();
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  const keep = (...a: unknown[]) => {
    const line = a.map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : show(x))).join(' ');
    logs.push(line);
    runLogs.push(line);
  };
  console.log = keep;
  console.warn = keep;
  console.error = keep;

  const worker = await load('src/services/google-sync/worker.ts');
  const push = await load('src/services/google-sync/push.ts');
  const links = await load('src/services/google-sync/links.ts');
  const gate = await load('src/services/google-sync/gate.ts');
  const handlers = await load('src/cron/handlers.ts');
  const client = await load('src/services/google-sync/client.ts');
  client.__useSyncGoogleForTests((token: string) => fakeGoogle(token));
  const pass = (now: Date = NOW) => {
    worker.__resetSyncWorkerForTests();
    return worker.runGoogleSyncPass(now);
  };
  const eventId = (linkId: string, seriesId: string, generation = 0) => push.syncEventId(linkId, seriesId, generation);
  const bump = (seriesId: string) => { item(seriesId)!.dirtySeq += 1; };

  // ---- Calendars ----

  await check('calendars: a new copy (creating, no Google calendar) is made "FamCal · Home" in the user\'s zone, its description in the user\'s language ending with [famcal:<linkId>], no calendarList write (Google refuses it for this grant; the copies carry no alerts themselves), then ok with its id, name and the token\'s account', async () => {
    seed();
    DB.googleSyncLink.push(linkRow('L', TAL, 'home', { state: 'creating', googleAccount: null, backfilledAt: null, dirtySeq: 1 }));
    seriesRow('one', 'home');
    await pass();
    const made = [...google.calendars.values()];
    assert(made.length === 1 && gcalls('calendars.insert').length === 1, `calendars ${show(made)} calls ${show(google.calls)}`);
    const c = made[0];
    assert(c.summary === 'FamCal · Home' && c.timeZone === IL, `summary/zone ${show(c)}`);
    assert(c.description.startsWith('FamCal keeps this calendar in step with your FamCal calendar “Home”') && c.description.endsWith('\n\n[famcal:L]'), `description ${show(c.description)}`);
    assert(gcalls('calendarList.patch').length === 0, `a calendarList write: ${show(google.calls)}`);
    const l = link('L');
    assert(l.state === 'ok' && l.googleCalendarId === c.id && l.pushedName === 'Home' && l.googleAccount === ACCOUNT && l.pushedSeq === 1, `link ${show(l)}`);
    assert(liveEvents(c.id).length === 1, `events ${show(gEvents(c.id))}`);
  });

  await check('calendars: a Hebrew name is bidi-isolated (FSI…PDI) and in the user\'s language; a name the user already has gets " (2)"', async () => {
    seed();
    DB.nativeCalendar.find((c) => c.id === 'home')!.name = 'בית';
    DB.user[0].language = 'he';
    DB.googleSyncLink.push(linkRow('L', TAL, 'home', { state: 'creating', backfilledAt: null }));
    await pass();
    const c = [...google.calendars.values()][0];
    assert(c?.summary === 'FamCal · ⁨בית⁩' && c.description.includes('FamCal מעדכן את היומן הזה') && c.description.endsWith('[famcal:L]'), `he ${show(c)}`);
    seed();
    googleCalendar('mine', null, { summary: 'FamCal · Home', description: 'my own' });
    DB.googleSyncLink.push(linkRow('L', TAL, 'home', { state: 'creating', backfilledAt: null }));
    await pass();
    const made = [...google.calendars.values()].filter((x) => x.id !== 'mine');
    assert(made.length === 1 && made[0].summary === 'FamCal · Home (2)', `clash ${show(made)}`);
  });

  await check('calendars: a retry while creating finds the calendar by its token in the calendar list and adopts it: no second calendar', async () => {
    seed();
    googleCalendar('g-lost', 'L');
    DB.googleSyncLink.push(linkRow('L', TAL, 'home', { state: 'creating', backfilledAt: null }));
    await pass();
    assert(gcalls('calendars.insert').length === 0 && google.calendars.size === 1, `calls ${show(google.calls)}`);
    assert(link('L').googleCalendarId === 'g-lost' && link('L').state === 'ok', `link ${show(link('L'))}`);
    assert(gcalls('calendarList.patch').length === 0, `a calendarList write on the adopted one: ${show(google.calls)}`);
  });

  await check('calendars: a FamCal rename patches the Google name and description; an unchanged copy makes no calendar call', async () => {
    seedCopy({ pushedName: 'Old', dirtySeq: 3, pushedSeq: 2 });
    await pass();
    const c = google.calendars.get('g-home')!;
    assert(c.summary === 'FamCal · Home' && c.description.includes('“Home”') && c.description.endsWith('[famcal:L]'), `calendar ${show(c)}`);
    assert(link('L').pushedName === 'Home' && link('L').pushedSeq === 3, `link ${show(link('L'))}`);
    google.calls = [];
    await pass();
    assert(google.calls.length === 0, `an unchanged copy called Google: ${show(google.calls)}`);
  });

  /** A turned-off copy, its Remove or Keep queued (enabled false, dirtySeq past pushedSeq). */
  const seedTurnOff = (choice: 'remove' | 'keep', o: Row = {}) => {
    seedCopy({ enabled: false, unlinkChoice: choice, dirtySeq: 2, pushedSeq: 1, ...o });
    const c = google.calendars.get('g-home')!;
    c.events.set('evl', { id: 'evl', status: 'confirmed', summary: TITLES[1], extendedProperties: { private: { famcalSync: 'L', famcalSeries: 'wk' } }, exceptions: new Map([['20261012T070000Z', { summary: 'moved' }]]) });
    itemRow('L', 'wk', { googleEventId: 'evl', dirtySeq: 1, pushedSeq: 1 });
    return c;
  };

  await check('Remove: a calendar holding only FamCal\'s marked events (and their occurrences) is deleted; the link keeps its row with no Google calendar, its items go, and it is clean', async () => {
    seedTurnOff('remove');
    await pass();
    assert(!google.calendars.has('g-home') && gcalls('calendars.delete').length === 1, `calls ${show(google.calls)}`);
    const l = link('L');
    assert(l.googleCalendarId === null && l.pushedSeq === 2 && l.enabled === false && table('googleSyncItem').length === 0, `link ${show(l)} items ${show(DB.googleSyncItem)}`);
  });

  await check('Remove: when the user added their own events, only the events marked famcalSync=<linkId> are deleted and the calendar stays', async () => {
    const c = seedTurnOff('remove');
    c.events.set('mine', { id: 'mine', status: 'confirmed', summary: 'my own', exceptions: new Map() });
    c.events.set('other', { id: 'other', status: 'confirmed', extendedProperties: { private: { famcalSync: 'L-OTHER' } }, exceptions: new Map() });
    await pass();
    assert(google.calendars.has('g-home') && gcalls('calendars.delete').length === 0, `calendar deleted ${show(google.calls)}`);
    assert(c.events.get('evl')!.status === 'cancelled' && c.events.get('mine')!.status === 'confirmed' && c.events.get('other')!.status === 'confirmed', `events ${show([...c.events.values()])}`);
    assert(link('L').googleCalendarId === 'g-home' && link('L').pushedSeq === 2, `link ${show(link('L'))}`);
    // The calendar keeps the deleted event's id: the item keeps its row, its generation moved past it.
    const it = item('wk');
    assert(it && it.googleEventId === null && it.generation === 1 && it.masterHash === null && show(it.slotHashes) === '{}', `item ${show(DB.googleSyncItem)}`);
  });

  await check('Remove that leaves the calendar (the user\'s own events in it), then copying on again: every series goes in under the next generation\'s id, never the deleted master\'s (no 409, no revived event)', async () => {
    seedCopy();
    seriesRow('wk', 'home', { title: TITLES[1], startsAt: at('2026-10-05 10:00'), rrule: 'FREQ=WEEKLY' });
    override('wk', at('2026-10-12 10:00'), { title: 'Swim, pool B' });
    itemRow('L', 'wk');
    await pass();
    const c = google.calendars.get('g-home')!;
    const first = eventId('L', 'wk', 0);
    assert(c.events.get(first)?.status === 'confirmed' && c.events.get(first)!.exceptions.size === 1, `copied ${show(gEvents())}`);
    c.events.set('mine', { id: 'mine', status: 'confirmed', summary: 'my own', exceptions: new Map() });
    Object.assign(link('L'), { enabled: false, unlinkChoice: 'remove', dirtySeq: link('L').dirtySeq + 1 });
    await pass();
    assert(c.events.get(first)!.status === 'cancelled' && google.calendars.has('g-home'), `emptied ${show(gEvents())}`);
    assert((await links.enableSyncLink(TAL, { nativeCalendarId: 'home', googleAccount: ACCOUNT }, SCOPES)).status === 'reenabled', 'not re-enabled');
    google.calls = [];
    await pass();
    const next = eventId('L', 'wk', 1);
    assert(next !== first && c.events.get(next)?.status === 'confirmed' && c.events.get(next)!.exceptions.size === 1 && item('wk')!.googleEventId === next, `re-enabled ${show(gEvents())} ${show(item('wk'))}`);
    assert(c.events.get(first)!.status === 'cancelled' && gcalls('events.insert').length === 1 && gcalls('events.get').length === 0 && gcalls('events.update').length === 0, `calls ${show(google.calls)}`);
  });

  await check('Remove safety: a calendar under the link\'s id whose description lacks the link\'s token is never touched (state error, Sentry)', async () => {
    const c = seedTurnOff('remove');
    c.description = 'somebody else\'s calendar';
    await pass();
    assert(gcalls('calendars.delete').length === 0 && gcalls('events.delete').length === 0 && gcalls('calendars.patch').length === 0, `calls ${show(google.calls)}`);
    assert(link('L').state === 'error' && link('L').lastError === 'not_our_calendar' && captured.some((x) => x.ctx === 'google-sync-turn-off' && x.level === 'error'), `link ${show(link('L'))} captured ${show(captured)}`);
  });

  await check('Keep: the description says FamCal no longer updates it (the token kept); the calendar and its events stay', async () => {
    const c = seedTurnOff('keep');
    await pass();
    assert(c.description === "FamCal no longer updates this calendar. It's yours to keep, change or delete.\n\n[famcal:L]", `description ${show(c.description)}`);
    assert(google.calendars.has('g-home') && c.events.get('evl')!.status === 'confirmed' && gcalls('calendars.delete').length === 0, `calls ${show(google.calls)}`);
    assert(link('L').pushedSeq === 2 && table('googleSyncItem').length === 1, `link ${show(link('L'))}`);
  });

  await check('a queued turn-off with link.unlinkToken (a merged-away account) is carried out with that token in its account, then the token is cleared', async () => {
    const c = seedTurnOff('remove', { unlinkToken: 'tok-w', googleAccount: 'w@example.com' });
    c.account = 'w@example.com';
    google.accounts.set('tok-w', 'w@example.com');
    await pass();
    assert(!google.calendars.has('g-home'), `not removed: ${show(google.calls)}`);
    assert(google.calls.every((x) => x.endsWith(' tok-w')), `calls with another token ${show(google.calls)}`);
    assert(link('L').unlinkToken === null && link('L').pushedSeq === 2, `link ${show(link('L'))}`);
  });

  await check('a queued Remove whose token is another Google account\'s is not carried out (otherAccount)', async () => {
    seedTurnOff('remove', { googleAccount: 'someone@else' });
    await pass();
    assert(google.calendars.has('g-home') && !google.calls.some((x) => /^(calendars|events)\./.test(x)), `calls ${show(google.calls)}`);
    assert(link('L').state === 'otherAccount' && link('L').pushedSeq === 1, `link ${show(link('L'))}`);
  });

  await check('re-enable: the same Google calendar is reused (no insert), its description managed again, every item whose hashes were cleared is replaced whole (delete, next generation), and the calendar is backfilled', async () => {
    seedCopy({ dirtySeq: 2, pushedSeq: 1, backfilledAt: null });
    const c = google.calendars.get('g-home')!;
    c.description = 'kept\n\n[famcal:L]';
    seriesRow('one', 'home');
    const old = eventId('L', 'one', 0);
    c.events.set(old, { id: old, status: 'confirmed', exceptions: new Map() });
    itemRow('L', 'one', { googleEventId: old, dirtySeq: 2, pushedSeq: 1, masterHash: null, slotHashes: {} });
    seriesRow('two', 'home', { title: TITLES[3] });
    await pass();
    assert(gcalls('calendars.insert').length === 0 && c.description.includes('FamCal keeps this calendar'), `calls ${show(google.calls)} ${show(c.description)}`);
    assert(c.events.get(old)!.status === 'cancelled' && c.events.get(eventId('L', 'one', 1))?.status === 'confirmed' && item('one')!.generation === 1, `events ${show(gEvents())}`);
    assert(link('L').backfilledAt?.getTime() === NOW.getTime() && item('two')?.pushedSeq === item('two')?.dirtySeq && c.events.has(eventId('L', 'two', 0)), `backfill ${show(DB.googleSyncItem)}`);
  });

  await check('recreate ("Create it again"): a gone copy forgets its Google calendar, account, events and hashes, goes creating with every item dirty; the next pass makes a new calendar and copies everything; a copy that isn\'t gone is refused', async () => {
    seedCopy({ state: 'gone', googleCalendarId: 'g-lost' });
    google.calendars.delete('g-home');
    seriesRow('one', 'home');
    itemRow('L', 'one', { googleEventId: 'x0000', masterHash: 'a:b', dirtySeq: 1, pushedSeq: 1, generation: 2 });
    assert((await links.recreateSyncLink(NOA, 'L')) === false, 'another user recreated it');
    assert((await links.recreateSyncLink(TAL, 'L')) === true, 'refused');
    const l = link('L');
    assert(l.state === 'creating' && l.googleCalendarId === null && l.googleAccount === null && l.backfilledAt === null, `link ${show(l)}`);
    assert(item('one')!.googleEventId === null && item('one')!.masterHash === null && item('one')!.dirtySeq === 2, `item ${show(item('one'))}`);
    await pass();
    const c = [...google.calendars.values()][0];
    assert(c && link('L').googleCalendarId === c.id && link('L').state === 'ok' && liveEvents(c.id).length === 1, `after ${show(link('L'))} ${show(google.calls)}`);
    assert((await links.recreateSyncLink(TAL, 'L')) === false, 'an ok copy was recreated');
  });

  // ---- Push ----

  await check('push: a new one-off is inserted under base32hex(sha256(linkId:seriesId:generation)) (52 chars of a–v, 0–9), with no alerts, the sync markers (not the move\'s), and the item clean', async () => {
    seedCopy();
    seriesRow('one', 'home', { description: 'notes', location: 'clinic' });
    itemRow('L', 'one');
    await pass();
    const id = eventId('L', 'one', 0);
    assert(/^[a-v0-9]{52}$/.test(id) && id !== eventId('L', 'one', 1) && id !== eventId('L2', 'one', 0), `id ${id}`);
    const e = google.calendars.get('g-home')!.events.get(id);
    assert(e && e.summary === TITLES[0] && e.description === 'notes' && e.location === 'clinic', `event ${show(e)}`);
    assert(show(e.reminders) === show({ useDefault: false, overrides: [] }), `reminders ${show(e.reminders)}`);
    assert(show(e.extendedProperties) === show({ private: { famcalSync: 'L', famcalSeries: 'one' } }), `markers ${show(e.extendedProperties)}`);
    const it = item('one')!;
    assert(it.googleEventId === id && it.pushedSeq === 1 && it.status === 'ok' && /^.+:.+$/.test(it.masterHash), `item ${show(it)}`);
    google.calls = [];
    await pass();
    assert(google.calls.length === 0, `a clean copy called Google ${show(google.calls)}`);
  });

  await check('push: a 409 on insert (a retry after a timeout) adopts the event and writes it whole: one event, never two', async () => {
    seedCopy();
    seriesRow('one', 'home');
    itemRow('L', 'one');
    const id = eventId('L', 'one', 0);
    google.calendars.get('g-home')!.events.set(id, { id, status: 'confirmed', summary: 'stale', exceptions: new Map() });
    await pass();
    assert(gcalls('events.insert').length === 1 && gcalls('events.get').length === 1 && gcalls('events.update').length === 1, `calls ${show(google.calls)}`);
    const e = google.calendars.get('g-home')!.events.get(id)!;
    assert(gEvents().length === 1 && e.summary === TITLES[0] && e.status === 'confirmed' && item('one')!.googleEventId === id, `events ${show(gEvents())}`);
  });

  await check('push: a 409 whose event is a deleted one (a series that left the copy and came back, its row and generation gone) goes in under the next generation; the deleted event is never revived', async () => {
    seedCopy();
    seriesRow('wk', 'home', { title: TITLES[1], startsAt: at('2026-10-05 10:00'), rrule: 'FREQ=WEEKLY' });
    itemRow('L', 'wk');
    await pass();
    const c = google.calendars.get('g-home')!;
    const first = eventId('L', 'wk', 0);
    const series = DB.nativeEvent.find((x) => x.id === 'wk')!;
    series.calendarId = 'work';
    bump('wk');
    await pass();
    assert(c.events.get(first)?.status === 'cancelled' && !item('wk'), `moved out ${show(gEvents())} ${show(DB.googleSyncItem)}`);
    series.calendarId = 'home';
    itemRow('L', 'wk');
    google.calls = [];
    await pass();
    const next = eventId('L', 'wk', 1);
    assert(c.events.get(first)!.status === 'cancelled' && c.events.get(next)?.status === 'confirmed' && item('wk')!.googleEventId === next && item('wk')!.generation === 1, `back ${show(gEvents())} ${show(item('wk'))}`);
    assert(gcalls('events.update').length === 0 && show(gcalls('events.')) === show(['events.insert', 'events.get', 'events.insert']), `calls ${show(google.calls)}`);
  });

  /** A weekly series with one override, copied once. */
  const seedWeekly = async () => {
    seedCopy();
    seriesRow('wk', 'home', { title: TITLES[1], startsAt: at('2026-10-05 10:00'), rrule: 'FREQ=WEEKLY' });
    override('wk', at('2026-10-12 10:00'), { title: 'Swim, pool B' });
    itemRow('L', 'wk');
    await pass();
    google.calls = [];
    return google.calendars.get('g-home')!.events.get(eventId('L', 'wk', 0))!;
  };

  await check('push: a series is inserted with its rule and its override patched on its instance (found by originalStart), the patch carrying the whole occurrence', async () => {
    const e = await seedWeekly();
    assert(e && show(e.recurrence) === show(['RRULE:FREQ=WEEKLY']), `master ${show(e)}`);
    const stamp = stampOf(at('2026-10-12 10:00').toISOString());
    const x = e.exceptions.get(stamp);
    assert(x && x.summary === 'Swim, pool B' && x.description === '' && x.location === '' && x.start?.dateTime === at('2026-10-12 10:00').toISOString() && show(x.reminders) === show({ useDefault: false, overrides: [] }), `exception ${show(x)}`);
  });

  await check('push: a master change writes the master whole (events.update) and replays every instance patch; no delete', async () => {
    const e0 = await seedWeekly();
    assert(e0, 'not copied');
    DB.nativeEvent.find((s) => s.id === 'wk')!.location = 'pool';
    bump('wk');
    await pass();
    assert(show(gcalls('events.')) === show(['events.update', 'events.instances', 'events.patch']), `calls ${show(google.calls)}`);
    const e = google.calendars.get('g-home')!.events.get(eventId('L', 'wk', 0))!;
    assert(e.location === 'pool' && e.exceptions.size === 1, `master ${show(e)}`);
  });

  await check('push: an override-only change patches just that slot', async () => {
    await seedWeekly();
    override('wk', at('2026-10-19 10:00'), { location: 'lake' });
    bump('wk');
    await pass();
    assert(show(gcalls('events.')) === show(['events.instances', 'events.patch']), `calls ${show(google.calls)}`);
    const e = google.calendars.get('g-home')!.events.get(eventId('L', 'wk', 0))!;
    assert(e.exceptions.get(stampOf(at('2026-10-19 10:00').toISOString()))?.location === 'lake', `exceptions ${show(e.exceptions)}`);
  });

  await check('push: an exdate added is a master write (EXDATE line), not a rebuild', async () => {
    await seedWeekly();
    DB.nativeEvent.find((s) => s.id === 'wk')!.exdates = [at('2026-10-26 10:00')];
    bump('wk');
    await pass();
    assert(gcalls('events.delete').length === 0 && gcalls('events.update').length === 1, `calls ${show(google.calls)}`);
    const e = google.calendars.get('g-home')!.events.get(eventId('L', 'wk', 0))!;
    assert(e.recurrence[1] === 'EXDATE;TZID=Asia/Jerusalem:20261026T100000', `recurrence ${show(e.recurrence)}`);
  });

  for (const [what, change] of [
    ['a rule change', () => { DB.nativeEvent.find((s) => s.id === 'wk')!.rrule = 'FREQ=DAILY'; }],
    // As the store's 'all' retime does, the override's slot moves with the series.
    ['a start change', () => { const s = DB.nativeEvent.find((x) => x.id === 'wk')!; s.startsAt = at('2026-10-05 11:00'); s.endsAt = at('2026-10-05 12:00'); DB.nativeEventInstance[0].originalStartsAt = at('2026-10-12 11:00'); }],
    ['a removed override', () => { DB.nativeEventInstance = []; }],
    ['an exdate removed', () => { DB.nativeEvent.find((s) => s.id === 'wk')!.exdates = []; }],
    ['an overridden slot cancelled', () => { DB.nativeEventInstance[0].status = 'CANCELLED'; }],
    ['a series becoming a one-off', () => { DB.nativeEvent.find((s) => s.id === 'wk')!.rrule = null; }],
  ] as Array<[string, () => void]>) {
    await check(`push: ${what} is structural: the master is deleted and inserted again with the next generation`, async () => {
      await seedWeekly();
      if (what === 'an exdate removed') {
        DB.nativeEvent.find((s) => s.id === 'wk')!.exdates = [at('2026-10-26 10:00')];
        bump('wk');
        await pass();
        google.calls = [];
      }
      change();
      bump('wk');
      await pass();
      const c = google.calendars.get('g-home')!;
      assert(c.events.get(eventId('L', 'wk', 0))!.status === 'cancelled' && c.events.get(eventId('L', 'wk', 1))?.status === 'confirmed', `events ${show(gEvents())} calls ${show(google.calls)}`);
      assert(item('wk')!.generation === 1 && item('wk')!.googleEventId === eventId('L', 'wk', 1) && item('wk')!.pushedSeq === item('wk')!.dirtySeq, `item ${show(item('wk'))}`);
    });
  }

  await check('push: a deleted series is deleted in Google (a 404 counting as done) and its item dropped; one never inserted is just dropped', async () => {
    seedCopy();
    seriesRow('one', 'home', { isDeleted: true });
    itemRow('L', 'one', { googleEventId: 'gone0', dirtySeq: 2, pushedSeq: 1 });
    seriesRow('two', 'home', { isDeleted: true });
    itemRow('L', 'two');
    await pass();
    assert(show(gcalls('events.')) === show(['events.delete']) && !item('one') && !item('two'), `calls ${show(google.calls)} items ${show(DB.googleSyncItem)}`);
  });

  await check('push: a series now a reminder, moved to an uncopied calendar, or missing is removed from the copy', async () => {
    seedCopy();
    const c = google.calendars.get('g-home')!;
    for (const id of ['rem', 'moved', 'missing']) c.events.set(`e${id}0`, { id: `e${id}0`, status: 'confirmed', exceptions: new Map() });
    seriesRow('rem', 'home', { kind: 'REMINDER' });
    seriesRow('moved', 'work');
    itemRow('L', 'rem', { googleEventId: 'erem0', dirtySeq: 2, pushedSeq: 1 });
    itemRow('L', 'moved', { googleEventId: 'emoved0', dirtySeq: 2, pushedSeq: 1 });
    itemRow('L', 'missing', { googleEventId: 'emissing0', dirtySeq: 2, pushedSeq: 1 });
    await pass();
    assert(liveEvents().length === 0 && table('googleSyncItem').length === 0, `events ${show(liveEvents())} items ${show(DB.googleSyncItem)}`);
  });

  await check('push: the owner is re-checked: a copy link on a calendar its user doesn\'t own is never pushed, and an item whose series moved to such a calendar is removed', async () => {
    seed();
    googleCalendar('g-noa', 'LN');
    DB.googleSyncLink.push(linkRow('LN', TAL, 'noa', { googleCalendarId: 'g-noa', pushedName: 'Noa' }));
    seriesRow('noa-ev', 'noa', { creatorUserId: NOA });
    itemRow('LN', 'noa-ev');
    await pass();
    assert(!google.calls.some((x) => x.startsWith('events.')) && item('noa-ev')!.pushedSeq === 0, `calls ${show(google.calls)}`);
    // The owner calendar changed hands under a copy (no route does this): push's own check removes.
    seedCopy();
    seriesRow('one', 'home');
    itemRow('L', 'one', { googleEventId: 'eone0', dirtySeq: 2, pushedSeq: 1 });
    google.calendars.get('g-home')!.events.set('eone0', { id: 'eone0', status: 'confirmed', exceptions: new Map() });
    const pushLink = { id: 'L', userId: TAL, nativeCalendarId: 'home', googleCalendarId: 'g-home' };
    DB.nativeCalendar.find((c) => c.id === 'home')!.ownerUserId = NOA;
    const outcome = await push.pushItem(fakeGoogle('tok-1'), { left: 10 }, pushLink, item('one'), NOW);
    assert(outcome === 'removed' && liveEvents().length === 0, `outcome ${outcome}`);
  });

  await check('push: a one-off that ended over 30 days ago and was never copied is dropped without a Google call', async () => {
    seedCopy();
    seriesRow('old', 'home', { startsAt: new Date(NOW.getTime() - 40 * DAY), endsAt: new Date(NOW.getTime() - 40 * DAY + HOUR) });
    itemRow('L', 'old');
    await pass();
    assert(!google.calls.some((x) => x.startsWith('events.')) && !item('old'), `calls ${show(google.calls)}`);
  });

  await check('push: a FamCal write that lands during the push leaves the item dirty (pushedSeq is the seq the push read), and the next pass pushes it', async () => {
    seedCopy();
    seriesRow('one', 'home');
    itemRow('L', 'one');
    google.during = (op) => { if (op === 'events.insert') { const s = DB.nativeEvent[0]; s.title = TITLES[2]; item('one')!.dirtySeq += 1; } };
    await pass();
    google.during = null;
    assert(item('one')!.pushedSeq === 1 && item('one')!.dirtySeq === 2, `item ${show(item('one'))}`);
    await pass();
    const e = google.calendars.get('g-home')!.events.get(eventId('L', 'one', 0))!;
    assert(item('one')!.pushedSeq === 2 && e.summary === TITLES[2], `after ${show(item('one'))} ${show(e)}`);
  });

  await check('unsupported: a series the mapper can\'t express is marked once (logged once), its Google copy deleted, never retried; a FamCal change retries it with attempts reset', async () => {
    seedCopy();
    seriesRow('bad', 'home', { startsAt: at('2026-11-01 10:00'), rrule: 'FREQ=WEEKLY;BYDAY=MO' }); // a Sunday start, a Monday rule
    itemRow('L', 'bad', { googleEventId: 'ebad0', attempts: 4 });
    google.calendars.get('g-home')!.events.set('ebad0', { id: 'ebad0', status: 'confirmed', exceptions: new Map() });
    await pass();
    assert(item('bad')!.status === 'unsupported' && item('bad')!.lastError === 'repeat' && item('bad')!.pushedSeq === 1 && item('bad')!.googleEventId === null, `item ${show(item('bad'))}`);
    assert(gcalls('events.insert').length === 0 && liveEvents().length === 0, `calls ${show(google.calls)}`);
    assert(logs.filter((l) => l.includes("can't be copied")).length === 1, `logs ${show(logs.filter((l) => l.includes('bad')))}`);
    google.calls = [];
    await pass();
    assert(google.calls.length === 0, `retried without a change ${show(google.calls)}`);
    const s = DB.nativeEvent.find((x) => x.id === 'bad')!;
    s.startsAt = at('2026-11-02 10:00');
    s.endsAt = at('2026-11-02 11:00');
    bump('bad');
    await pass();
    assert(item('bad')!.status === 'ok' && item('bad')!.attempts === 0 && liveEvents().length === 1, `retry ${show(item('bad'))}`);
  });

  await check('unsupported: a series the mapper throws on (a code bug, not a refusal) is marked unreadable and sent to Sentry as an error with ids only; a mapper refusal sends nothing', async () => {
    seedCopy();
    seriesRow('boom', 'home', { startsAt: new Date(NaN) });
    itemRow('L', 'boom', { googleEventId: 'eboom0' });
    google.calendars.get('g-home')!.events.set('eboom0', { id: 'eboom0', status: 'confirmed', exceptions: new Map() });
    seriesRow('bad', 'home', { startsAt: at('2026-11-01 10:00'), rrule: 'FREQ=WEEKLY;BYDAY=MO' });
    itemRow('L', 'bad');
    await pass();
    assert(item('boom')!.status === 'unsupported' && item('boom')!.lastError === 'unreadable: RangeError' && liveEvents().length === 0, `item ${show(item('boom'))}`);
    assert(item('bad')!.status === 'unsupported' && item('bad')!.lastError === 'repeat', `refusal ${show(item('bad'))}`);
    const build = captured.filter((x) => x.ctx === 'google-sync-build');
    assert(build.length === 1 && build[0].level === 'error' && build[0].extra?.link_id === 'L' && build[0].extra?.series_id === 'boom' && build[0].extra?.item_id === 'item-boom' && build[0].extra?.user_id === TAL, `captured ${show(captured)}`);
  });

  await check('unsupported: an override on a slot Google won\'t yield (events.instances finds nothing) is unsupported, and the part-made copy is deleted', async () => {
    seedCopy();
    seriesRow('wk', 'home', { startsAt: at('2026-10-05 10:00'), rrule: 'FREQ=WEEKLY' });
    override('wk', at('2026-10-12 10:00'), { title: 'x' });
    itemRow('L', 'wk');
    google.missingInstances.add(at('2026-10-12 10:00').toISOString());
    await pass();
    assert(item('wk')!.status === 'unsupported' && liveEvents().length === 0, `item ${show(item('wk'))} events ${show(gEvents())}`);
  });

  await check('Hebrew: a Hebrew-date series is copied as its first date in the current Hebrew year plus RDATE lines through 10 years ahead, all day as VALUE=DATE; the horizon is kept while 2+ years remain and moves on below that', async () => {
    seedCopy();
    const anchor = at('2020-03-10 00:00');
    seriesRow('heb', 'home', { title: TITLES[2], allDay: true, startsAt: anchor, endsAt: at('2020-03-10 23:59'), rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary', hebrewAnchor: '2020-03-10' });
    itemRow('L', 'heb');
    await pass();
    const e = google.calendars.get('g-home')!.events.get(eventId('L', 'heb', 0))!;
    assert(e && e.recurrence[0] === 'RRULE:FREQ=YEARLY;COUNT=1' && /^RDATE;VALUE=DATE:(\d{8},){9}\d{8}$/.test(e.recurrence[1]), `recurrence ${show(e?.recurrence)}`);
    assert(e.start.date >= '2026-09-12' && e.start.date < '2027-10-02', `start ${show(e.start)} (Hebrew year 5787)`);
    assert(item('heb')!.slotHashes['~hebrewFrom'] === '5787', `horizon ${show(item('heb')!.slotHashes)}`);
    // A year on: still listed from 5787 (9 years ahead remain): nothing changes in Google.
    google.calls = [];
    bump('heb');
    await pass(new Date(NOW.getTime() + 365 * DAY));
    assert(!google.calls.some((x) => x.startsWith('events.')) && item('heb')!.slotHashes['~hebrewFrom'] === '5787', `a year on ${show(google.calls)}`);
    // Nine years on (5796: 1 year left): the daily check marks it, and it is listed from 5796 whole.
    const later = new Date(NOW.getTime() + Math.round(9.1 * 365.25 * DAY));
    await pass(later);
    const again = google.calendars.get('g-home')!.events.get(eventId('L', 'heb', 1));
    assert(again && item('heb')!.slotHashes['~hebrewFrom'] === '5796' && item('heb')!.generation === 1 && again.start.date > '2035-09-01', `refresh ${show(item('heb'))} ${show(again?.start)}`);
  });

  await check('Hebrew: a timed Hebrew series lists TZID wall times; a cancelled date is left out of the list', async () => {
    seedCopy();
    seriesRow('heb', 'home', { startsAt: at('2020-03-10 18:00'), endsAt: at('2020-03-10 19:00'), rrule: 'FREQ=YEARLY', hebrewRule: 'yahrzeit', hebrewAnchor: '2020-03-10' });
    itemRow('L', 'heb');
    await pass();
    const first = google.calendars.get('g-home')!.events.get(eventId('L', 'heb', 0))!;
    const dates = first.recurrence[1].split(':')[1].split(',');
    assert(/^RDATE;TZID=Asia\/Jerusalem:/.test(first.recurrence[1]) && dates.every((d: string) => /^\d{8}T180000$/.test(d)), `rdate ${show(first.recurrence)}`);
    const skipped = dates[2];
    const day = `${skipped.slice(0, 4)}-${skipped.slice(4, 6)}-${skipped.slice(6, 8)}`;
    DB.nativeEvent[0].exdates = [at(`${day} 18:00`)];
    bump('heb');
    await pass();
    const e = google.calendars.get('g-home')!.events.get(eventId('L', 'heb', 1))!;
    assert(e && !e.recurrence[1].includes(skipped) && e.recurrence[1].split(',').length === dates.length - 1, `after ${show(e?.recurrence)}`);
  });

  // ---- Failures ----

  await check('404 split: a write that answers 404 with calendars.get 404 too sets the link gone and writes nothing else', async () => {
    seedCopy();
    seriesRow('one', 'home');
    seriesRow('two', 'home');
    itemRow('L', 'one', { googleEventId: 'eone0', masterHash: 'a:b', dirtySeq: 2, pushedSeq: 1 });
    itemRow('L', 'two');
    google.calendars.delete('g-home');
    await pass();
    assert(link('L').state === 'gone' && gcalls('calendars.get').length === 1 && gcalls('events.insert').length <= 1, `link ${show(link('L'))} calls ${show(google.calls)}`);
    assert(item('two')!.pushedSeq === 0 && item('one')!.attempts === 0, `items ${show(DB.googleSyncItem)}`);
    google.calls = [];
    await pass();
    assert(google.calls.length === 0, `a gone copy was pushed again ${show(google.calls)}`);
  });

  await check('404 split: only the event gone (calendars.get finds the calendar): it is inserted again with the next generation in the same push', async () => {
    await seedWeekly();
    google.calendars.get('g-home')!.events.delete(eventId('L', 'wk', 0)); // deleted in Google by the user, id and all
    DB.nativeEvent.find((s) => s.id === 'wk')!.location = 'pool';
    bump('wk');
    await pass();
    assert(gcalls('calendars.get').length === 1 && item('wk')!.generation === 1 && item('wk')!.status === 'ok' && item('wk')!.lastError === null, `item ${show(item('wk'))} ${show(google.calls)}`);
    const e = google.calendars.get('g-home')!.events.get(eventId('L', 'wk', 1));
    assert(e?.location === 'pool' && e.exceptions.size === 1, `reinserted ${show(e)}`);
  });

  await check('404 split: a second 404 in a row on the same item (in the push, or since the last one) is error, retried only after a FamCal change', async () => {
    await seedWeekly();
    bump('wk');
    DB.nativeEvent.find((s) => s.id === 'wk')!.location = 'pool';
    google.calendars.get('g-home')!.events.delete(eventId('L', 'wk', 0));
    google.failures.push({ op: 'events.instances', error: gErr(404, 'notFound'), left: 1 });
    await pass();
    assert(item('wk')!.status === 'error' && item('wk')!.pushedSeq === item('wk')!.dirtySeq && item('wk')!.attempts === 0, `in one push ${show(item('wk'))} ${show(google.calls)}`);
    google.calls = [];
    await pass();
    assert(google.calls.length === 0, 'an error item was retried without a change');
    bump('wk');
    await pass();
    assert(item('wk')!.status === 'ok' && liveEvents().length === 1, `after a change ${show(item('wk'))} ${show(liveEvents().map((e) => e.id))}`);
    await seedWeekly();
    item('wk')!.lastError = push.EVENT_GONE;
    bump('wk');
    DB.nativeEvent.find((s) => s.id === 'wk')!.location = 'pool';
    google.failures.push({ op: 'events.update', error: gErr(410, 'deleted'), left: 1 });
    await pass();
    assert(item('wk')!.status === 'error', `since the last one ${show(item('wk'))}`);
  });

  await check('backoff: a transient failure counts an attempt and waits 30–60 s (exponential with jitter, capped at 6 h); the run stops there and the item waits its turn', async () => {
    assert(worker.backoffMs(1, () => 0) === 30_000 && worker.backoffMs(1, () => 1) === 60_000 && worker.backoffMs(3, () => 1) === 240_000 && worker.backoffMs(30, () => 1) === 6 * HOUR, 'backoff curve');
    seedCopy();
    seriesRow('a', 'home');
    seriesRow('b', 'home');
    itemRow('L', 'a');
    itemRow('L', 'b');
    google.failures.push({ op: 'events.insert', error: gErr(503, 'backendError'), left: 1 });
    const result = await pass();
    const a = item('a')!;
    assert(a.attempts === 1 && a.lastError === 'transient' && a.nextAttemptAt >= new Date(NOW.getTime() + 30_000) && a.nextAttemptAt <= new Date(NOW.getTime() + 60_000), `a ${show(a)}`);
    assert(item('b')!.pushedSeq === 0 && result.next.getTime() === NOW.getTime() + 60_000, `b ${show(item('b'))} next ${show(result.next)}`);
    await pass(new Date(NOW.getTime() + 10_000));
    assert(item('a')!.attempts === 1 && item('a')!.pushedSeq === 0 && item('b')!.pushedSeq === 1, `later ${show(DB.googleSyncItem)}`);
    const later = await pass(new Date(NOW.getTime() + 20_000));
    assert(later.next?.getTime() === item('a')!.nextAttemptAt.getTime(), `the gate's next ${show(later)} vs ${show(item('a'))}`);
  });

  for (const [label, error] of [['403 rateLimitExceeded (usageLimits)', gErr(403, 'rateLimitExceeded', 'usageLimits')], ['403 userRateLimitExceeded', gErr(403, 'userRateLimitExceeded', 'usageLimits')], ['429', gErr(429, 'rateLimitExceeded', 'usageLimits')]] as Array<[string, Error]>) {
    await check(`rate limit (${label}): the user's run ends with no attempt counted and nothing sent to Sentry; the next tick goes on`, async () => {
      seedCopy();
      seriesRow('a', 'home');
      itemRow('L', 'a');
      google.failures.push({ op: 'events.insert', error, left: 1 });
      const result = await pass();
      assert(item('a')!.attempts === 0 && item('a')!.nextAttemptAt === null && captured.length === 0, `item ${show(item('a'))} captured ${show(captured)}`);
      assert(result.next?.getTime() === NOW.getTime() + 60_000, `next ${show(result.next)}`);
    });
  }

  await check('token: no token sets every working link of the user to token and sends the reconnect message once per outage (Telegram, /refresh-token); a commit\'s clear lets the next outage message again', async () => {
    seedCopy();
    DB.googleSyncLink.push(linkRow('L2', TAL, 'work', { googleCalendarId: 'g-work', pushedName: 'Work', backfilledAt: null }));
    DB.googleSyncLink.push(linkRow('LG', TAL, 'home2', { nativeCalendarId: null, state: 'gone' }));
    DB.user[0].googleRefreshToken = '';
    seriesRow('a', 'home');
    itemRow('L', 'a');
    await pass();
    assert(link('L').state === 'token' && link('L2').state === 'token' && link('LG').state === 'gone' && google.calls.length === 0, `links ${show(DB.googleSyncLink.map((l) => [l.id, l.state]))}`);
    assert(sent.length === 1 && sent[0].via === 'telegram' && sent[0].chatId === 1001 && String(sent[0].text).startsWith('<b>Copies to Google are paused</b>'), `sent ${show(sent)}`);
    assert(sent[0].options?.replyMarkup.inline_keyboard[0][0].web_app.url.endsWith('/refresh-token?user_id=1001'), `button ${show(sent[0].options)}`);
    assert(DB.user[0].googleSyncNotifiedAt?.getTime() === NOW.getTime(), 'notified not stamped');
    DB.googleSyncLink.forEach((l) => { if (l.state === 'token') l.state = 'ok'; });
    await pass();
    assert(sent.length === 1, `a second message in one outage ${show(sent)}`);
  });

  await check('token: a token Google refuses (invalid_grant) mid-run is the same outage', async () => {
    seedCopy();
    seriesRow('a', 'home');
    itemRow('L', 'a');
    google.accounts.clear();
    await pass();
    assert(link('L').state === 'token' && sent.length === 1, `link ${show(link('L'))} sent ${show(sent)}`);
  });

  /** A copy's events.insert refused the way Google refused calendarList.patch in production: a bare 401, no OAuth error. */
  const insertRefused = (left = 1) => google.failures.push({ op: 'events.insert', error: prodRefusal('POST', 'calendars/g-home%40group.calendar.google.com/events'), left });
  /** What googleAccountOf throws on a 401 (account.ts): the status and Google's body, as the API client shapes them. */
  const checkRefusal = () => Object.assign(new Error('calendars.get(primary) answered HTTP 401'), {
    status: 401, response: { status: 401, data: { error: { code: 401, message: 'Invalid Credentials', errors: [{ domain: 'global', reason: 'authError', message: 'Invalid Credentials' }] } } },
  });
  /** The token endpoint's answer for a dead refresh token. */
  const deadGrant = () => Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } } });
  /** The token check fails with `error`: an account call made after the run's own one (once a calendar or event call went out). */
  const checkFails = (error: Error) => google.failures.push({ op: 'account', error, left: 1, when: () => google.calls.some((c) => /^(events|calendars)\./.test(c)) });
  const retryOf = (linkId: string) => String(redisStore.get(`google-sync:link-retry:${linkId}`)?.value);

  await check('outage: the log and Sentry name the cause: a 401 on a copy\'s events.insert (the token check failing too) gives the request (id masked), status and Google\'s message; no stored token says so', async () => {
    seedCopy();
    seriesRow('a', 'home');
    itemRow('L', 'a');
    insertRefused();
    checkFails(checkRefusal());
    await pass();
    assert(link('L').state === 'token', `link ${show(link('L'))}`);
    const line = logs.find((l) => l.includes('copies wait for a reconnect')) ?? '';
    assert(line.includes('POST www.googleapis.com/calendar/v3/calendars/:id/events') && line.includes('401') && line.includes('Invalid Credentials'), `log ${show(line)}`);
    assert(!line.includes('g-home') && !line.includes('REQUEST BODY') && !line.includes('alt=json'), `log leaks the id, body or query: ${show(line)}`);
    const outage = captured.find((c) => c.ctx === 'google-sync-outage');
    assert(String(outage?.extra?.cause).includes('calendars/:id/events') && String(outage?.extra?.cause).includes('401'), `captured ${show(captured)}`);
    seedCopy();
    DB.user[0].googleRefreshToken = '';
    seriesRow('a', 'home');
    itemRow('L', 'a');
    await pass();
    const none = logs.find((l) => l.includes('copies wait for a reconnect')) ?? '';
    assert(none.includes('no Google token stored') && String(captured.find((c) => c.ctx === 'google-sync-outage')?.extra?.cause).includes('no Google token stored'), `log ${show(none)} captured ${show(captured)}`);
  });

  // ---- A 401 on one request while the token works (the token check) ----

  await check('token check: a 401 on one copy\'s events.insert while the token works (a fresh client\'s account call) backs off only that copy (lastError, still ok): no outage, no reconnect message, a Sentry warning naming the request; the user\'s other copy syncs in the same pass', async () => {
    seedCopy();
    googleCalendar('g-work', 'L2', { summary: 'FamCal · Work' });
    DB.googleSyncLink.push(linkRow('L2', TAL, 'work', { googleCalendarId: 'g-work', pushedName: 'Work' }));
    seriesRow('a', 'home');
    itemRow('L', 'a');
    seriesRow('w1', 'work');
    itemRow('L2', 'w1');
    insertRefused();
    await pass();
    assert(link('L').state === 'ok' && link('L').lastError === 'token' && retryOf('L').startsWith('1:') && item('a')!.pushedSeq === 0, `link ${show(link('L'))} retry ${retryOf('L')}`);
    assert(sent.length === 0 && DB.user[0].googleSyncNotifiedAt === null && !captured.some((c) => c.ctx === 'google-sync-outage'), `sent ${show(sent)} captured ${show(captured)}`);
    const warned = captured.find((c) => c.ctx === 'google-sync-token-check');
    const cause = String(warned?.extra?.cause);
    assert(warned?.level === 'warning' && warned.extra?.user_id === TAL && cause.includes('POST www.googleapis.com/calendar/v3/calendars/:id/events') && cause.includes('401'), `captured ${show(captured)}`);
    assert(!cause.includes('g-home') && !cause.includes('REQUEST BODY'), `the cause leaks the id or body: ${cause}`);
    assert(logs.some((l) => l.includes('though the token works') && l.includes('Invalid Credentials')), `logs ${show(logs.filter((l) => l.includes('401')))}`);
    assert(link('L2').state === 'ok' && item('w1')!.pushedSeq === 1 && liveEvents('g-work').length === 1, `the other copy ${show(link('L2'))} ${show(item('w1'))}`);
    // The run's account check, then the token check on a client of its own (a fresh access token).
    assert(gcalls('account').length === 2 && google.clients === 2, `account calls ${show(google.calls)} clients ${google.clients}`);
  });

  await check('token check: the create step (calendars.insert) answering a bare 401 while the token works backs off that copy (still creating) with no outage; its 10th attempt tells the admin the token works', async () => {
    seed();
    DB.googleSyncLink.push(linkRow('L', TAL, 'home', { state: 'creating', backfilledAt: null }));
    redisStore.set('google-sync:link-retry:L', { value: `9:${NOW.getTime() - 1}` });
    google.failures.push({ op: 'calendars.insert', error: prodRefusal('POST', 'calendars'), left: 1 });
    await pass();
    assert(link('L').state === 'creating' && link('L').googleCalendarId === null && link('L').lastError === 'token' && retryOf('L').startsWith('10:'), `link ${show(link('L'))} retry ${retryOf('L')}`);
    assert(sent.length === 0 && !captured.some((c) => c.ctx === 'google-sync-outage') && captured.some((c) => c.ctx === 'google-sync-token-check'), `sent ${show(sent)} captured ${show(captured)}`);
    assert(adminWarnings.length === 1 && adminWarnings[0].includes('link L') && adminWarnings[0].includes('10 times') && adminWarnings[0].includes('token works'), `warnings ${show(adminWarnings)}`);
  });

  for (const [label, refusal] of [['a 401 of its own', checkRefusal()], ['invalid_grant', deadGrant()]] as Array<[string, Error]>) {
    await check(`token check: a 401 on one request with the check failing too (${label}) is the outage as before: every copy 'token', one reconnect message, google-sync-outage with the request as the cause`, async () => {
      seedCopy();
      googleCalendar('g-work', 'L2', { summary: 'FamCal · Work' });
      DB.googleSyncLink.push(linkRow('L2', TAL, 'work', { googleCalendarId: 'g-work', pushedName: 'Work' }));
      seriesRow('a', 'home');
      itemRow('L', 'a');
      seriesRow('w1', 'work');
      itemRow('L2', 'w1');
      insertRefused();
      checkFails(refusal);
      await pass();
      assert(link('L').state === 'token' && link('L2').state === 'token' && item('w1')!.pushedSeq === 0, `links ${show(DB.googleSyncLink.map((l) => [l.id, l.state]))}`);
      assert(sent.length === 1 && String(sent[0].text).startsWith('<b>Copies to Google are paused</b>'), `sent ${show(sent)}`);
      const outage = captured.find((c) => c.ctx === 'google-sync-outage');
      assert(String(outage?.extra?.cause).includes('calendars/:id/events') && String(outage?.extra?.cause).includes('401'), `captured ${show(captured)}`);
      assert(gcalls('account').length === 2 && !captured.some((c) => c.ctx === 'google-sync-token-check'), `the check ${show(google.calls)} captured ${show(captured)}`);
      assert(logs.some((l) => l.includes('the token check failed too')), `logs ${show(logs)}`);
    });
  }

  await check('token check: asked at most once per run: a turned-off copy\'s Keep and two copies that are on, each refused with a bare 401, make one check, and each backs off', async () => {
    seedCopy();
    DB.nativeCalendar.push(calendarRow('kids', TAL, 'Kids'));
    googleCalendar('g-work', 'L2', { summary: 'FamCal · Work' });
    googleCalendar('g-kids', 'LK', { summary: 'FamCal · Kids' });
    DB.googleSyncLink.push(linkRow('L2', TAL, 'work', { googleCalendarId: 'g-work', pushedName: 'Work' }));
    DB.googleSyncLink.push(linkRow('LK', TAL, 'kids', { googleCalendarId: 'g-kids', pushedName: 'Kids', enabled: false, unlinkChoice: 'keep', dirtySeq: 2, pushedSeq: 1 }));
    seriesRow('a', 'home');
    itemRow('L', 'a');
    seriesRow('w1', 'work');
    itemRow('L2', 'w1');
    google.failures.push({ op: 'calendars.patch', error: prodRefusal('PATCH', 'calendars/g-kids%40group.calendar.google.com'), left: 1 });
    insertRefused(2);
    await pass();
    assert(['L', 'L2', 'LK'].every((id) => link(id).state === 'ok' && link(id).lastError === 'token' && retryOf(id).startsWith('1:')), `links ${show(DB.googleSyncLink.map((l) => [l.id, l.state, l.lastError, retryOf(l.id)]))}`);
    assert(link('LK').pushedSeq === 1 && !google.calendars.get('g-kids')!.description.startsWith('FamCal no longer updates'), `keep ${show(link('LK'))}`);
    // The turn-off's own account call, the token check, then the account check of the copies that are on.
    assert(gcalls('account').length === 3 && google.clients === 3, `account calls ${show(google.calls)} clients ${google.clients}`);
    assert(captured.filter((c) => c.ctx === 'google-sync-token-check').length === 1 && sent.length === 0, `captured ${show(captured)} sent ${show(sent)}`);
  });

  for (const [choice, op, method, p] of [['remove', 'calendars.delete', 'DELETE', 'calendars/g-home%40group.calendar.google.com'], ['keep', 'calendars.patch', 'PATCH', 'calendars/g-home%40group.calendar.google.com']] as const) {
    const what = choice === 'remove' ? 'Remove' : 'Keep';
    await check(`token check: a queued ${what} whose ${op} answers a bare 401 while the token works is not an outage: the copy backs off, its turn-off still queued`, async () => {
      seedTurnOff(choice);
      google.failures.push({ op, error: prodRefusal(method, p), left: 1 });
      await pass();
      assert(link('L').state === 'ok' && link('L').lastError === 'token' && retryOf('L').startsWith('1:') && link('L').pushedSeq === 1 && google.calendars.has('g-home'), `link ${show(link('L'))} retry ${retryOf('L')}`);
      assert(sent.length === 0 && !captured.some((c) => c.ctx === 'google-sync-outage') && captured.some((c) => c.ctx === 'google-sync-token-check'), `sent ${show(sent)} captured ${show(captured)}`);
    });

    await check(`token check: a queued ${what} whose ${op} answers a bare 401 with the token check failing too is the outage, as before`, async () => {
      seedTurnOff(choice);
      google.failures.push({ op, error: prodRefusal(method, p), left: 1 });
      checkFails(checkRefusal());
      await pass();
      // The turn-off's own account call, then the token check.
      assert(link('L').state === 'token' && sent.length === 1 && captured.some((c) => c.ctx === 'google-sync-outage') && gcalls('account').length === 2, `outage ${show(link('L'))} sent ${show(sent)} calls ${show(google.calls)}`);
    });
  }

  for (const [label, error] of [['Google down (503)', gErr(503, 'backendError')], ['a rate limit', gErr(403, 'userRateLimitExceeded', 'usageLimits')]] as Array<[string, Error]>) {
    await check(`token check: the check itself cut short (${label}) ends the run for the next tick: no outage, no message, the copy not backed off`, async () => {
      seedCopy();
      seriesRow('a', 'home');
      itemRow('L', 'a');
      insertRefused();
      checkFails(error);
      const result = await pass();
      assert(link('L').state === 'ok' && !redisStore.has('google-sync:link-retry:L') && item('a')!.pushedSeq === 0, `link ${show(link('L'))} retry ${retryOf('L')}`);
      assert(sent.length === 0 && !captured.some((c) => c.ctx === 'google-sync-outage') && result.next?.getTime() === NOW.getTime() + 60_000, `sent ${show(sent)} captured ${show(captured)} next ${show(result.next)}`);
    });
  }

  await check('token check: a bare 401 on the run\'s own account check is the outage with no token check (nothing has worked yet this run)', async () => {
    seedCopy();
    seriesRow('a', 'home');
    itemRow('L', 'a');
    google.failures.push({ op: 'account', error: checkRefusal(), left: 1 });
    await pass();
    assert(link('L').state === 'token' && sent.length === 1 && gcalls('account').length === 1, `link ${show(link('L'))} sent ${show(sent)} calls ${show(google.calls)}`);
    assert(!captured.some((c) => c.ctx === 'google-sync-token-check'), `captured ${show(captured)}`);
  });

  await check('token check: a turned-off copy whose own account check answers a bare 401 is the outage with no second account call (that account call is the check)', async () => {
    seedTurnOff('remove');
    google.failures.push({ op: 'account', error: checkRefusal(), left: 1 });
    await pass();
    assert(link('L').state === 'token' && sent.length === 1 && gcalls('account').length === 1, `link ${show(link('L'))} sent ${show(sent)} calls ${show(google.calls)}`);
    assert(!captured.some((c) => c.ctx === 'google-sync-token-check') && google.calendars.has('g-home'), `captured ${show(captured)}`);
  });

  await check('token check: an invalid_grant after the check passed earlier in the run is still the outage (the cached pass never covers an OAuth error)', async () => {
    seedCopy();
    googleCalendar('g-work', 'L2', { summary: 'FamCal · Work' });
    DB.googleSyncLink.push(linkRow('L2', TAL, 'work', { googleCalendarId: 'g-work', pushedName: 'Work' }));
    seriesRow('a', 'home');
    itemRow('L', 'a');
    seriesRow('w1', 'work');
    itemRow('L2', 'w1');
    google.failures.push({ op: 'events.insert', error: prodRefusal('POST', 'calendars/g-home%40group.calendar.google.com/events'), left: 1, when: (a) => a.calendarId === 'g-home' });
    google.failures.push({ op: 'events.insert', error: deadGrant(), left: 1, when: (a) => a.calendarId === 'g-work' });
    await pass();
    assert(link('L').state === 'token' && link('L2').state === 'token' && sent.length === 1, `links ${show(DB.googleSyncLink.map((l) => [l.id, l.state]))} sent ${show(sent)}`);
    assert(captured.filter((c) => c.ctx === 'google-sync-token-check').length === 1 && captured.some((c) => c.ctx === 'google-sync-outage'), `captured ${show(captured)}`);
  });

  await check('token check: a check that says the grant lacks a scope (403 insufficientPermissions) is the scopes outage: the message opens the calendars page', async () => {
    seedCopy();
    seriesRow('a', 'home');
    itemRow('L', 'a');
    insertRefused();
    checkFails(gErr(403, 'insufficientPermissions'));
    await pass();
    assert(link('L').state === 'scopes' && sent.length === 1, `link ${show(link('L'))} sent ${show(sent)}`);
    assert(String(sent[0]?.options?.replyMarkup?.inline_keyboard?.[0]?.[0]?.web_app?.url).includes('/calendars?'), `button ${show(sent[0]?.options)}`);
  });

  for (const [label, error] of [['a 403 that names no reason', gErr(403)], ['an answer it can\'t read', new Error('calendars.get(primary) answered with no id')]] as Array<[string, Error]>) {
    await check(`token check: a check that says nothing about the token (${label}) is no outage: the copy backs off, the admin can see why`, async () => {
      seedCopy();
      seriesRow('a', 'home');
      itemRow('L', 'a');
      insertRefused();
      checkFails(error);
      await pass();
      assert(link('L').state === 'ok' && link('L').lastError === 'token' && retryOf('L').startsWith('1:') && sent.length === 0, `link ${show(link('L'))} retry ${retryOf('L')} sent ${show(sent)}`);
      const warned = captured.find((c) => c.ctx === 'google-sync-token-check');
      assert(warned && !captured.some((c) => c.ctx === 'google-sync-outage') && logs.some((l) => l.includes('the token check was inconclusive')), `captured ${show(captured)} logs ${show(logs.filter((l) => l.includes('token check')))}`);
    });
  }

  await check('token check: a 401 on the run\'s last Google call leaves no call for the check: the run ends for the next tick with no outage', async () => {
    seedCopy();
    // The account check and 98 inserts, then the 100th call (s098's insert) refused.
    for (let i = 0; i < 99; i++) {
      seriesRow(`s${String(i).padStart(3, '0')}`, 'home');
      itemRow('L', `s${String(i).padStart(3, '0')}`);
    }
    const last = eventId('L', 's098');
    google.failures.push({ op: 'events.insert', error: prodRefusal('POST', 'calendars/g-home%40group.calendar.google.com/events'), left: 1, when: (a) => a.requestBody?.id === last });
    const result = await pass();
    assert(google.calls.length === 100 && gcalls('account').length === 1, `calls ${google.calls.length} ${show(gcalls('account'))}`);
    assert(link('L').state === 'ok' && !redisStore.has('google-sync:link-retry:L') && item('s098')!.pushedSeq === 0 && item('s097')!.pushedSeq === 1, `link ${show(link('L'))} ${show(item('s098'))}`);
    assert(sent.length === 0 && !captured.some((c) => c.ctx === 'google-sync-outage') && result.next?.getTime() === NOW.getTime() + 60_000, `sent ${show(sent)} captured ${show(captured)}`);
  });

  await check('scopes: no calendar.app.created sets scopes; the message opens the calendars page; a WhatsApp-only user gets the settings template', async () => {
    seedCopy();
    DB.user[0].googleScopes = SCOPES.slice(0, 2);
    seriesRow('a', 'home');
    itemRow('L', 'a');
    await pass();
    assert(link('L').state === 'scopes' && google.calls.length === 0, `link ${show(link('L'))}`);
    assert(sent[0]?.options?.replyMarkup.inline_keyboard[0][0].web_app.url.endsWith('/en/calendars?user_id=1001') && String(sent[0].text).includes('permission'), `sent ${show(sent)}`);
    seedCopy();
    Object.assign(DB.user[0], { googleScopes: [], telegramId: null, whatsappPhone: '972500000001' });
    seriesRow('a', 'home');
    itemRow('L', 'a');
    await pass();
    assert(sent.length === 1 && sent[0].via === 'whatsapp' && sent[0].options?.whatsappTemplate?.buttonPayload === 'settings', `wa ${show(sent)}`);
  });

  await check('otherAccount: a token of another Google account than the copy\'s sets otherAccount and writes nothing; a copy with no account yet adopts the token\'s', async () => {
    seedCopy({ googleAccount: 'old@example.com' });
    seriesRow('a', 'home');
    itemRow('L', 'a');
    await pass();
    assert(link('L').state === 'otherAccount' && !google.calls.some((x) => /^(events|calendars)\./.test(x)), `link ${show(link('L'))} calls ${show(google.calls)}`);
    seedCopy({ googleAccount: null });
    seriesRow('a', 'home');
    itemRow('L', 'a');
    await pass();
    assert(link('L').googleAccount === ACCOUNT && link('L').state === 'ok' && liveEvents().length === 1, `adopt ${show(link('L'))}`);
  });

  await check('plan: a plan without google_sync pauses the copies (plan) with no Google call; when it comes back they are ok and pushed', async () => {
    seedCopy();
    seriesRow('a', 'home');
    itemRow('L', 'a');
    planAllowed.set(TAL, false);
    await pass();
    assert(link('L').state === 'plan' && google.calls.length === 0, `link ${show(link('L'))} calls ${show(google.calls)}`);
    planAllowed.set(TAL, true);
    await pass();
    assert(link('L').state === 'ok' && liveEvents().length === 1, `back ${show(link('L'))}`);
  });

  await check('suspended: a suspended user is skipped: no lock, no Google call', async () => {
    seedCopy();
    seriesRow('a', 'home');
    itemRow('L', 'a');
    DB.user[0].suspendedAt = NOW;
    await pass();
    assert(google.calls.length === 0 && redisLog.length === 0 && item('a')!.pushedSeq === 0, `calls ${show(google.calls)} redis ${show(redisLog)}`);
  });

  await check('admin alert: the 10th failed attempt in a row tells the admin, once per link per day', async () => {
    seedCopy();
    seriesRow('a', 'home');
    seriesRow('b', 'home');
    itemRow('L', 'a', { attempts: 9 });
    itemRow('L', 'b', { attempts: 9 });
    google.failures.push({ op: 'events.insert', error: gErr(400, 'invalid'), left: 2 });
    await pass();
    assert(item('a')!.attempts === 10 && item('b')!.attempts === 10, `items ${show(DB.googleSyncItem)}`);
    assert(adminWarnings.length === 1 && adminWarnings[0].includes('link L') && !TITLES.some((t) => adminWarnings[0].includes(t)), `warnings ${show(adminWarnings)}`);
    assert(captured.filter((x) => x.ctx === 'google-sync-push').every((x) => x.extra?.link_id === 'L' && !x.message.includes('REQUEST BODY')), `captured ${show(captured)}`);
  });

  // ---- Pace ----

  await check('lock: each user runs under google-sync:lock:<id> taken NX with a 600 s TTL, renewed before each item and released after', async () => {
    seedCopy();
    seriesRow('a', 'home');
    seriesRow('b', 'home');
    itemRow('L', 'a');
    itemRow('L', 'b');
    await pass();
    assert(redisLog[0] === 'set google-sync:lock:1 nx ex 600', `take ${show(redisLog)}`);
    assert(redisLog.filter((x) => x === 'expire google-sync:lock:1 600').length === 2 && redisLog[redisLog.length - 1] === 'del google-sync:lock:1', `renew/release ${show(redisLog)}`);
    assert(!redisStore.has('google-sync:lock:1'), 'lock left behind');
  });

  await check('lock: a user whose lock is held is skipped (next tick), and a Redis error skips the run fail-closed', async () => {
    seedCopy();
    seriesRow('a', 'home');
    itemRow('L', 'a');
    redisStore.set('google-sync:lock:1', { value: 'other' });
    const result = await pass();
    assert(google.calls.length === 0 && result.next?.getTime() === NOW.getTime() + 60_000 && redisStore.get('google-sync:lock:1')?.value === 'other', `busy ${show(google.calls)}`);
    redisStore.clear();
    redisFail = 'set';
    await pass();
    assert(google.calls.length === 0 && captured.some((x) => x.ctx === 'google-sync-lock'), `redis down ${show(captured)}`);
    redisFail = 'expire';
    await pass();
    assert(!google.calls.some((x) => x.startsWith('events.')) && item('a')!.pushedSeq === 0, `renew failed but pushed ${show(google.calls)}`);
  });

  await check('pace: a user\'s run makes at most 100 Google calls; the rest goes on at the next tick', async () => {
    seedCopy();
    for (let i = 0; i < 150; i++) {
      seriesRow(`s${String(i).padStart(3, '0')}`, 'home');
      itemRow('L', `s${String(i).padStart(3, '0')}`);
    }
    const result = await pass();
    const done = table('googleSyncItem').filter((r) => r.pushedSeq === r.dirtySeq).length;
    assert(google.calls.length === 100 && done === 99 && result.next?.getTime() === NOW.getTime() + 60_000, `calls ${google.calls.length} done ${done} next ${show(result.next)}`);
    await pass();
    assert(table('googleSyncItem').every((r) => r.pushedSeq === r.dirtySeq), 'not drained on the next pass');
  });

  await check('pace: at most 3 users run at a time', async () => {
    seed();
    for (let u = 10; u < 16; u++) {
      DB.user.push(userRow(u));
      DB.nativeCalendar.push(calendarRow(`c${u}`, u, `Cal ${u}`));
      google.accounts.set(`tok-${u}`, `u${u}@example.com`);
      googleCalendar(`g${u}`, `L${u}`, { account: `u${u}@example.com` });
      DB.googleSyncLink.push(linkRow(`L${u}`, u, `c${u}`, { googleCalendarId: `g${u}`, googleAccount: `u${u}@example.com`, pushedName: `Cal ${u}` }));
      for (let i = 0; i < 3; i++) {
        seriesRow(`u${u}s${i}`, `c${u}`, { creatorUserId: u });
        itemRow(`L${u}`, `u${u}s${i}`);
      }
    }
    await pass();
    assert(table('googleSyncItem').every((r) => r.pushedSeq === r.dirtySeq), `items ${show(DB.googleSyncItem.map((r) => [r.id, r.pushedSeq]))}`);
    assert(google.maxInflight <= 3 && google.maxInflight >= 2, `users at once ${google.maxInflight}`);
  });

  await check('pace: calendars are created one at a time, across the users running', async () => {
    seed();
    for (let u = 10; u < 14; u++) {
      DB.user.push(userRow(u));
      DB.nativeCalendar.push(calendarRow(`c${u}`, u, `Cal ${u}`));
      DB.googleSyncLink.push(linkRow(`L${u}`, u, `c${u}`, { state: 'creating', googleAccount: null, backfilledAt: null }));
      google.accounts.set(`tok-${u}`, `u${u}@example.com`);
    }
    await pass();
    assert(DB.googleSyncLink.every((l) => l.state === 'ok' && l.googleCalendarId), `links ${show(DB.googleSyncLink.map((l) => [l.id, l.state]))}`);
    assert(google.maxInserting === 1, `calendars created at once ${google.maxInserting}`);
  });

  await check('pace: the cap holds when items take several calls each (insert, then an instance and its patch)', async () => {
    seedCopy();
    for (let i = 0; i < 60; i++) {
      const id = `w${String(i).padStart(3, '0')}`;
      seriesRow(id, 'home', { startsAt: at('2026-10-05 10:00'), rrule: 'FREQ=WEEKLY' });
      override(id, at('2026-10-12 10:00'), { title: 'x' });
      itemRow('L', id);
    }
    const result = await pass();
    assert(google.calls.length === 100 && result.next?.getTime() === NOW.getTime() + 60_000, `calls ${google.calls.length}`);
    for (let n = 0; n < 3; n++) await pass();
    const copied = table('googleSyncItem').filter((r) => r.pushedSeq === r.dirtySeq).length;
    assert(copied === 60 && liveEvents().length === 60 && liveEvents().every((e) => e.exceptions.size === 1), `copied ${copied}, events ${liveEvents().length}`);
  });

  await check('backfill: a new copy marks the calendar\'s event series (series whole, one-offs from 30 days back; never reminders or deleted ones), drains them, and syncProgress counts it', async () => {
    seedCopy({ backfilledAt: null });
    seriesRow('future', 'home');
    seriesRow('recent', 'home', { startsAt: new Date(NOW.getTime() - 10 * DAY), endsAt: new Date(NOW.getTime() - 10 * DAY + HOUR) });
    seriesRow('old', 'home', { startsAt: new Date(NOW.getTime() - 40 * DAY), endsAt: new Date(NOW.getTime() - 40 * DAY + HOUR) });
    seriesRow('series', 'home', { startsAt: at('2024-01-01 09:00'), rrule: 'FREQ=WEEKLY' });
    seriesRow('rem', 'home', { kind: 'REMINDER' });
    seriesRow('del', 'home', { isDeleted: true });
    seriesRow('elsewhere', 'work');
    const before = await worker.syncProgress('L');
    assert(before.total === 0, `before ${show(before)}`);
    await pass();
    assert(show(table('googleSyncItem').map((r) => r.nativeEventId).sort()) === show(['future', 'recent', 'series']), `items ${show(DB.googleSyncItem)}`);
    assert(link('L').backfilledAt?.getTime() === NOW.getTime(), 'backfilledAt');
    const after = await worker.syncProgress('L');
    assert(after.total === 3 && after.copied === 3 && after.unsupported === 0, `progress ${show(after)}`);
    // What the backfill itself marked, before push drained anything (push drops an old one-off or a reminder too, so the items alone can't tell).
    assert(logs.some((l) => l === '[google-sync] link L: backfill marked 3 series'), `backfill marks ${show(logs.filter((l) => l.includes('backfill')))}`);
    item('future')!.dirtySeq += 1;
    item('series')!.status = 'unsupported';
    const mid = await worker.syncProgress('L');
    assert(mid.copied === 1 && mid.unsupported === 1 && mid.total === 3, `progress mid ${show(mid)}`);
  });


  // ---- A copy's own steps (review fixes) ----

  await check('rename: a FamCal rename whose Google calendar was deleted in Google sets the link gone (calendar_gone, a Sentry warning, no error), and the user\'s other copies still run', async () => {
    seedCopy({ pushedName: 'Old', dirtySeq: 3, pushedSeq: 2 });
    google.calendars.delete('g-home');
    googleCalendar('g-work', 'L2', { summary: 'FamCal · Work' });
    DB.googleSyncLink.push(linkRow('L2', TAL, 'work', { googleCalendarId: 'g-work', pushedName: 'Work' }));
    seriesRow('w1', 'work');
    itemRow('L2', 'w1');
    await pass();
    assert(link('L').state === 'gone' && link('L').lastError === 'calendar_gone', `link ${show(link('L'))}`);
    assert(item('w1')!.pushedSeq === 1 && liveEvents('g-work').length === 1, `the other copy ${show(item('w1'))} ${show(google.calls)}`);
    assert(captured.some((x) => x.ctx === 'google-sync-gone' && x.level === 'warning') && captured.every((x) => x.level === 'warning'), `captured ${show(captured)}`);
    google.calls = [];
    await pass();
    assert(google.calls.length === 0, `a gone copy was worked again ${show(google.calls)}`);
  });

  await check('a copy\'s own step (calendars.insert) failing transiently backs off per link (30–60 s, a Sentry warning, lastError), makes no call while it waits (the gate sleeps till then), and clears once it works', async () => {
    seed();
    DB.googleSyncLink.push(linkRow('L', TAL, 'home', { state: 'creating', backfilledAt: null }));
    google.failures.push({ op: 'calendars.insert', error: gErr(503, 'backendError'), left: 1 });
    await pass();
    const key = 'google-sync:link-retry:L';
    const [attempts, at] = String(redisStore.get(key)?.value).split(':').map(Number);
    assert(attempts === 1 && at >= NOW.getTime() + 30_000 && at <= NOW.getTime() + 60_000 && redisStore.get(key)?.ex === 2 * 86_400, `retry ${show(redisStore.get(key))}`);
    assert(link('L').state === 'creating' && link('L').lastError === 'transient', `link ${show(link('L'))}`);
    assert(captured.some((x) => x.ctx === 'google-sync-link' && x.level === 'warning') && !captured.some((x) => x.ctx === 'google-sync-user'), `captured ${show(captured)}`);
    google.calls = [];
    const waiting = await pass(new Date(NOW.getTime() + 20_000));
    assert(google.calls.length === 0 && waiting.next?.getTime() === at, `while backed off ${show(google.calls)} next ${show(waiting.next)} vs ${at}`);
    await pass(new Date(at + 1));
    assert(link('L').state === 'ok' && link('L').googleCalendarId && link('L').lastError === null && !redisStore.has(key), `after ${show(link('L'))} ${show(redisStore.get(key))}`);
  });

  await check('a copy\'s own step failing for the 10th time in a row tells the admin, once per link per day; one that isn\'t transient (403 forbidden) is an error in Sentry and doesn\'t hold back the user\'s other copies', async () => {
    seed();
    DB.googleSyncLink.push(linkRow('L', TAL, 'home', { state: 'creating', backfilledAt: null }));
    googleCalendar('g-work', 'L2', { summary: 'FamCal · Work' });
    DB.googleSyncLink.push(linkRow('L2', TAL, 'work', { googleCalendarId: 'g-work', pushedName: 'Work' }));
    seriesRow('w1', 'work');
    itemRow('L2', 'w1');
    redisStore.set('google-sync:link-retry:L', { value: `9:${NOW.getTime() - 1}` });
    google.failures.push({ op: 'calendars.insert', error: gErr(403, 'forbidden'), left: 2 });
    await pass();
    assert(String(redisStore.get('google-sync:link-retry:L')?.value).startsWith('10:') && link('L').lastError === 'forbidden', `retry ${show(redisStore.get('google-sync:link-retry:L'))}`);
    assert(adminWarnings.length === 1 && adminWarnings[0].includes('link L') && adminWarnings[0].includes('10 times'), `warnings ${show(adminWarnings)}`);
    assert(captured.some((x) => x.ctx === 'google-sync-link' && x.level === 'error'), `captured ${show(captured)}`);
    assert(item('w1')!.pushedSeq === 1 && liveEvents('g-work').length === 1, `the other copy ${show(item('w1'))}`);
    await pass(new Date(NOW.getTime() + 7 * HOUR));
    assert(String(redisStore.get('google-sync:link-retry:L')?.value).startsWith('11:') && adminWarnings.length === 1, `the same day ${show(adminWarnings)}`);
  });

  await check('the account check failing transiently backs off every copy of the user; a 403 rate limit on it pauses the run with nothing counted or sent to Sentry', async () => {
    seedCopy();
    seriesRow('a', 'home');
    itemRow('L', 'a');
    google.failures.push({ op: 'account', error: gErr(503, 'backendError'), left: 1 });
    await pass();
    assert(String(redisStore.get('google-sync:link-retry:L')?.value).startsWith('1:') && item('a')!.pushedSeq === 0, `retry ${show(redisStore.get('google-sync:link-retry:L'))}`);
    seedCopy();
    seriesRow('a', 'home');
    itemRow('L', 'a');
    google.failures.push({ op: 'account', error: gErr(403, 'userRateLimitExceeded', 'usageLimits'), left: 1 });
    const result = await pass();
    assert(result.next?.getTime() === NOW.getTime() + 60_000 && captured.length === 0 && !redisStore.has('google-sync:link-retry:L'), `rate limit ${show(result)} ${show(captured)}`);
  });

  await check('googleAccountOf: a 403 carries Google\'s reasons, so usageLimits is a rate limit and insufficientPermissions a missing scope; a body that isn\'t JSON still keeps its status; a network failure is transient', async () => {
    const account = await load('src/services/google-sync/account.ts');
    const map = await load('src/services/calendar-read/google-map.ts');
    const blocked = globalThis.fetch;
    const answer = (status: number, body: string) => { globalThis.fetch = (async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })) as typeof fetch; };
    const thrown = async () => {
      try {
        await account.googleAccountOf('access-token');
      } catch (error) {
        return error;
      }
      throw new Error('no error');
    };
    const googleBody = (reason: string, domain: string) => JSON.stringify({ error: { code: 403, message: reason, errors: [{ domain, reason, message: reason }] } });
    try {
      answer(403, googleBody('rateLimitExceeded', 'usageLimits'));
      const limit = await thrown();
      answer(403, googleBody('userRateLimitExceeded', 'usageLimits'));
      const userLimit = await thrown();
      answer(403, googleBody('insufficientPermissions', 'global'));
      const scopes = await thrown();
      answer(502, '<html>Bad Gateway</html>');
      const html = await thrown();
      globalThis.fetch = (async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }); }) as typeof fetch;
      const network = await thrown();
      assert(map.classifyGoogleError(network) === 'transient' && String((network as Error).message).includes('fetch failed'), `network ${show(network)} ${String((network as Error).message)}`);
      assert(map.isGoogleRateLimit(limit) && map.isGoogleRateLimit(userLimit), `rate limit ${show(limit)}`);
      assert(map.classifyGoogleError(scopes) === 'scopes' && !map.isGoogleRateLimit(scopes), `scopes ${show(scopes)}`);
      assert(map.classifyGoogleError(html) === 'transient', `html ${show(html)}`);
    } finally {
      globalThis.fetch = blocked;
    }
  });

  await check('lock: a run whose lock was taken by another run (it lapsed) stops before its next item, and its release leaves the other run\'s lock in place', async () => {
    seedCopy();
    for (const id of ['a', 'b', 'c']) {
      seriesRow(id, 'home');
      itemRow('L', id);
    }
    let swapped = false;
    google.during = (op) => {
      if (op === 'events.insert' && !swapped) {
        swapped = true;
        redisStore.set('google-sync:lock:1', { value: 'OTHER-RUN', ex: 600 });
      }
    };
    await pass();
    assert(gcalls('events.insert').length === 1 && redisStore.get('google-sync:lock:1')?.value === 'OTHER-RUN', `inserts ${gcalls('events.insert').length} lock ${show(redisStore.get('google-sync:lock:1'))}`);
  });

  await check('outage: no token with a queued turn-off and a copy that is on sends the reconnect message once in the pass', async () => {
    seedCopy();
    DB.user[0].googleRefreshToken = '';
    googleCalendar('g-work', 'L2', { summary: 'FamCal · Work' });
    DB.googleSyncLink.push(linkRow('L2', TAL, 'work', { googleCalendarId: 'g-work', enabled: false, unlinkChoice: 'remove', dirtySeq: 2, pushedSeq: 1 }));
    DB.googleSyncLink.push(linkRow('L3', TAL, 'noa', { googleCalendarId: 'g-x', enabled: false, unlinkChoice: 'keep', dirtySeq: 2, pushedSeq: 1 }));
    seriesRow('a', 'home');
    itemRow('L', 'a');
    await pass();
    assert(sent.length === 1 && link('L').state === 'token' && link('L2').state === 'token', `sent ${show(sent)} links ${show(DB.googleSyncLink.map((l) => [l.id, l.state]))}`);
  });

  await check('otherAccount: reconnecting the copy\'s own account (a commit) puts its copies back: the one that is on resumes, the turned-off one\'s queued Remove is carried out; the wrong account again goes back to otherAccount', async () => {
    seedCopy();
    seriesRow('a', 'home');
    itemRow('L', 'a');
    googleCalendar('g-work', 'L2', { summary: 'FamCal · Work' });
    DB.googleSyncLink.push(linkRow('L2', TAL, 'work', { googleCalendarId: 'g-work', enabled: false, unlinkChoice: 'remove', dirtySeq: 2, pushedSeq: 1 }));
    google.accounts.set('tok-1', 'other@example.com');
    await pass();
    assert(link('L').state === 'otherAccount' && link('L2').state === 'otherAccount', `links ${show(DB.googleSyncLink.map((l) => [l.id, l.state]))}`);
    google.accounts.set('tok-1', 'other@example.com');
    await links.restoreSyncLinks(TAL, SCOPES);
    await pass();
    assert(link('L').state === 'otherAccount' && link('L2').state === 'otherAccount' && google.calendars.has('g-work'), `the wrong account again ${show(DB.googleSyncLink.map((l) => [l.id, l.state]))}`);
    google.accounts.set('tok-1', ACCOUNT);
    await links.restoreSyncLinks(TAL, SCOPES);
    await pass();
    assert(link('L').state === 'ok' && item('a')!.pushedSeq === 1 && liveEvents().length === 1, `on ${show(link('L'))} ${show(item('a'))}`);
    assert(!google.calendars.has('g-work') && link('L2').pushedSeq === 2, `turned off ${show(link('L2'))}`);
  });

  await check('a turned-off copy with no stored Google calendar id (a create that failed before storing it) is looked up by its token: Remove deletes that calendar, Keep marks it and keeps its id; none found is clean', async () => {
    seedCopy({ googleCalendarId: null, state: 'creating', enabled: false, unlinkChoice: 'remove', dirtySeq: 2, pushedSeq: 1 });
    await pass();
    assert(!google.calendars.has('g-home') && link('L').pushedSeq === 2 && link('L').googleCalendarId === null, `remove ${show(link('L'))} ${show(google.calls)}`);
    seedCopy({ googleCalendarId: null, state: 'creating', enabled: false, unlinkChoice: 'keep', dirtySeq: 2, pushedSeq: 1 });
    await pass();
    assert(google.calendars.get('g-home')!.description.startsWith('FamCal no longer updates') && link('L').googleCalendarId === 'g-home' && link('L').pushedSeq === 2, `keep ${show(link('L'))}`);
    seedCopy({ googleCalendarId: null, state: 'creating', enabled: false, unlinkChoice: 'remove', dirtySeq: 2, pushedSeq: 1 });
    google.calendars.delete('g-home');
    await pass();
    assert(link('L').pushedSeq === 2 && gcalls('calendars.delete').length === 0 && gcalls('calendarList.list').length === 1, `none ${show(link('L'))} ${show(google.calls)}`);
  });

  await check('a turned-off copy with no stored Google calendar id whose Remove waited out a token outage is restored by the commit, and the next pass removes the calendar found by its token; one with nothing queued is left as it is', async () => {
    seedCopy({ googleCalendarId: null, state: 'creating', enabled: false, unlinkChoice: 'remove', dirtySeq: 2, pushedSeq: 1 });
    DB.googleSyncLink.push(linkRow('L2', TAL, 'work', { googleCalendarId: null, state: 'token', enabled: false, unlinkChoice: 'remove', dirtySeq: 2, pushedSeq: 2 }));
    google.accounts.clear();
    await pass();
    assert(link('L').state === 'token' && google.calendars.has('g-home'), `outage ${show(link('L'))}`);
    google.accounts.set('tok-1', ACCOUNT);
    const changed = await links.restoreSyncLinks(TAL, SCOPES);
    assert(show(changed) === show(['L']) && link('L').state === 'creating' && link('L2').state === 'token', `commit ${show(changed)} ${show(DB.googleSyncLink.map((l) => [l.id, l.state]))}`);
    await pass();
    assert(!google.calendars.has('g-home') && link('L').pushedSeq === 2 && gcalls('calendars.insert').length === 0, `remove ${show(link('L'))} ${show(google.calls)}`);
  });

  await check('hard delete: a copy that is on with no stored Google calendar id is looked up by its token and removed before the delete', async () => {
    seedCopy({ googleCalendarId: null, state: 'creating' });
    await worker.carryOutCopiesBeforeDelete(TAL);
    assert(!google.calendars.has('g-home') && gcalls('calendars.delete').length === 1, `calls ${show(google.calls)}`);
  });

  // ---- The cron handler ----

  await check('cron: handleGoogleSync reads nothing while the gate is closed, runs a pass when it is open, and closes the gate until the pass\'s next', async () => {
    seedCopy();
    seriesRow('a', 'home');
    itemRow('L', 'a');
    gate.__resetSyncGateForTests();
    gate.setNextSync(new Date(Date.now() + HOUR), new Date());
    calls = [];
    await handlers.handleGoogleSync();
    assert(calls.length === 0, `read with the gate closed ${show(calls)}`);
    gate.openSyncGate();
    worker.__resetSyncWorkerForTests();
    await handlers.handleGoogleSync();
    assert(item('a')!.pushedSeq === 1 && calls.length > 0, `not run ${show(item('a'))}`);
    assert(!gate.shouldRunSync(new Date()), 'the gate stayed open after a clean pass');
  });

  await check('no titles in logs or Sentry (every scenario of the run)', async () => {
    assert(runLogs.length > 100 && runCaptured.some((c) => c.ctx === 'google-sync-push') && runCaptured.some((c) => c.ctx === 'google-sync-alert' || c.ctx === 'google-sync-link'), `run lists not filled: ${runLogs.length} logs, ${runCaptured.length} captures`);
    const leaked = [...runLogs, ...runCaptured.map((c) => `${c.ctx} ${c.message} ${show(c.extra)}`)].filter((l) => TITLES.some((t) => l.includes(t)) || l.includes('REQUEST BODY'));
    assert(leaked.length === 0, `leaked ${show(leaked.slice(0, 3))}`);
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

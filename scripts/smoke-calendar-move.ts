// Smoke test for the cross-source move ("Google as a connection" spec §5, §7 second
// bullet): an event moved between FamCal and Google from the editor's Calendar row.
//
// What runs for real: the mapper (src/services/calendar-move/mapper.ts) both ways, the move
// (calendar-move/move.ts) through write.ts's updateItem and the PATCH body's parser, the
// event store and its new createNativeSeries, the recurrence expansion, the item info's
// move targets, the real @googleapis/calendar client with its auth library and gaxios, and
// the store's dropItem. Faked at the boundaries: gaxios's transport (an in-memory Google
// Calendar, grown from smoke-google-write's: events.list by iCalUID and by private extended
// property, extended properties on inserts), Prisma (in memory, with transactions that roll
// back), Redis (NX semantics, and a switch that makes it fail), the stamp's Upstash client,
// error capture, analytics, the moved-ping edit, Telegram and the user's timezone. No
// network, no database.
//
// Run under both clocks; nothing may depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-calendar-move.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-move.ts

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { RRule } from 'rrule';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
type Where = Record<string, unknown>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

process.env.GOOGLE_CLIENT_ID ||= 'fake-client-id';
process.env.GOOGLE_CLIENT_SECRET ||= 'fake-client-secret';
process.env.UPSTASH_REDIS_REST_URL = 'https://stamp-redis.smoke.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'smoke-token';
process.env.TELEGRAM_BOT_TOKEN ||= 'test';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    reset();
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? (err.stack ?? err.message).split('\n').slice(0, 4).join('\n') : String(err) });
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
function assertSame(got: unknown, want: unknown, label: string) {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const at = (local: string, zone = IL) => fromZonedTime(local, zone);
const dt = (instant: Date, zone: string) => formatInTimeZone(instant, zone, "yyyy-MM-dd'T'HH:mm:ssXXX");
const utcStamp = (d: Date) => formatInTimeZone(d, 'UTC', "yyyyMMdd'T'HHmmss'Z'");
const dayStartOf = (day: string, zone = IL) => fromZonedTime(`${day}T00:00:00`, zone);
const dayEndOf = (day: string, zone = IL) => fromZonedTime(`${day}T23:59:00`, zone);

// ================= The fake Google Calendar, behind gaxios's transport =================

const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface CalMeta { summary: string; accessRole: string; primary?: boolean; timeZone: string; backgroundColor: string }
type Req = { method: string; path: string; params: Row; body: Row | undefined };
type Answer = { status: number; data: unknown };

const cals = new Map<string, CalMeta>();
const evs = new Map<string, Map<string, Row>>();
const gone = new Set<string>();
const calls: Req[] = [];
let seq = 0;
/** One-shot (or n-shot) answers, matched in order. `apply` serves the request first (Google applied it, then the answer was lost). */
let rules: { match: (r: Req) => boolean; answer: Answer; left: number; apply?: boolean }[] = [];
/** When set, events.instances ignores originalStart and lists from the first instance (the move's window fallback is then what finds the slot). */
let ignoreOriginalStart = false;

const apiBody = (code: number, reason: string, message: string) => ({ error: { code, message, errors: [{ domain: 'global', reason, message }] } });
const fail = (status: number, reason: string, message = reason): Answer => ({ status, data: apiBody(status, reason, message) });
function failOn(match: (r: Req) => boolean, answer: Answer, o: { times?: number; apply?: boolean } = {}) {
  rules.push({ match, answer, left: o.times ?? 1, apply: o.apply });
}

const writes = () => calls.filter((c) => c.method !== 'GET');
/** gaxios retries a GET or DELETE that answered 5xx three times: a failure that lasts answers every try. */
const RETRIED = 4;
const eventsOf = (cal: string) => evs.get(cal) ?? new Map<string, Row>();
const stored = (cal: string, id: string) => eventsOf(cal).get(id);

function lineValues(line: string, zone: string): Array<{ date?: string; instant?: Date }> {
  const colon = line.indexOf(':');
  const head = line.slice(0, colon);
  const tzid = /TZID=([^;:]+)/i.exec(head)?.[1];
  return line.slice(colon + 1).split(',').map((v) => {
    if (/^\d{8}$/.test(v)) return { date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` };
    const wall = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}`;
    return { instant: v.endsWith('Z') ? new Date(`${wall}Z`) : fromZonedTime(wall, tzid ?? zone) };
  });
}

/** The fake's own expansion of a master (RFC 5545 as Google reads it): slots, exdates applied, exceptions not. */
function slotsOf(cal: string, m: Row): Row[] {
  const rr = (m.recurrence ?? []).find((l: string) => /^RRULE:/i.test(l));
  if (!rr) return [];
  const zone = m.start.timeZone ?? cals.get(cal)?.timeZone ?? IL;
  const allDay = Boolean(m.start.date);
  const parts = rr.slice(6).split(';');
  const until = parts.find((p: string) => /^UNTIL=/i.test(p))?.slice(6);
  const countPart = parts.find((p: string) => /^COUNT=/i.test(p));
  const count = countPart ? Number(countPart.slice(6)) : undefined;
  const rest = parts.filter((p: string) => !/^(UNTIL|COUNT)=/i.test(p)).join(';');
  const opts = RRule.parseString(rest);
  const startFloat = allDay ? new Date(`${m.start.date}T00:00:00Z`) : new Date(`${formatInTimeZone(new Date(m.start.dateTime), zone, "yyyy-MM-dd'T'HH:mm:ss")}Z`);
  const durMs = allDay ? Date.parse(m.end.date) - Date.parse(m.start.date) : Date.parse(m.end.dateTime) - Date.parse(m.start.dateTime);
  const floats = new RRule({ ...opts, dtstart: startFloat }).all((_d, i) => i < (count ?? 400));
  const ex = (m.recurrence ?? []).filter((l: string) => /^EXDATE[:;]/i.test(l)).flatMap((l: string) => lineValues(l, zone));
  const out: Row[] = [];
  for (const f of floats) {
    if (allDay) {
      const date = f.toISOString().slice(0, 10);
      if (until && date.replace(/-/g, '') > until.slice(0, 8)) break;
      if (ex.some((e: Row) => e.date === date)) continue;
      const end = new Date(Date.parse(`${date}T00:00:00Z`) + durMs).toISOString().slice(0, 10);
      out.push({ id: `${m.id}_${date.replace(/-/g, '')}`, originalStartTime: { date }, start: { date }, end: { date: end } });
      continue;
    }
    const instant = fromZonedTime(f.toISOString().slice(0, 19), zone);
    if (until) {
      if (/^\d{8}$/.test(until)) {
        if (formatInTimeZone(instant, zone, 'yyyyMMdd') > until) break;
      } else if (until.endsWith('Z')) {
        if (utcStamp(instant) > until) break;
      } else if (f.toISOString().replace(/[-:]/g, '').slice(0, 15) > until) break;
    }
    if (ex.some((e: Row) => e.instant?.getTime() === instant.getTime() || e.date === formatInTimeZone(instant, zone, 'yyyy-MM-dd'))) continue;
    const tz = m.start.timeZone;
    out.push({
      id: `${m.id}_${utcStamp(instant)}`,
      originalStartTime: { dateTime: dt(instant, zone), ...(tz ? { timeZone: tz } : {}) },
      start: { dateTime: dt(instant, zone), ...(tz ? { timeZone: tz } : {}) },
      end: { dateTime: dt(new Date(instant.getTime() + durMs), zone), ...(m.end.timeZone ? { timeZone: m.end.timeZone } : {}) },
    });
  }
  return out;
}

const SERIES_FIELDS = ['summary', 'description', 'location', 'colorId', 'reminders', 'visibility', 'transparency', 'attendees', 'organizer', 'creator', 'eventType', 'locked', 'attendeesOmitted', 'conferenceData', 'attachments', 'extendedProperties', 'htmlLink', 'status', 'iCalUID'];

function instancesOf(cal: string, m: Row): Row[] {
  const exceptions = [...eventsOf(cal).values()].filter((e) => e.recurringEventId === m.id);
  const slots = slotsOf(cal, m).map((s) => {
    const own = exceptions.find((e) => e.id === s.id);
    if (own) return own;
    const base: Row = {};
    for (const f of SERIES_FIELDS) if (m[f] !== undefined) base[f] = structuredClone(m[f]);
    return { ...base, status: 'confirmed', ...s, recurringEventId: m.id };
  });
  const strays = exceptions.filter((e) => !slots.some((s) => s.id === e.id));
  return [...slots, ...strays];
}

function findEvent(cal: string, id: string): Row | undefined {
  const own = stored(cal, id);
  if (own) return own;
  const masterId = id.split('_')[0];
  const m = stored(cal, masterId);
  if (!m || masterId === id) return undefined;
  return instancesOf(cal, m).find((i) => i.id === id);
}

const instantOf = (s: Row | undefined, zone: string) => (s?.dateTime ? new Date(s.dateTime) : s?.date ? fromZonedTime(`${s.date}T00:00:00`, zone) : null);

function serve(req: Req): Answer {
  const seg = req.path.split('/').filter(Boolean).map(decodeURIComponent);
  if (seg[0] === 'users') {
    if (seg.length === 3) {
      const items = [...cals.entries()].map(([id, c]) => ({ id, ...c }));
      return { status: 200, data: { items } };
    }
    const c = cals.get(seg[3]);
    return c ? { status: 200, data: { id: seg[3], ...c } } : fail(404, 'notFound', 'Not Found');
  }
  const cal = seg[1];
  const meta = cals.get(cal);
  if (!meta) return fail(404, 'notFound', 'Not Found');
  const writable = ['owner', 'writer'].includes(meta.accessRole);
  const id = seg[3];
  const tail = seg[4];
  if (req.method !== 'GET' && !writable) return fail(403, 'requiredAccessLevel', 'You need to have writer access to this calendar.');
  if (!id && req.method === 'POST') {
    if (req.body?.recurrence?.length && req.body.start?.dateTime && !req.body.start.timeZone) return fail(400, 'invalid', 'Missing time zone definition for start time.');
    for (const line of req.body?.recurrence ?? []) if (!/^(RRULE|EXDATE|RDATE)[:;]/i.test(line)) return fail(400, 'invalid', 'bad line');
    const nid = `new${++seq}`;
    const ev = { ...structuredClone(req.body), id: nid, iCalUID: `${nid}@google.com`, status: 'confirmed', htmlLink: `https://calendar.google.com/event?eid=${nid}`, organizer: { email: cal, self: true } };
    if (!evs.has(cal)) evs.set(cal, new Map());
    eventsOf(cal).set(nid, ev);
    return { status: 200, data: ev };
  }
  if (!id && req.method === 'GET') {
    let list = [...eventsOf(cal).values()];
    if (req.params.iCalUID) list = list.filter((e) => e.iCalUID === req.params.iCalUID);
    const props = ([] as string[]).concat(req.params.privateExtendedProperty ?? []);
    for (const p of props) {
      const [k, v] = String(p).split('=');
      list = list.filter((e) => e.extendedProperties?.private?.[k] === v);
    }
    if (!req.params.showDeleted || req.params.showDeleted === 'false') list = list.filter((e) => e.status !== 'cancelled');
    return { status: 200, data: { items: structuredClone(list) } };
  }
  if (tail === 'instances') {
    const m = stored(cal, id);
    if (!m || !m.recurrence) return fail(404, 'notFound', 'Not Found');
    let list = instancesOf(cal, m);
    if (!req.params.showDeleted) list = list.filter((i) => i.status !== 'cancelled');
    const zone = m.start.timeZone ?? meta.timeZone;
    if (req.params.timeMin) list = list.filter((i) => instantOf(i.end, zone)! > new Date(req.params.timeMin));
    if (req.params.timeMax) list = list.filter((i) => instantOf(i.start, zone)! < new Date(req.params.timeMax));
    if (req.params.originalStart && !ignoreOriginalStart) {
      const want = String(req.params.originalStart);
      list = list.filter((i) => (i.originalStartTime?.date ? i.originalStartTime.date === want : new Date(i.originalStartTime.dateTime).getTime() === new Date(want).getTime()));
    }
    if (req.params.maxResults) list = list.slice(0, Number(req.params.maxResults));
    return { status: 200, data: { items: structuredClone(list) } };
  }
  if (req.method === 'GET') {
    const ev = findEvent(cal, id);
    if (!ev) return gone.has(`${cal}|${id}`) ? fail(410, 'deleted', 'Resource has been deleted') : fail(404, 'notFound', 'Not Found');
    return { status: 200, data: structuredClone(ev) };
  }
  if (req.method === 'PATCH') {
    const ev = findEvent(cal, id);
    if (!ev) return fail(404, 'notFound', 'Not Found');
    if (ev.recurringEventId && req.body?.recurrence) return fail(400, 'invalid', 'An instance has no recurrence.');
    const next = { ...structuredClone(ev), ...structuredClone(req.body ?? {}) };
    eventsOf(cal).set(id, next);
    return { status: 200, data: next };
  }
  if (req.method === 'DELETE') {
    const ev = findEvent(cal, id);
    if (!ev || ev.status === 'cancelled') return gone.has(`${cal}|${id}`) ? fail(410, 'deleted', 'Resource has been deleted') : fail(404, 'notFound', 'Not Found');
    if (ev.recurringEventId) {
      eventsOf(cal).set(id, { ...ev, status: 'cancelled' });
    } else {
      for (const e of [...eventsOf(cal).values()]) if (e.id === id || e.recurringEventId === id) eventsOf(cal).delete(e.id);
    }
    gone.add(`${cal}|${id}`);
    return { status: 204, data: '' };
  }
  return fail(400, 'invalid', `unknown ${req.method} ${req.path}`);
}

const calendarRequire = createRequire(nodeRequire.resolve('@googleapis/calendar'));
const gaxiosModule = calendarRequire('gaxios') as { Gaxios: { prototype: { _defaultAdapter: (opts: Row) => Promise<unknown> } } };

function installFakeGoogle(): void {
  const authGaxios = createRequire(calendarRequire.resolve('google-auth-library'))('gaxios');
  const commonGaxios = createRequire(calendarRequire.resolve('googleapis-common'))('gaxios');
  if (authGaxios !== gaxiosModule || commonGaxios !== gaxiosModule) {
    console.error('FAIL  the Google client loads more than one gaxios; refusing to run without the fake');
    process.exit(1);
  }
  gaxiosModule.Gaxios.prototype._defaultAdapter = async function (opts: Row) {
    const url = new URL(String(opts.url));
    let answer: Answer;
    if (`${url.origin}${url.pathname}` === TOKEN_URL) {
      answer = { status: 200, data: { access_token: 'fake-access', expires_in: 3600, token_type: 'Bearer' } };
    } else {
      if (!url.href.startsWith(API)) throw new Error(`unexpected URL ${url.href}`);
      const params: Row = { ...Object.fromEntries(url.searchParams), ...(opts.params ?? {}) };
      const body = typeof opts.data === 'string' ? JSON.parse(opts.data) : opts.data;
      const req: Req = { method: String(opts.method ?? 'GET').toUpperCase(), path: url.pathname.slice('/calendar/v3'.length), params, body: body === undefined ? undefined : structuredClone(body) };
      calls.push(req);
      const rule = rules.find((r) => r.left > 0 && r.match(req));
      if (rule) {
        rule.left--;
        if (rule.apply) serve(req);
        answer = rule.answer;
      } else {
        answer = serve(req);
      }
    }
    return { config: opts, data: answer.data, headers: {}, status: answer.status, statusText: String(answer.status), request: { responseURL: String(opts.url) } };
  };
}

// ================= Fake Prisma: in memory, transactions that roll back =================

const tables: Record<string, Row[]> = {};
const COMPOUND_KEYS = ['seriesEventId_originalStartsAt'];
const DEFAULTS: Record<string, () => Row> = {
  nativeCalendar: () => ({ color: '#039BE5', labels: [], personName: null, privacy: 'PRIVATE', isDeleted: false }),
  nativeEvent: () => ({ description: null, location: null, allDay: false, rrule: null, hebrewRule: null, hebrewAnchor: null, exdates: [], reminderMinutes: null, ownAlerts: false, alertMinutes: [], isDeleted: false, kind: 'EVENT', forUserId: null, armedAt: null }),
  nativeEventInstance: () => ({ title: null, description: null, location: null, startsAt: null, endsAt: null, allDay: null }),
  nativeReminderState: () => ({ doneAt: null, doneByUserId: null, snoozedUntil: null, lastPingedAt: null, pingAttempts: 0, pingChatId: null, pingMessageId: null }),
};
let nextId = 0;
const prismaCalls: string[] = [];
/**
 * One-shot Prisma failures: `apply` writes first, then throws (the database took it, the answer
 * was lost). Inside a transaction "took it" means it committed: the write stays and the
 * transaction's answer is the one lost.
 */
let dbFailures: { table: string; method: string; when?: (args: Row) => boolean; apply?: boolean; left: number }[] = [];
/** The open transaction's lost answer, thrown once it has committed. */
let inTransaction = false;
let lostCommit: Error | null = null;

const same = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : (a ?? null) === (b ?? null);

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    if (COMPOUND_KEYS.includes(key)) return matches(row, cond as Where);
    const value = row[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return same(value, cond);
    return Object.entries(cond as Where).every(([op, arg]) => {
      switch (op) {
        case 'in': return (arg as unknown[]).some((a) => same(value, a));
        case 'not': return !same(value, arg);
        case 'lt': return value != null && (value as Date) < (arg as Date);
        case 'lte': return value != null && (value as Date) <= (arg as Date);
        case 'gt': return value != null && (value as Date) > (arg as Date);
        case 'gte': return value != null && (value as Date) >= (arg as Date);
        default: throw new Error(`stand-in Prisma does not know '${op}'`);
      }
    });
  });
}

const pick = (row: Row | undefined, select?: Record<string, boolean>) =>
  !row ? null : select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row };

function apply(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const push = value !== null && typeof value === 'object' && Object.hasOwn(value, 'push');
    row[key] = push ? [...(row[key] as unknown[]), (value as { push: unknown }).push] : value;
  }
  row.updatedAt = new Date();
}

function table(name: string) {
  const find = (where?: Where) => tables[name].filter((r) => !where || matches(r, where));
  const insert = (data: Row) => {
    const row: Row = { id: `${name}-${++nextId}`, ...DEFAULTS[name]?.(), createdAt: new Date() };
    apply(row, data);
    tables[name].push(row);
    return { ...row };
  };
  type Args = { where?: Where; select?: Record<string, boolean>; orderBy?: Array<Record<string, 'asc' | 'desc'>>; data?: Row };
  const rec = <T>(method: string, args: Row, fn: () => T) => {
    prismaCalls.push(`${name}.${method}`);
    const f = dbFailures.find((x) => x.left > 0 && x.table === name && x.method === method && (!x.when || x.when(args)));
    if (f) {
      f.left--;
      const error = Object.assign(new Error(`stand-in ${name}.${method} failed (Zebra Private Title)`), { code: 'P1001' });
      if (f.apply && inTransaction) {
        lostCommit = error;
        return fn();
      }
      if (f.apply) fn();
      throw error;
    }
    return fn();
  };
  return {
    findUnique: async (a: Args) => rec('findUnique', a, () => pick(find(a.where)[0], a.select)),
    findFirst: async (a: Args) => rec('findFirst', a, () => pick(find(a.where)[0], a.select)),
    findMany: async (a: Args = {}) => rec('findMany', a, () => {
      const rows = [...find(a.where)];
      for (const order of [...(a.orderBy ?? [])].reverse()) {
        const [[key, dir]] = Object.entries(order);
        rows.sort((x, y) => ((x[key] as Date) > (y[key] as Date) ? 1 : (x[key] as Date) < (y[key] as Date) ? -1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      return rows.map((r) => pick(r, a.select));
    }),
    create: async (a: Args) => rec('create', a, () => insert(a.data!)),
    update: async (a: Args) => rec('update', a, () => {
      const row = find(a.where)[0];
      if (!row) throw new Error(`stand-in ${name}.update: no row matches ${JSON.stringify(a.where)}`);
      apply(row, a.data!);
      return { ...row };
    }),
    updateMany: async (a: Args) => rec('updateMany', a, () => {
      const rows = find(a.where);
      rows.forEach((r) => apply(r, a.data!));
      return { count: rows.length };
    }),
    deleteMany: async (a: Args) => rec('deleteMany', a, () => {
      const before = tables[name].length;
      tables[name] = tables[name].filter((r) => !a.where || !matches(r, a.where));
      return { count: before - tables[name].length };
    }),
  };
}

const fakePrisma: Row = {
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const snapshot = structuredClone(tables);
    inTransaction = true;
    lostCommit = null;
    try {
      const out = await fn(fakePrisma);
      if (lostCommit) throw lostCommit; // committed, the answer lost: the writes stay
      return out;
    } catch (err) {
      if (err !== lostCommit) for (const k of Object.keys(snapshot)) tables[k] = snapshot[k];
      throw err;
    } finally {
      inTransaction = false;
      lostCommit = null;
    }
  },
};
// googleSyncLink: no calendar here is copied to Google (google-sync spec §2), so the store's marks find no link.
for (const name of ['user', 'pairing', 'nativeCalendar', 'nativeEvent', 'nativeEventInstance', 'nativeReminderState', 'adminSettings', 'googleSyncLink']) {
  tables[name] = [];
  fakePrisma[name] = table(name);
}

// ================= Fake Redis (NX, a failure switch), recorders =================

const redisStore = new Map<string, string>();
let redisDown: 'set' | 'del' | null = null;
const redisImpl: Row = {
  get: async (k: string) => redisStore.get(k) ?? null,
  set: async (k: string, v: unknown, o?: { nx?: boolean }) => {
    if (redisDown === 'set') throw new Error('Redis unreachable');
    if (o?.nx && redisStore.has(k)) return null;
    redisStore.set(k, String(v));
    return 'OK';
  },
  del: async (k: string) => {
    if (redisDown === 'del') throw new Error('Redis unreachable');
    return redisStore.delete(k) ? 1 : 0;
  },
};
const fakeRedis = new Proxy(redisImpl, { get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? (async () => null)) });
class FakeUpstash {
  async set() { return 'OK'; }
  async get() { return null; }
}

const captured: { ctx: string; extra: Row | undefined; message: string; severity?: string }[] = [];
const tracked: { userId: number; action: string; meta: Row }[] = [];
const consoleLines: string[] = [];

// ================= Boundaries: stubs served to import() by a load hook =================

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

function stubFile(filename: string, exports: Row) {
  stubs[filename] = exports;
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  Module._cache[filename] = mod;
}
const stub = (rel: string, exports: Row) => stubFile(path.join(ROOT, rel), exports);

const recorder = (): Row =>
  new Proxy({} as Row, { get: (_t, p) => (typeof p !== 'string' || p === 'then' ? undefined : async () => ({ message_id: 1 })) });

function installStubs() {
  stubFile(nodeRequire.resolve('@upstash/redis'), { Redis: FakeUpstash });
  stub('src/utils/prisma.ts', { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() });
  stub('src/utils/redis.ts', { redis: fakeRedis });
  stub('src/lib/error-capture.ts', {
    captureError: (e: unknown, ctx: string, extra?: Row, severity?: string) => { captured.push({ ctx, extra, message: e instanceof Error ? e.message : String(e), severity }); },
    captureWarning: () => undefined,
    captureInfo: () => undefined,
  });
  stub('src/lib/timezone.ts', { resolveUserTimezone: async () => IL, resolveTimezoneForLocation: async () => null });
  const telegram = { getBot: () => recorder(), initBot: () => recorder(), getMessagingService: () => recorder(), setUserMenuButton: async () => undefined };
  stub('src/services/telegram/index.ts', telegram);
  stub('src/services/telegram/bot.ts', telegram);
  const messaging = {
    ...nodeRequire(path.join(ROOT, 'src/services/messaging/types.ts')),
    getMessagingService: () => recorder(), getTelegramService: () => recorder(), getWhatsAppService: () => recorder(),
    detectPlatform: () => 'telegram',
  };
  stub('src/services/messaging/index.ts', messaging);
  stub('src/services/messaging/factory.ts', messaging);
  stub('src/services/analytics-service.ts', {
    trackActivityAsync: (userId: number, action: string, meta: Row) => { tracked.push({ userId, action, meta }); },
    trackActivity: async () => undefined,
  });
  stub('src/services/native-reminders/moved-pings.ts', { stripMovedPings: async () => undefined, movedWhen: () => '' });
  const allowed = async () => ({ allowed: true });
  stub('src/services/subscription-service.ts', { checkFeatureAccess: allowed, peekFeatureAccess: allowed });
  stub('src/services/hebrew-holidays.ts', { getHolidaysForDate: async () => [] });
}

// ================= Fixtures =================

const NOA = 7;
const DAN = 8;
const PAIRING = 'pair-7-8';
const NOA_CAL = 'noa@gmail.com';
const FAMILY = 'family@group.calendar.google.com';
const HOLIDAYS = 'en.jewish#holiday@group.v.calendar.google.com';
const SECRET = 'Zebra Private Title';

const ASSIGNMENTS = [
  { calendarId: NOA_CAL, labels: ['primary', 'yours'], name: 'Noa', color: '#7986cb' },
  { calendarId: FAMILY, labels: ['kids'], name: 'Family', color: '#33b679' },
  { calendarId: HOLIDAYS, labels: [], name: 'Holidays', color: '#16a765' },
];

function baseUser(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'female', language: 'en', location: 'Tel Aviv', culture: 'default',
    messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null, calendarSource: 'NATIVE',
    pairingId: null, remindersEnabled: false, suspendedAt: null, unreachableSince: null, whatsappPhone: null,
    whatsappBsuid: null, telegramId: null, isAdmin: false, globalRules: [], createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...o,
  };
}
function cal(id: string, ownerUserId: number, privacy: string, labels: string[], name: string, createdAt = '2026-01-01T00:00:00Z'): Row {
  return { ...DEFAULTS.nativeCalendar(), id, ownerUserId, name, privacy, labels, createdAt: new Date(createdAt), updatedAt: new Date(createdAt) };
}
const OLD = new Date('2026-10-01T06:00:00Z');
function seedSeries(id: string, fields: Row): Row {
  const row: Row = { ...DEFAULTS.nativeEvent(), id, calendarId: 'fam-noa', creatorUserId: NOA, title: `Event ${id}`, timeZone: IL, createdAt: OLD, updatedAt: OLD, ...fields };
  row.endsAt ??= new Date(row.startsAt.getTime() + 3_600_000);
  tables.nativeEvent.push(row);
  return row;
}
function seedInstance(seriesEventId: string, originalStartsAt: Date, fields: Row): Row {
  const row: Row = { ...DEFAULTS.nativeEventInstance(), id: `inst-${++nextId}`, seriesEventId, originalStartsAt, createdAt: OLD, updatedAt: OLD, ...fields };
  tables.nativeEventInstance.push(row);
  return row;
}
/** A stored Google event (master or one-off) on `cal`, its times as wall times in `zone`. */
function gseed(calId: string, id: string, o: { start: string; end?: string; zone?: string; allDay?: boolean; recurrence?: string[]; noZone?: boolean } & Row): Row {
  const { start, end, zone = IL, allDay, recurrence, noZone, ...extra } = o;
  const ev: Row = {
    id, iCalUID: `${id}@google.com`, status: 'confirmed', summary: `Event ${id}`, htmlLink: `https://calendar.google.com/event?eid=${id}`,
    organizer: { email: calId, self: true }, creator: { email: calId, self: true }, eventType: 'default', ...extra,
  };
  if (allDay) {
    ev.start = { date: start };
    ev.end = { date: end ?? new Date(Date.parse(`${start}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) };
  } else {
    const s = at(start, zone);
    const e = end ? at(end, zone) : new Date(s.getTime() + 3_600_000);
    ev.start = { dateTime: dt(s, zone), ...(noZone ? {} : { timeZone: zone }) };
    ev.end = { dateTime: dt(e, zone), ...(noZone ? {} : { timeZone: zone }) };
  }
  if (recurrence) ev.recurrence = recurrence;
  if (!evs.has(calId)) evs.set(calId, new Map());
  eventsOf(calId).set(id, ev);
  return ev;
}
function gseedException(calId: string, slotId: string, fields: Row): Row {
  const inst = findEvent(calId, slotId);
  assert(inst, `no instance ${slotId}`);
  const ev = { ...structuredClone(inst), ...fields };
  eventsOf(calId).set(slotId, ev);
  return ev;
}
const ginst = (masterId: string, local: string, zone = IL) => `${masterId}_${utcStamp(at(local, zone))}`;

function reset() {
  cals.clear();
  evs.clear();
  gone.clear();
  calls.length = 0;
  rules = [];
  ignoreOriginalStart = false;
  seq = 0;
  nextId = 0;
  dbFailures = [];
  redisStore.clear();
  redisDown = null;
  for (const list of [prismaCalls, captured, tracked, consoleLines] as unknown[][]) list.length = 0;
  cals.set(NOA_CAL, { summary: 'noa@gmail.com', accessRole: 'owner', primary: true, timeZone: IL, backgroundColor: '#9fc6e7' });
  cals.set(FAMILY, { summary: 'Family', accessRole: 'writer', timeZone: IL, backgroundColor: '#33b679' });
  cals.set(HOLIDAYS, { summary: 'Jewish Holidays', accessRole: 'reader', timeZone: IL, backgroundColor: '#16a765' });
  tables.user = [
    baseUser({ id: NOA, name: 'Noa', telegramId: BigInt(111), pairingId: PAIRING, googleRefreshToken: 'refresh-token', calendarAssignments: structuredClone(ASSIGNMENTS) }),
    baseUser({ id: DAN, name: 'Dan', telegramId: BigInt(222), pairingId: PAIRING }),
    baseUser({ id: 9, name: 'Solo', telegramId: BigInt(333), googleRefreshToken: 'refresh-token', calendarAssignments: structuredClone(ASSIGNMENTS) }),
  ];
  tables.pairing = [{ id: PAIRING, status: 'ACTIVE', inviterUserId: NOA, inviteeUserId: DAN }];
  tables.nativeCalendar = [
    cal('fam-noa', NOA, 'PRIVATE', ['yours'], 'Noa FamCal'),
    cal('fam-shared', NOA, 'SHARED_EDITOR', ['kids'], 'Kids', '2026-02-01T00:00:00Z'),
    cal('fam-dan', DAN, 'SHARED_EDITOR', ['yours'], 'Dan'),
    cal('fam-solo', 9, 'SHARED_EDITOR', ['yours'], 'Solo FamCal'),
  ];
  tables.nativeEvent = [];
  tables.nativeEventInstance = [];
  tables.nativeReminderState = [];
  tables.adminSettings = [];
}

const userRow = (id: number) => tables.user.find((u) => u.id === id)!;
const eventRow = (id: string) => tables.nativeEvent.find((e) => e.id === id);
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));
const famWrites = () => prismaCalls.filter((c) => /\.(update|updateMany|create|deleteMany)$/.test(c));

async function main() {
  installStubs();
  installFakeGoogle();
  const quiet = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    (console as Row)[level] = (...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')); };
  }

  // Loaded apart: until they exist, their checks fail one by one instead of the whole run.
  const missing = (name: string) => (err: Error) => {
    consoleLines.push(`${name} did not load: ${err.message.split('\n')[0]}`);
    return {} as Row;
  };
  const mapper = await load('src/services/calendar-move/mapper.ts').catch(missing('mapper.ts'));
  const write = await load('src/services/calendar-write/write.ts');
  const info = await load('src/services/calendar-write/item-info.ts');
  const validate = await load('src/services/calendar-write/validate.ts');
  const eventStore = await load('src/services/native-calendar/event-store.ts');
  const recurrence = await load('src/services/native-calendar/recurrence.ts');
  const { writeResponse } = await load('src/services/calendar-write/respond.ts');
  const storeMod = await load('src/lib/calendar-view/store.ts');
  const { htmlToText } = await load('src/utils/html.ts');

  const patchCmd = (raw: Row) => {
    const parsed = validate.parseUpdate(raw);
    assert(parsed.ok, `parseUpdate refused ${show(raw)}: ${show(parsed)}`);
    return parsed.value;
  };
  const move = (userId: number, key: string, calendarId: string, scope = 'all', extra: Row = {}) =>
    write.updateItem(userRow(userId), patchCmd({ key, scope, changes: { calendarId, ...extra } }), IL);
  const editInfo = (userId: number, key: string) => info.itemInfoFor(userRow(userId), validate.parseAnyItemKey(key), IL);
  const gkey = (calId: string, id: string) => `google|${calId}|${id}`;
  const native = (o: Row): Row => {
    const row: Row = { ...DEFAULTS.nativeEvent(), id: 's1', calendarId: 'fam-noa', creatorUserId: NOA, title: 'Dentist', timeZone: IL, createdAt: OLD, updatedAt: OLD, ...o };
    row.endsAt ??= new Date(row.startsAt.getTime() + 3_600_000);
    return row;
  };
  const override = (seriesEventId: string, originalStartsAt: Date, o: Row): Row => ({ ...DEFAULTS.nativeEventInstance(), id: `o-${originalStartsAt.getTime()}`, seriesEventId, originalStartsAt, status: 'OVERRIDE', createdAt: OLD, updatedAt: OLD, ...o });
  const toGoogle = (series: Row, overrides: Row[] = []) => {
    const r = mapper.toGoogleEvent(series, overrides);
    assert(r.ok, `toGoogleEvent refused: ${show(r)}`);
    return r.copy;
  };
  const fromGoogle = (master: Row, listed: Row[] = [], zone = IL) => {
    const r = mapper.fromGoogleEvent(master, listed, zone);
    assert(r.ok, `fromGoogleEvent refused: ${show(r)}`);
    return r.series;
  };
  const isos = (ds: Date[]) => ds.map((d) => d.toISOString());
  /** A FamCal series' slots in a window, as instants, exdates and cancellations applied. */
  const famSlots = (series: Row, overrides: Row[] = [], to = '2027-03-01T00:00:00Z') =>
    isos(recurrence.expandSeries(series, { from: new Date('2026-01-01T00:00:00Z'), to: new Date(to) }, overrides).map((i: Row) => i.instanceStartsAt));
  /** A Google copy's visible instances' original starts, as the fake expands it. */
  const googleSlots = (calId: string, id: string) =>
    isos(instancesOf(calId, stored(calId, id)!).filter((i) => i.status !== 'cancelled').map((i) => (i.originalStartTime.dateTime ? new Date(i.originalStartTime.dateTime) : dayStartOf(i.originalStartTime.date))));

  // ================= The mapper, FamCal → Google =================

  await check('mapper F→G: a timed one-off keeps title, place and notes, its zone on start and end, and the marker; nothing else', async () => {
    const copy = toGoogle(native({ location: 'Clinic', description: 'Bring the card', startsAt: at('2026-10-20T10:00:00'), endsAt: at('2026-10-20T11:30:00') }));
    assertSame(copy.event, {
      summary: 'Dentist', description: 'Bring the card', location: 'Clinic',
      start: { dateTime: '2026-10-20T07:00:00.000Z', timeZone: IL }, end: { dateTime: '2026-10-20T08:30:00.000Z', timeZone: IL },
      extendedProperties: { private: { famcalMovedFrom: 's1' } },
    }, 'event');
    assertSame(copy.exceptions, [], 'no exceptions');
  });

  await check('mapper F→G: an all-day item ends on the exclusive next day (a two-day one, in its own zone)', async () => {
    const copy = toGoogle(native({ allDay: true, timeZone: NY, startsAt: dayStartOf('2026-10-20', NY), endsAt: dayEndOf('2026-10-21', NY) }));
    assertSame([copy.event.start, copy.event.end], [{ date: '2026-10-20', timeZone: NY }, { date: '2026-10-22', timeZone: NY }], 'dates');
  });

  await check('mapper F→G: a timed series carries its exdates and cancellations as one TZID line, and each override as an exception found by its original start', async () => {
    const series = native({ id: 'wk', title: 'Team sync', rrule: 'FREQ=WEEKLY', startsAt: at('2026-10-06T10:00:00'), exdates: [at('2026-10-13T10:00:00')] });
    const rows = [
      override('wk', at('2026-10-20T10:00:00'), { status: 'CANCELLED' }),
      override('wk', at('2026-10-27T10:00:00'), { title: 'Moved sync', startsAt: at('2026-10-28T11:00:00'), endsAt: at('2026-10-28T12:00:00') }),
    ];
    const copy = toGoogle(series, rows);
    assertSame(copy.event.recurrence, ['RRULE:FREQ=WEEKLY', 'EXDATE;TZID=Asia/Jerusalem:20261013T100000,20261020T100000'], 'recurrence');
    assertSame(copy.exceptions.map((x: Row) => [x.slot.toISOString(), x.originalStart, x.patch]), [[
      '2026-10-27T08:00:00.000Z', '2026-10-27T08:00:00.000Z',
      { summary: 'Moved sync', start: { dateTime: '2026-10-28T09:00:00.000Z', timeZone: IL }, end: { dateTime: '2026-10-28T10:00:00.000Z', timeZone: IL } },
    ]], 'exceptions');
  });

  await check('mapper F→G: an all-day series carries VALUE=DATE exdates and keeps a date UNTIL; a date-time UNTIL becomes its date', async () => {
    const series = native({ id: 'ad', allDay: true, rrule: 'FREQ=WEEKLY;UNTIL=20261124', startsAt: dayStartOf('2026-11-03'), endsAt: dayEndOf('2026-11-03'), exdates: [dayStartOf('2026-11-10')] });
    const copy = toGoogle(series, [override('ad', dayStartOf('2026-11-17'), { status: 'CANCELLED' })]);
    assertSame(copy.event.recurrence, ['RRULE:FREQ=WEEKLY;UNTIL=20261124', 'EXDATE;VALUE=DATE:20261110,20261117'], 'recurrence');
    assertSame([copy.event.start, copy.event.end], [{ date: '2026-11-03', timeZone: IL }, { date: '2026-11-04', timeZone: IL }], 'dates');
    const cut = toGoogle(native({ ...series, rrule: 'FREQ=WEEKLY;UNTIL=20261116T235959' }));
    assertSame(cut.event.recurrence, ['RRULE:FREQ=WEEKLY;UNTIL=20261116', 'EXDATE;VALUE=DATE:20261110'], 'a floating UNTIL on an all-day series');
  });

  await check('mapper F→G: every UNTIL form of a timed series becomes UTC, across DST (Israel 25 Oct, New York 1 Nov)', async () => {
    const daily = (rrule: string, o: Row = {}) => toGoogle(native({ id: 'd', rrule, startsAt: at('2026-10-20T10:00:00'), ...o })).event.recurrence[0];
    assertSame(daily('FREQ=DAILY;UNTIL=20261030T100000'), 'RRULE:FREQ=DAILY;UNTIL=20261030T080000Z', 'a floating UNTIL after the change');
    assertSame(daily('FREQ=DAILY;UNTIL=20261022T100000'), 'RRULE:FREQ=DAILY;UNTIL=20261022T070000Z', 'a floating UNTIL before it');
    assertSame(daily('FREQ=DAILY;UNTIL=20261030T100000Z'), 'RRULE:FREQ=DAILY;UNTIL=20261030T080000Z', 'a Z UNTIL, which FamCal reads as wall time');
    assertSame(daily('FREQ=DAILY;UNTIL=20261030'), 'RRULE:FREQ=DAILY;UNTIL=20261030T215959Z', 'a date UNTIL: the end of that day');
    assertSame(daily('FREQ=DAILY;UNTIL=20261022'), 'RRULE:FREQ=DAILY;UNTIL=20261022T205959Z', 'a date UNTIL before the change');
    assertSame(daily('FREQ=DAILY;INTERVAL=2;UNTIL=20261105T090000;WKST=MO', { timeZone: NY, startsAt: at('2026-10-26T09:00:00', NY) }), 'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261105T140000Z;WKST=MO', 'New York, the parts kept in place');
    assertSame(daily('FREQ=DAILY;COUNT=5'), 'RRULE:FREQ=DAILY;COUNT=5', 'a COUNT stays');
  });

  await check('mapper F→G: what can\'t cross is refused (a Hebrew rule; a start that isn\'t a slot; an override on a slot the rule never yields)', async () => {
    const hebrew = mapper.toGoogleEvent(native({ rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary', hebrewAnchor: '2026-10-20', startsAt: at('2026-10-20T10:00:00') }), []);
    assertSame(hebrew, { ok: false, reason: 'hebrew' }, 'hebrew');
    const sunday = mapper.toGoogleEvent(native({ rrule: 'FREQ=WEEKLY;BYDAY=MO', startsAt: at('2026-10-18T10:00:00') }), []);
    assertSame(sunday, { ok: false, reason: 'repeat' }, 'a Sunday start of a Monday rule');
    const series = native({ id: 'wk', rrule: 'FREQ=WEEKLY', startsAt: at('2026-10-06T10:00:00') });
    const stray = mapper.toGoogleEvent(series, [override('wk', at('2026-10-07T10:00:00'), { title: 'x' })]);
    assertSame(stray, { ok: false, reason: 'repeat' }, 'an unyielded override');
    const strayCancel = mapper.toGoogleEvent(series, [override('wk', at('2026-10-07T10:00:00'), { status: 'CANCELLED' })]);
    assert(strayCancel.ok && strayCancel.copy.event.recurrence.length === 1, `an unyielded cancellation is nothing to cancel: ${show(strayCancel)}`);
    assertSame(mapper.famcalCrossRefusal(series, []), null, 'a plain weekly crosses');
    assertSame(mapper.famcalCrossRefusal(native({ rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary', hebrewAnchor: '2026-10-20', startsAt: at('2026-10-20T10:00:00') }), []), 'hebrew', 'a Hebrew series');
  });

  // ================= The mapper, Google → FamCal =================

  const gmaster = (o: Row = {}): Row => ({
    id: 'gw', iCalUID: 'gw@google.com', status: 'confirmed', summary: 'Team sync', eventType: 'default', organizer: { self: true },
    start: { dateTime: '2026-10-06T10:00:00+03:00', timeZone: IL }, end: { dateTime: '2026-10-06T11:00:00+03:00', timeZone: IL }, ...o,
  });

  await check('mapper G→F: a timed series: a Z UNTIL becomes floating local time; EXDATE in every form becomes exactly the slots FamCal yields', async () => {
    const m = gmaster({
      recurrence: [
        'RRULE:FREQ=WEEKLY;UNTIL=20261117T075959Z',
        'EXDATE;TZID=Asia/Jerusalem:20261013T100000,20261020T100000',
        'EXDATE:20261103T080000Z',
        'EXDATE;VALUE=DATE:20261110',
      ],
    });
    const s = fromGoogle(m);
    assertSame([s.rrule, s.timeZone, s.allDay, s.startsAt.toISOString(), s.endsAt.toISOString()], ['FREQ=WEEKLY;UNTIL=20261117T095959', IL, false, '2026-10-06T07:00:00.000Z', '2026-10-06T08:00:00.000Z'], 'series');
    assertSame(isos(s.exdates), ['2026-10-13T07:00:00.000Z', '2026-10-20T07:00:00.000Z', '2026-11-03T08:00:00.000Z', '2026-11-10T08:00:00.000Z'], 'exdates');
    const row = native({ ...s, id: 'copy' });
    assertSame(famSlots(row), ['2026-10-06T07:00:00.000Z', '2026-10-27T08:00:00.000Z'], 'FamCal shows what Google shows');
  });

  await check('mapper G→F: exceptions: a modified one is an override, a cancelled one an exdate; strays, another master\'s and a cancelled master are dropped', async () => {
    const m = gmaster({ recurrence: ['RRULE:FREQ=WEEKLY;COUNT=6'] });
    const exc = (slot: string, o: Row) => ({ id: `gw_${utcStamp(new Date(slot))}`, recurringEventId: 'gw', iCalUID: 'gw@google.com', originalStartTime: { dateTime: slot, timeZone: IL }, status: 'confirmed', summary: 'Team sync', ...o });
    const listed = [
      m,
      exc('2026-10-27T10:00:00+02:00', { summary: 'Moved sync', location: 'Room 2', start: { dateTime: '2026-10-28T11:00:00+02:00', timeZone: IL }, end: { dateTime: '2026-10-28T12:00:00+02:00', timeZone: IL } }),
      exc('2026-11-10T10:00:00+02:00', { status: 'cancelled' }),
      exc('2026-10-07T10:00:00+03:00', { summary: 'Stray', start: { dateTime: '2026-10-07T10:00:00+03:00' }, end: { dateTime: '2026-10-07T11:00:00+03:00' } }),
      { ...exc('2026-10-13T10:00:00+03:00', { summary: 'Other' }), recurringEventId: 'other' },
      { ...gmaster({ id: 'old', status: 'cancelled', recurrence: ['RRULE:FREQ=DAILY'] }) },
    ];
    const s = fromGoogle(m, listed);
    assertSame(isos(s.exdates), ['2026-11-10T08:00:00.000Z'], 'the cancelled exception');
    assertSame(s.overrides.map((o: Row) => ({ ...o, originalStartsAt: o.originalStartsAt.toISOString(), startsAt: o.startsAt?.toISOString(), endsAt: o.endsAt?.toISOString() })), [
      { originalStartsAt: '2026-10-27T08:00:00.000Z', title: 'Moved sync', description: null, location: 'Room 2', startsAt: '2026-10-28T09:00:00.000Z', endsAt: '2026-10-28T10:00:00.000Z', allDay: false },
    ], 'overrides');
  });

  await check('mapper G→F: an all-day series ends at 23:59 on the day before Google\'s exclusive end, its exceptions too; the zone falls back on the calendar\'s; notes become text', async () => {
    const m = gmaster({ start: { date: '2026-11-03' }, end: { date: '2026-11-05' }, description: '<b>Bring</b> the&nbsp;card<br>now', recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20261201', 'EXDATE;VALUE=DATE:20261110'] });
    const exc = { id: 'gw_20261117', recurringEventId: 'gw', originalStartTime: { date: '2026-11-17' }, status: 'confirmed', summary: 'Team sync', description: m.description, start: { date: '2026-11-18' }, end: { date: '2026-11-19' } };
    const s = fromGoogle(m, [exc], NY);
    assertSame([s.timeZone, s.allDay, s.startsAt.toISOString(), s.endsAt.toISOString(), s.rrule, s.description], [NY, true, dayStartOf('2026-11-03', NY).toISOString(), dayEndOf('2026-11-04', NY).toISOString(), 'FREQ=WEEKLY;UNTIL=20261201', htmlToText(m.description)], 'series');
    assertSame(isos(s.exdates), [dayStartOf('2026-11-10', NY).toISOString()], 'exdate at 00:00 local');
    assertSame(s.overrides.map((o: Row) => [o.originalStartsAt.toISOString(), o.startsAt?.toISOString(), o.endsAt?.toISOString(), o.allDay, o.description]), [
      [dayStartOf('2026-11-17', NY).toISOString(), dayStartOf('2026-11-18', NY).toISOString(), dayEndOf('2026-11-18', NY).toISOString(), true, null],
    ], 'the exception moved a day, notes inherited');
    const one = fromGoogle(gmaster({ start: { dateTime: '2026-10-20T10:00:00-04:00' }, end: { dateTime: '2026-10-20T11:00:00-04:00' } }), [], NY);
    assertSame([one.rrule, one.timeZone, one.exdates.length, one.overrides.length], [null, NY, 0, 0], 'a one-off with no zone of its own');
  });

  await check('mapper G→F: what can\'t cross is refused: RDATE, EXRULE, two rules, an unreadable EXDATE, a start that isn\'t a slot, a rule FamCal can\'t keep; a call or files', async () => {
    const refused = (recurrence: string[], o: Row = {}) => show(mapper.fromGoogleEvent(gmaster({ recurrence, ...o }), [], IL));
    const no = show({ ok: false, reason: 'repeat' });
    assertSame(refused(['RRULE:FREQ=WEEKLY', 'RDATE;TZID=Asia/Jerusalem:20261008T100000']), no, 'RDATE');
    assertSame(refused(['RRULE:FREQ=WEEKLY', 'EXRULE:FREQ=MONTHLY']), no, 'EXRULE');
    assertSame(refused(['RRULE:FREQ=WEEKLY', 'RRULE:FREQ=DAILY']), no, 'two rules');
    assertSame(refused(['RRULE:FREQ=WEEKLY', 'EXDATE;TZID=Asia/Jerusalem:soon']), no, 'an unreadable EXDATE');
    assertSame(refused(['RRULE:FREQ=WEEKLY', 'EXDATE;VALUE=PERIOD:20261013T100000Z/PT1H']), no, 'a PERIOD EXDATE');
    assertSame(refused(['RRULE:FREQ=WEEKLY;BYDAY=WE']), no, 'a Tuesday start of a Wednesday rule');
    assertSame(refused(['RRULE:FREQ=HOURLY']), no, 'an hourly rule');
    assertSame(refused(['RRULE:FREQ=WEEKLY;BYSETPOS=1;BYDAY=TU']), no, 'BYSETPOS');
    assertSame(mapper.googleCrossRefusal(gmaster({ conferenceData: { entryPoints: [{ uri: 'https://meet.google.com/x' }] } })), 'meet', 'Meet');
    assertSame(mapper.googleCrossRefusal(gmaster({ attachments: [{ fileUrl: 'https://drive.google.com/x' }] })), 'meet', 'files');
    assertSame(mapper.googleCrossRefusal(gmaster({ recurrence: ['RRULE:FREQ=WEEKLY', 'RDATE:20261008T070000Z'] })), 'repeat', 'the edit info sees an RDATE');
    assertSame(mapper.googleCrossRefusal(gmaster({ recurrence: ['RRULE:FREQ=WEEKLY'] })), null, 'a plain weekly crosses');
  });

  await check('mapper: a series goes F→G→F with the same slots, exdates and overrides', async () => {
    const series = native({ id: 'rt', rrule: 'FREQ=DAILY;UNTIL=20261031', startsAt: at('2026-10-20T10:00:00'), exdates: [at('2026-10-24T10:00:00')] });
    const rows = [override('rt', at('2026-10-27T10:00:00'), { title: 'Late', startsAt: at('2026-10-27T13:00:00'), endsAt: at('2026-10-27T14:00:00') })];
    const copy = toGoogle(series, rows);
    const master = { ...copy.event, id: 'rt-g', iCalUID: 'rt-g@google.com', status: 'confirmed' };
    const exception = { ...copy.exceptions[0].patch, id: 'rt-g_x', recurringEventId: 'rt-g', status: 'confirmed', originalStartTime: { dateTime: copy.exceptions[0].originalStart, timeZone: IL } };
    const back = fromGoogle(master, [master, { ...master, ...exception }]);
    const backRow = native({ ...back, id: 'rt' });
    const backRows = back.overrides.map((o: Row) => override('rt', o.originalStartsAt, o));
    assertSame(famSlots(backRow, backRows), famSlots(series, rows), 'slots');
    assertSame([backRow.rrule, backRows[0].title, backRows[0].startsAt.toISOString()], ['FREQ=DAILY;UNTIL=20261031T235959', 'Late', at('2026-10-27T13:00:00').toISOString()], 'rule and override');
  });

  // ================= The store: createNativeSeries =================

  await check('createNativeSeries: the series, its exdates and its overrides in one transaction; a failed override row leaves nothing', async () => {
    const input = {
      calendarCuid: 'fam-noa', creatorUserId: NOA, title: 'Team sync', startsAt: at('2026-10-06T10:00:00'), endsAt: at('2026-10-06T11:00:00'), allDay: false, timeZone: IL,
      rrule: 'FREQ=WEEKLY', exdates: [at('2026-10-13T10:00:00')],
      overrides: [{ originalStartsAt: at('2026-10-20T10:00:00'), title: 'Moved', description: null, location: null, startsAt: at('2026-10-21T10:00:00'), endsAt: at('2026-10-21T11:00:00'), allDay: false }],
    };
    const made = await eventStore.createNativeSeries(input);
    assertSame([made.rrule, isos(made.exdates), made.kind], ['FREQ=WEEKLY', [at('2026-10-13T10:00:00').toISOString()], 'EVENT'], 'series');
    assertSame(tables.nativeEventInstance.map((r) => [r.seriesEventId, r.status, r.title, r.originalStartsAt.toISOString()]), [[made.id, 'OVERRIDE', 'Moved', at('2026-10-20T10:00:00').toISOString()]], 'override');
    reset();
    dbFailures.push({ table: 'nativeEventInstance', method: 'create', left: 1 });
    let threw = false;
    try { await eventStore.createNativeSeries(input); } catch { threw = true; }
    assertSame([threw, tables.nativeEvent.length, tables.nativeEventInstance.length], [true, 0, 0], 'rolled back');
    reset();
    let denied: unknown;
    try { await eventStore.createNativeSeries({ ...input, calendarCuid: 'fam-solo' }); } catch (e) { denied = e; }
    assert(denied instanceof eventStore.NativePermissionDeniedError, `another's calendar: ${denied}`);
  });

  // ================= The move, FamCal → Google =================

  await check('F→G: a one-off: the copy in Google with the marker, then the original deleted; the key is the copy\'s; analytics; no title in a log', async () => {
    seedSeries('ev1', { title: SECRET, location: 'Clinic', startsAt: at('2026-10-20T10:00:00') });
    const r = await move(NOA, 'famcal|ev1', NOA_CAL, 'single');
    assertSame(r, { status: 'ok', key: gkey(NOA_CAL, 'new1') }, 'result');
    const copy = stored(NOA_CAL, 'new1')!;
    assertSame([copy.summary, copy.location, copy.extendedProperties], [SECRET, 'Clinic', { private: { famcalMovedFrom: 'ev1' } }], 'copy');
    assertSame(eventRow('ev1')!.isDeleted, true, 'original deleted');
    assertSame(tracked.filter((t) => t.action === 'calendar_item_moved').map((t) => t.meta), [{ from: 'famcal', to: 'google', recurring: false, source: 'app' }], 'analytics');
    assert(![...redisStore.keys()].some((k) => k.startsWith('calendar-move:lock:')), `the lock stayed: ${[...redisStore.keys()]}`);
    assert(!show([consoleLines, captured, tracked]).includes(SECRET), 'a title leaked');
  });

  await check('F→G: a timed series with exdates, a cancellation and an override: the copy shows what FamCal showed; the key is the opened occurrence\'s instance', async () => {
    const s = seedSeries('wk', { title: 'Team sync', rrule: 'FREQ=WEEKLY;UNTIL=20261124T100000', startsAt: at('2026-10-06T10:00:00'), exdates: [at('2026-10-13T10:00:00')] });
    seedInstance('wk', at('2026-10-20T10:00:00'), { status: 'CANCELLED' });
    seedInstance('wk', at('2026-10-27T10:00:00'), { status: 'OVERRIDE', title: 'Moved sync', startsAt: at('2026-10-28T11:00:00'), endsAt: at('2026-10-28T12:00:00') });
    const want = famSlots(s, tables.nativeEventInstance);
    const r = await move(NOA, `famcal|wk#${at('2026-11-03T10:00:00').toISOString()}`, FAMILY);
    assertSame(r, { status: 'ok', key: gkey(FAMILY, `new1_${utcStamp(at('2026-11-03T10:00:00'))}`) }, 'result');
    assertSame(googleSlots(FAMILY, 'new1'), want, 'slots');
    const ex = stored(FAMILY, `new1_${utcStamp(at('2026-10-27T10:00:00'))}`)!;
    assertSame([ex.summary, ex.start.dateTime], ['Moved sync', '2026-10-28T09:00:00.000Z'], 'the override, on its instance');
    assertSame([eventRow('wk')!.isDeleted, tracked.find((t) => t.action === 'calendar_item_moved')?.meta.recurring], [true, true], 'deleted, recurring');
    assert(calls.some((c) => c.path.endsWith('/instances') && c.params.originalStart === '2026-10-27T08:00:00.000Z'), 'the instance was asked for by its original start');
  });

  await check('F→G: an all-day series and a daily series ending after the DST change keep every occurrence', async () => {
    const ad = seedSeries('ad', { allDay: true, rrule: 'FREQ=WEEKLY;UNTIL=20261124', startsAt: dayStartOf('2026-11-03'), endsAt: dayEndOf('2026-11-03'), exdates: [dayStartOf('2026-11-10')] });
    const wantAd = famSlots(ad);
    assertSame((await move(NOA, `famcal|ad#${dayStartOf('2026-11-03').toISOString()}`, NOA_CAL)).status, 'ok', 'all-day');
    assertSame(googleSlots(NOA_CAL, 'new1'), wantAd, 'all-day slots');
    for (const until of ['20261030T100000', '20261030']) {
      reset();
      const d = seedSeries('d', { rrule: `FREQ=DAILY;UNTIL=${until}`, startsAt: at('2026-10-20T10:00:00') });
      const want = famSlots(d);
      assertSame((await move(NOA, `famcal|d#${at('2026-10-20T10:00:00').toISOString()}`, NOA_CAL)).status, 'ok', until);
      assertSame([googleSlots(NOA_CAL, 'new1'), want.length], [want, 11], `UNTIL=${until}`);
    }
  });

  await check('F→G refusals: a partner\'s event, a reminder, a read-only calendar, a Hebrew series, an unyielded override, other changes, a scope other than all; nothing written', async () => {
    seedSeries('dan1', { calendarId: 'fam-dan', creatorUserId: DAN, startsAt: at('2026-10-20T10:00:00') });
    seedSeries('rem', { kind: 'REMINDER', startsAt: at('2026-10-20T10:00:00'), endsAt: at('2026-10-20T10:00:00') });
    seedSeries('heb', { rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary', hebrewAnchor: '2026-10-20', startsAt: at('2026-10-20T10:00:00') });
    seedSeries('wk', { rrule: 'FREQ=WEEKLY', startsAt: at('2026-10-06T10:00:00') });
    seedInstance('wk', at('2026-10-07T10:00:00'), { status: 'OVERRIDE', title: 'Stray' });
    seedSeries('one', { startsAt: at('2026-10-20T10:00:00') });
    const wk = `famcal|wk#${at('2026-10-06T10:00:00').toISOString()}`;
    prismaCalls.length = 0;
    assertSame(await move(NOA, 'famcal|dan1', NOA_CAL, 'single'), { status: 'invalid', field: 'calendarId' }, 'the partner\'s event never leaves their view');
    assertSame(await move(NOA, 'famcal|rem', NOA_CAL, 'single'), { status: 'invalid', field: 'calendarId' }, 'a reminder has no Calendar row');
    assertSame(await move(NOA, 'famcal|one', HOLIDAYS, 'single'), { status: 'invalid', field: 'calendarId' }, 'a read-only Google calendar');
    assertSame(await move(NOA, `famcal|heb#${at('2026-10-20T10:00:00').toISOString()}`, NOA_CAL), { status: 'invalid', field: 'moveHebrew' }, 'Hebrew');
    assertSame(await move(NOA, wk, NOA_CAL), { status: 'invalid', field: 'moveRepeat' }, 'an unyielded override');
    assertSame(await move(NOA, 'famcal|one', NOA_CAL, 'single', { title: 'New title' }), { status: 'invalid', field: 'moveAlone' }, 'saved alone');
    assertSame(await move(NOA, 'famcal|one', NOA_CAL, 'single', { start: '2026-10-21T10:00' }), { status: 'invalid', field: 'moveAlone' }, 'saved alone: a time');
    tables.nativeEventInstance = [];
    assertSame(await move(NOA, wk, NOA_CAL, 'following'), { status: 'invalid', field: 'scope' }, 'only the whole series');
    assertSame([writes().length, famWrites()], [0, []], 'nothing written');
    assertSame(writeResponse({ status: 'invalid', field: 'moveAlone' }).status, 400, '400');
  });

  await check('F→G compensation: a failed insert or override patch leaves the original alone (the copy deleted); the outcome is failed', async () => {
    seedSeries('wk', { rrule: 'FREQ=WEEKLY;COUNT=4', startsAt: at('2026-10-06T10:00:00') });
    seedInstance('wk', at('2026-10-20T10:00:00'), { status: 'OVERRIDE', title: 'Moved' });
    const key = `famcal|wk#${at('2026-10-06T10:00:00').toISOString()}`;
    failOn((r) => r.method === 'POST', fail(503, 'backendError', 'Backend Error'));
    assertSame(await move(NOA, key, NOA_CAL), { status: 'failed' }, 'insert failed');
    assertSame([eventsOf(NOA_CAL).size, eventRow('wk')!.isDeleted], [0, false], 'nothing in Google, original kept');
    reset();
    seedSeries('wk', { rrule: 'FREQ=WEEKLY;COUNT=4', startsAt: at('2026-10-06T10:00:00') });
    seedInstance('wk', at('2026-10-20T10:00:00'), { status: 'OVERRIDE', title: 'Moved' });
    failOn((r) => r.method === 'PATCH', fail(500, 'backendError', 'Backend Error'));
    assertSame(await move(NOA, key, NOA_CAL), { status: 'failed' }, 'patch failed');
    assertSame([eventsOf(NOA_CAL).size, eventRow('wk')!.isDeleted], [0, false], 'the copy deleted, original kept');
    assert(captured.some((c) => c.ctx.startsWith('calendar-move')), `logged: ${show(captured.map((c) => c.ctx))}`);
  });

  await check('F→G compensation: a failed delete of the original re-reads it: present → the copy goes, "Couldn\'t move"; gone (it applied) → done; unreadable → both kept, "still in"', async () => {
    const one = () => seedSeries('one', { startsAt: at('2026-10-20T10:00:00') });
    const deleting = (a: Row) => a.data?.isDeleted === true;
    one();
    dbFailures.push({ table: 'nativeEvent', method: 'update', when: deleting, left: 1 });
    const r1 = await move(NOA, 'famcal|one', NOA_CAL, 'single');
    assertSame([r1, eventsOf(NOA_CAL).size, eventRow('one')!.isDeleted], [{ status: 'move_failed' }, 0, false], 'present: compensated');
    assertSame(writeResponse(r1).status, 500, 'move_failed answers 500');
    reset();
    one();
    dbFailures.push({ table: 'nativeEvent', method: 'update', when: deleting, left: 1, apply: true });
    assertSame([(await move(NOA, 'famcal|one', NOA_CAL, 'single')).status, eventsOf(NOA_CAL).size], ['ok', 1], 'it applied: done');
    reset();
    one();
    dbFailures.push({ table: 'nativeEvent', method: 'update', when: deleting, left: 1 });
    const reads = { n: 0 };
    dbFailures.push({ table: 'nativeEvent', method: 'findUnique', when: () => ++reads.n >= 3, left: 1 });
    const r3 = await move(NOA, 'famcal|one', NOA_CAL, 'single');
    assertSame([r3, eventsOf(NOA_CAL).size, eventRow('one')!.isDeleted], [{ status: 'ok', key: gkey(NOA_CAL, 'new1'), leftIn: 'Noa FamCal' }, 1, false], 'unreadable: both kept');
    assert(captured.some((c) => c.extra?.copy_id === 'new1' && c.extra?.series_id === 'one'), `both ids sent: ${show(captured.map((c) => c.extra))}`);
    reset();
    one();
    dbFailures.push({ table: 'nativeEvent', method: 'update', when: deleting, left: 1 });
    failOn((r) => r.method === 'DELETE', fail(500, 'backendError', 'Backend Error'), { times: RETRIED });
    const r4 = await move(NOA, 'famcal|one', NOA_CAL, 'single');
    assertSame([r4.status, r4.leftIn, eventsOf(NOA_CAL).size], ['ok', 'Noa FamCal', 1], 'a failed compensation: still in');
  });

  await check('F→G retry: a copy already in the destination (found by famcalMovedFrom) is replaced by a whole new one before the original goes, nothing stale kept; one elsewhere or cancelled is left', async () => {
    seedSeries('wk', { title: 'Team sync', rrule: 'FREQ=WEEKLY;COUNT=5', startsAt: at('2026-10-06T10:00:00'), exdates: [at('2026-10-13T10:00:00')] });
    seedInstance('wk', at('2026-10-20T10:00:00'), { status: 'OVERRIDE', title: 'Moved sync' });
    // The earlier attempt's copy: notes and an override the FamCal series no longer has.
    gseed(NOA_CAL, 'half', { start: '2026-10-06T10:00:00', summary: 'Team sync', description: 'Bring ID', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=5'], extendedProperties: { private: { famcalMovedFrom: 'wk' } } });
    gseedException(NOA_CAL, `half_${utcStamp(at('2026-10-27T10:00:00'))}`, { summary: 'Moved to room 4' });
    gseed(FAMILY, 'elsewhere', { start: '2026-10-06T10:00:00', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=5'], extendedProperties: { private: { famcalMovedFrom: 'wk' } } });
    gseed(NOA_CAL, 'dead', { start: '2026-10-06T10:00:00', status: 'cancelled', extendedProperties: { private: { famcalMovedFrom: 'wk' } } });
    const key = `famcal|wk#${at('2026-10-06T10:00:00').toISOString()}`;
    const r = await move(NOA, key, NOA_CAL);
    assertSame(r, { status: 'ok', key: gkey(NOA_CAL, `new1_${utcStamp(at('2026-10-06T10:00:00'))}`) }, 'a whole new copy');
    const lookup = calls.find((c) => c.method === 'GET' && c.path === `/calendars/${encodeURIComponent(NOA_CAL)}/events`);
    assertSame(String(lookup?.params.privateExtendedProperty), 'famcalMovedFrom=wk', 'looked up by the marker, in the destination');
    const copies = [...eventsOf(NOA_CAL).values()].filter((e) => e.extendedProperties?.private?.famcalMovedFrom === 'wk' && e.status !== 'cancelled' && !e.recurringEventId).map((e) => e.id);
    assertSame(copies, ['new1'], 'one copy in the destination: the earlier one taken back');
    assertSame(stored(NOA_CAL, 'new1')!.recurrence, ['RRULE:FREQ=WEEKLY;COUNT=5', 'EXDATE;TZID=Asia/Jerusalem:20261013T100000'], 'the cancellation applied');
    assertSame(stored(NOA_CAL, `new1_${utcStamp(at('2026-10-20T10:00:00'))}`)?.summary, 'Moved sync', 'the override applied');
    assertSame(stored(NOA_CAL, 'new1')!.description, undefined, 'notes the FamCal series no longer has are not kept');
    assert(![...eventsOf(NOA_CAL).values()].some((e) => e.summary === 'Moved to room 4'), 'an override the FamCal series no longer has is not kept');
    assertSame([eventRow('wk')!.isDeleted, Boolean(stored(FAMILY, 'elsewhere'))], [true, true], 'original gone; the copy elsewhere left');
    reset();
    seedSeries('wk', { rrule: 'FREQ=WEEKLY;COUNT=5', startsAt: at('2026-10-06T10:00:00') });
    gseed(NOA_CAL, 'half', { start: '2026-10-06T10:00:00', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=5'], extendedProperties: { private: { famcalMovedFrom: 'wk' } } });
    failOn((r) => r.method === 'DELETE', fail(500, 'backendError'), { times: RETRIED });
    assertSame([await move(NOA, key, NOA_CAL), Boolean(stored(NOA_CAL, 'half')), eventRow('wk')!.isDeleted], [{ status: 'failed' }, true, false], 'an earlier copy that can\'t be taken back: failed, the original kept');
    assert(!calls.some((c) => c.method === 'POST'), 'no second copy beside it');
  });

  await check('F→G: an override found by the days around its slot when originalStart misses: the patch lands on the instance at the exact slot (timed, all day)', async () => {
    ignoreOriginalStart = true;
    seedSeries('d', { rrule: 'FREQ=DAILY;COUNT=10', startsAt: at('2026-10-20T10:00:00') });
    seedInstance('d', at('2026-10-27T10:00:00'), { status: 'OVERRIDE', title: 'Day eight' });
    const r = await move(NOA, `famcal|d#${at('2026-10-24T10:00:00').toISOString()}`, NOA_CAL);
    assertSame(r, { status: 'ok', key: gkey(NOA_CAL, `new1_${utcStamp(at('2026-10-24T10:00:00'))}`) }, 'timed: the key at the opened slot');
    const titled = () => [...eventsOf(NOA_CAL).values()].filter((e) => e.summary === 'Day eight').map((e) => e.id);
    assertSame(titled(), [`new1_${utcStamp(at('2026-10-27T10:00:00'))}`], 'timed: the override on its own instance only');
    reset();
    ignoreOriginalStart = true;
    seedSeries('ad', { allDay: true, rrule: 'FREQ=DAILY;COUNT=10', startsAt: dayStartOf('2026-10-20'), endsAt: dayEndOf('2026-10-20') });
    seedInstance('ad', dayStartOf('2026-10-27'), { status: 'OVERRIDE', title: 'Day eight' });
    const r2 = await move(NOA, `famcal|ad#${dayStartOf('2026-10-24').toISOString()}`, NOA_CAL);
    assertSame(r2, { status: 'ok', key: gkey(NOA_CAL, 'new1_20261024') }, 'all day: the key at the opened slot');
    assertSame(titled(), ['new1_20261027'], 'all day: the override on its own instance only');
  });

  await check('F→G: a part-way copy that can\'t be taken back is reported with both ids and answers "Couldn\'t move. Try again", never the final refusal', async () => {
    const seedWk = () => {
      seedSeries('wk', { rrule: 'FREQ=WEEKLY;COUNT=4', startsAt: at('2026-10-06T10:00:00') });
      seedInstance('wk', at('2026-10-20T10:00:00'), { status: 'OVERRIDE', title: 'Moved' });
    };
    const key = `famcal|wk#${at('2026-10-06T10:00:00').toISOString()}`;
    const noInstance = () => failOn((r) => r.method === 'GET' && r.path.endsWith('/instances'), { status: 200, data: { items: [] } }, { times: 2 });
    const leftReported = () => captured.some((c) => c.ctx === 'calendar-move-left' && c.extra?.copy_id === 'new1' && c.extra?.series_id === 'wk');
    seedWk();
    noInstance();
    assertSame([await move(NOA, key, NOA_CAL), eventsOf(NOA_CAL).size, eventRow('wk')!.isDeleted, leftReported()], [{ status: 'invalid', field: 'moveRepeat' }, 0, false, false], 'no instance, the copy taken back: the repeat can\'t be moved');
    reset();
    seedWk();
    noInstance();
    failOn((r) => r.method === 'DELETE', fail(500, 'backendError'), { times: RETRIED });
    const r = await move(NOA, key, NOA_CAL);
    assertSame([r, eventsOf(NOA_CAL).size, eventRow('wk')!.isDeleted, leftReported()], [{ status: 'move_failed' }, 1, false, true], 'no instance, the take-back failed');
    reset();
    seedWk();
    failOn((r) => r.method === 'PATCH', fail(500, 'backendError'));
    failOn((r) => r.method === 'DELETE', fail(500, 'backendError'), { times: RETRIED });
    const r2 = await move(NOA, key, NOA_CAL);
    assertSame([r2, eventsOf(NOA_CAL).size, eventRow('wk')!.isDeleted, leftReported()], [{ status: 'move_failed' }, 1, false, true], 'a failed patch, the take-back failed');
  });

  // ================= The move, Google → FamCal =================

  await check('G→F: a series with a cancellation, an override and strays: one FamCal series written whole, then the Google master deleted; the key is famcal|<new>#<opened slot>', async () => {
    gseed(NOA_CAL, 'gw', { start: '2026-10-06T10:00:00', summary: SECRET, location: 'Office', recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20261117T075959Z', 'EXDATE;TZID=Asia/Jerusalem:20261013T100000'] });
    gseedException(NOA_CAL, ginst('gw', '2026-10-27T10:00:00'), { summary: 'Moved sync', start: { dateTime: '2026-10-28T11:00:00+02:00', timeZone: IL }, end: { dateTime: '2026-10-28T12:00:00+02:00', timeZone: IL } });
    gseedException(NOA_CAL, ginst('gw', '2026-11-03T10:00:00'), { status: 'cancelled' });
    eventsOf(NOA_CAL).set('gw_stray', { id: 'gw_stray', recurringEventId: 'gw', iCalUID: 'gw@google.com', status: 'confirmed', summary: 'Stray', originalStartTime: { dateTime: '2026-10-07T10:00:00+03:00' }, start: { dateTime: '2026-10-07T10:00:00+03:00' }, end: { dateTime: '2026-10-07T11:00:00+03:00' } });
    const want = googleSlots(NOA_CAL, 'gw').filter((s) => s !== '2026-10-07T07:00:00.000Z');
    const r = await move(NOA, gkey(NOA_CAL, ginst('gw', '2026-10-20T10:00:00')), 'native:fam-shared');
    const made = tables.nativeEvent[0];
    assertSame(r, { status: 'ok', key: `famcal|${made.id}#${at('2026-10-20T10:00:00').toISOString()}` }, 'result');
    assertSame([made.calendarId, made.title, made.location, made.rrule, made.timeZone, isos(made.exdates)], ['fam-shared', SECRET, 'Office', 'FREQ=WEEKLY;UNTIL=20261117T095959', IL, [at('2026-10-13T10:00:00').toISOString(), at('2026-11-03T10:00:00').toISOString()]], 'series');
    assertSame(tables.nativeEventInstance.map((o) => [o.title, o.originalStartsAt.toISOString(), o.startsAt?.toISOString()]), [['Moved sync', at('2026-10-27T10:00:00').toISOString(), at('2026-10-28T11:00:00').toISOString()]], 'override');
    assertSame(famSlots(made, tables.nativeEventInstance), want, 'FamCal shows what Google showed');
    assertSame(Boolean(stored(NOA_CAL, 'gw')), false, 'the Google master deleted');
    const listed = calls.find((c) => c.method === 'GET' && c.params.iCalUID);
    assertSame([listed?.params.iCalUID, String(listed?.params.singleEvents), String(listed?.params.showDeleted)], ['gw@google.com', 'false', 'true'], 'the exceptions listed by iCalUID');
    assertSame(tracked.filter((t) => t.action === 'calendar_item_moved').map((t) => t.meta), [{ from: 'google', to: 'famcal', recurring: true, source: 'app' }], 'analytics');
    assert(!show([consoleLines, captured, tracked]).includes(SECRET), 'a title leaked');
  });

  await check('G→F: a one-off and an all-day series land with FamCal\'s all-day ends', async () => {
    gseed(NOA_CAL, 'g1', { start: '2026-10-20T18:00:00', end: '2026-10-20T19:30:00', description: '<p>Bring <b>snacks</b></p>' });
    const r = await move(NOA, gkey(NOA_CAL, 'g1'), 'native:fam-noa', 'single');
    const made = tables.nativeEvent[0];
    assertSame([r, made.rrule, made.startsAt.toISOString(), made.endsAt.toISOString(), made.description], [{ status: 'ok', key: `famcal|${made.id}` }, null, at('2026-10-20T18:00:00').toISOString(), at('2026-10-20T19:30:00').toISOString(), htmlToText('<p>Bring <b>snacks</b></p>')], 'one-off');
    reset();
    gseed(NOA_CAL, 'ga', { allDay: true, start: '2026-11-03', end: '2026-11-05', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'] });
    const r2 = await move(NOA, gkey(NOA_CAL, 'ga_20261110'), 'native:fam-noa');
    const ad = tables.nativeEvent[0];
    assertSame([r2.key, ad.allDay, ad.startsAt.toISOString(), ad.endsAt.toISOString()], [`famcal|${ad.id}#${dayStartOf('2026-11-10').toISOString()}`, true, dayStartOf('2026-11-03').toISOString(), dayEndOf('2026-11-04').toISOString()], 'all-day');
  });

  await check('G→F refusals: guests, a Meet link, files, an RDATE, a start that isn\'t a slot, other changes, a scope other than all; nothing written', async () => {
    gseed(NOA_CAL, 'guests', { start: '2026-10-20T10:00:00', attendees: [{ email: 'dan@x.com' }, { email: NOA_CAL, self: true }] });
    gseed(NOA_CAL, 'meet', { start: '2026-10-20T10:00:00', conferenceData: { entryPoints: [{ uri: 'https://meet.google.com/x' }] } });
    gseed(NOA_CAL, 'files', { start: '2026-10-20T10:00:00', attachments: [{ fileUrl: 'https://drive.google.com/x' }] });
    gseed(NOA_CAL, 'rd', { start: '2026-10-06T10:00:00', recurrence: ['RRULE:FREQ=WEEKLY', 'RDATE;TZID=Asia/Jerusalem:20261008T100000'] });
    gseed(NOA_CAL, 'wed', { start: '2026-10-06T10:00:00', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE'] });
    gseed(NOA_CAL, 'one', { start: '2026-10-20T10:00:00' });
    const before = writes().length;
    assertSame(await move(NOA, gkey(NOA_CAL, 'guests'), 'native:fam-noa', 'single'), { status: 'not_allowed' }, 'guests (3b\'s editable test)');
    assertSame(await move(NOA, gkey(NOA_CAL, 'meet'), 'native:fam-noa', 'single'), { status: 'invalid', field: 'moveMeet' }, 'Meet');
    assertSame(await move(NOA, gkey(NOA_CAL, 'files'), 'native:fam-noa', 'single'), { status: 'invalid', field: 'moveMeet' }, 'files');
    assertSame(await move(NOA, gkey(NOA_CAL, ginst('rd', '2026-10-06T10:00:00')), 'native:fam-noa'), { status: 'invalid', field: 'moveRepeat' }, 'RDATE');
    assertSame(await move(NOA, gkey(NOA_CAL, ginst('wed', '2026-10-07T10:00:00')), 'native:fam-noa'), { status: 'invalid', field: 'moveRepeat' }, 'a start that isn\'t a slot');
    assertSame(await move(NOA, gkey(NOA_CAL, 'one'), 'native:fam-noa', 'single', { location: 'Home' }), { status: 'invalid', field: 'moveAlone' }, 'saved alone');
    assertSame(await move(NOA, gkey(NOA_CAL, ginst('rd', '2026-10-06T10:00:00')), 'native:fam-noa', 'following'), { status: 'invalid', field: 'scope' }, 'scope');
    assertSame(await move(NOA, gkey(NOA_CAL, 'one'), 'native:fam-solo', 'single'), { status: 'invalid', field: 'calendarId' }, 'a FamCal calendar the user can\'t write');
    assertSame([writes().length - before, tables.nativeEvent.length], [0, 0], 'nothing written');
  });

  await check('G→F refusals: a series whose master or another occurrence has a guest, opened on an occurrence without one; nothing written, nothing deleted; the item info offers no FamCal calendar', async () => {
    const guest = [{ email: 'dan@x.com' }, { email: NOA_CAL, self: true }];
    gseed(NOA_CAL, 'gm', { start: '2026-10-06T10:00:00', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=6'], attendees: guest });
    const alone = ginst('gm', '2026-10-20T10:00:00');
    gseedException(NOA_CAL, alone, { attendees: [] });
    gseed(NOA_CAL, 'gx', { start: '2026-10-06T10:00:00', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=6'] });
    gseedException(NOA_CAL, ginst('gx', '2026-11-03T10:00:00'), { attendees: guest });
    gseed(NOA_CAL, 'go', { start: '2026-10-06T10:00:00', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=6'] });
    gseedException(NOA_CAL, ginst('go', '2026-11-03T10:00:00'), { attendeesOmitted: true });
    const before = writes().length;
    assertSame(await move(NOA, gkey(NOA_CAL, alone), 'native:fam-noa'), { status: 'not_allowed' }, 'the master has a guest');
    assertSame(await move(NOA, gkey(NOA_CAL, ginst('gx', '2026-10-27T10:00:00')), 'native:fam-noa'), { status: 'not_allowed' }, 'another occurrence has a guest');
    assertSame(await move(NOA, gkey(NOA_CAL, ginst('go', '2026-10-27T10:00:00')), 'native:fam-noa'), { status: 'not_allowed' }, 'another occurrence\'s guests are left out');
    assertSame([writes().length - before, tables.nativeEvent.length, ['gm', 'gx', 'go'].every((id) => Boolean(stored(NOA_CAL, id)))], [0, 0, true], 'nothing written, nothing deleted');
    const info = await editInfo(NOA, gkey(NOA_CAL, alone));
    assertSame(info.moveTargets, [NOA_CAL, FAMILY], 'the item info: only the Google calendars');
  });

  await check('G→F compensation: a failed FamCal write leaves Google alone; a failed Google delete re-reads: present → the copy goes; applied, 404, 410 or cancelled → done; unreadable or a failed compensation → "still in"', async () => {
    const seedOne = () => gseed(NOA_CAL, 'g1', { start: '2026-10-20T10:00:00' });
    const run = () => move(NOA, gkey(NOA_CAL, 'g1'), 'native:fam-noa', 'single');
    seedOne();
    dbFailures.push({ table: 'nativeEvent', method: 'create', left: 1 });
    assertSame([await run(), Boolean(stored(NOA_CAL, 'g1')), tables.nativeEvent.length], [{ status: 'failed' }, true, 0], 'FamCal write failed');
    const outcomes: Array<[string, Answer, { apply?: boolean; reread?: Answer }, string, boolean]> = [
      ['present', fail(500, 'backendError'), {}, 'move_failed', false],
      ['applied', fail(500, 'backendError'), { apply: true }, 'ok', true],
      ['404', fail(404, 'notFound'), {}, 'ok', true],
      ['410', fail(410, 'deleted'), {}, 'ok', true],
      ['cancelled', fail(503, 'backendError'), { reread: { status: 200, data: { id: 'g1', status: 'cancelled' } } }, 'ok', true],
      ['unreadable', fail(503, 'backendError'), { reread: fail(500, 'backendError') }, 'left', true],
    ];
    for (const [name, answer, o, want, copyKept] of outcomes) {
      reset();
      seedOne();
      failOn((r) => r.method === 'DELETE', answer, { apply: o.apply, times: RETRIED });
      if (o.reread) failOn((r) => r.method === 'GET' && r.path.endsWith('/events/g1') && writes().some((w) => w.method === 'DELETE'), o.reread, { times: RETRIED });
      const r = await run();
      const status = r.status === 'ok' && r.leftIn ? 'left' : r.status;
      assertSame([status, tables.nativeEvent[0]?.isDeleted === false], [want, copyKept], name);
      if (want === 'left') assertSame(r.leftIn, 'Noa', 'the Google calendar named');
    }
    reset();
    seedOne();
    failOn((r) => r.method === 'DELETE', fail(500, 'backendError'), { times: RETRIED });
    dbFailures.push({ table: 'nativeEvent', method: 'update', when: (a) => a.data?.isDeleted === true, left: 1 });
    const r = await run();
    assertSame([r.status, r.leftIn], ['ok', 'Noa'], 'a failed compensation');
  });

  // ================= The lock =================

  await check('lock: fail-closed NX on the source series: held → busy; a Redis error refuses; released after success, after a refusal and after a failure; its own prefix, not the voice lock\'s', async () => {
    seedSeries('one', { startsAt: at('2026-10-20T10:00:00') });
    redisStore.set('calendar-move:lock:famcal:one', '1');
    assertSame(await move(NOA, 'famcal|one', NOA_CAL, 'single'), { status: 'busy' }, 'held');
    assertSame([writes().length, famWrites().length, writeResponse({ status: 'busy' }).status], [0, 0, 429], 'nothing written; 429');
    redisStore.clear();
    redisDown = 'set';
    assertSame(await move(NOA, 'famcal|one', NOA_CAL, 'single'), { status: 'failed' }, 'Redis down');
    assertSame([writes().length, captured.some((c) => c.ctx === 'calendar-move-lock')], [0, true], 'refused, logged');
    redisDown = null;
    failOn((r) => r.method === 'POST', fail(500, 'backendError'));
    await move(NOA, 'famcal|one', NOA_CAL, 'single');
    assertSame([...redisStore.keys()], [], 'released after a failure');
    gseed(NOA_CAL, 'g1', { start: '2026-10-20T10:00:00' });
    const sets: string[] = [];
    const realSet = redisImpl.set;
    redisImpl.set = async (k: string, v: unknown, o?: Row) => { sets.push(`${k} ${show(o)}`); return realSet(k, v, o); };
    await move(NOA, gkey(NOA_CAL, 'g1'), 'native:fam-noa', 'single');
    redisImpl.set = realSet;
    assert(sets.some((s) => s.startsWith(`calendar-move:lock:google:${NOA_CAL}|g1 `) && /"nx":true/.test(s) && /"ex":\d+/.test(s)), `the Google lock: ${sets}`);
    assertSame([...redisStore.keys()].filter((k) => k.includes('lock')), [], 'released');
    redisDown = 'del';
    seedSeries('two', { startsAt: at('2026-10-21T10:00:00') });
    assertSame((await move(NOA, 'famcal|two', NOA_CAL, 'single')).status, 'ok', 'a release that fails doesn\'t fail the move');
    assert(captured.some((c) => c.ctx === 'calendar-move-lock'), 'and is logged');
  });

  // ================= Item info: move targets across kinds =================

  await check('item info: a FamCal event lists the writable Google calendars too; a partner\'s lists none; a Hebrew series names why', async () => {
    seedSeries('one', { startsAt: at('2026-10-20T10:00:00') });
    seedSeries('dan1', { calendarId: 'fam-dan', creatorUserId: DAN, startsAt: at('2026-10-20T10:00:00') });
    seedSeries('heb', { rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary', hebrewAnchor: '2026-10-20', startsAt: at('2026-10-20T10:00:00') });
    const own = await editInfo(NOA, 'famcal|one');
    assertSame([own.moveTargets, own.canMoveCalendar, own.moveReason], [['native:fam-noa', 'native:fam-shared', 'native:fam-dan', NOA_CAL, FAMILY], true, undefined], 'own');
    const dans = await editInfo(NOA, 'famcal|dan1');
    assert(!dans.moveTargets.some((id: string) => !id.startsWith('native:')) && dans.moveReason === undefined, `partner's: ${show(dans.moveTargets)}`);
    const heb = await editInfo(NOA, `famcal|heb#${at('2026-10-20T10:00:00').toISOString()}`);
    assertSame([heb.moveTargets.filter((id: string) => !id.startsWith('native:')), heb.moveReason], [[], 'hebrew'], 'Hebrew');
  });

  await check('item info: a Google event lists the writable FamCal calendars, and which a partner sees; a Meet event or an RDATE series names why', async () => {
    gseed(NOA_CAL, 'g1', { start: '2026-10-20T10:00:00' });
    gseed(NOA_CAL, 'meet', { start: '2026-10-20T10:00:00', conferenceData: { entryPoints: [{ uri: 'https://meet.google.com/x' }] } });
    gseed(NOA_CAL, 'rd', { start: '2026-10-06T10:00:00', recurrence: ['RRULE:FREQ=WEEKLY', 'RDATE;TZID=Asia/Jerusalem:20261008T100000'] });
    const g = await editInfo(NOA, gkey(NOA_CAL, 'g1'));
    assertSame([g.moveTargets, g.sharedTargets, g.moveReason], [[NOA_CAL, FAMILY, 'native:fam-noa', 'native:fam-shared', 'native:fam-dan'], ['native:fam-shared', 'native:fam-dan'], undefined], 'targets');
    const meet = await editInfo(NOA, gkey(NOA_CAL, 'meet'));
    assertSame([meet.moveTargets, meet.moveReason], [[NOA_CAL, FAMILY], 'meet'], 'Meet');
    const rd = await editInfo(NOA, gkey(NOA_CAL, ginst('rd', '2026-10-06T10:00:00')));
    assertSame(rd.moveReason, 'repeat', 'RDATE');
    const solo = await editInfo(9, gkey(NOA_CAL, 'g1'));
    assertSame(solo.sharedTargets ?? [], [], 'no partner: nobody else sees it');
  });

  await check('parseUpdate: a PATCH may name a calendar of the other kind (the move); the key and id forms stay strict', async () => {
    assert(validate.parseUpdate({ key: 'famcal|abc', scope: 'single', changes: { calendarId: FAMILY } }).ok, 'famcal → google');
    assert(validate.parseUpdate({ key: gkey(NOA_CAL, 'e1'), scope: 'single', changes: { calendarId: 'native:abc' } }).ok, 'google → famcal');
    assertSame(validate.parseUpdate({ key: 'famcal|abc', scope: 'single', changes: { calendarId: 'bad id' } }), { ok: false, field: 'calendarId' }, 'whitespace');
    assertSame(validate.parseUpdate({ key: 'famcal|abc', scope: 'single', changes: { calendarId: 'native:' } }), { ok: false, field: 'calendarId' }, 'empty native');
  });

  // ================= The client store: dropItem =================

  await check('store: dropItem drops the moved item, and the rest of its series from its source, at once; nothing else', async () => {
    const item = (key: string, source: string, seriesId: string | null, date: string): Row => ({
      key, source, readOnly: false, id: key, seriesId, originalStart: null, kind: 'event', title: 'x', start: `${date}T10:00:00Z`, end: `${date}T11:00:00Z`,
      allDay: false, tz: null, recurring: seriesId !== null, repeatsDaily: false, span: null, calendar: { id: 'c', name: 'c', color: null }, location: null, description: null,
    });
    const days = ['2026-10-20', '2026-10-27'];
    const response = {
      tz: IL, today: '2026-10-20', weekStart: 'sunday', hebrewDates: false, from: '2026-10-18', to: '2026-11-01',
      sources: { famcal: { status: 'ok' }, google: { status: 'ok' } }, calendars: [], partner: null, carryOvers: null,
      days: days.map((d) => ({ date: d, items: [item(`famcal|wk#${d}`, 'famcal', 'wk', d), item(`famcal|other#${d}`, 'famcal', 'other', d), item(`google|c|wk_${d}`, 'google', 'wk', d)] })),
    };
    const s0 = storeMod.reduceStore(storeMod.emptyStore(), { type: 'response', response, epoch: 0 });
    const s1 = storeMod.reduceStore(s0, { type: 'dropItem', key: 'famcal|wk#2026-10-20' });
    assertSame(days.map((d) => storeMod.dayItems(s1, d).map((i: Row) => i.key)), days.map((d) => [`famcal|other#${d}`, `google|c|wk_${d}`]), 'the series gone from FamCal only');
    assert(storeMod.reduceStore(s1, { type: 'dropItem', key: 'famcal|nope' }) === s1, 'a key it does not hold changes nothing');
    assertSame(storeMod.dayStatus(s1, '2026-10-20'), 'answered', 'coverage kept');
  });

  for (const level of ['log', 'warn', 'error', 'info'] as const) (console as Row)[level] = quiet[level];
  const leaked = [...consoleLines, ...captured.map((c) => show(c.extra ?? {}))].filter((l) => l.includes(SECRET) || l.includes('Team sync'));
  results.push({ name: 'logs: no title reaches a log line or an error context', ok: leaked.length === 0, reason: leaked.slice(0, 3).join(' | ') });

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) console.log(`${r.ok ? 'OK ' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
  console.log(`\n${passed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

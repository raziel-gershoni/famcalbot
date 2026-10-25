// Smoke test for the calendar home's editing API (home editing spec §3 and §6):
//   GET    /api/calendar/editor   what the "+" needs
//   GET    /api/calendar/item     one FamCal item's edit info, read live
//   POST   /api/calendar/items    create an event or a reminder
//   PATCH  /api/calendar/items    edit one, for a scope
//   DELETE /api/calendar/items    delete one, for a scope
//
// The routes, the validation, the wall-time arithmetic, the event store, the reminder
// resolver, the ownership rules, the recurrence expansion, api-auth and telegram-auth run
// for real over an in-memory Prisma. Faked at the boundaries: Prisma and Redis, the rate
// limiter (records each key), error capture, analytics, the moved-ping edit (Telegram),
// the plan check, and Telegram itself. No network, no database.
//
// Run with the fake env from the task brief (no dotenv), under both clocks; nothing may
// depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-calendar-editor-api.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-editor-api.ts

import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
type Where = Record<string, unknown>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.CRON_SECRET ||= 'test-cron';
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
function assertSame(got: unknown, want: unknown, label: string) {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

// ---- Fake Prisma: in memory, with the where operators, compound keys, select, push and
// transactions the store uses ----

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
/** Set to make the next nativeEvent.create reject with this message. */
let failCreateWith: string | null = null;

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

/** The tables with a unique (seriesEventId, originalStartsAt), as the schema has them. */
const UNIQUE_SLOT = ['nativeEventInstance', 'nativeReminderState'];
/** Throw as Postgres does when two rows of `name` share a unique (seriesEventId, originalStartsAt). */
function checkUnique(name: string) {
  if (!UNIQUE_SLOT.includes(name)) return;
  const seen = new Set<string>();
  for (const r of tables[name]) {
    const k = `${r.seriesEventId}|${(r.originalStartsAt as Date).getTime()}`;
    if (seen.has(k)) throw Object.assign(new Error(`stand-in ${name}: unique (seriesEventId, originalStartsAt) violated`), { code: 'P2002' });
    seen.add(k);
  }
}

function table(name: string) {
  const find = (where?: Where) => tables[name].filter((r) => !where || matches(r, where));
  const insert = (data: Row) => {
    const row: Row = { id: `${name}-${++nextId}`, ...DEFAULTS[name]?.(), createdAt: new Date() };
    apply(row, data);
    tables[name].push(row);
    checkUnique(name);
    return { ...row };
  };
  type Args = { where?: Where; select?: Record<string, boolean>; orderBy?: Array<Record<string, 'asc' | 'desc'>>; data?: Row; create?: Row; update?: Row };
  const rec = <T>(method: string, fn: () => T) => { prismaCalls.push(`${name}.${method}`); return fn(); };
  return {
    findUnique: async ({ where, select }: Args) => rec('findUnique', () => pick(find(where)[0], select)),
    findFirst: async ({ where, select }: Args) => rec('findFirst', () => pick(find(where)[0], select)),
    findMany: async ({ where, select, orderBy = [] }: Args = {}) => rec('findMany', () => {
      const rows = [...find(where)];
      for (const order of [...orderBy].reverse()) {
        const [[key, dir]] = Object.entries(order);
        rows.sort((a, b) => ((a[key] as Date) > (b[key] as Date) ? 1 : (a[key] as Date) < (b[key] as Date) ? -1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      return rows.map((r) => pick(r, select));
    }),
    create: async ({ data }: Args) => rec('create', () => {
      if (name === 'nativeEvent' && failCreateWith) {
        const message = failCreateWith;
        failCreateWith = null;
        throw Object.assign(new Error(message), { code: 'P2002' });
      }
      return insert(data!);
    }),
    update: async ({ where, data }: Args) => rec('update', () => {
      const row = find(where)[0];
      if (!row) throw new Error(`stand-in ${name}.update: no row matches ${JSON.stringify(where)}`);
      apply(row, data!);
      checkUnique(name);
      return { ...row };
    }),
    upsert: async ({ where, create, update }: Args) => rec('upsert', () => {
      const row = find(where)[0];
      if (!row) return insert(create!);
      apply(row, update!);
      checkUnique(name);
      return { ...row };
    }),
    updateMany: async ({ where, data }: Args) => rec('updateMany', () => {
      const rows = find(where);
      rows.forEach((r) => apply(r, data!));
      checkUnique(name);
      return { count: rows.length };
    }),
    deleteMany: async ({ where }: Args) => rec('deleteMany', () => {
      const before = tables[name].length;
      tables[name] = tables[name].filter((r) => !where || !matches(r, where));
      return { count: before - tables[name].length };
    }),
  };
}

const fakePrisma: Row = {
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const snapshot = structuredClone(tables);
    try {
      return await fn(fakePrisma);
    } catch (err) {
      Object.assign(tables, snapshot);
      throw err;
    }
  },
};
// googleSyncLink: no calendar here is copied to Google (google-sync spec §2), so the store's marks find no link.
for (const name of ['user', 'pairing', 'nativeCalendar', 'nativeEvent', 'nativeEventInstance', 'nativeReminderState', 'adminSettings', 'googleSyncLink']) {
  tables[name] = [];
  fakePrisma[name] = table(name);
}

// ---- Fake Redis ----

const redisStore = new Map<string, string>();
const decode = (raw: string | undefined) => {
  if (raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return raw; }
};
const redisImpl: Row = {
  get: async (k: string) => decode(redisStore.get(k)),
  set: async (k: string, v: unknown) => { redisStore.set(k, typeof v === 'string' ? v : JSON.stringify(v)); return 'OK'; },
  del: async () => 1,
  expire: async () => 1,
};
const fakeRedis = new Proxy(redisImpl, { get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? (async () => null)) });

// ---- Recorders ----

const rateChecks: string[] = [];
let rateAllow = true;
const captured: { ctx: string; extra: Row | undefined; message: string }[] = [];
const tracked: { userId: number; action: string; meta: Row }[] = [];
const stripped: { pings: Row[]; original: Row; updates: Row; editorId: number; extra?: Row }[] = [];
/** Users the plan check refuses reminders to. */
const noReminderPlan = new Set<number>();
/** Everything the run writes to the console. */
const consoleLines: string[] = [];

// ---- Boundaries: stubs served to import() by a load hook ----

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

function stub(rel: string, exports: Row) {
  const filename = path.join(ROOT, rel);
  stubs[filename] = exports;
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  Module._cache[filename] = mod;
}

const recorder = (): Row =>
  new Proxy({} as Row, { get: (_t, p) => (typeof p !== 'string' || p === 'then' ? undefined : async () => ({ message_id: 1 })) });

function installStubs() {
  stub('src/utils/prisma.ts', { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() });
  stub('src/utils/redis.ts', { redis: fakeRedis });
  stub('src/lib/error-capture.ts', {
    captureError: (e: unknown, ctx: string, extra?: Row) => { captured.push({ ctx, extra, message: e instanceof Error ? e.message : String(e) }); },
    captureWarning: () => undefined,
    captureInfo: () => undefined,
  });
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
  stub('src/lib/rate-limit.ts', {
    calendarRateLimiter: { name: 'calendar' },
    calendarWriteRateLimiter: { name: 'calendar-write' },
    checkRateLimit: async (limiter: Row, identifier: string | number) => {
      rateChecks.push(`${limiter?.name}:${String(identifier)}`);
      return rateAllow ? { success: true, remaining: 19, reset: 0 } : { success: false, remaining: 0, reset: 0 };
    },
    getRateLimitHeaders: () => ({}),
  });
  stub('src/services/analytics-service.ts', {
    trackActivityAsync: (userId: number, action: string, meta: Row) => { tracked.push({ userId, action, meta }); },
    trackActivity: async () => undefined,
  });
  stub('src/services/native-reminders/moved-pings.ts', {
    stripMovedPings: async (pings: Row[], original: Row, updates: Row, editor: Row, extra?: Row) => {
      stripped.push({ pings, original, updates, editorId: editor.id, ...(extra ? { extra } : {}) });
    },
    movedWhen: () => '',
  });
  const allowed = async (userId: number) => ({ allowed: !noReminderPlan.has(userId) });
  stub('src/services/subscription-service.ts', { checkFeatureAccess: allowed, peekFeatureAccess: allowed });
}

// ---- Fixtures ----

const IL = 'Asia/Jerusalem';
const TAL = 9; // the user under test: native, paired with Noa, Telegram
const NOA = 42;
const TG = { tal: 111111111, noa: 222222222, solo: 333333333, dan: 444444444, sus: 555555555, lone: 666666666 };
const PAIRING = 'pairing-9-42';
const SECRET_TITLE = 'Zebra Private Title';

/** A wall-clock time in `tz` as an instant. */
const at = (local: string, tz = IL) => fromZonedTime(`${local}:00`, tz);
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d));

function baseUser(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', culture: 'default',
    messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null, calendarSource: 'NATIVE',
    pairingId: null, remindersEnabled: false, suspendedAt: null, unreachableSince: null, whatsappPhone: null,
    whatsappBsuid: null, telegramId: null, isAdmin: false, globalRules: [], voiceInputEnabled: true,
    textSummaryEnabled: true, voiceSummaryEnabled: false, weatherEnabled: true, locationForced: false,
    createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...o,
  };
}

function cal(id: string, ownerUserId: number, privacy: string, labels: string[], name = id, createdAt = '2026-01-01T00:00:00Z'): Row {
  return { ...DEFAULTS.nativeCalendar(), id, ownerUserId, name, privacy, labels, createdAt: new Date(createdAt), updatedAt: new Date(createdAt) };
}

const OLD = new Date('2026-10-01T06:00:00Z');

/** A series row written the way an earlier write left it. */
function seedSeries(id: string, fields: Row): Row {
  const row: Row = { ...DEFAULTS.nativeEvent(), id, timeZone: IL, createdAt: OLD, updatedAt: OLD, ...fields };
  if (row.kind === 'REMINDER') row.armedAt ??= OLD;
  row.endsAt ??= row.kind === 'REMINDER' ? row.startsAt : new Date(row.startsAt.getTime() + 3_600_000);
  tables.nativeEvent.push(row);
  return row;
}

function seedState(seriesEventId: string, originalStartsAt: Date, pingMessageId: number | null, fields: Row = {}) {
  tables.nativeReminderState.push({
    ...DEFAULTS.nativeReminderState(), id: `state-${++nextId}`, seriesEventId, originalStartsAt,
    pingChatId: pingMessageId === null ? null : 5001n, pingMessageId, createdAt: OLD, updatedAt: OLD, ...fields,
  });
}

function seed() {
  nextId = 0;
  failCreateWith = null;
  rateAllow = true;
  noReminderPlan.clear();
  for (const list of [prismaCalls, rateChecks, captured, tracked, stripped, consoleLines] as unknown[][]) list.length = 0;
  redisStore.clear();
  tables.user = [
    baseUser({ id: TAL, name: 'Tal', telegramId: BigInt(TG.tal), pairingId: PAIRING }),
    baseUser({ id: NOA, name: 'Noa', telegramId: BigInt(TG.noa), pairingId: PAIRING, language: 'he' }),
    baseUser({ id: 11, name: 'Solo', telegramId: BigInt(TG.solo) }),
    baseUser({ id: 12, name: 'Dan', telegramId: BigInt(TG.dan), calendarSource: 'GOOGLE' }),
    baseUser({ id: 13, name: 'Sus', telegramId: BigInt(TG.sus), suspendedAt: new Date('2026-10-10T00:00:00Z') }),
    // On the built-in calendar and paired with nobody, but with no Telegram: no reminders.
    baseUser({ id: 14, name: 'Lone', telegramId: null, whatsappPhone: '+972501234567' }),
  ];
  tables.pairing = [{ id: PAIRING, status: 'ACTIVE', inviterUserId: TAL, inviteeUserId: NOA }];
  tables.nativeCalendar = [
    cal('cal-tal', TAL, 'PRIVATE', ['primary', 'yours'], 'Tal', '2026-01-01T00:00:00Z'),
    cal('cal-tal-family', TAL, 'SHARED_EDITOR', ['kids'], 'Family', '2026-02-01T00:00:00Z'),
    cal('cal-noa-edit', NOA, 'SHARED_EDITOR', ['primary', 'yours'], 'Noa shared', '2026-01-01T00:00:00Z'),
    cal('cal-noa-view', NOA, 'SHARED_VIEWER', ['kids'], 'Noa view', '2026-02-01T00:00:00Z'),
    cal('cal-noa-private', NOA, 'PRIVATE', ['spouse'], 'Noa secret', '2026-03-01T00:00:00Z'),
    cal('cal-solo', 11, 'PRIVATE', ['primary', 'yours'], 'Solo'),
    cal('cal-lone', 14, 'PRIVATE', ['primary', 'yours'], 'Lone'),
  ];
  tables.nativeEvent = [];
  tables.nativeEventInstance = [];
  tables.nativeReminderState = [];
  tables.adminSettings = [];
  tracked.length = 0;
  (globalThis as Row).__recurrenceCache?.clear?.();
}

/** Valid Telegram initData for a Telegram user id, signed with the bot token. */
function initDataFor(tgId: number): string {
  const params: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAH-smoke',
    user: JSON.stringify({ id: tgId, first_name: 'Test' }),
  };
  const checkString = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN ?? '').digest();
  const hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  return [...Object.entries(params), ['hash', hash]].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));
const eventRow = (id: string) => tables.nativeEvent.find((r) => r.id === id)!;
const eventsAll = () => tables.nativeEvent;
/** A length the compiler does not narrow across checks. */
const count = (list: readonly unknown[]): number => list.length;
const lastEvent = () => tables.nativeEvent[tables.nativeEvent.length - 1];

async function main() {
  installStubs();
  seed();
  const { NextRequest } = nodeRequire('next/server');
  const { shouldRunPass, setNextDue, __resetDueGateForTests } = nodeRequire(path.join(ROOT, 'src/services/native-reminders/due-gate.ts'));

  // The routes log refused attempts; keep the output to the results, and keep what they write.
  const quiet = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    (console as Row)[level] = (...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')); };
  }

  const editorRoute = await load('app/api/calendar/editor/route.ts');
  const itemRoute = await load('app/api/calendar/item/route.ts');
  const itemsRoute = await load('app/api/calendar/items/route.ts');

  type Call = { tg?: number; header?: boolean; raw?: string; userId?: string | number };
  type Reply = { status: number; body: Row; text: string; res: Response };

  const read = async (res: Response): Promise<Reply> => {
    const text = await res.clone().text();
    let body: Row = {};
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body, text, res };
  };
  const headersFor = (o: Call): Record<string, string> => (o.header === false ? {} : { 'x-telegram-init-data': initDataFor(o.tg ?? TG.tal) });
  const getRoute = async (route: Row, name: string, qs: string, o: Call = {}) =>
    read(await route.GET(new NextRequest(`http://localhost/api/calendar/${name}?user_id=${o.userId ?? o.tg ?? TG.tal}${qs ? `&${qs}` : ''}`, { headers: headersFor(o) })));
  const editorOf = (o: Call = {}) => getRoute(editorRoute, 'editor', '', o);
  const itemOf = (key: string, o: Call = {}) => getRoute(itemRoute, 'item', `key=${encodeURIComponent(key)}`, o);
  const send = async (method: 'POST' | 'PATCH' | 'DELETE', body: unknown, o: Call = {}) => {
    const payload = o.raw !== undefined ? o.raw : JSON.stringify(body && typeof body === 'object' && !Array.isArray(body) ? { user_id: o.userId ?? o.tg ?? TG.tal, ...body } : body);
    const req = new NextRequest('http://localhost/api/calendar/items', { method, headers: { 'content-type': 'application/json', ...headersFor(o) }, body: payload });
    return read(await itemsRoute[method](req));
  };
  const post = (body: unknown, o?: Call) => send('POST', body, o);
  const patch = (body: unknown, o?: Call) => send('PATCH', body, o);
  const del = (body: unknown, o?: Call) => send('DELETE', body, o);

  const NOT_STORED = 'private, no-store';
  const cacheOf = (r: Reply) => r.res.headers.get('cache-control');
  const idOf = (key: string) => key.slice('famcal|'.length).split('#')[0];
  const eventBody = (o: Row = {}) => ({ kind: 'event', title: 'Dentist', allDay: false, start: '2026-10-20T10:00', end: '2026-10-20T11:00', ...o });
  const reminderBody = (o: Row = {}) => ({ kind: 'reminder', title: 'Call the plumber', allDay: false, start: '2026-10-20T17:30', ...o });

  /** Seed the recurrence cache with an entry per user, to see whose a write drops. */
  const seedRecurrenceCache = () => {
    const g = globalThis as Row;
    g.__recurrenceCache ??= new Map();
    for (const u of [TAL, NOA, 11]) g.__recurrenceCache.set(`${u}:cal:series`, { value: null, at: Date.now(), ttlMs: 3_600_000 });
  };
  const cacheUsers = () => [TAL, NOA, 11].filter((u) => (globalThis as Row).__recurrenceCache?.has(`${u}:cal:series`));

  // ================= auth, limits, privacy =================

  await check('auth: every route and verb is 401 without init data, private, and touches nothing', async () => {
    seed();
    const key = 'famcal|nope';
    const replies = [
      await getRoute(editorRoute, 'editor', '', { header: false }),
      await getRoute(itemRoute, 'item', `key=${key}`, { header: false }),
      await post(eventBody(), { header: false }),
      await patch({ key, scope: 'single', changes: { title: 'x' } }, { header: false }),
      await del({ key, scope: 'single' }, { header: false }),
    ];
    assert(replies.every((r) => r.status === 401), `statuses ${replies.map((r) => r.status)}`);
    assert(replies.every((r) => cacheOf(r) === NOT_STORED), 'a 401 was cacheable');
    assert(eventsAll().length === 0 && rateChecks.length === 0, 'a refused request wrote or counted');
  });

  await check('auth: init data in the body works (the header or the body), another user\'s id is 401, no user_id is 400', async () => {
    seed();
    const inBody = await post({ ...eventBody(), initData: initDataFor(TG.tal) }, { header: false });
    assert(inBody.status === 200, `body initData ${inBody.status} ${inBody.text}`);
    const other = await post(eventBody(), { tg: TG.noa, userId: TAL });
    assert(other.status === 401, `another user's id ${other.status}`);
    const none = await send('POST', null, { raw: JSON.stringify(eventBody()) });
    assert(none.status === 400, `no user_id ${none.status}`);
  });

  await check('auth: a suspended user is 403 and a spent bucket is 429, on the write budget keyed by user', async () => {
    seed();
    const sus = await post(eventBody(), { tg: TG.sus });
    assert(sus.status === 403 && eventsAll().length === 0, `suspended ${sus.status}`);
    seed();
    rateAllow = false;
    const limited = await post(eventBody());
    assert(limited.status === 429 && cacheOf(limited) === NOT_STORED, `limited ${limited.status} ${cacheOf(limited)}`);
    assert(eventsAll().length === 0, 'a 429 wrote');
    rateAllow = true;
    await post(eventBody());
    await patch({ key: 'famcal|zzz', scope: 'single', changes: { title: 'x' } });
    await del({ key: 'famcal|zzz', scope: 'single' });
    assert(rateChecks.slice(1).every((k) => k === `calendar-write:u${TAL}`), `limiter keys ${rateChecks}`);
    await editorOf();
    assert(rateChecks[rateChecks.length - 1] === `calendar:u${TAL}`, `the reads use the calendar budget: ${rateChecks[rateChecks.length - 1]}`);
  });

  // ================= GET /editor =================

  await check('editor: kinds, writable calendars (own first, main flagged), the partner, the zone', async () => {
    seed();
    const r = await editorOf();
    assert(r.status === 200 && cacheOf(r) === NOT_STORED, `status ${r.status} ${r.text}`);
    assertSame(r.body.kinds, { event: true, reminder: true }, 'kinds');
    assertSame(r.body.calendars.map((c: Row) => [c.id, c.main, c.mine]), [
      ['native:cal-tal', true, true], ['native:cal-tal-family', false, true], ['native:cal-noa-edit', false, false],
    ], 'calendars: the viewer and private ones are left out');
    assertSame(r.body.calendars[2], { id: 'native:cal-noa-edit', name: 'Noa shared', color: '#039BE5', main: false, mine: false, ownerName: 'Noa' }, 'the partner\'s calendar');
    assertSame(r.body.partner, { name: 'Noa', canRemind: true }, 'partner');
    assert(r.body.tz === IL, `tz ${r.body.tz}`);
    assert(eventsAll().length === 0 && tables.nativeCalendar.length === 7, 'the editor info wrote');
  });

  await check('editor: no partner, a partner who cannot be pinged, no plan for reminders, no Telegram; a Google user gets FamCal (made lazily) and reminders', async () => {
    seed();
    const solo = await editorOf({ tg: TG.solo });
    assertSame([solo.body.kinds, solo.body.partner, solo.body.calendars.length], [{ event: true, reminder: true }, null, 1], 'a solo user');
    tables.user.find((u) => u.id === NOA)!.telegramId = null;
    assertSame((await editorOf()).body.partner, { name: 'Noa', canRemind: false }, 'partner without Telegram');
    noReminderPlan.add(TAL);
    assertSame((await editorOf()).body.kinds, { event: true, reminder: false }, 'plan without reminders');
    const lone = await editorOf({ userId: 14, header: false }).catch(() => null);
    assert(lone === null || lone.status === 401, 'no credential for a Telegram-less user');
    const dan = await editorOf({ tg: TG.dan });
    assertSame([dan.body.kinds, dan.body.calendars.map((c: Row) => [c.mine, c.main])], [{ event: true, reminder: true }, [[true, true]]], 'a Google user: the FamCal main and reminders');
  });

  // ================= validation =================

  await check('validation: a create is refused with the field named, and writes nothing', async () => {
    seed();
    const long = (n: number) => 'x'.repeat(n);
    const cases: [string, Row, string][] = [
      ['empty title', { title: '' }, 'title'],
      ['blank title', { title: '   ' }, 'title'],
      ['title of 201', { title: long(201) }, 'title'],
      ['title not a string', { title: 5 }, 'title'],
      ['location of 201', { location: long(201) }, 'location'],
      ['notes of 2001', { description: long(2001) }, 'description'],
      ['no kind', { kind: undefined }, 'kind'],
      ['unknown kind', { kind: 'task' }, 'kind'],
      ['allDay missing', { allDay: undefined }, 'allDay'],
      ['start missing', { start: undefined }, 'start'],
      ['start with a space', { start: '2026-10-20 10:00' }, 'start'],
      ['start with seconds', { start: '2026-10-20T10:00:00' }, 'start'],
      ['start 24:00', { start: '2026-10-20T24:00' }, 'start'],
      ['start 10:60', { start: '2026-10-20T10:60' }, 'start'],
      ['start 2026-02-30', { start: '2026-02-30T10:00' }, 'start'],
      ['start in year 0026', { start: '0026-10-20T10:00' }, 'start'],
      ['all-day start with a time', { allDay: true, start: '2026-10-20T10:00', end: undefined }, 'start'],
      ['timed start with only a day', { start: '2026-10-20' }, 'start'],
      ['end before start', { end: '2026-10-20T09:00' }, 'end'],
      ['end equal to start', { end: '2026-10-20T10:00' }, 'end'],
      ['end a day only', { end: '2026-10-21' }, 'end'],
      ['all-day end before start', { allDay: true, start: '2026-10-20', end: '2026-10-19' }, 'end'],
      ['more than a year long', { allDay: true, start: '2026-10-20', end: '2027-10-21' }, 'end'],
      ['unknown repeat', { repeat: 'hourly' }, 'repeat'],
      ['repeat not a string', { repeat: true }, 'repeat'],
      ['a calendar that is not a native id', { calendarId: 'primary' }, 'calendarId'],
      ['forPartner on an event', { forPartner: true }, 'forPartner'],
      ['forPartner not a boolean', { kind: 'reminder', end: undefined, forPartner: 'yes' }, 'forPartner'],
      ['an unknown field', { colour: 'red' }, 'colour'],
    ];
    for (const [name, patchBody, field] of cases) {
      const r = await post(eventBody(patchBody));
      assert(r.status === 400, `${name}: status ${r.status} ${r.text}`);
      assertSame(r.body, { error: 'invalid', field }, name);
      assert(cacheOf(r) === NOT_STORED, `${name}: cache-control`);
    }
    assert(eventsAll().length === 0, 'a refused create wrote');
    const notJson = await post(null, { raw: 'not json' });
    assert(notJson.status === 400, `not JSON ${notJson.status}`);
    const array = await post(null, { raw: '[1]' });
    assert(array.status === 400, `an array ${array.status}`);
  });

  await check('validation: the limits themselves are fine (title 200, location 200, notes 2000, an emoji counts as one)', async () => {
    seed();
    const ok = await post(eventBody({ title: `  ${'x'.repeat(200)}  `, location: 'y'.repeat(200), description: 'z'.repeat(2000) }));
    assert(ok.status === 200, `limits ${ok.status} ${ok.text}`);
    assert(eventRow(idOf(ok.body.key)).title === 'x'.repeat(200), 'the title is stored trimmed');
    const emoji = await post(eventBody({ title: '🎂'.repeat(200) }));
    assert(emoji.status === 200, `200 emoji ${emoji.status}`);
    const wide = await post(eventBody({ allDay: true, start: '2026-10-20', end: '2027-10-20' }));
    assert(wide.status === 200, `a year-long all-day ${wide.status} ${wide.text}`);
  });

  await check('validation: a patch and a delete name the field', async () => {
    seed();
    const created = await post(eventBody());
    const key = created.body.key;
    const cases: [string, Row, string][] = [
      ['no key', { key: undefined, scope: 'single', changes: { title: 'x' } }, 'key'],
      ['a key of neither source', { key: 'outlook|cal|id', scope: 'single', changes: { title: 'x' } }, 'key'],
      ['a key with a bad instant', { key: 'famcal|abc#2026-10-20', scope: 'single', changes: { title: 'x' } }, 'key'],
      ['no scope', { key, changes: { title: 'x' } }, 'scope'],
      ['an unknown scope', { key, scope: 'some', changes: { title: 'x' } }, 'scope'],
      ['no changes', { key, scope: 'single' }, 'changes'],
      ['empty changes', { key, scope: 'single', changes: {} }, 'changes'],
      ['an unknown change', { key, scope: 'single', changes: { rrule: 'FREQ=DAILY' } }, 'changes.rrule'],
      ['an empty title', { key, scope: 'single', changes: { title: ' ' } }, 'title'],
      ['a long location', { key, scope: 'single', changes: { location: 'x'.repeat(201) } }, 'location'],
      ['long notes', { key, scope: 'single', changes: { description: 'x'.repeat(2001) } }, 'description'],
      ['allDay as a string', { key, scope: 'single', changes: { allDay: 'yes' } }, 'allDay'],
      ['start as a number', { key, scope: 'single', changes: { start: 5 } }, 'start'],
      ['a start of the wrong form', { key, scope: 'single', changes: { start: '2026-10-20' } }, 'start'],
      ['an end before the start', { key, scope: 'single', changes: { end: '2026-10-20T09:00' } }, 'end'],
      ['an end of the wrong form', { key, scope: 'single', changes: { end: '2026-10-20' } }, 'end'],
      ['an extra field', { key, scope: 'single', changes: { title: 'x' }, kind: 'reminder' }, 'kind'],
    ];
    for (const [name, body, field] of cases) {
      const r = await patch(body);
      assert(r.status === 400, `${name}: status ${r.status} ${r.text}`);
      assertSame(r.body, { error: 'invalid', field }, name);
    }
    for (const [name, body, field] of [
      ['delete: no scope', { key }, 'scope'],
      ['delete: a bad key', { key: 'x', scope: 'single' }, 'key'],
      ['delete: an extra field', { key, scope: 'single', hard: true }, 'hard'],
    ] as [string, Row, string][]) {
      const r = await del(body);
      assert(r.status === 400, `${name}: status ${r.status}`);
      assertSame(r.body, { error: 'invalid', field }, name);
    }
    // 3b: a Google key goes to the Google path, which knows no calendar the user didn't choose.
    const google = await patch({ key: 'google|cal|id', scope: 'single', changes: { title: 'x' } });
    assertSame([google.status, google.body], [404, { error: 'not_found' }], 'a Google key for a calendar not chosen');
    const row = eventRow(idOf(key));
    assert(row.title === 'Dentist' && !row.isDeleted, 'a refused request changed the event');
  });

  // ================= create: events =================

  await check('create event: timed, on the main calendar, the end an hour on by default, wall times on the user\'s clock', async () => {
    seed();
    const r = await post(eventBody({ end: undefined, location: ' Clinic ', description: 'Bring the card' }));
    assert(r.status === 200 && cacheOf(r) === NOT_STORED, `status ${r.status} ${r.text}`);
    const row = lastEvent();
    assertSame(r.body, { status: 'ok', key: `famcal|${row.id}` }, 'response');
    assertSame(
      [row.title, row.location, row.description, row.kind, row.calendarId, row.creatorUserId, row.timeZone, row.allDay, row.rrule, row.forUserId],
      ['Dentist', 'Clinic', 'Bring the card', 'EVENT', 'cal-tal', TAL, IL, false, null, null],
      'row'
    );
    assertSame([iso(row.startsAt), iso(row.endsAt)], [iso(at('2026-10-20 10:00')), iso(at('2026-10-20 11:00'))], 'times (07:00Z to 08:00Z)');
    assert(iso(row.startsAt) === '2026-10-20T07:00:00.000Z', `Israel is UTC+3 on Oct 20: ${iso(row.startsAt)}`);
    const sent = await post(eventBody({ end: '2026-10-20T12:30' }));
    assert(iso(eventRow(idOf(sent.body.key)).endsAt) === '2026-10-20T09:30:00.000Z', 'an end that was sent is used');
  });

  await check('create event: all-day (one day by default, several days), the dates the user chose', async () => {
    seed();
    const one = await post(eventBody({ allDay: true, start: '2026-10-20', end: undefined }));
    const row = eventRow(idOf(one.body.key));
    assertSame([iso(row.startsAt), iso(row.endsAt), row.allDay], ['2026-10-19T21:00:00.000Z', '2026-10-20T20:59:00.000Z', true], 'a one-day event: local 00:00 to 23:59');
    const many = await post(eventBody({ allDay: true, start: '2026-10-20', end: '2026-10-22' }));
    assert(iso(eventRow(idOf(many.body.key)).endsAt) === '2026-10-22T20:59:00.000Z', 'the last day is the end, inclusive');
  });

  await check('create event: each repeat is a rule built on the start; a repeating event\'s key names its first occurrence', async () => {
    seed();
    const { expandSeries } = await load('src/services/native-calendar/recurrence.ts');
    const rules: [string, string | null][] = [['none', null], ['daily', 'FREQ=DAILY'], ['weekly', 'FREQ=WEEKLY'], ['monthly', 'FREQ=MONTHLY'], ['yearly', 'FREQ=YEARLY']];
    for (const [repeat, rrule] of rules) {
      const r = await post(eventBody({ repeat }));
      assert(r.status === 200, `${repeat}: ${r.status} ${r.text}`);
      const row = eventRow(idOf(r.body.key));
      assert(row.rrule === rrule, `${repeat}: rrule ${row.rrule}`);
      assert(r.body.key === (rrule ? `famcal|${row.id}#${iso(row.startsAt)}` : `famcal|${row.id}`), `${repeat}: key ${r.body.key}`);
    }
    const weekly = tables.nativeEvent[2];
    const march = expandSeries(weekly, { from: at('2026-11-01 00:00'), to: at('2026-11-30 00:00') }, []);
    assertSame(march.map((i: Row) => iso(i.startsAt)), ['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24'].map((d) => iso(at(`${d} 10:00`))), 'a weekly event lands on the same weekday');
    const monthly = tables.nativeEvent[3];
    const yearEnd = expandSeries(monthly, { from: at('2026-12-01 00:00'), to: at('2027-01-30 00:00') }, []);
    assertSame(yearEnd.map((i: Row) => iso(i.startsAt)), [iso(at('2026-12-20 10:00')), iso(at('2027-01-20 10:00'))], 'monthly on the 20th');
  });

  await check('create event: on the partner\'s shared editor calendar; a viewer calendar, a private one and nothing else are refused', async () => {
    seed();
    seedRecurrenceCache();
    const ok = await post(eventBody({ calendarId: 'native:cal-noa-edit' }));
    assert(ok.status === 200, `editor calendar ${ok.status} ${ok.text}`);
    assertSame([lastEvent().calendarId, lastEvent().creatorUserId], ['cal-noa-edit', TAL], 'the partner\'s calendar, created by Tal');
    assertSame(cacheOf(ok), NOT_STORED, 'cache');
    assertSame(cacheUsers(), [11], 'the recurrence cache is cleared for Tal and Noa, not for a stranger');
    const before = eventsAll().length;
    for (const [id, status] of [['native:cal-noa-view', 403], ['native:cal-noa-private', 403], ['native:cal-solo', 403], ['native:cal-nowhere', 404]] as const) {
      const r = await post(eventBody({ calendarId: id }));
      assert(r.status === status, `${id}: ${r.status} ${r.text}`);
      assert(r.body.error === (status === 403 ? 'not_allowed' : 'not_found'), `${id}: ${r.text}`);
    }
    assert(eventsAll().length === before, 'a refused create wrote');
  });

  await check('create event: on a private calendar the partner\'s cache stays; on a shared one it goes; a Google user with no token adds to FamCal, made lazily (Google as a connection)', async () => {
    seed();
    seedRecurrenceCache();
    await post(eventBody());
    assertSame(cacheUsers(), [NOA, 11], 'a private calendar clears only the user\'s');
    seedRecurrenceCache();
    await post(eventBody({ calendarId: 'native:cal-tal-family' }));
    assertSame(cacheUsers(), [11], 'a shared calendar clears the partner\'s too');
    const dan = await post(eventBody(), { tg: TG.dan });
    assert(dan.status === 200 && String(dan.body.key).startsWith('famcal|'), `Google user ${dan.status} ${dan.text}`);
  });

  await check('create event: analytics with source app under the bot\'s action name, no title in them', async () => {
    seed();
    await post(eventBody({ title: SECRET_TITLE }));
    assertSame(tracked.map((t) => [t.userId, t.action, t.meta.source]), [[TAL, 'voice_event_created', 'app']], 'tracked');
    assert(!show(tracked).includes(SECRET_TITLE), 'a title reached analytics');
  });

  await check('year floor: a one-off or a yearly item (Gregorian or Hebrew) may start in 1950, any other repeat is refused with the start named; 1899 and 2101 are refused for all', async () => {
    seed();
    const old = { start: '1950-03-02T10:00', end: '1950-03-02T11:00' };
    for (const repeat of ['none', 'yearly', 'hebrew']) {
      const r = await post(eventBody({ ...old, repeat }));
      assert(r.status === 200, `1950 ${repeat}: ${r.status} ${r.text}`);
    }
    const allDay = await post(eventBody({ allDay: true, start: '1950-03-02', end: '1950-03-03', repeat: 'yearly' }));
    assert(allDay.status === 200, `an all-day yearly item from 1950: ${allDay.status} ${allDay.text}`);
    const reminder = await post(reminderBody({ start: '1950-03-02T10:00', repeat: 'yearly' }));
    assert(reminder.status === 200, `a yearly reminder from 1950: ${reminder.status} ${reminder.text}`);
    const created = eventsAll().length;
    for (const repeat of ['daily', 'weekly', 'monthly']) {
      const r = await post(eventBody({ ...old, repeat }));
      assertSame([r.status, r.body], [400, { error: 'invalid', field: 'start' }], `1950 ${repeat} is refused`);
    }
    const late = await post(eventBody({ start: '1999-12-31T10:00', end: '1999-12-31T11:00', repeat: 'daily' }));
    assertSame([late.status, late.body.field], [400, 'start'], '1999 daily is refused');
    const edge = await post(eventBody({ start: '2000-01-01T10:00', end: '2000-01-01T11:00', repeat: 'daily' }));
    assert(edge.status === 200, `2000 daily is fine: ${edge.status} ${edge.text}`);
    const endOnly = await post(eventBody({ start: '2000-01-01T10:00', end: '1950-01-01T11:00' }));
    assertSame([endOnly.status, endOnly.body.field], [400, 'end'], 'an end before the start is still refused');
    const tooOld = await post(eventBody({ start: '1899-12-31T10:00', end: '1899-12-31T11:00' }));
    assertSame([tooOld.status, tooOld.body.field], [400, 'start'], '1899 is refused even as a one-off');
    const tooNew = await post(eventBody({ start: '2101-01-01T10:00', end: '2101-01-01T11:00' }));
    assertSame([tooNew.status, tooNew.body.field], [400, 'start'], '2101 is refused');
    assert(eventsAll().length === created + 1, 'only the 2000 daily one was written after the 1950 ones');
  });

  await check('year floor, edits: a one-off moves to 1950; a daily series does not; picking Yearly in the same save lets it', async () => {
    seed();
    const one = await post(eventBody());
    const moved = await patch({ key: one.body.key, scope: 'single', changes: { start: '1950-03-02T10:00', end: '1950-03-02T11:00' } });
    assert(moved.status === 200, `a one-off to 1950: ${moved.status} ${moved.text}`);
    const daily = await post(eventBody({ repeat: 'daily' }));
    const dailyKey = `famcal|${idOf(daily.body.key)}#${iso(at('2026-10-20 10:00'))}`;
    const refused = await patch({ key: dailyKey, scope: 'all', changes: { start: '1950-03-02T10:00', end: '1950-03-02T11:00' } });
    assertSame([refused.status, refused.body], [400, { error: 'invalid', field: 'start' }], 'a daily series to 1950');
    const yearly = await post(eventBody({ repeat: 'yearly' }));
    const yearlyKey = `famcal|${idOf(yearly.body.key)}#${iso(at('2026-10-20 10:00'))}`;
    const ok = await patch({ key: yearlyKey, scope: 'all', changes: { start: '1950-10-20T10:00', end: '1950-10-20T11:00' } });
    assert(ok.status === 200, `a yearly series to 1950: ${ok.status} ${ok.text}`);
  });

  await check('year floor, series start: "All" refuses a moved series start that leaves the years (a yearly one from 1 Jan 1900 moved a day back, a daily one moved back past 2000); 1950 re-entered on a 1950 yearly item keeps it', async () => {
    seed();
    const yearly = await post(eventBody({ start: '1950-03-02T10:00', end: '1950-03-02T11:00', repeat: 'yearly' }));
    assert(yearly.status === 200, `a yearly item from 1950: ${yearly.status} ${yearly.text}`);
    const key = `famcal|${idOf(yearly.body.key)}#${iso(at('2026-03-02 10:00'))}`;
    // The count hint asks for the original date: 1950 on this year's occurrence is the series' own first date (the day shift put it in 1874).
    const same = await patch({ key, scope: 'all', changes: { start: '1950-03-02T10:00', end: '1950-03-02T11:00' } });
    assertSame([same.status, same.body.key, iso(eventRow(idOf(yearly.body.key)).startsAt)], [200, key, iso(at('1950-03-02 10:00'))], 'the series keeps 1950 and the opened occurrence');
    const first = await post(eventBody({ start: '1900-01-01T10:00', end: '1900-01-01T11:00', repeat: 'yearly' }));
    const firstKey = `famcal|${idOf(first.body.key)}#${iso(at('2026-01-01 10:00'))}`;
    const refused = await patch({ key: firstKey, scope: 'all', changes: { start: '2025-12-31T10:00', end: '2025-12-31T11:00' } });
    assertSame([refused.status, refused.body], [400, { error: 'invalid', field: 'start', reason: 'year' }], 'a day back from 1 Jan puts the first date on 31 Dec 1899 (the year reason, not a day move the rule refuses)');
    assertSame(iso(eventRow(idOf(first.body.key)).startsAt), iso(at('1900-01-01 10:00')), 'nothing written');
    const daily = await post(eventBody({ start: '2000-01-03T10:00', end: '2000-01-03T11:00', repeat: 'daily' }));
    const dailyKey = (day: string) => `famcal|${idOf(daily.body.key)}#${iso(at(`${day} 10:00`))}`;
    const back = await patch({ key: dailyKey('2026-10-20'), scope: 'all', changes: { start: '2026-10-15T10:00', end: '2026-10-15T11:00' } });
    assertSame([back.status, back.body], [400, { error: 'invalid', field: 'start', reason: 'year' }], 'a daily series moved five days back starts in 1999');
    const near = await patch({ key: dailyKey('2026-10-20'), scope: 'all', changes: { start: '2026-10-21T10:00', end: '2026-10-21T11:00' } });
    assertSame([near.status, iso(eventRow(idOf(daily.body.key)).startsAt)], [200, iso(at('2000-01-04 10:00'))], 'a day later is fine');
  });

  await check('year floor, repeat change without a start: a 1950 one-off cannot become a daily series, but can become yearly', async () => {
    seed();
    const one = await post(eventBody({ start: '1950-03-02T10:00', end: '1950-03-02T11:00' }));
    assert(one.status === 200, `a one-off from 1950: ${one.status} ${one.text}`);
    const refused = await patch({ key: one.body.key, scope: 'single', changes: { repeat: 'daily' } });
    assertSame([refused.status, refused.body], [400, { error: 'invalid', field: 'start' }], 'daily from 1950');
    const ok = await patch({ key: one.body.key, scope: 'single', changes: { repeat: 'yearly' } });
    assert(ok.status === 200, `yearly from 1950: ${ok.status} ${ok.text}`);
  });

  // ================= create: reminders =================

  await check('create reminder: timed, zero-length, on the main calendar for the user, armed, the due gate open', async () => {
    seed();
    __resetDueGateForTests();
    setNextDue(new Date(Date.now() + 30 * 60_000), new Date());
    assert(!shouldRunPass(new Date()), 'the gate did not close');
    setNextDue(new Date(Date.now() + 30 * 60_000), new Date());
    const before = Date.now();
    const r = await post(reminderBody({ calendarId: 'native:cal-noa-edit', end: '2030-01-01T00:00' }));
    assert(r.status === 200, `status ${r.status} ${r.text}`);
    const row = lastEvent();
    assertSame([row.kind, row.calendarId, row.creatorUserId, row.forUserId, row.allDay, row.rrule], ['REMINDER', 'cal-tal', TAL, null, false, null], 'row: the calendar is the main one whatever was asked');
    assertSame([iso(row.startsAt), iso(row.endsAt)], [iso(at('2026-10-20 17:30')), iso(at('2026-10-20 17:30'))], 'one moment');
    assert(row.armedAt instanceof Date && row.armedAt.getTime() >= before, 'armedAt is now');
    assert(shouldRunPass(new Date()), 'the due gate was not cleared');
    assert(r.body.key === `famcal|${row.id}`, `key ${r.body.key}`);
    assertSame(tracked.map((t) => t.action), ['voice_event_created', 'native_reminder_created'], 'the bot\'s two names');
    assertSame(tracked[1].meta, { for_partner: false, all_day: false, recurring: false, source: 'app' }, 'reminder analytics');
  });

  await check('create reminder: date-only is all-day at the start of its day; repeating; for the partner', async () => {
    seed();
    const dateOnly = await post(reminderBody({ allDay: true, start: '2026-10-20' }));
    const row = eventRow(idOf(dateOnly.body.key));
    assertSame([row.allDay, iso(row.startsAt), iso(row.endsAt)], [true, '2026-10-19T21:00:00.000Z', '2026-10-19T21:00:00.000Z'], 'date-only: local midnight, no length');
    const weekly = await post(reminderBody({ repeat: 'weekly' }));
    assert(eventRow(idOf(weekly.body.key)).rrule === 'FREQ=WEEKLY' && weekly.body.key.includes('#'), `weekly ${weekly.body.key}`);
    seedRecurrenceCache();
    const partner = await post(reminderBody({ forPartner: true, title: 'Pick up the cake' }));
    assert(partner.status === 200, `for the partner ${partner.status} ${partner.text}`);
    assertSame([lastEvent().forUserId, lastEvent().creatorUserId, lastEvent().calendarId], [NOA, TAL, 'cal-tal'], 'for Noa, on Tal\'s main calendar');
    assertSame(cacheUsers(), [11], 'a reminder for the partner clears their cache too');
    assert(tracked[tracked.length - 1].meta.for_partner === true, 'analytics for_partner');
  });

  await check('create reminder: for a partner who cannot be pinged is invalid; with no plan or no Telegram it is 403; a Google user\'s goes to their FamCal main', async () => {
    seed();
    tables.user.find((u) => u.id === NOA)!.telegramId = null;
    const r = await post(reminderBody({ forPartner: true }));
    assert(r.status === 400, `${r.status} ${r.text}`);
    assertSame(r.body, { error: 'invalid', field: 'forPartner' }, 'no Telegram');
    assert(eventsAll().length === 0, 'it wrote');
    const alone = await post(reminderBody({ forPartner: true }), { tg: TG.solo });
    assertSame([alone.status, alone.body], [400, { error: 'invalid', field: 'forPartner' }], 'no partner');
    noReminderPlan.add(TAL);
    const noPlan = await post(reminderBody());
    assertSame([noPlan.status, noPlan.body.error], [403, 'not_allowed'], 'no plan');
    assert(eventsAll().length === 0, 'a refused reminder wrote');
    const dan = await post(reminderBody(), { tg: TG.dan });
    assertSame([dan.status, eventsAll().length], [200, 1], 'a Google user\'s reminder');
    const events = await post(eventBody());
    assert(events.status === 200, 'events stay available without the reminders plan');
  });

  // ================= GET /item =================

  await check('item: a one-off event\'s edit info, a repeating one\'s, in the wall form', async () => {
    seed();
    const one = await post(eventBody({ location: 'Clinic', description: 'Card' }));
    const r = await itemOf(one.body.key);
    assert(r.status === 200 && cacheOf(r) === NOT_STORED, `${r.status} ${r.text}`);
    assertSame(r.body, {
      kind: 'event', canEdit: true, canDelete: true,
      occurrence: { start: '2026-10-20T10:00', end: '2026-10-20T11:00', allDay: false, title: 'Dentist', location: 'Clinic', description: 'Card' },
      series: { recurring: false, start: '2026-10-20T10:00', repeat: null, fixedDays: false, zone: IL, rule: { choice: 'none' }, first: true },
      tz: IL,
      // The fixtures share one colour, so the sheet shows each calendar shifted apart (displayColours); the saved colour is #039BE5.
      calendar: { id: 'native:cal-tal', name: 'Tal', color: '#7987ed' },
      forName: null, alert: 'default', scopes: ['single'],
      canMoveCalendar: true, moveTargets: ['native:cal-tal', 'native:cal-tal-family', 'native:cal-noa-edit'],
      canChangeRecipient: false, forPartner: false, source: 'famcal',
    }, 'a one-off');
    const weekly = await post(eventBody({ repeat: 'weekly' }));
    const occurrence = `famcal|${idOf(weekly.body.key)}#${iso(at('2026-11-03 10:00'))}`;
    const w = await itemOf(occurrence);
    assertSame(
      [w.body.occurrence.start, w.body.series, w.body.scopes, w.body.tz],
      ['2026-11-03T10:00', { recurring: true, start: '2026-10-20T10:00', repeat: { freq: 'weekly', interval: 1, byDay: [], ends: false }, fixedDays: false, zone: IL, rule: { choice: 'weekly' }, spec: { freq: 'weekly', interval: 1, byDay: ['TU'] }, first: false }, ['single', 'following', 'all'], IL],
      'an occurrence of a weekly series'
    );
    const allDay = await post(eventBody({ allDay: true, start: '2026-10-20', end: '2026-10-22' }));
    assertSame((await itemOf(allDay.body.key)).body.occurrence, { start: '2026-10-20', end: '2026-10-22', allDay: true, title: 'Dentist', location: '', description: '' }, 'all-day: dates, the end inclusive');
  });

  await check('item: the bot\'s rules read as they are (BYDAY, INTERVAL, UNTIL)', async () => {
    seed();
    const s = seedSeries('bot-series', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Piano', startsAt: at('2026-10-20 16:00'), rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20261231' });
    const r = await itemOf(`famcal|${s.id}#${iso(at('2026-10-20 16:00'))}`);
    assertSame(r.body.series.repeat, { freq: 'weekly', interval: 2, byDay: ['TU', 'TH'], ends: true, until: '2026-12-31' }, 'repeat');
    assertSame(r.body.series.spec, { freq: 'weekly', interval: 2, byDay: ['TU', 'TH'], until: '2026-12-31' }, 'the sheet can say it');
    assert(r.body.series.fixedDays === true, 'BYDAY fixes the days');
    for (const [rule, fixed] of [['FREQ=MONTHLY;BYMONTHDAY=20', true], ['FREQ=YEARLY;BYMONTH=10', true], ['FREQ=WEEKLY', false], ['FREQ=DAILY;INTERVAL=2;UNTIL=20261231', false]] as const) {
      const other = seedSeries(`rule-${rule}`.replace(/[^A-Za-z0-9_-]/g, '_'), { calendarId: 'cal-tal', creatorUserId: TAL, title: 'x', startsAt: at('2026-10-20 16:00'), rrule: rule });
      const info = await itemOf(`famcal|${other.id}#${iso(at('2026-10-20 16:00'))}`);
      assert(info.body.series?.fixedDays === fixed, `${rule}: fixedDays ${info.body.series?.fixedDays}`);
    }
  });

  await check('item: 404 for unknown, the partner\'s private calendar, someone else\'s, a Google user, a missing or extra instant; 409 not used on reads', async () => {
    seed();
    const own = await post(eventBody());
    const weekly = await post(eventBody({ repeat: 'weekly' }));
    const theirs = seedSeries('noa-private-event', { calendarId: 'cal-noa-private', creatorUserId: NOA, title: 'Surprise', startsAt: at('2026-10-21 10:00') });
    const strangers = seedSeries('solo-event', { calendarId: 'cal-solo', creatorUserId: 11, title: 'Solo', startsAt: at('2026-10-21 10:00') });
    for (const [what, key] of [
      ['unknown', 'famcal|nope'],
      ['the partner\'s private calendar', `famcal|${theirs.id}`],
      ['a stranger\'s', `famcal|${strangers.id}`],
      ['a repeating series with no occurrence', `famcal|${idOf(weekly.body.key)}`],
      ['a one-off with an occurrence', `${own.body.key}#${iso(at('2026-10-20 10:00'))}`],
      ['an occurrence the rule does not make', `famcal|${idOf(weekly.body.key)}#${iso(at('2026-10-21 10:00'))}`],
    ] as const) {
      const r = await itemOf(key);
      assert(r.status === 404 && r.body.error === 'not_found', `${what}: ${r.status} ${r.text}`);
    }
    assert((await itemOf(own.body.key, { tg: TG.dan })).status === 404, 'a Google user');
    assert((await itemOf(own.body.key, { tg: TG.noa })).status === 404, 'the partner cannot read a private calendar\'s event');
    assert((await itemOf('not a key')).status === 400, 'a malformed key is 400');
  });

  await check('item: permissions of a shared editor, a viewer calendar, a masked reminder; the partner sees their shared event', async () => {
    seed();
    const editorEvent = seedSeries('on-editor', { calendarId: 'cal-noa-edit', creatorUserId: NOA, title: 'Shared', startsAt: at('2026-10-21 10:00') });
    const viewerEvent = seedSeries('on-viewer', { calendarId: 'cal-noa-view', creatorUserId: NOA, title: 'Viewed', startsAt: at('2026-10-21 12:00') });
    const e = await itemOf(`famcal|${editorEvent.id}`);
    assertSame([e.body.canEdit, e.body.canDelete, e.body.calendar.name], [true, true, 'Noa shared'], 'an editor can');
    const v = await itemOf(`famcal|${viewerEvent.id}`);
    assertSame([v.body.canEdit, v.body.canDelete], [false, false], 'a viewer cannot');
    const masked = seedSeries('noa-for-tal', { calendarId: 'cal-noa-private', creatorUserId: NOA, forUserId: TAL, kind: 'REMINDER', title: 'Call your mother', startsAt: at('2026-10-21 09:00') });
    const m = await itemOf(`famcal|${masked.id}`);
    assertSame(
      [m.body.kind, m.body.canEdit, m.body.canDelete, m.body.calendar, m.body.forName, m.body.occurrence.end],
      ['reminder', false, true, { id: null, name: 'Noa', color: null }, null, '2026-10-21T09:00'],
      'a reminder set for Tal on a private calendar: masked, deletable, not editable'
    );
    assert(!m.text.includes('Noa secret') && !m.text.includes('cal-noa-private'), 'the private calendar leaked');
    const forNoa = seedSeries('tal-for-noa', { calendarId: 'cal-noa-view', creatorUserId: TAL, forUserId: NOA, kind: 'REMINDER', title: 'Tell Noa', startsAt: at('2026-10-21 09:00') });
    const f = await itemOf(`famcal|${forNoa.id}`);
    assertSame([f.body.canEdit, f.body.canDelete, f.body.forName], [true, true, 'Noa'], 'the creator edits a reminder on a calendar they can only view');
    const shared = await post(eventBody({ calendarId: 'native:cal-tal-family' }));
    // The calendars it can move to are each reader's own (3b), so they are left out of the comparison.
    const { moveTargets: _noaTargets, ...asNoa } = (await itemOf(shared.body.key, { tg: TG.noa })).body;
    const { moveTargets: _talTargets, ...asTal } = (await itemOf(shared.body.key)).body;
    assertSame(asNoa, { ...asTal, calendar: { id: 'native:cal-tal-family', name: 'Family', color: '#00aa8f' }, canEdit: true, canDelete: true }, 'the partner reads and edits the shared calendar\'s event');
  });

  // ================= PATCH: events, each scope =================

  /** A weekly Tuesday 10:00 event from Oct 20, and the keys of its occurrences. */
  const weeklySeries = async (extra: Row = {}) => {
    const created = await post(eventBody({ repeat: 'weekly', ...extra }));
    const id = idOf(created.body.key);
    const occ = (day: string, time = '10:00') => `famcal|${id}#${iso(at(`${day} ${time}`))}`;
    return { id, occ, row: eventRow(id) };
  };
  const overrides = (id: string) => tables.nativeEventInstance.filter((o) => o.seriesEventId === id);

  await check('edit event, this one only: a title change is an override with only the title; the series and the key stay', async () => {
    seed();
    const { id, occ } = await weeklySeries();
    const r = await patch({ key: occ('2026-10-27'), scope: 'single', changes: { title: 'Dentist (moved)' } });
    assertSame(r.body, { status: 'ok', key: occ('2026-10-27') }, 'response');
    assertSame(overrides(id).map((o) => [iso(o.originalStartsAt), o.title, o.startsAt, o.endsAt, o.location, o.description]), [[iso(at('2026-10-27 10:00')), 'Dentist (moved)', null, null, null, null]], 'override');
    assert(eventRow(id).title === 'Dentist', 'the series changed');
    assert((await itemOf(occ('2026-10-27'))).body.occurrence.title === 'Dentist (moved)', 'the item reads the override');
    assert((await itemOf(occ('2026-11-03'))).body.occurrence.title === 'Dentist', 'the next one is as before');
  });

  await check('edit event, this one only: a time change moves the occurrence and keeps the key (its slot)', async () => {
    seed();
    const { id, occ } = await weeklySeries();
    const r = await patch({ key: occ('2026-10-27'), scope: 'single', changes: { start: '2026-10-28T14:00', end: '2026-10-28T15:30' } });
    assert(r.status === 200 && r.body.key === occ('2026-10-27'), `${r.status} ${r.text}`);
    const o = overrides(id)[0];
    assertSame([iso(o.startsAt), iso(o.endsAt), o.title], [iso(at('2026-10-28 14:00')), iso(at('2026-10-28 15:30')), null], 'moved');
    const read = await itemOf(occ('2026-10-27'));
    assertSame([read.body.occurrence.start, read.body.occurrence.end], ['2026-10-28T14:00', '2026-10-28T15:30'], 'read back');
    const moveStartOnly = await patch({ key: occ('2026-11-03'), scope: 'single', changes: { start: '2026-11-03T09:00' } });
    assert(moveStartOnly.status === 200, 'start only');
    assert((await itemOf(occ('2026-11-03'))).body.occurrence.end === '2026-11-03T10:00', 'a moved start keeps the length');
  });

  await check('edit event, all of them: a title change keeps the overrides; a time change shifts the series, and an override keeps what it carries at the new time', async () => {
    seed();
    const { id, occ } = await weeklySeries();
    await patch({ key: occ('2026-11-03'), scope: 'single', changes: { location: 'Home' } });
    const title = await patch({ key: occ('2026-10-27'), scope: 'all', changes: { title: 'Dentist visit' } });
    assertSame(title.body, { status: 'ok', key: occ('2026-10-27') }, 'title: same key');
    assertSame([eventRow(id).title, overrides(id).length, iso(eventRow(id).startsAt)], ['Dentist visit', 1, iso(at('2026-10-20 10:00'))], 'title: the series, the override stays, the start stays');
    const time = await patch({ key: occ('2026-10-27'), scope: 'all', changes: { start: '2026-10-27T11:30', end: '2026-10-27T12:30' } });
    assert(time.status === 200 && time.body.key === occ('2026-10-27', '11:30'), `time: ${time.status} ${time.text}`);
    assertSame([iso(eventRow(id).startsAt), iso(eventRow(id).endsAt)], [iso(at('2026-10-20 11:30')), iso(at('2026-10-20 12:30'))], 'time: every occurrence moves');
    assertSame(overrides(id).map((o) => [iso(o.originalStartsAt), o.location, o.startsAt]), [[iso(at('2026-11-03 11:30')), 'Home', null]], 'the override follows to the new time with its location');
    assert((await itemOf(occ('2026-11-03', '11:30'))).body.occurrence.location === 'Home', 'and reads there');
    assert((await itemOf(time.body.key)).body.occurrence.start === '2026-10-27T11:30', 'the returned key reads');
    const longer = await patch({ key: time.body.key, scope: 'all', changes: { end: '2026-10-27T13:30' } });
    assert(longer.body.key === time.body.key, 'a longer event keeps its key');
    assert(iso(eventRow(id).endsAt) === iso(at('2026-10-20 13:30')) && iso(eventRow(id).startsAt) === iso(at('2026-10-20 11:30')), 'only the end moved');
  });

  await check('edit event, all of them, the start where it was: a new end reaches an occurrence with its own times too; its title, another one\'s location and a cancelled one stay', async () => {
    seed();
    const { id, occ } = await weeklySeries();
    const longer = await patch({ key: occ('2026-10-27'), scope: 'single', changes: { title: 'Dentist, longer', end: '2026-10-27T11:30' } });
    assert(longer.status === 200 && iso(overrides(id)[0].endsAt) === iso(at('2026-10-27 11:30')), `single: ${longer.status} ${longer.text}`);
    await patch({ key: occ('2026-11-03'), scope: 'single', changes: { location: 'Home' } });
    await patch({ key: occ('2026-11-10'), scope: 'single', changes: { start: '2026-11-10T09:00' } });
    await del({ key: occ('2026-11-10'), scope: 'single' });
    const all = await patch({ key: occ('2026-10-27'), scope: 'all', changes: { end: '2026-10-27T12:00' } });
    assert(all.status === 200 && all.body.key === occ('2026-10-27'), `all: ${all.status} ${all.text}`);
    assertSame([iso(eventRow(id).startsAt), iso(eventRow(id).endsAt)], [iso(at('2026-10-20 10:00')), iso(at('2026-10-20 12:00'))], 'the series: same start, the new end');
    for (const d of ['2026-10-20', '2026-10-27', '2026-11-03', '2026-11-17']) {
      const read = await itemOf(occ(d));
      assertSame([read.body.occurrence.start, read.body.occurrence.end], [`${d}T10:00`, `${d}T12:00`], `${d} has the new end`);
    }
    assertSame([(await itemOf(occ('2026-10-27'))).body.occurrence.title, (await itemOf(occ('2026-11-03'))).body.occurrence.location], ['Dentist, longer', 'Home'], 'what else the overrides carry stays');
    assertSame([(await itemOf(occ('2026-11-10'))).status, overrides(id).find((o) => iso(o.originalStartsAt) === iso(at('2026-11-10 10:00')))?.status], [404, 'CANCELLED'], 'the cancelled one stays cancelled');
  });

  await check('edit reminder, all of them back at the series\' time: the occurrence moved on its own comes back, its state goes and its ping is stripped', async () => {
    seed();
    const created = await post(reminderBody({ repeat: 'daily' }));
    const id = idOf(created.body.key);
    const day = (d: string) => `famcal|${id}#${iso(at(`${d} 17:30`))}`;
    const moved = await patch({ key: day('2026-10-21'), scope: 'single', changes: { title: 'Plumber, later', start: '2026-10-21T19:00' } });
    assert(moved.status === 200, `single: ${moved.status} ${moved.text}`);
    seedState(id, at('2026-10-21 17:30'), 61, { lastPingedAt: at('2026-10-21 19:00') });
    seedState(id, at('2026-10-22 17:30'), 62);
    stripped.length = 0;
    eventRow(id).armedAt = OLD;
    const back = await patch({ key: day('2026-10-21'), scope: 'all', changes: { start: '2026-10-21T17:30' } });
    assert(back.status === 200 && back.body.key === day('2026-10-21'), `all: ${back.status} ${back.text}`);
    const read = await itemOf(day('2026-10-21'));
    assertSame([read.body.occurrence.start, read.body.occurrence.title, iso(eventRow(id).startsAt)], ['2026-10-21T17:30', 'Plumber, later', iso(at('2026-10-20 17:30'))], 'back at 17:30, its title kept, the series where it was');
    assertSame(tables.nativeReminderState.map((r) => r.pingMessageId), [62], 'only the moved one\'s state went');
    assertSame(stripped.map((x) => x.pings.map((p: Row) => p.messageId)), [[61]], 'and its ping was stripped');
    assert(eventRow(id).armedAt.getTime() > OLD.getTime(), 'armed again');
  });

  await check('edit event, all of them, to another day: the series shifts by those days, and the weekday follows', async () => {
    seed();
    const { id, occ } = await weeklySeries();
    const r = await patch({ key: occ('2026-11-03'), scope: 'all', changes: { start: '2026-11-05T10:00', end: '2026-11-05T11:00' } });
    assert(r.status === 200 && r.body.key === occ('2026-11-05'), `${r.status} ${r.text}`);
    assert(iso(eventRow(id).startsAt) === iso(at('2026-10-22 10:00')), `series start ${iso(eventRow(id).startsAt)}`);
    const { expandSeries } = await load('src/services/native-calendar/recurrence.ts');
    const days = expandSeries(eventRow(id), { from: at('2026-10-20 00:00'), to: at('2026-11-20 00:00') }, []).map((i: Row) => iso(i.startsAt));
    assertSame(days, ['2026-10-22', '2026-10-29', '2026-11-05', '2026-11-12', '2026-11-19'].map((d) => iso(at(`${d} 10:00`))), 'Thursdays now');
  });

  await check('edit event, a rule with fixed days (the bot\'s BYDAY, BYMONTHDAY, BYMONTH): a day move is this one only; "after" and "all" are refused and write nothing; a new time of day is fine for every scope', async () => {
    seed();
    const series = seedSeries('bot-weekly', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Piano', startsAt: at('2026-10-20 16:00'), rrule: 'FREQ=WEEKLY;BYDAY=TU' });
    const occ = (d: string, time = '16:00') => `famcal|${series.id}#${iso(at(`${d} ${time}`))}`;
    const untouched = () => show([series.rrule, iso(series.startsAt), iso(series.endsAt), tables.nativeEvent.length, tables.nativeEventInstance.length]);
    const before = untouched();
    for (const scope of ['all', 'following']) {
      const r = await patch({ key: occ('2026-10-27'), scope, changes: { start: '2026-10-29T16:00', end: '2026-10-29T17:00' } });
      assertSame([r.status, r.body], [400, { error: 'invalid', field: 'start' }], `${scope}: a day move`);
      const later = await patch({ key: occ('2026-10-27'), scope, changes: { title: 'Piano lesson', start: '2026-10-28T09:00', end: '2026-10-28T10:00' } });
      assertSame([later.status, later.body], [400, { error: 'invalid', field: 'start' }], `${scope}: a day move with a title`);
      assert(untouched() === before && series.title === 'Piano', `${scope}: a refused move wrote: ${untouched()}`);
    }
    const allDay = await patch({ key: occ('2026-10-27'), scope: 'all', changes: { allDay: true, start: '2026-10-28' } });
    assertSame([allDay.status, allDay.body], [400, { error: 'invalid', field: 'start' }], 'made all-day on another day');
    const single = await patch({ key: occ('2026-10-27'), scope: 'single', changes: { start: '2026-10-29T16:00', end: '2026-10-29T17:00' } });
    assert(single.status === 200 && single.body.key === occ('2026-10-27'), `single: ${single.status} ${single.text}`);
    assertSame(overrides(series.id).map((o) => iso(o.startsAt)), [iso(at('2026-10-29 16:00'))], 'only that one moved');
    // A new time of day keeps the days: every scope takes it.
    const all = await patch({ key: occ('2026-11-03'), scope: 'all', changes: { start: '2026-11-03T17:30', end: '2026-11-03T18:30' } });
    assert(all.status === 200 && all.body.key === occ('2026-11-03', '17:30'), `all, a new time: ${all.status} ${all.text}`);
    assertSame([series.rrule, iso(series.startsAt)], ['FREQ=WEEKLY;BYDAY=TU', iso(at('2026-10-20 17:30'))], 'the series keeps its Tuesdays at the new time');
    const following = await patch({ key: occ('2026-11-10', '17:30'), scope: 'following', changes: { start: '2026-11-10T08:00', end: '2026-11-10T09:00' } });
    assert(following.status === 200, `following, a new time: ${following.status} ${following.text}`);
    const fresh = lastEvent();
    assertSame([fresh.rrule, iso(fresh.startsAt)], ['FREQ=WEEKLY;BYDAY=TU', iso(at('2026-11-10 08:00'))], 'the new series starts on that Tuesday');
    // A time that crosses midnight is a day move too.
    const late = await patch({ key: `famcal|${fresh.id}#${iso(at('2026-11-17 08:00'))}`, scope: 'all', changes: { start: '2026-11-16T23:30', end: '2026-11-17T00:30' } });
    assertSame(late.body, { error: 'invalid', field: 'start' }, 'the day before');
    // BYMONTHDAY and BYMONTH fix their days the same way; a rule the editor wrote does not.
    for (const rule of ['FREQ=MONTHLY;BYMONTHDAY=20', 'FREQ=YEARLY;BYMONTH=10']) {
      seed();
      const s2 = seedSeries('bot-rule', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Rent', startsAt: at('2026-10-20 16:00'), rrule: rule });
      const r = await patch({ key: `famcal|${s2.id}#${iso(at('2026-10-20 16:00'))}`, scope: 'all', changes: { start: '2026-10-21T16:00', end: '2026-10-21T17:00' } });
      assertSame([r.status, r.body, iso(s2.startsAt)], [400, { error: 'invalid', field: 'start' }, iso(at('2026-10-20 16:00'))], rule);
    }
    seed();
    const { id, occ: plain } = await weeklySeries();
    const moved = await patch({ key: plain('2026-10-27'), scope: 'following', changes: { start: '2026-10-29T10:00', end: '2026-10-29T11:00' } });
    assert(moved.status === 200 && iso(lastEvent().startsAt) === iso(at('2026-10-29 10:00')) && lastEvent().id !== id, `a rule the editor wrote follows its start: ${moved.status} ${moved.text}`);
  });

  await check('an occurrence moved on its own to another day, then given a new time: "all" answers the key it lands on (back on the rule\'s day), and "this and after" on a rule with fixed days starts the new series on the rule\'s day', async () => {
    seed();
    const { id, occ } = await weeklySeries();
    const alone = await patch({ key: occ('2026-10-27'), scope: 'single', changes: { start: '2026-10-29T10:00', end: '2026-10-29T11:00' } });
    assert(alone.status === 200, `single ${alone.status} ${alone.text}`);
    const all = await patch({ key: occ('2026-10-27'), scope: 'all', changes: { start: '2026-10-29T12:00', end: '2026-10-29T13:00' } });
    assert(all.status === 200 && all.body.key === occ('2026-10-27', '12:00'), `all: ${all.status} ${all.body.key}`);
    const read = await itemOf(all.body.key);
    assertSame([read.status, read.body.occurrence?.start], [200, '2026-10-27T12:00'], 'the key reads: Tuesday at 12:00');
    assert(eventRow(id).startsAt.getTime() === at('2026-10-20 12:00').getTime(), `series ${iso(eventRow(id).startsAt)}`);
    seed();
    const series = seedSeries('bot-weekly', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Piano', startsAt: at('2026-10-20 16:00'), rrule: 'FREQ=WEEKLY;BYDAY=TU', exdates: [at('2026-11-10 16:00')] });
    const k = `famcal|${series.id}#${iso(at('2026-10-27 16:00'))}`;
    assert((await patch({ key: k, scope: 'single', changes: { start: '2026-10-28T16:00', end: '2026-10-28T17:00' } })).status === 200, 'moved to Wednesday alone');
    const later = await patch({ key: k, scope: 'following', changes: { start: '2026-10-28T18:00', end: '2026-10-28T19:00' } });
    const fresh = lastEvent();
    assert(later.status === 200 && later.body.key === `famcal|${fresh.id}#${iso(at('2026-10-27 18:00'))}`, `following: ${later.status} ${later.text}`);
    assertSame([iso(fresh.startsAt), fresh.exdates.map(iso)], [iso(at('2026-10-27 18:00')), [iso(at('2026-11-10 18:00'))]], 'the new series: Tuesday the 27th at 18:00, the skipped 10th still skipped');
    assertSame((await itemOf(later.body.key)).body.occurrence?.start, '2026-10-27T18:00', 'the key reads');
    const back = await patch({ key: `famcal|${fresh.id}#${iso(at('2026-11-03 18:00'))}`, scope: 'following', changes: { start: '2026-11-04T18:00', end: '2026-11-04T19:00' } });
    assertSame([back.status, back.body], [400, { error: 'invalid', field: 'start' }], 'a day move on it is still refused');
  });

  await check('this and the ones after to another day, from an occurrence moved on its own: the new series starts on the date entered, and the key says so', async () => {
    seed();
    const { id, occ } = await weeklySeries();
    assert((await patch({ key: occ('2026-10-27'), scope: 'single', changes: { start: '2026-10-29T10:00', end: '2026-10-29T11:00' } })).status === 200, 'moved to Thursday alone');
    const r = await patch({ key: occ('2026-10-27'), scope: 'following', changes: { start: '2026-10-30T10:00', end: '2026-10-30T11:00' } });
    const fri = tables.nativeEvent.find((e) => e.id !== id)!;
    assert(r.status === 200 && r.body.key === `famcal|${fri.id}#${iso(at('2026-10-30 10:00'))}`, `following: ${r.status} ${r.text}`);
    assertSame([(await itemOf(r.body.key)).body.occurrence?.start, iso(fri.startsAt)], ['2026-10-30T10:00', iso(at('2026-10-30 10:00'))], 'Friday the 30th, and it reads');
    assertSame((await itemOf(`famcal|${fri.id}#${iso(at('2026-11-06 10:00'))}`)).status, 200, 'and every Friday after');
  });

  await check('edit reminder, a rule with fixed days: a day move for every one is refused; this one moves', async () => {
    seed();
    const series = seedSeries('bot-reminder', { calendarId: 'cal-tal', creatorUserId: TAL, kind: 'REMINDER', title: 'Bins', startsAt: at('2026-10-20 20:00'), rrule: 'FREQ=WEEKLY;BYDAY=TU' });
    const key = `famcal|${series.id}#${iso(at('2026-10-27 20:00'))}`;
    const all = await patch({ key, scope: 'all', changes: { start: '2026-10-28T20:00' } });
    assertSame([all.status, all.body, iso(series.startsAt)], [400, { error: 'invalid', field: 'start' }, iso(at('2026-10-20 20:00'))], 'all');
    const single = await patch({ key, scope: 'single', changes: { start: '2026-10-28T20:00' } });
    assert(single.status === 200 && iso(overrides(series.id)[0]?.startsAt) === iso(at('2026-10-28 20:00')), `single: ${single.status} ${single.text}`);
  });

  await check('a deleted occurrence stays deleted when its series moves: an event\'s "all" to Thursdays, a reminder\'s "this and after" to a new time', async () => {
    seed();
    const { occ } = await weeklySeries();
    await del({ key: occ('2026-11-03'), scope: 'single' });
    await patch({ key: occ('2026-11-10'), scope: 'single', changes: { title: 'x' } });
    await del({ key: occ('2026-11-10'), scope: 'single' });
    const moved = await patch({ key: occ('2026-10-27'), scope: 'all', changes: { start: '2026-10-29T10:00', end: '2026-10-29T11:00' } });
    assert(moved.status === 200, `${moved.status} ${moved.text}`);
    assertSame([(await itemOf(occ('2026-11-05'))).status, (await itemOf(occ('2026-11-12'))).status, (await itemOf(occ('2026-11-19'))).status], [404, 404, 200], 'the Thursdays of the deleted Tuesdays stay deleted');
    const created = await post(reminderBody({ repeat: 'daily' }));
    const id = idOf(created.body.key);
    const day = (d: string, time = '17:30') => `famcal|${id}#${iso(at(`${d} ${time}`))}`;
    await del({ key: day('2026-10-23'), scope: 'single' });
    const later = await patch({ key: day('2026-10-21'), scope: 'following', changes: { start: '2026-10-21T19:00' } });
    assert(later.status === 200, `${later.status} ${later.text}`);
    const fresh = (d: string) => `famcal|${lastEvent().id}#${iso(at(`${d} 19:00`))}`;
    assertSame([(await itemOf(fresh('2026-10-22'))).status, (await itemOf(fresh('2026-10-23'))).status], [200, 404], 'the reminder skipped on the 23rd stays skipped at 19:00');
  });

  await check('edit event, this one and the ones after: the series is cut and a new one starts here, by the editor', async () => {
    seed();
    const { id, occ } = await weeklySeries();
    const r = await patch({ key: occ('2026-11-03'), scope: 'following', changes: { title: 'Dentist, new clinic', start: '2026-11-03T09:00', end: '2026-11-03T10:00' } }, { tg: TG.tal });
    assert(r.status === 200, `${r.status} ${r.text}`);
    assert(tables.nativeEvent.length === 2, `${tables.nativeEvent.length} series`);
    const fresh = tables.nativeEvent[1];
    assert(r.body.key === `famcal|${fresh.id}#${iso(at('2026-11-03 09:00'))}`, `key ${r.body.key}`);
    assertSame([fresh.title, iso(fresh.startsAt), iso(fresh.endsAt), fresh.rrule, fresh.creatorUserId], ['Dentist, new clinic', iso(at('2026-11-03 09:00')), iso(at('2026-11-03 10:00')), 'FREQ=WEEKLY', TAL], 'new series');
    assert(/UNTIL=/.test(eventRow(id).rrule), `the old one ends: ${eventRow(id).rrule}`);
    assert((await itemOf(r.body.key)).body.occurrence.title === 'Dentist, new clinic', 'the new key reads');
    assert((await itemOf(`famcal|${id}#${iso(at('2026-11-03 10:00'))}`)).status === 404, 'the old series no longer has that day');
    const textOnly = await patch({ key: `famcal|${id}#${iso(at('2026-10-27 10:00'))}`, scope: 'following', changes: { location: 'Elsewhere' } });
    assert(textOnly.status === 200 && textOnly.body.key.endsWith(`#${iso(at('2026-10-27 10:00'))}`), `a text-only cut keeps the slot: ${textOnly.body.key}`);
  });

  await check('edit event, this one and the ones after: what was deleted or moved after the cut stays so, on the new series, with the time or without', async () => {
    seed();
    const { occ } = await weeklySeries();
    await del({ key: occ('2026-11-10'), scope: 'single' });
    await patch({ key: occ('2026-11-17'), scope: 'single', changes: { title: 'x' } });
    await del({ key: occ('2026-11-17'), scope: 'single' });
    await patch({ key: occ('2026-11-24'), scope: 'single', changes: { start: '2026-11-25T15:00', end: '2026-11-25T16:00' } });
    const renamed = await patch({ key: occ('2026-11-03'), scope: 'following', changes: { title: 'Dentist, new clinic' } });
    assert(renamed.status === 200, `${renamed.status} ${renamed.text}`);
    const fresh = (d: string, time = '10:00') => `famcal|${lastEvent().id}#${iso(at(`${d} ${time}`))}`;
    assertSame([(await itemOf(fresh('2026-11-10'))).status, (await itemOf(fresh('2026-11-17'))).status], [404, 404], 'the deleted ones stay deleted');
    const moved = await itemOf(fresh('2026-11-24'));
    assertSame([moved.body.occurrence?.start, moved.body.occurrence?.title], ['2026-11-25T15:00', 'Dentist, new clinic'], 'the moved one stays moved, with the new title');
    const retimed = await patch({ key: fresh('2026-11-03'), scope: 'following', changes: { start: '2026-11-03T08:30', end: '2026-11-03T09:30' } });
    assert(retimed.status === 200, `${retimed.status} ${retimed.text}`);
    const later = (d: string) => `famcal|${lastEvent().id}#${iso(at(`${d} 08:30`))}`;
    assertSame([(await itemOf(later('2026-11-10'))).status, (await itemOf(later('2026-11-17'))).status], [404, 404], 'a new time: still deleted');
    assertSame((await itemOf(later('2026-11-24'))).body.occurrence?.start, '2026-11-24T08:30', 'a new time: the moved one takes it');
  });

  await check('edit event: a one-off takes any scope as itself; no change is a no-op that writes nothing', async () => {
    seed();
    const created = await post(eventBody());
    for (const scope of ['single', 'all', 'following']) {
      const r = await patch({ key: created.body.key, scope, changes: { title: `Title ${scope}` } });
      assert(r.status === 200 && r.body.key === created.body.key, `${scope}: ${r.status} ${r.text}`);
    }
    assert(tables.nativeEvent.length === 1 && eventRow(idOf(created.body.key)).title === 'Title following', 'one row, edited in place');
    prismaCalls.length = 0;
    const same = await patch({ key: created.body.key, scope: 'single', changes: { title: 'Title following', start: '2026-10-20T10:00', end: '2026-10-20T11:00', allDay: false } });
    assert(same.status === 200 && same.body.key === created.body.key, 'no-op');
    assert(!prismaCalls.some((c) => /\.(update|upsert|create|deleteMany)$/.test(c)), `a no-op wrote: ${prismaCalls}`);
  });

  await check('edit event: all-day on and off, notes and location cleared, a timed event made all-day keeps its day', async () => {
    seed();
    const created = await post(eventBody({ location: 'Clinic', description: 'Card' }));
    const toAllDay = await patch({ key: created.body.key, scope: 'single', changes: { allDay: true } });
    assert(toAllDay.status === 200, `${toAllDay.status} ${toAllDay.text}`);
    const row = eventRow(idOf(created.body.key));
    assertSame([row.allDay, iso(row.startsAt), iso(row.endsAt)], [true, '2026-10-19T21:00:00.000Z', '2026-10-20T20:59:00.000Z'], 'all-day, that day');
    const needsTime = await patch({ key: created.body.key, scope: 'single', changes: { allDay: false } });
    assertSame([needsTime.status, needsTime.body], [400, { error: 'invalid', field: 'start' }], 'back to timed needs a start');
    const timed = await patch({ key: created.body.key, scope: 'single', changes: { allDay: false, start: '2026-10-21T08:00' } });
    assert(timed.status === 200, `${timed.status} ${timed.text}`);
    assertSame([row.allDay, iso(row.startsAt), iso(row.endsAt)], [false, iso(at('2026-10-21 08:00')), iso(at('2026-10-21 09:00'))], 'timed again, an hour');
    const cleared = await patch({ key: created.body.key, scope: 'single', changes: { location: '', description: '' } });
    assert(cleared.status === 200, 'clear');
    const read = await itemOf(created.body.key);
    assertSame([read.body.occurrence.location, read.body.occurrence.description], ['', ''], 'cleared');
  });

  await check('edit event: permissions and absence (a viewer calendar, a gone occurrence, a deleted event, a stranger, a Google user)', async () => {
    seed();
    const onViewer = seedSeries('on-viewer', { calendarId: 'cal-noa-view', creatorUserId: NOA, title: 'Viewed', startsAt: at('2026-10-21 12:00') });
    const r = await patch({ key: `famcal|${onViewer.id}`, scope: 'single', changes: { title: 'Mine now' } });
    assertSame([r.status, r.body.error], [403, 'not_allowed'], 'viewer');
    assert(onViewer.title === 'Viewed', 'a refused edit wrote');
    const onEditor = seedSeries('on-editor', { calendarId: 'cal-noa-edit', creatorUserId: NOA, title: 'Shared', startsAt: at('2026-10-21 12:00') });
    assert((await patch({ key: `famcal|${onEditor.id}`, scope: 'single', changes: { title: 'Ours' } })).status === 200 && onEditor.title === 'Ours', 'editor calendar');
    const private_ = seedSeries('private', { calendarId: 'cal-noa-private', creatorUserId: NOA, title: 'Secret', startsAt: at('2026-10-21 12:00') });
    assertSame((await patch({ key: `famcal|${private_.id}`, scope: 'single', changes: { title: 'x' } })).status, 404, 'a private calendar is not even there');
    const { id, occ } = await weeklySeries();
    await del({ key: occ('2026-10-27'), scope: 'single' });
    const gone = await patch({ key: occ('2026-10-27'), scope: 'single', changes: { title: 'x' } });
    assertSame([gone.status, gone.body], [409, { error: 'changed' }], 'a cancelled occurrence is 409');
    await del({ key: occ('2026-10-20'), scope: 'all' });
    const dead = await patch({ key: occ('2026-11-03'), scope: 'all', changes: { title: 'x' } });
    assertSame([dead.status, dead.body.error], [404, 'not_found'], 'a deleted series is 404');
    assert(eventRow(id).isDeleted, 'deleted');
    const dan = await patch({ key: occ('2026-11-03'), scope: 'all', changes: { title: 'x' } }, { tg: TG.dan });
    assert(dan.status === 404, `Google user ${dan.status}`);
  });

  // ================= PATCH: reminders =================

  await check('edit reminder: a title change keeps its state; a time change clears the state, re-arms it and strips the ping', async () => {
    seed();
    const created = await post(reminderBody());
    const id = idOf(created.body.key);
    const slot = eventRow(id).startsAt as Date;
    seedState(id, slot, 77, { doneAt: new Date('2026-10-20T15:00:00Z') });
    __resetDueGateForTests();
    setNextDue(new Date(Date.now() + 30 * 60_000), new Date());
    const title = await patch({ key: created.body.key, scope: 'single', changes: { title: 'Call the electrician' } });
    assert(title.status === 200 && tables.nativeReminderState.length === 1 && stripped.length === 0, `title: ${title.status}, states ${tables.nativeReminderState.length}, stripped ${stripped.length}`);
    eventRow(id).armedAt = OLD;
    const before = Date.now();
    const moved = await patch({ key: created.body.key, scope: 'single', changes: { start: '2026-10-21T08:15' } });
    assert(moved.status === 200, `${moved.status} ${moved.text}`);
    const row = eventRow(id);
    assertSame([iso(row.startsAt), iso(row.endsAt)], [iso(at('2026-10-21 08:15')), iso(at('2026-10-21 08:15'))], 'still one moment');
    assert(row.armedAt.getTime() >= before, 'armed again');
    assert(count(tables.nativeReminderState) === 0, 'state cleared');
    assert(count(stripped) === 1 && stripped[0].pings[0].messageId === 77 && stripped[0].editorId === TAL, `stripped ${show(stripped)}`);
    assertSame([iso(stripped[0].updates.startTime), stripped[0].original.summary], [iso(at('2026-10-21 08:15')), 'Call the electrician'], 'the ping edit is told where it went');
    assert(shouldRunPass(new Date()), 'the move opens the due gate');
  });

  await check('edit reminder: date-only to timed and back; an end in the body is ignored', async () => {
    seed();
    const created = await post(reminderBody({ allDay: true, start: '2026-10-20' }));
    const id = idOf(created.body.key);
    const timed = await patch({ key: created.body.key, scope: 'single', changes: { allDay: false, start: '2026-10-20T09:00', end: '2030-01-01T00:00' } });
    assert(timed.status === 200, `${timed.status} ${timed.text}`);
    assertSame([eventRow(id).allDay, iso(eventRow(id).startsAt), iso(eventRow(id).endsAt)], [false, iso(at('2026-10-20 09:00')), iso(at('2026-10-20 09:00'))], 'timed at 09:00');
    const back = await patch({ key: created.body.key, scope: 'single', changes: { allDay: true } });
    assert(back.status === 200 && eventRow(id).allDay && iso(eventRow(id).startsAt) === '2026-10-19T21:00:00.000Z', `back ${back.status} ${back.text}`);
    const read = await itemOf(created.body.key);
    assertSame([read.body.occurrence.allDay, read.body.occurrence.start, read.body.occurrence.end], [true, '2026-10-20', '2026-10-20'], 'read back as a date');
  });

  await check('edit reminder, repeating: this one, this and after, all; a series shift moves the state of every occurrence', async () => {
    seed();
    const created = await post(reminderBody({ repeat: 'daily' }));
    const id = idOf(created.body.key);
    const day = (d: string) => `famcal|${id}#${iso(at(`${d} 17:30`))}`;
    seedState(id, at('2026-10-21 17:30'), 41);
    seedState(id, at('2026-10-22 17:30'), 42);
    const single = await patch({ key: day('2026-10-21'), scope: 'single', changes: { start: '2026-10-21T19:00' } });
    assert(single.status === 200 && single.body.key === day('2026-10-21'), `single ${single.status} ${single.text}`);
    assertSame(tables.nativeReminderState.map((s) => s.pingMessageId), [42], 'only that occurrence\'s state went');
    assertSame(stripped.map((s) => s.pings[0].messageId), [41], 'only its ping was stripped');
    const all = await patch({ key: day('2026-10-22'), scope: 'all', changes: { start: '2026-10-22T18:00' } });
    assert(all.status === 200 && all.body.key === day('2026-10-22').replace('17:30', '18:00') || all.body.key.includes(iso(at('2026-10-22 18:00'))), `all ${all.body.key}`);
    assertSame([iso(eventRow(id).startsAt), tables.nativeReminderState.length, overrides(id).length], [iso(at('2026-10-20 18:00')), 0, 0], 'the series moved, state and overrides cleared');
    const following = await patch({ key: all.body.key, scope: 'following', changes: { title: 'New title' } });
    assert(following.status === 200 && tables.nativeEvent.length === 2, `following ${following.status} ${following.text}`);
    const fresh = tables.nativeEvent[1];
    assertSame([fresh.kind, fresh.creatorUserId, fresh.forUserId, fresh.title], ['REMINDER', TAL, null, 'New title'], 'a reminder still, the same creator');
  });

  await check('edit reminder: its creator edits it on a calendar they can only view; the person it is for cannot edit it but can delete it', async () => {
    seed();
    const forNoa = seedSeries('tal-for-noa', { calendarId: 'cal-noa-view', creatorUserId: TAL, forUserId: NOA, kind: 'REMINDER', title: 'Tell Noa', startsAt: at('2026-10-21 09:00') });
    const edit = await patch({ key: `famcal|${forNoa.id}`, scope: 'single', changes: { title: 'Tell Noa today' } });
    assert(edit.status === 200 && forNoa.title === 'Tell Noa today', `creator edit ${edit.status} ${edit.text}`);
    const masked = seedSeries('noa-for-tal', { calendarId: 'cal-noa-private', creatorUserId: NOA, forUserId: TAL, kind: 'REMINDER', title: 'Call your mother', startsAt: at('2026-10-21 09:00') });
    const talEdit = await patch({ key: `famcal|${masked.id}`, scope: 'single', changes: { title: 'x' } });
    assertSame([talEdit.status, masked.title], [403, 'Call your mother'], 'Tal cannot edit Noa\'s reminder');
    const noaEdit = await patch({ key: `famcal|${masked.id}`, scope: 'single', changes: { title: 'Call your mum' } }, { tg: TG.noa });
    assert(noaEdit.status === 200 && masked.title === 'Call your mum', `Noa edits her own ${noaEdit.status}`);
    const talDelete = await del({ key: `famcal|${masked.id}`, scope: 'single' });
    assert(talDelete.status === 200 && masked.isDeleted === true, `Tal deletes the one set for him ${talDelete.status} ${talDelete.text}`);
  });

  // ================= DELETE =================

  await check('delete event, each scope: this one (exdate, or cancelled when it has an override), after, all, a one-off', async () => {
    seed();
    seedRecurrenceCache();
    const { id, occ, row } = await weeklySeries({ calendarId: 'native:cal-tal-family' });
    cacheUsers();
    const single = await del({ key: occ('2026-10-27'), scope: 'single' });
    assertSame([single.status, single.body], [200, { status: 'ok' }], 'single');
    assertSame(row.exdates.map(iso), [iso(at('2026-10-27 10:00'))], 'exdate');
    assertSame(cacheUsers(), [11], 'the caches of Tal and Noa are cleared (a shared calendar)');
    await patch({ key: occ('2026-11-03'), scope: 'single', changes: { title: 'x' } });
    await del({ key: occ('2026-11-03'), scope: 'single' });
    assertSame(overrides(id).map((o) => o.status), ['CANCELLED'], 'an override is cancelled');
    assert((await itemOf(occ('2026-11-03'))).status === 404, 'and gone');
    assert((await itemOf(occ('2026-11-10'))).status === 200, 'the next stays');
    const following = await del({ key: occ('2026-11-17'), scope: 'following' });
    assert(following.status === 200 && /UNTIL=/.test(row.rrule), `following ${following.status} ${row.rrule}`);
    assert((await itemOf(occ('2026-11-24'))).status === 404 && (await itemOf(occ('2026-11-10'))).status === 200, 'cut from the 17th');
    const all = await del({ key: occ('2026-11-10'), scope: 'all' });
    assert(all.status === 200 && row.isDeleted === true, 'all');
    assert((await itemOf(occ('2026-11-10'))).status === 404, 'a deleted series is not found');
    const oneOff = await post(eventBody());
    for (const scope of ['single', 'following', 'all']) {
      const again = await post(eventBody({ title: scope }));
      assert((await del({ key: again.body.key, scope })).status === 200 && eventRow(idOf(again.body.key)).isDeleted, `a one-off, ${scope}`);
    }
    assert((await del({ key: oneOff.body.key, scope: 'single' })).status === 200 && (await del({ key: oneOff.body.key, scope: 'single' })).status === 404, 'a second delete is 404');
  });

  await check('delete: refused on a viewer calendar and a stranger\'s, a gone occurrence is 409, the person a reminder is for may delete it', async () => {
    seed();
    const onViewer = seedSeries('on-viewer', { calendarId: 'cal-noa-view', creatorUserId: NOA, title: 'Viewed', startsAt: at('2026-10-21 12:00') });
    assertSame((await del({ key: `famcal|${onViewer.id}`, scope: 'single' })).status, 403, 'viewer');
    assert(!onViewer.isDeleted, 'a refused delete wrote');
    const strangers = seedSeries('solo', { calendarId: 'cal-solo', creatorUserId: 11, title: 'Solo', startsAt: at('2026-10-21 12:00') });
    assertSame((await del({ key: `famcal|${strangers.id}`, scope: 'single' })).status, 404, 'a stranger\'s');
    const { occ } = await weeklySeries();
    await del({ key: occ('2026-10-27'), scope: 'single' });
    assertSame((await del({ key: occ('2026-10-27'), scope: 'single' })).body, { error: 'changed' }, 'twice');
    const asReminder = seedSeries('noa-for-tal', { calendarId: 'cal-noa-private', creatorUserId: NOA, forUserId: TAL, kind: 'REMINDER', title: 'x', startsAt: at('2026-10-21 09:00'), rrule: 'FREQ=DAILY' });
    const key = `famcal|${asReminder.id}#${iso(at('2026-10-22 09:00'))}`;
    assert((await del({ key, scope: 'single' })).status === 200 && asReminder.exdates.length === 1, 'Tal skips one of the reminders Noa set for him');
    tables.pairing[0].status = 'UNLINKED';
    assert((await del({ key: `famcal|${asReminder.id}#${iso(at('2026-10-23 09:00'))}`, scope: 'single' })).status === 404, 'once unlinked he no longer sees it');
  });

  // ================= DST =================

  await check('analytics: an edit and a delete are tracked after the write with the kind, the scope applied, source app and the fields changed, nothing more; a refused, gone, invalid or no-op write tracks nothing', async () => {
    seed();
    const { occ } = await weeklySeries({ title: SECRET_TITLE });
    const reminder = await post(reminderBody({ title: SECRET_TITLE }));
    const oneOff = await post(eventBody({ title: SECRET_TITLE }));
    tracked.length = 0;
    await patch({ key: occ('2026-10-27'), scope: 'following', changes: { title: `${SECRET_TITLE} 2` } });
    await patch({ key: reminder.body.key, scope: 'all', changes: { start: '2026-10-20T18:00' } });
    await patch({ key: oneOff.body.key, scope: 'all', changes: { location: 'Clinic' } });
    await del({ key: occ('2026-10-20'), scope: 'single' });
    await del({ key: reminder.body.key, scope: 'following' });
    assertSame(tracked.map((t) => [t.userId, t.action, t.meta]), [
      [TAL, 'calendar_item_edited', { kind: 'event', scope: 'following', source: 'app', provider: 'famcal', changed_fields: ['title'] }],
      [TAL, 'calendar_item_edited', { kind: 'reminder', scope: 'single', source: 'app', provider: 'famcal', changed_fields: ['time'] }],
      [TAL, 'calendar_item_edited', { kind: 'event', scope: 'single', source: 'app', provider: 'famcal', changed_fields: ['location'] }],
      [TAL, 'calendar_item_deleted', { kind: 'event', scope: 'single', source: 'app', provider: 'famcal' }],
      [TAL, 'calendar_item_deleted', { kind: 'reminder', scope: 'single', source: 'app', provider: 'famcal' }],
    ], 'one each, a one-off\'s scope being single');
    assert(!show(tracked).includes(SECRET_TITLE), 'a title reached analytics');
    tracked.length = 0;
    const onViewer = seedSeries('on-viewer', { calendarId: 'cal-noa-view', creatorUserId: NOA, title: 'Viewed', startsAt: at('2026-10-21 12:00') });
    await patch({ key: `famcal|${onViewer.id}`, scope: 'single', changes: { title: 'x' } });
    await del({ key: `famcal|${onViewer.id}`, scope: 'single' });
    await patch({ key: oneOff.body.key, scope: 'single', changes: { location: 'Clinic' } });
    const gone = await patch({ key: occ('2026-11-03'), scope: 'single', changes: { title: 'x' } });
    const invalid = await patch({ key: oneOff.body.key, scope: 'single', changes: { start: '2026-10-20T12:00', end: '2026-10-20T11:00' } });
    assertSame([gone.status, invalid.status], [409, 400], 'cut off by the split; ends before it starts');
    assertSame(tracked, [], 'refused (403), a no-op, a gone occurrence (409) and an invalid body track nothing');
  });

  await check('Asia/Jerusalem across the spring change: a weekly 10:00 stays 10:00 on the wall; edits are read on the wall', async () => {
    seed();
    const created = await post(eventBody({ repeat: 'weekly', start: '2026-03-20T10:00', end: '2026-03-20T11:00' }));
    const id = idOf(created.body.key);
    assert(iso(eventRow(id).startsAt) === '2026-03-20T08:00:00.000Z', `winter time: ${iso(eventRow(id).startsAt)}`);
    const occ = (day: string) => `famcal|${id}#${iso(at(`${day} 10:00`))}`;
    assert(iso(at('2026-03-27 10:00')) === '2026-03-27T07:00:00.000Z', 'summer time after the change');
    const after = await itemOf(occ('2026-04-03'));
    assertSame([after.body.occurrence.start, after.body.series.start], ['2026-04-03T10:00', '2026-03-20T10:00'], 'both read 10:00');
    await patch({ key: occ('2026-04-03'), scope: 'single', changes: { start: '2026-04-03T11:00', end: '2026-04-03T12:00' } });
    assert(iso(overrides(id)[0].startsAt) === '2026-04-03T08:00:00.000Z', `override ${iso(overrides(id)[0].startsAt)}`);
    const all = await patch({ key: occ('2026-04-10'), scope: 'all', changes: { start: '2026-04-10T10:30', end: '2026-04-10T11:30' } });
    assert(all.status === 200, `${all.status} ${all.text}`);
    assert(iso(eventRow(id).startsAt) === '2026-03-20T08:30:00.000Z', `the series moves on the wall, in winter time: ${iso(eventRow(id).startsAt)}`);
    assert((await itemOf(all.body.key)).body.occurrence.start === '2026-04-10T10:30', 'the returned key is the moved occurrence');
    const gap = await post(eventBody({ start: '2026-03-27T02:30', end: '2026-03-27T03:30' }));
    assert(gap.status === 200, `a time the change skips is accepted: ${gap.status} ${gap.text}`);
  });

  await check('Asia/Jerusalem across the autumn change: all-day and a reminder keep their day and time', async () => {
    seed();
    const allDay = await post(eventBody({ allDay: true, start: '2026-10-24', end: '2026-10-26', repeat: 'daily' }));
    const row = eventRow(idOf(allDay.body.key));
    assertSame([iso(row.startsAt), iso(row.endsAt)], ['2026-10-23T21:00:00.000Z', '2026-10-26T21:59:00.000Z'], 'Oct 24 00:00 IDT to Oct 26 23:59 IST');
    const read = await itemOf(allDay.body.key);
    assertSame([read.body.occurrence.start, read.body.occurrence.end], ['2026-10-24', '2026-10-26'], 'the dates read back across the change');
    const reminder = await post(reminderBody({ start: '2026-10-25T08:00', repeat: 'daily' }));
    assert(iso(eventRow(idOf(reminder.body.key)).startsAt) === '2026-10-25T06:00:00.000Z', 'the first morning after the change is UTC+2');
    const nextDay = await itemOf(`famcal|${idOf(reminder.body.key)}#${iso(at('2026-10-26 08:00'))}`);
    assert(nextDay.body.occurrence.start === '2026-10-26T08:00', 'still 08:00 on the wall');
    const shift = await patch({ key: `famcal|${idOf(reminder.body.key)}#${iso(at('2026-10-26 08:00'))}`, scope: 'all', changes: { start: '2026-10-26T09:00' } });
    assert(shift.status === 200 && iso(eventRow(idOf(reminder.body.key)).startsAt) === iso(at('2026-10-25 09:00')), `${shift.status} ${shift.text}`);
  });

  await check('the user\'s own zone decides, not the server\'s: a New York user\'s 10:00 is not Tel Aviv\'s', async () => {
    seed();
    tables.user.find((u) => u.id === 11)!.location = 'New York';
    redisStore.set('tz:user:11', 'America/New_York');
    const r = await post(eventBody(), { tg: TG.solo });
    assert(r.status === 200, `${r.status} ${r.text}`);
    const row = eventRow(idOf(r.body.key));
    assertSame([row.timeZone, iso(row.startsAt)], ['America/New_York', iso(at('2026-10-20 10:00', 'America/New_York'))], 'New York');
    const read = await itemOf(r.body.key, { tg: TG.solo });
    assert(read.body.occurrence.start === '2026-10-20T10:00', 'read back on the same clock');
    assert((await editorOf({ tg: TG.solo })).body.tz === 'America/New_York', 'the editor info says so');
  });

  // ================= 3b: the repeat, the calendar and the recipient (3b spec §3.1, §3.3) =================

  const rec = await load('src/services/native-calendar/recurrence.ts');
  const store = await load('src/services/native-calendar/event-store.ts');
  const statesOf = (id: string) => tables.nativeReminderState.filter((s) => s.seriesEventId === id);
  /** Every ping the write handed to the ping edit, by list. */
  const strips = () => ({
    moved: stripped.flatMap((s) => s.pings.map((p: Row) => p.messageId)),
    changed: stripped.flatMap((s) => (s.extra?.changed ?? []).map((p: Row) => p.messageId)),
    reassigned: stripped.flatMap((s) => (s.extra?.reassigned?.pings ?? []).map((p: Row) => p.messageId)),
    names: stripped.flatMap((s) => (s.extra?.reassigned?.pings?.length ? [s.extra.reassigned.name] : [])),
  });
  const thrownBy = async (fn: () => unknown): Promise<unknown> => {
    try { await fn(); return null; } catch (e) { return e; }
  };

  await check('3b rules: assertStorableRule takes what the bot, the editor and a cut write (an RRULE: prefix too) and refuses what would hang or break a read', async () => {
    for (const ok of [
      'FREQ=DAILY', 'FREQ=WEEKLY', 'FREQ=MONTHLY', 'FREQ=YEARLY', 'RRULE:FREQ=WEEKLY;BYDAY=TU', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20261231',
      'FREQ=DAILY;COUNT=10', 'FREQ=DAILY;INTERVAL=1', 'FREQ=WEEKLY;UNTIL=20261019T075959', 'FREQ=DAILY;UNTIL=20261019T075959Z', 'FREQ=WEEKLY;WKST=MO;BYDAY=MO',
      'FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=20', 'FREQ=MONTHLY;BYDAY=+1TU', 'FREQ=MONTHLY;BYDAY=-1FR', 'FREQ=MONTHLY;BYMONTHDAY=-1', 'FREQ=MONTHLY;BYMONTHDAY=1,15',
      'FREQ=YEARLY;BYMONTH=1,12',
    ]) {
      const e = await thrownBy(() => rec.assertStorableRule(ok));
      assert(e === null, `${ok} refused: ${e}`);
    }
    for (const bad of [
      'FREQ=WEEKLY;INTERVAL=-1', 'FREQ=DAILY;INTERVAL=0', 'FREQ=DAILY;INTERVAL=1.5', 'FREQ=DAILY;INTERVAL=', 'FREQ=DAILY;COUNT=0', 'FREQ=DAILY;COUNT=-3',
      'FREQ=HOURLY', 'FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO', 'FREQ=DAILY;BYHOUR=8', 'FREQ=DAILY;TZID=Asia/Jerusalem', 'X-HEBREW=1', 'FREQ=WEEKLY;BYDAY=Tuesday',
      '', 'COUNT=3', 'DTSTART:20260101T000000Z\nRRULE:FREQ=DAILY',
      // BY values parseString takes but no reader can expand (a hole that throws) or no date has.
      'FREQ=WEEKLY;BYDAY=tu', 'FREQ=WEEKLY;BYDAY=TU,XX', 'FREQ=MONTHLY;BYMONTHDAY=0', 'FREQ=MONTHLY;BYMONTHDAY=99', 'FREQ=MONTHLY;BYMONTHDAY=1.5',
      'FREQ=YEARLY;BYMONTH=13', 'FREQ=YEARLY;BYMONTH=0', 'FREQ=MONTHLY;BYDAY=+60TU',
    ]) {
      const e = await thrownBy(() => rec.assertStorableRule(bad));
      assert(e instanceof store.NativeRuleError, `${JSON.stringify(bad)}: ${e}`);
    }
  });

  await check('3b rules: classifyRule names the five on the item\'s own start (its weekday in its zone), anything else is custom, and an end is its last occurrence', async () => {
    const tue = at('2026-10-20 10:00');
    const cases: [string | null, string][] = [
      [null, 'none'], ['FREQ=DAILY', 'daily'], ['FREQ=DAILY;INTERVAL=1', 'daily'], ['FREQ=WEEKLY', 'weekly'], ['FREQ=WEEKLY;BYDAY=TU', 'weekly'],
      ['RRULE:FREQ=WEEKLY;WKST=MO', 'weekly'], ['FREQ=WEEKLY;BYDAY=WE', 'custom'], ['FREQ=WEEKLY;BYDAY=TU,TH', 'custom'], ['FREQ=WEEKLY;INTERVAL=2', 'custom'],
      ['FREQ=DAILY;BYDAY=TU', 'custom'], ['FREQ=MONTHLY', 'monthly'], ['FREQ=MONTHLY;BYMONTHDAY=20', 'monthly'], ['FREQ=MONTHLY;BYMONTHDAY=21', 'custom'],
      ['FREQ=MONTHLY;BYDAY=TU', 'custom'], ['FREQ=YEARLY', 'yearly'], ['FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=20', 'yearly'], ['FREQ=YEARLY;BYMONTH=11', 'custom'],
      ['FREQ=HOURLY', 'custom'], ['FREQ=WEEKLY;BYDAY=+1TU', 'custom'], ['not a rule', 'custom'],
    ];
    for (const [rule, want] of cases) assertSame(rec.classifyRule(rule, tue, IL).choice, want, String(rule));
    assertSame(rec.classifyRule('FREQ=WEEKLY;BYDAY=TU', at('2026-10-20 00:30'), IL).choice, 'weekly', '00:30 on a Tuesday in Israel is Monday in UTC');
    assertSame(rec.classifyRule('FREQ=DAILY;UNTIL=20261031', tue, IL), { choice: 'daily', until: at('2026-10-31 10:00') }, 'a date-only UNTIL');
    assertSame(rec.classifyRule('FREQ=WEEKLY;COUNT=3', tue, IL), { choice: 'weekly', until: at('2026-11-03 10:00') }, 'a COUNT, across the autumn change');
    assertSame(rec.classifyRule('FREQ=DAILY;UNTIL=20261024T095959', tue, IL), { choice: 'daily', until: at('2026-10-23 10:00') }, 'a cut\'s UNTIL');
    assertSame(rec.classifyRule('FREQ=WEEKLY;BYDAY=TU,TH;COUNT=3', tue, IL), { choice: 'custom', until: at('2026-10-27 10:00') }, 'a custom rule\'s end');
    assertSame(rec.classifyRule('FREQ=WEEKLY', tue, IL), { choice: 'weekly' }, 'no end');
  });

  await check('3b rules: slotsBefore counts the rule\'s slots (the skipped ones too); endCarriedRule keeps an UNTIL, turns a COUNT into its last day, and Never has none', async () => {
    const series = { rrule: 'FREQ=WEEKLY;COUNT=10', startsAt: at('2026-10-20 10:00'), timeZone: IL, exdates: [at('2026-11-03 10:00')] };
    assertSame([rec.slotsBefore(series, at('2026-11-24 10:00')), rec.slotsBefore(series, at('2026-10-20 10:00'))], [5, 0], 'slots before the 6th and the 1st');
    const s = { startsAt: at('2026-10-20 10:00'), timeZone: IL };
    assertSame([
      rec.endCarriedRule(null, 'FREQ=WEEKLY;UNTIL=20261231', s),
      rec.endCarriedRule('FREQ=DAILY', 'FREQ=WEEKLY', s),
      rec.endCarriedRule('FREQ=DAILY', 'FREQ=WEEKLY;UNTIL=20261231', s),
      rec.endCarriedRule('FREQ=DAILY', 'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261024T095959', s),
      rec.endCarriedRule('FREQ=DAILY', 'FREQ=WEEKLY;COUNT=3', s),
    ], [null, 'FREQ=DAILY', 'FREQ=DAILY;UNTIL=20261231', 'FREQ=DAILY;UNTIL=20261024T095959', 'FREQ=DAILY;UNTIL=20261103'], 'the ends');
  });

  await check('3b validation: repeat, calendarId and forPartner are checked and named; forPartner on an event is refused', async () => {
    seed();
    const created = await post(eventBody());
    const key = created.body.key;
    for (const [name, changes, field] of [
      ['an unknown repeat', { repeat: 'hourly' }, 'repeat'],
      ['a repeat not a string', { repeat: 1 }, 'repeat'],
      ['custom is not a choice', { repeat: 'custom' }, 'repeat'],
      ['a calendar that is not a native id', { calendarId: 'primary' }, 'calendarId'],
      ['a calendar id not a string', { calendarId: 5 }, 'calendarId'],
      ['forPartner not a boolean', { forPartner: 'yes' }, 'forPartner'],
      ['forPartner on an event', { forPartner: true }, 'forPartner'],
    ] as [string, Row, string][]) {
      const r = await patch({ key, scope: 'single', changes });
      assertSame([r.status, r.body], [400, { error: 'invalid', field }], name);
    }
    assertSame([eventRow(idOf(key)).rrule, eventRow(idOf(key)).calendarId], [null, 'cal-tal'], 'nothing written');
  });

  await check('3b repeat: a one-off becomes a series in place and its key gains the start; with a new time it starts there; a reminder keeps its state', async () => {
    seed();
    const created = await post(eventBody());
    const id = idOf(created.body.key);
    const r = await patch({ key: created.body.key, scope: 'single', changes: { repeat: 'weekly' } });
    assertSame(r.body, { status: 'ok', key: `famcal|${id}#${iso(at('2026-10-20 10:00'))}` }, 'key');
    assertSame([eventRow(id).rrule, tables.nativeEvent.length], ['FREQ=WEEKLY', 1], 'the row repeats');
    assert((await itemOf(`famcal|${id}#${iso(at('2026-10-27 10:00'))}`)).status === 200, 'the next week reads');
    const other = await post(eventBody({ title: 'b' }));
    const moved = await patch({ key: other.body.key, scope: 'single', changes: { repeat: 'daily', start: '2026-10-21T09:00', end: '2026-10-21T10:00' } });
    assertSame(moved.body, { status: 'ok', key: `${other.body.key}#${iso(at('2026-10-21 09:00'))}` }, 'a new time too');
    const reminder = await post(reminderBody());
    const rid = idOf(reminder.body.key);
    seedState(rid, eventRow(rid).startsAt, 31, { doneAt: new Date('2026-10-20T15:00:00Z') });
    const daily = await patch({ key: reminder.body.key, scope: 'single', changes: { repeat: 'daily' } });
    assertSame([daily.body.key, eventRow(rid).rrule, statesOf(rid).length, stripped.length], [`${reminder.body.key}#${iso(at('2026-10-20 17:30'))}`, 'FREQ=DAILY', 1, 0], 'the reminder: its done first occurrence stays done');
  });

  await check('3b repeat: a change from a later occurrence applies from there on whatever scope was sent; what the new rule does not yield goes, what it yields comes along', async () => {
    seed();
    const created = await post(eventBody({ repeat: 'daily' }));
    const id = idOf(created.body.key);
    const day = (d: string, id_ = id) => `famcal|${id_}#${iso(at(`${d} 10:00`))}`;
    await patch({ key: day('2026-10-21'), scope: 'single', changes: { title: 'Before the cut' } });
    await patch({ key: day('2026-10-28'), scope: 'single', changes: { title: 'A Wednesday' } });
    await patch({ key: day('2026-11-03'), scope: 'single', changes: { location: 'Home' } });
    await del({ key: day('2026-10-29'), scope: 'single' });
    await del({ key: day('2026-11-10'), scope: 'single' });
    tracked.length = 0;
    const r = await patch({ key: day('2026-10-27'), scope: 'all', changes: { repeat: 'weekly' } });
    const tail = lastEvent();
    assert(r.status === 200 && tail.id !== id, `a new series: ${r.status} ${r.text}`);
    assertSame(r.body, { status: 'ok', key: day('2026-10-27', tail.id) }, 'the key names the new series at the cut');
    assertSame([tail.rrule, iso(tail.startsAt), tail.calendarId, tail.title, tail.creatorUserId], ['FREQ=WEEKLY', iso(at('2026-10-27 10:00')), 'cal-tal', 'Dentist', TAL], 'the new series');
    assertSame(eventRow(id).rrule, 'FREQ=DAILY;UNTIL=20261027T095959', 'the earlier ones keep their rule up to the cut');
    assertSame(overrides(tail.id).map((o) => [iso(o.originalStartsAt), o.location]), [[iso(at('2026-11-03 10:00')), 'Home']], 'the Wednesday\'s override went, the Tuesday\'s came');
    assertSame(overrides(id).map((o) => [iso(o.originalStartsAt), o.title]), [[iso(at('2026-10-21 10:00')), 'Before the cut']], 'the earlier override stays');
    assertSame(tail.exdates.map(iso), [iso(at('2026-11-10 10:00'))], 'the skipped Tuesday stays skipped, the skipped Thursday is gone');
    assertSame([(await itemOf(day('2026-10-28', tail.id))).status, (await itemOf(day('2026-11-03', tail.id))).status], [404, 200], 'weekly now');
    assertSame(tracked.map((t) => [t.meta.scope, t.meta.changed_fields]), [['following', ['repeat']]], 'analytics: following, the repeat');
  });

  await check('3b repeat: from the first occurrence the whole series changes (same id, same key); "first" counts what is visible', async () => {
    seed();
    const created = await post(eventBody({ repeat: 'daily' }));
    const id = idOf(created.body.key);
    const day = (d: string) => `famcal|${id}#${iso(at(`${d} 10:00`))}`;
    await patch({ key: day('2026-10-21'), scope: 'single', changes: { title: 'A Wednesday' } });
    await patch({ key: day('2026-10-27'), scope: 'single', changes: { location: 'Home' } });
    const r = await patch({ key: day('2026-10-20'), scope: 'following', changes: { repeat: 'weekly' } });
    assertSame([r.body, tables.nativeEvent.length, eventRow(id).rrule], [{ status: 'ok', key: day('2026-10-20') }, 1, 'FREQ=WEEKLY'], 'one series, weekly');
    assertSame(overrides(id).map((o) => iso(o.originalStartsAt)), [iso(at('2026-10-27 10:00'))], 'only the Tuesday\'s override stays');
    seed();
    const again = await post(eventBody({ repeat: 'daily' }));
    const id2 = idOf(again.body.key);
    const d2 = (d: string) => `famcal|${id2}#${iso(at(`${d} 10:00`))}`;
    await del({ key: d2('2026-10-20'), scope: 'single' });
    const fromSecond = await patch({ key: d2('2026-10-21'), scope: 'following', changes: { repeat: 'weekly' } });
    assertSame([fromSecond.body, tables.nativeEvent.length], [{ status: 'ok', key: d2('2026-10-21') }, 1], 'the first visible one is the first');
    assertSame([eventRow(id2).rrule, iso(eventRow(id2).startsAt), eventRow(id2).exdates.length], ['FREQ=WEEKLY', iso(at('2026-10-21 10:00')), 0], 'the series starts there');
  });

  await check('3b repeat: an end is kept (an UNTIL as it is, a COUNT as its last day); the head of a cut keeps a COUNT out', async () => {
    seed();
    const until = seedSeries('until-daily', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Course', startsAt: at('2026-10-20 10:00'), rrule: 'FREQ=DAILY;UNTIL=20261031' });
    const r = await patch({ key: `famcal|${until.id}#${iso(at('2026-10-22 10:00'))}`, scope: 'following', changes: { repeat: 'weekly' } });
    assert(r.status === 200, `${r.status} ${r.text}`);
    assertSame(lastEvent().rrule, 'FREQ=WEEKLY;UNTIL=20261031', 'the UNTIL carried');
    const count = seedSeries('count-daily', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Course', startsAt: at('2026-10-20 10:00'), rrule: 'FREQ=DAILY;COUNT=10' });
    const c = await patch({ key: `famcal|${count.id}#${iso(at('2026-10-22 10:00'))}`, scope: 'following', changes: { repeat: 'weekly' } });
    assert(c.status === 200, `${c.status} ${c.text}`);
    assertSame([lastEvent().rrule, count.rrule], ['FREQ=WEEKLY;UNTIL=20261029', 'FREQ=DAILY;UNTIL=20261022T095959'], 'the COUNT is its last day; the head has only an UNTIL');
    const info = await itemOf(`famcal|${count.id}#${iso(at('2026-10-21 10:00'))}`);
    assertSame(info.body.series.rule, { choice: 'daily', until: '2026-10-21' }, 'the head reads as daily until its last day');
    // A repeat change and a day move in one save: the carried end stays on its day (§2.1), it doesn't move with the cut.
    const weekly = seedSeries('until-weekly', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Course', startsAt: at('2026-10-20 10:00'), rrule: 'FREQ=WEEKLY;UNTIL=20261124' });
    assertSame((await itemOf(`famcal|${weekly.id}#${iso(at('2026-10-20 10:00'))}`)).body.series.rule, { choice: 'weekly', until: '2026-11-24' }, 'until 24 Nov');
    const moved = await patch({ key: `famcal|${weekly.id}#${iso(at('2026-10-20 10:00'))}`, scope: 'following', changes: { repeat: 'daily', start: '2026-10-22T10:00', end: '2026-10-22T11:00' } });
    assert(moved.status === 200, `${moved.status} ${moved.text}`);
    assertSame([eventRow(weekly.id).rrule, iso(eventRow(weekly.id).startsAt)], ['FREQ=DAILY;UNTIL=20261124', iso(at('2026-10-22 10:00'))], 'from the first: daily from the 22nd, still until the 24th');
    assertSame((await itemOf(`famcal|${weekly.id}#${iso(at('2026-10-22 10:00'))}`)).body.series.rule, { choice: 'daily', until: '2026-11-24' }, 'reads until 24 Nov');
    const six = seedSeries('count-weekly-6', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Course', startsAt: at('2026-10-20 10:00'), rrule: 'FREQ=WEEKLY;COUNT=6' });
    const sixMoved = await patch({ key: `famcal|${six.id}#${iso(at('2026-10-27 10:00'))}`, scope: 'following', changes: { repeat: 'daily', start: '2026-10-29T10:00', end: '2026-10-29T11:00' } });
    assert(sixMoved.status === 200, `${sixMoved.status} ${sixMoved.text}`);
    assertSame([lastEvent().rrule, iso(lastEvent().startsAt)], ['FREQ=DAILY;UNTIL=20261124', iso(at('2026-10-29 10:00'))], 'a COUNT\'s last day, from a later one, not moved');
    const rem = seedSeries('until-weekly-reminder', { calendarId: 'cal-tal', creatorUserId: TAL, kind: 'REMINDER', title: 'Pills', startsAt: at('2026-10-20 17:30'), rrule: 'FREQ=WEEKLY;UNTIL=20261124' });
    const remMoved = await patch({ key: `famcal|${rem.id}#${iso(at('2026-10-27 17:30'))}`, scope: 'following', changes: { repeat: 'daily', start: '2026-10-29T17:30' } });
    assert(remMoved.status === 200, `${remMoved.status} ${remMoved.text}`);
    assertSame([lastEvent().rrule, iso(lastEvent().startsAt)], ['FREQ=DAILY;UNTIL=20261124', iso(at('2026-10-29 17:30'))], 'a reminder\'s too');
  });

  // ---- Richer repeats (editor upgrades spec §3): the RepeatSpec on both bodies ----

  await check('richer repeats, create: a spec writes the one builder\'s rule (interval, days with the start\'s added, n-th and last weekday, ends); a string is its spec; a bad spec is 400 repeat and writes nothing', async () => {
    seed();
    const rule = async (repeat: unknown, over: Row = {}) => {
      const r = await post(eventBody({ repeat, ...over }));
      assert(r.status === 200, `${show(repeat)}: ${r.status} ${r.text}`);
      return eventRow(idOf(r.body.key)).rrule;
    };
    assertSame(await rule({ freq: 'weekly', interval: 2, byDay: ['TH'], count: 4 }), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=4', 'Tuesday start, Thursday chip');
    assertSame(await rule({ freq: 'weekly', interval: 1, byDay: ['TU'] }), 'FREQ=WEEKLY', 'a single start day writes no BYDAY');
    assertSame(await rule({ freq: 'monthly', interval: 1, monthly: 'weekday' }, { start: '2026-10-13T10:00', end: '2026-10-13T11:00' }), 'FREQ=MONTHLY;BYDAY=2TU', 'the second Tuesday');
    assertSame(await rule({ freq: 'monthly', interval: 1, monthly: 'last', until: '2027-03-30' }, { start: '2026-10-27T10:00', end: '2026-10-27T11:00' }), 'FREQ=MONTHLY;BYDAY=-1TU;UNTIL=20270330', 'the last Tuesday, until');
    assertSame(await rule({ freq: 'daily', interval: 3 }), 'FREQ=DAILY;INTERVAL=3', 'every 3 days');
    assertSame(await rule('weekly'), 'FREQ=WEEKLY', 'the string, as before');
    const heb = await post(eventBody({ repeat: { freq: 'hebrew', interval: 2, count: 3 } }));
    assertSame([eventRow(idOf(heb.body.key)).rrule, eventRow(idOf(heb.body.key)).hebrewRule], ['FREQ=YEARLY;INTERVAL=2;COUNT=3', 'anniversary'], 'every 2 years on the Hebrew date, 3 times');
    const rem = await post(reminderBody({ repeat: { freq: 'weekly', interval: 1, byDay: ['MO', 'TU'], until: '2026-12-31' } }));
    assertSame(eventRow(idOf(rem.body.key)).rrule, 'FREQ=WEEKLY;BYDAY=MO,TU;UNTIL=20261231', 'a reminder takes the same builder');
    const before = tables.nativeEvent.length;
    for (const [name, repeat, over] of [
      ['a last weekday off the last week', { freq: 'monthly', interval: 1, monthly: 'last' }, {}],
      ['an until before the start', { freq: 'daily', interval: 1, until: '2026-10-19' }, {}],
      ['an interval over the limit', { freq: 'daily', interval: 100 }, {}],
      ['a count over the limit', { freq: 'daily', interval: 1, count: 1000 }, {}],
      ['both ends', { freq: 'daily', interval: 1, count: 3, until: '2026-12-01' }, {}],
      ['no days', { freq: 'weekly', interval: 1, byDay: [] }, {}],
      ['days on a monthly one', { freq: 'monthly', interval: 1, byDay: ['MO'] }, {}],
    ] as [string, Row, Row][]) {
      const r = await post(eventBody({ repeat, ...over }));
      assertSame([r.status, r.body], [400, { error: 'invalid', field: 'repeat' }], name);
    }
    assertSame(tables.nativeEvent.length, before, 'nothing written');
  });

  await check('richer repeats, item info: series.spec says the stored rule (FamCal, bot rules too); a rule it can\'t say has none, and its repeat info keeps the real words', async () => {
    seed();
    const created = await post(eventBody({ repeat: { freq: 'monthly', interval: 2, monthly: 'weekday', count: 4 }, start: '2026-10-13T10:00', end: '2026-10-13T11:00' }));
    const info = await itemOf(created.body.key);
    assertSame(info.body.series.spec, { freq: 'monthly', interval: 2, monthly: 'weekday', count: 4 }, 'the spec it was made from');
    assertSame(info.body.series.repeat, { freq: 'monthly', interval: 2, byDay: ['TU'], ends: true, byDayOrdinals: [2], count: 4 }, 'the words\' parts');
    const odd = seedSeries('second-friday', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Club', startsAt: at('2026-10-09 10:00'), rrule: 'FREQ=MONTHLY;BYDAY=2FR;BYMONTH=10,11,12;UNTIL=20261231' });
    const oddInfo = await itemOf(`famcal|${odd.id}#${iso(at('2026-10-09 10:00'))}`);
    assertSame(oddInfo.body.series.spec, undefined, 'custom: no spec');
    assertSame([oddInfo.body.series.rule.choice, oddInfo.body.series.repeat], ['custom', { freq: 'monthly', interval: 1, byDay: ['FR'], ends: true, byDayOrdinals: [2], byMonth: [10, 11, 12], until: '2026-12-31' }], 'but its parts are there');
    const dom = seedSeries('on-the-15th', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Rent', startsAt: at('2026-10-15 10:00'), rrule: 'FREQ=MONTHLY;BYMONTHDAY=15,30' });
    assertSame((await itemOf(`famcal|${dom.id}#${iso(at('2026-10-15 10:00'))}`)).body.series.repeat.byMonthDay, [15, 30], 'BYMONTHDAY');
    const oneOff = await post(eventBody());
    assertSame((await itemOf(oneOff.body.key)).body.series.spec, undefined, 'a one-off has none');
  });

  await check('richer repeats, edit: a spec equal to the stored rule writes nothing (a bot\'s BYDAY=TU too); a changed one splits there, with the sheet\'s days and interval', async () => {
    seed();
    const bot = seedSeries('every-tuesday', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Piano', startsAt: at('2026-10-20 10:00'), rrule: 'FREQ=WEEKLY;BYDAY=TU' });
    const key = `famcal|${bot.id}#${iso(at('2026-10-27 10:00'))}`;
    const rows = tables.nativeEvent.length;
    const same = await patch({ key, scope: 'following', changes: { repeat: { freq: 'weekly', interval: 1, byDay: ['TU'] } } });
    assertSame([same.body, tables.nativeEvent.length, eventRow(bot.id).rrule], [{ status: 'ok', key }, rows, 'FREQ=WEEKLY;BYDAY=TU'], 'unchanged: nothing written');
    const str = await patch({ key, scope: 'following', changes: { repeat: 'weekly' } });
    assert(str.status === 200 && tables.nativeEvent.length === rows + 1, 'a string re-pick still follows the start (today\'s meaning)');
    assertSame(lastEvent().rrule, 'FREQ=WEEKLY', 'the string choice\'s rule');
    seed();
    const plain = await post(eventBody({ repeat: 'weekly' }));
    const pid = idOf(plain.body.key);
    const r = await patch({ key: `famcal|${pid}#${iso(at('2026-10-27 10:00'))}`, scope: 'all', changes: { repeat: { freq: 'weekly', interval: 2, byDay: ['TU', 'FR'] } } });
    assert(r.status === 200, `${r.status} ${r.text}`);
    assertSame([lastEvent().rrule, eventRow(pid).rrule], ['FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,FR', 'FREQ=WEEKLY;UNTIL=20261027T095959'], 'the tail every other week on Tue and Fri; the head cut');
    assertSame((await itemOf(r.body.key)).body.series.spec, { freq: 'weekly', interval: 2, byDay: ['TU', 'FR'] }, 'and it reads back as the spec');
  });

  await check('richer repeats, ends on a split: an unchanged end carries (a COUNT as its last day); a changed count counts from the first occurrence; Never removes the end; an until is the sheet\'s', async () => {
    seed();
    const counted = (id: string, rule: string, extra: Row = {}) => seedSeries(id, { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Course', startsAt: at('2026-10-20 10:00'), rrule: rule, ...extra });
    const cut = (s: Row, d: string) => `famcal|${s.id}#${iso(at(`${d} 10:00`))}`;
    // Unchanged count (6), a changed rule: today's carry, the COUNT as its last day under the old rule.
    const a = counted('weekly-count-6', 'FREQ=WEEKLY;COUNT=6');
    let r = await patch({ key: cut(a, '2026-11-03'), scope: 'following', changes: { repeat: { freq: 'daily', interval: 1, count: 6 } } });
    assert(r.status === 200, `${r.status} ${r.text}`);
    assertSame(lastEvent().rrule, 'FREQ=DAILY;UNTIL=20261124', 'the carried end');
    // A changed count (5 in all) cut after two slots: 3 left.
    const b = counted('weekly-count-6b', 'FREQ=WEEKLY;COUNT=6');
    r = await patch({ key: cut(b, '2026-11-03'), scope: 'following', changes: { repeat: { freq: 'daily', interval: 1, count: 5 } } });
    assert(r.status === 200, `${r.status} ${r.text}`);
    assertSame([lastEvent().rrule, eventRow(b.id).rrule], ['FREQ=DAILY;COUNT=3', 'FREQ=WEEKLY;UNTIL=20261103T095959'], 'five in all, two before the cut');
    // At least 1.
    const c = counted('weekly-count-6c', 'FREQ=WEEKLY;COUNT=6');
    r = await patch({ key: cut(c, '2026-11-17'), scope: 'following', changes: { repeat: { freq: 'daily', interval: 1, count: 2 } } });
    assertSame(lastEvent().rrule, 'FREQ=DAILY;COUNT=1', 'never below 1');
    // From the first occurrence it is the whole count.
    const d = counted('weekly-count-6d', 'FREQ=WEEKLY;COUNT=6');
    r = await patch({ key: cut(d, '2026-10-20'), scope: 'following', changes: { repeat: { freq: 'daily', interval: 1, count: 4 } } });
    assertSame([eventRow(d.id).rrule, tables.nativeEvent.length === 0 ? 0 : tables.nativeEvent.filter((e) => e.id === d.id).length], ['FREQ=DAILY;COUNT=4', 1], 'the whole series, in place');
    // A count added to an endless series, a stored UNTIL replaced, Never on a stored UNTIL.
    const e = counted('weekly-endless', 'FREQ=WEEKLY');
    r = await patch({ key: cut(e, '2026-11-03'), scope: 'following', changes: { repeat: { freq: 'daily', interval: 1, count: 5 } } });
    assertSame(lastEvent().rrule, 'FREQ=DAILY;COUNT=3', 'a count added counts from the first occurrence');
    const f = counted('weekly-until', 'FREQ=WEEKLY;UNTIL=20261231');
    r = await patch({ key: cut(f, '2026-11-03'), scope: 'following', changes: { repeat: { freq: 'daily', interval: 1, until: '2026-12-15' } } });
    assertSame(lastEvent().rrule, 'FREQ=DAILY;UNTIL=20261215', 'a new until replaces the carried one');
    const g = counted('weekly-until-never', 'FREQ=WEEKLY;UNTIL=20261231');
    r = await patch({ key: cut(g, '2026-11-03'), scope: 'following', changes: { repeat: { freq: 'daily', interval: 1 } } });
    assertSame(lastEvent().rrule, 'FREQ=DAILY', 'Never removes the stored end');
    const h = counted('weekly-count-never', 'FREQ=WEEKLY;COUNT=6');
    r = await patch({ key: cut(h, '2026-11-03'), scope: 'following', changes: { repeat: { freq: 'daily', interval: 1 } } });
    assertSame(lastEvent().rrule, 'FREQ=DAILY', 'Never removes a stored COUNT');
    // The same change on a reminder, and an until the new part could not start in.
    const rem = seedSeries('weekly-count-reminder', { calendarId: 'cal-tal', creatorUserId: TAL, kind: 'REMINDER', title: 'Pills', startsAt: at('2026-10-20 17:30'), rrule: 'FREQ=WEEKLY;COUNT=6' });
    r = await patch({ key: `famcal|${rem.id}#${iso(at('2026-11-03 17:30'))}`, scope: 'following', changes: { repeat: { freq: 'daily', interval: 1, count: 5 } } });
    assert(r.status === 200, `${r.status} ${r.text}`);
    assertSame(lastEvent().rrule, 'FREQ=DAILY;COUNT=3', 'a reminder, too');
    const rows = tables.nativeEvent.length;
    const j = counted('weekly-until-before', 'FREQ=WEEKLY');
    r = await patch({ key: cut(j, '2026-11-03'), scope: 'following', changes: { repeat: { freq: 'daily', interval: 1, until: '2026-11-02' } } });
    assertSame([r.status, r.body, tables.nativeEvent.length], [400, { error: 'invalid', field: 'repeat' }, rows + 1], 'an until before the cut\'s day is 400 repeat (the row is the seeded one)');
  });

  await check('richer repeats, Hebrew ends and every N years: a spec on a Hebrew series changes its interval and end; the pair is kept; the year floor is 1900', async () => {
    seed();
    const created = await post(eventBody({ repeat: { freq: 'hebrew', interval: 1 }, start: '1950-03-02T10:00', end: '1950-03-02T11:00' }));
    assert(created.status === 200, `${created.status} ${created.text}`);
    const id = idOf(created.body.key);
    assertSame([eventRow(id).rrule, eventRow(id).hebrewRule], ['FREQ=YEARLY', 'anniversary'], 'created from 1950');
    assertSame((await itemOf(created.body.key)).body.series.spec, { freq: 'hebrew', interval: 1 }, 'its spec');
    const r = await patch({ key: created.body.key, scope: 'all', changes: { repeat: { freq: 'hebrew', interval: 2, count: 5 } } });
    assert(r.status === 200, `${r.status} ${r.text}`);
    assertSame([eventRow(id).rrule, eventRow(id).hebrewRule], ['FREQ=YEARLY;INTERVAL=2;COUNT=5', 'anniversary'], 'every 2 years, 5 times (from the first occurrence: in place)');
    assertSame((await itemOf(r.body.key)).body.series.spec, { freq: 'hebrew', interval: 2, count: 5 }, 'reads back');
    const daily = await post(eventBody({ repeat: { freq: 'daily', interval: 1 }, start: '1950-03-02T10:00', end: '1950-03-02T11:00' }));
    assertSame([daily.status, daily.body], [400, { error: 'invalid', field: 'start' }], 'a daily spec keeps the 2000 floor');
  });

  await check('richer repeats, a fixed-day series: a day move alone is "only this one"; with the shown spec restated it applies from there, the chips gaining the new day and a weekday ordinal following the start', async () => {
    seed();
    const two = seedSeries('tue-thu', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Class', startsAt: at('2026-10-20 10:00'), rrule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
    const key = `famcal|${two.id}#${iso(at('2026-10-22 10:00'))}`;
    const refusedMove = await patch({ key, scope: 'following', changes: { start: '2026-10-21T10:00', end: '2026-10-21T11:00' } });
    assertSame([refusedMove.status, refusedMove.body], [400, { error: 'invalid', field: 'start' }], 'moving a fixed-day series is refused for more than this one');
    const rows = tables.nativeEvent.length;
    const restated = await patch({ key, scope: 'following', changes: { start: '2026-10-21T10:00', end: '2026-10-21T11:00', repeat: { freq: 'weekly', interval: 1, byDay: ['TU', 'TH'] } } });
    assert(restated.status === 200, `${restated.status} ${restated.text}`);
    assertSame([tables.nativeEvent.length, lastEvent().rrule, iso(lastEvent().startsAt)], [rows + 1, 'FREQ=WEEKLY;BYDAY=TU,WE,TH', iso(at('2026-10-21 10:00'))], 'Wednesday joins');
    const nth = seedSeries('second-tuesday', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Club', startsAt: at('2026-10-13 10:00'), rrule: 'FREQ=MONTHLY;BYDAY=2TU' });
    const moved = await patch({ key: `famcal|${nth.id}#${iso(at('2026-11-10 10:00'))}`, scope: 'following', changes: { start: '2026-11-17T10:00', end: '2026-11-17T11:00', repeat: { freq: 'monthly', interval: 1, monthly: 'weekday' } } });
    assert(moved.status === 200, `${moved.status} ${moved.text}`);
    assertSame([lastEvent().rrule, iso(lastEvent().startsAt)], ['FREQ=MONTHLY;BYDAY=3TU', iso(at('2026-11-17 10:00'))], 'the ordinal follows the new start (the third Tuesday)');
  });

  await check('richer repeats, a bad spec on an edit: a last weekday off the last week, an until before the start; 400 repeat and nothing written', async () => {
    seed();
    const created = await post(eventBody({ repeat: 'weekly' }));
    const id = idOf(created.body.key);
    const key = `famcal|${id}#${iso(at('2026-11-03 10:00'))}`;
    for (const [name, repeat] of [
      ['a last weekday off the last week', { freq: 'monthly', interval: 1, monthly: 'last' }],
      ['an until before the start', { freq: 'weekly', interval: 1, byDay: ['TU'], until: '2026-11-02' }],
      ['past the limits', { freq: 'weekly', interval: 0 }],
    ] as [string, Row][]) {
      const r = await patch({ key, scope: 'following', changes: { repeat } });
      assertSame([r.status, r.body], [400, { error: 'invalid', field: 'repeat' }], name);
    }
    assertSame([tables.nativeEvent.length, eventRow(id).rrule], [1, 'FREQ=WEEKLY'], 'nothing written');
  });

  await check('3b repeat: a repeat change that moves the opened occurrence past the carried end keeps it: the end goes to its new day, never an empty series', async () => {
    seed();
    const yields = async (key: string) => (await itemOf(key)).status;
    // The last of a COUNT, moved a day later with a new rule (the end carried is its old day).
    const count = seedSeries('count-daily-5', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Course', startsAt: at('2026-10-19 08:00'), rrule: 'FREQ=DAILY;COUNT=5' });
    const r = await patch({ key: `famcal|${count.id}#${iso(at('2026-10-23 08:00'))}`, scope: 'following', changes: { repeat: 'weekly', start: '2026-10-24T08:00', end: '2026-10-24T09:00' } });
    assert(r.status === 200, `${r.status} ${r.text}`);
    const tail = lastEvent();
    assertSame([tail.rrule, iso(tail.startsAt), r.body.key], ['FREQ=WEEKLY;UNTIL=20261024', iso(at('2026-10-24 08:00')), `famcal|${tail.id}#${iso(at('2026-10-24 08:00'))}`], 'the end is the new day');
    assertSame(await yields(r.body.key), 200, 'the key points at an occurrence');
    // A series an earlier split cut (a date-time UNTIL 1 s before the next slot), its last moved onto the UNTIL's day.
    const cut = seedSeries('cut-daily', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Course', startsAt: at('2026-10-19 08:00'), rrule: 'FREQ=DAILY;UNTIL=20261023T075959' });
    const c = await patch({ key: `famcal|${cut.id}#${iso(at('2026-10-22 08:00'))}`, scope: 'following', changes: { repeat: 'weekly', start: '2026-10-23T08:00', end: '2026-10-23T09:00' } });
    assert(c.status === 200, `${c.status} ${c.text}`);
    assertSame([lastEvent().rrule, await yields(c.body.key)], ['FREQ=WEEKLY;UNTIL=20261023', 200], 'a cut series: the end is the new day');
    // From the first occurrence (in place).
    const only = seedSeries('until-only', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Course', startsAt: at('2026-10-19 08:00'), rrule: 'FREQ=DAILY;UNTIL=20261019' });
    const f = await patch({ key: `famcal|${only.id}#${iso(at('2026-10-19 08:00'))}`, scope: 'following', changes: { repeat: 'weekly', start: '2026-10-21T08:00', end: '2026-10-21T09:00' } });
    assert(f.status === 200, `${f.status} ${f.text}`);
    assertSame([eventRow(only.id).rrule, iso(eventRow(only.id).startsAt), await yields(f.body.key)], ['FREQ=WEEKLY;UNTIL=20261021', iso(at('2026-10-21 08:00')), 200], 'from the first, in place');
    // A reminder.
    const rem = seedSeries('until-weekly-last', { calendarId: 'cal-tal', creatorUserId: TAL, kind: 'REMINDER', title: 'Pills', startsAt: at('2026-10-20 17:30'), rrule: 'FREQ=WEEKLY;UNTIL=20261027' });
    const m = await patch({ key: `famcal|${rem.id}#${iso(at('2026-10-27 17:30'))}`, scope: 'following', changes: { repeat: 'daily', start: '2026-10-29T17:30' } });
    assert(m.status === 200, `${m.status} ${m.text}`);
    assertSame([lastEvent().rrule, await yields(m.body.key)], ['FREQ=DAILY;UNTIL=20261029', 200], 'a reminder\'s too');
    // A rule that never yields the opened occurrence, given straight to the store, is refused and nothing is written.
    const mondays = seedSeries('daily-for-mondays', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Course', startsAt: at('2026-10-19 08:00'), rrule: 'FREQ=DAILY' });
    const before = tables.nativeEvent.length;
    const e = await thrownBy(() => store.updateNativeEvent({ seriesCuid: mondays.id, instanceStartsAt: at('2026-10-20 08:00'), scope: 'following', actingUserId: TAL, rrule: 'FREQ=WEEKLY;BYDAY=MO' }));
    assertSame([e instanceof store.NativeRuleError, eventRow(mondays.id).rrule, tables.nativeEvent.length], [true, 'FREQ=DAILY', before], 'refused, nothing written');
  });

  await check('3b repeat, reminder: from a later occurrence the new rule re-arms the new series; overrides and state at keys it does not yield go, their pings read "changed"', async () => {
    seed();
    const created = await post(reminderBody({ repeat: 'daily' }));
    const id = idOf(created.body.key);
    const day = (d: string, id_ = id) => `famcal|${id_}#${iso(at(`${d} 17:30`))}`;
    await patch({ key: day('2026-10-28'), scope: 'single', changes: { title: 'A Wednesday' } });
    seedState(id, at('2026-10-27 17:30'), 82, { doneAt: at('2026-10-27 17:40') });
    seedState(id, at('2026-10-28 17:30'), 81, { lastPingedAt: at('2026-10-28 17:30') });
    seedState(id, at('2026-11-03 17:30'), 83, { snoozedUntil: at('2026-11-03 18:00') });
    seedState(id, at('2026-10-21 17:30'), 84);
    eventRow(id).armedAt = OLD;
    stripped.length = 0;
    const before = Date.now();
    const r = await patch({ key: day('2026-10-27'), scope: 'single', changes: { repeat: 'weekly' } });
    const tail = lastEvent();
    assertSame([r.status, r.body.key, tail.rrule, tail.kind, tail.forUserId], [200, day('2026-10-27', tail.id), 'FREQ=WEEKLY', 'REMINDER', null], 'the new series');
    assert(tail.armedAt.getTime() >= before, 'armed from now');
    assertSame(overrides(tail.id).length + overrides(id).length, 0, 'the Wednesday\'s override went');
    assertSame([statesOf(tail.id).map((s) => s.pingMessageId).sort(), statesOf(id).map((s) => s.pingMessageId)], [[82, 83], [84]], 'the Tuesdays\' state came along, the earlier one stayed');
    assertSame(strips(), { moved: [], changed: [81], reassigned: [], names: [] }, 'the Wednesday\'s ping reads "changed"');
  });

  await check('3b repeat, reminder: a new rule and a new time together: the occurrences the rule keeps read "moved", the ones it drops "changed"', async () => {
    seed();
    const created = await post(reminderBody({ repeat: 'daily' }));
    const id = idOf(created.body.key);
    seedState(id, at('2026-10-28 17:30'), 85);
    seedState(id, at('2026-11-03 17:30'), 86);
    stripped.length = 0;
    const r = await patch({ key: `famcal|${id}#${iso(at('2026-10-27 17:30'))}`, scope: 'following', changes: { repeat: 'weekly', start: '2026-10-27T18:00' } });
    assertSame([r.status, lastEvent().rrule, iso(lastEvent().startsAt)], [200, 'FREQ=WEEKLY', iso(at('2026-10-27 18:00'))], 'weekly at 18:00');
    assertSame(strips(), { moved: [86], changed: [85], reassigned: [], names: [] }, 'the Tuesday moved, the Wednesday is gone');
  });

  await check('3b repeat, reminder, from the first occurrence: the series changes in place, re-armed; what the rule drops goes, its pings read "changed"', async () => {
    seed();
    const created = await post(reminderBody({ repeat: 'daily' }));
    const id = idOf(created.body.key);
    const day = (d: string) => `famcal|${id}#${iso(at(`${d} 17:30`))}`;
    await patch({ key: day('2026-10-21'), scope: 'single', changes: { title: 'A Wednesday' } });
    seedState(id, at('2026-10-20 17:30'), 87, { doneAt: at('2026-10-20 17:35') });
    seedState(id, at('2026-10-21 17:30'), 88);
    eventRow(id).armedAt = OLD;
    stripped.length = 0;
    const before = Date.now();
    const r = await patch({ key: day('2026-10-20'), scope: 'following', changes: { repeat: 'weekly' } });
    assertSame([r.body, tables.nativeEvent.length, eventRow(id).rrule, overrides(id).length], [{ status: 'ok', key: day('2026-10-20') }, 1, 'FREQ=WEEKLY', 0], 'in place, the Wednesday\'s override gone');
    assert(eventRow(id).armedAt.getTime() >= before, 'armed from now');
    assertSame([statesOf(id).map((s) => s.pingMessageId), strips()], [[87], { moved: [], changed: [88], reassigned: [], names: [] }], 'the done first one stays; the Wednesday\'s ping reads "changed"');
  });

  await check('3b stop repeating with a calendar or recipient change in the same save: the one-off takes them', async () => {
    seed();
    const { occ } = await weeklySeries();
    const r = await patch({ key: occ('2026-11-03'), scope: 'following', changes: { repeat: 'none', calendarId: 'native:cal-tal-family' } });
    assertSame([r.status, lastEvent().rrule, lastEvent().calendarId], [200, null, 'cal-tal-family'], 'an event, on the new calendar');
    const reminder = await post(reminderBody({ repeat: 'daily' }));
    const rid = idOf(reminder.body.key);
    seedState(rid, at('2026-10-22 17:30'), 89, { lastPingedAt: at('2026-10-22 17:30') });
    stripped.length = 0;
    const p2 = await patch({ key: `famcal|${rid}#${iso(at('2026-10-22 17:30'))}`, scope: 'following', changes: { repeat: 'none', forPartner: true } });
    const one = lastEvent();
    assertSame([p2.status, one.rrule, one.forUserId, eventRow(rid).forUserId, statesOf(one.id).length], [200, null, NOA, null, 0], 'a reminder, for Noa; the earlier ones stay Tal\'s');
    assertSame(strips(), { moved: [], changed: [], reassigned: [89], names: ['Noa'] }, 'its open ping says "now for Noa"');
  });

  await check('3b stop repeating from a later occurrence: the earlier ones keep repeating up to it, the opened one is a one-off with its own values, the later ones go', async () => {
    seed();
    const { id, occ } = await weeklySeries({ calendarId: 'native:cal-tal-family' });
    await patch({ key: occ('2026-11-03'), scope: 'single', changes: { title: 'Dentist – room 4', start: '2026-11-03T10:30', end: '2026-11-03T11:30' } });
    await patch({ key: occ('2026-11-10'), scope: 'single', changes: { title: 'Later' } });
    const r = await patch({ key: occ('2026-11-03'), scope: 'all', changes: { repeat: 'none' } }, { tg: TG.noa });
    const one = lastEvent();
    assertSame([r.status, r.body], [200, { status: 'ok', key: `famcal|${one.id}` }], 'the key names the one-off');
    assertSame([one.rrule, iso(one.startsAt), iso(one.endsAt), one.title, one.calendarId, one.creatorUserId, one.kind],
      [null, iso(at('2026-11-03 10:30')), iso(at('2026-11-03 11:30')), 'Dentist – room 4', 'cal-tal-family', TAL, 'EVENT'], 'the one-off: where it was shown, the series\' creator');
    assertSame([eventRow(id).rrule, overrides(id).length], ['FREQ=WEEKLY;UNTIL=20261103T095959', 0], 'the series stops before it, the rows from it are gone');
    assertSame((await itemOf(`famcal|${one.id}`)).body.occurrence?.title, 'Dentist – room 4', 'the one-off reads');
  });

  await check('3b stop repeating, reminder: the opened occurrence\'s state moves to the one-off only when its time is unchanged; the later ones\' pings read "changed", a moved one\'s "moved"', async () => {
    seed();
    const created = await post(reminderBody({ repeat: 'daily' }));
    const id = idOf(created.body.key);
    const day = (d: string) => `famcal|${id}#${iso(at(`${d} 17:30`))}`;
    seedState(id, at('2026-10-21 17:30'), 93);
    seedState(id, at('2026-10-22 17:30'), 91, { doneAt: at('2026-10-22 17:40') });
    seedState(id, at('2026-10-23 17:30'), 92);
    stripped.length = 0;
    const r = await patch({ key: day('2026-10-22'), scope: 'following', changes: { repeat: 'none' } });
    const one = lastEvent();
    assertSame([r.status, one.rrule, one.kind, iso(one.startsAt)], [200, null, 'REMINDER', iso(at('2026-10-22 17:30'))], 'a one-off reminder');
    assertSame(statesOf(one.id).map((s) => [iso(s.originalStartsAt), s.doneAt !== null, s.pingMessageId]), [[iso(at('2026-10-22 17:30')), true, 91]], 'its done state came along');
    assertSame(statesOf(id).map((s) => s.pingMessageId), [93], 'the earlier one stays');
    assertSame(strips(), { moved: [], changed: [92], reassigned: [], names: [] }, 'the later one\'s ping reads "changed"');
    seed();
    const again = await post(reminderBody({ repeat: 'daily' }));
    const id2 = idOf(again.body.key);
    seedState(id2, at('2026-10-22 17:30'), 91, { doneAt: at('2026-10-22 17:40') });
    seedState(id2, at('2026-10-23 17:30'), 92);
    stripped.length = 0;
    const before = Date.now();
    const t = await patch({ key: `famcal|${id2}#${iso(at('2026-10-22 17:30'))}`, scope: 'following', changes: { repeat: 'none', start: '2026-10-22T18:00' } });
    const one2 = lastEvent();
    assertSame([t.status, iso(one2.startsAt), statesOf(one2.id).length], [200, iso(at('2026-10-22 18:00')), 0], 'a new time: the state does not come');
    assert(one2.armedAt.getTime() >= before, 'armed from now');
    assertSame(strips(), { moved: [91], changed: [92], reassigned: [], names: [] }, 'its ping reads "moved"');
  });

  await check('3b stop repeating, reminder: a moved one-off is armed from now (moved into the past beyond the grace, it stays silent); an unmoved one keeps the series\' armedAt', async () => {
    seed();
    const created = await post(reminderBody({ repeat: 'daily' }));
    const id = idOf(created.body.key);
    eventRow(id).armedAt = OLD;
    // A wall time 30 minutes ago. On the night the clocks go back, 01:00-02:00 happens twice
    // and its later reading is still ahead, so step back an hour until the time is past.
    const wall = (ms: number) => formatInTimeZone(new Date(ms), IL, "yyyy-MM-dd'T'HH:mm");
    let pastMs = Date.now() - 30 * 60_000;
    while (at(wall(pastMs).replace('T', ' ')).getTime() >= Date.now()) pastMs -= 60 * 60_000;
    const past = wall(pastMs);
    const before = Date.now();
    const m = await patch({ key: `famcal|${id}#${iso(at('2026-10-22 17:30'))}`, scope: 'following', changes: { repeat: 'none', start: past } });
    const one = lastEvent();
    assertSame([m.status, one.rrule, iso(one.startsAt)], [200, null, iso(at(past.replace('T', ' ')))], 'a one-off 30 minutes ago');
    assert(one.armedAt.getTime() >= before && one.armedAt.getTime() > one.startsAt.getTime(), `armed from now, after its time: ${iso(one.armedAt)}`);
    seed();
    const again = await post(reminderBody({ repeat: 'daily' }));
    const id2 = idOf(again.body.key);
    eventRow(id2).armedAt = OLD;
    const u = await patch({ key: `famcal|${id2}#${iso(at('2026-10-22 17:30'))}`, scope: 'following', changes: { repeat: 'none' } });
    assertSame([u.status, lastEvent().rrule, iso(lastEvent().armedAt)], [200, null, iso(OLD)], 'unmoved: the series\' armedAt stays');
  });

  await check('3b stop repeating from the first occurrence: the series row is the one-off (no rule, no skips, no rows); its state is re-keyed after the others go, with no collision', async () => {
    seed();
    const created = await post(reminderBody({ repeat: 'daily', start: '2026-10-20T08:00' }));
    const id = idOf(created.body.key);
    const day = (d: string) => `famcal|${id}#${iso(at(`${d} 08:00`))}`;
    await patch({ key: day('2026-10-20'), scope: 'single', changes: { start: '2026-10-21T08:00' } });
    seedState(id, at('2026-10-20 08:00'), 71, { doneAt: at('2026-10-21 08:05') });
    seedState(id, at('2026-10-21 08:00'), 72, { lastPingedAt: at('2026-10-21 08:00') });
    await del({ key: day('2026-10-25'), scope: 'single' });
    stripped.length = 0;
    const r = await patch({ key: day('2026-10-20'), scope: 'following', changes: { repeat: 'none' } });
    assertSame([r.status, r.body], [200, { status: 'ok', key: `famcal|${id}` }], 'the same row, a one-off\'s key');
    const row = eventRow(id);
    assertSame([tables.nativeEvent.length, row.rrule, row.exdates.length, overrides(id).length, iso(row.startsAt)], [1, null, 0, 0, iso(at('2026-10-21 08:00'))], 'no rule, no skips, no rows, where it was shown');
    assertSame(statesOf(id).map((s) => [iso(s.originalStartsAt), s.doneAt !== null, s.pingMessageId]), [[iso(at('2026-10-21 08:00')), true, 71]], 'its done state, at its start');
    assertSame(strips(), { moved: [], changed: [72], reassigned: [], names: [] }, 'the other\'s ping reads "changed"');
    seed();
    const { id: eid, occ } = await weeklySeries();
    await patch({ key: occ('2026-10-20'), scope: 'single', changes: { title: 'Only this' } });
    await patch({ key: occ('2026-10-27'), scope: 'single', changes: { title: 'x' } });
    const ev = await patch({ key: occ('2026-10-20'), scope: 'following', changes: { repeat: 'none' } });
    assertSame([ev.body, eventRow(eid).rrule, eventRow(eid).title, overrides(eid).length], [{ status: 'ok', key: `famcal|${eid}` }, null, 'Only this', 0], 'an event: its own title, no rows');
  });

  await check('3b first occurrence as "all": a plain "this and after" edit there changes the series in place (the bot\'s too), with no empty series left', async () => {
    seed();
    const { id, occ } = await weeklySeries();
    await patch({ key: occ('2026-10-27'), scope: 'single', changes: { title: 'Own title' } });
    await patch({ key: occ('2026-11-03'), scope: 'single', changes: { location: 'Home' } });
    const title = await patch({ key: occ('2026-10-20'), scope: 'following', changes: { title: 'Dentist visit' } });
    assertSame([title.body, tables.nativeEvent.length, eventRow(id).title, eventRow(id).rrule], [{ status: 'ok', key: occ('2026-10-20') }, 1, 'Dentist visit', 'FREQ=WEEKLY'], 'in place, no UNTIL');
    assertSame(overrides(id).map((o) => [iso(o.originalStartsAt), o.title, o.location]), [[iso(at('2026-10-27 10:00')), null, null], [iso(at('2026-11-03 10:00')), null, 'Home']], 'the title it sets is cleared from the overrides, as "this and after" clears it');
    const time = await patch({ key: occ('2026-10-20'), scope: 'following', changes: { start: '2026-10-20T11:00', end: '2026-10-20T12:00' } });
    assertSame([time.body, tables.nativeEvent.length, iso(eventRow(id).startsAt)], [{ status: 'ok', key: occ('2026-10-20', '11:00') }, 1, iso(at('2026-10-20 11:00'))], 'a new time: the series moves');
    assertSame(overrides(id).filter((o) => o.location).map((o) => iso(o.originalStartsAt)), [iso(at('2026-11-03 11:00'))], 'the override follows');
    const { nativeProvider } = await load('src/services/calendar-provider/native-provider.ts');
    const bot = await nativeProvider.updateEvent(tables.user.find((u) => u.id === TAL), 'native:cal-tal', `${id}#${iso(at('2026-10-20 11:00'))}`, { scope: 'following', title: 'From the bot' });
    assertSame([bot.success, bot.eventId, tables.nativeEvent.length, eventRow(id).title], [true, id, 1, 'From the bot'], 'the bot\'s edit');
    const r = await post(reminderBody({ repeat: 'daily' }));
    const rid = idOf(r.body.key);
    seedState(rid, at('2026-10-20 17:30'), 66);
    stripped.length = 0;
    const moved = await patch({ key: r.body.key, scope: 'following', changes: { start: '2026-10-20T18:00' } });
    assertSame([moved.body.key, tables.nativeEvent.length, statesOf(rid).length, strips().moved], [`famcal|${rid}#${iso(at('2026-10-20 18:00'))}`, 2, 0, [66]], 'a reminder moves in place and re-arms');
  });

  await check('3b delete "this and after" from the first occurrence deletes the series; from a later one it cuts', async () => {
    seed();
    const { row, occ } = await weeklySeries();
    const first = await del({ key: occ('2026-10-20'), scope: 'following' });
    assertSame([first.status, row.isDeleted, row.rrule], [200, true, 'FREQ=WEEKLY'], 'deleted, no husk');
    seed();
    const second = await weeklySeries();
    await del({ key: second.occ('2026-10-20'), scope: 'single' });
    await del({ key: second.occ('2026-10-27'), scope: 'following' });
    assert(second.row.isDeleted === true, 'the first visible one counts');
    // An overridden first occurrence deleted on its own is a CANCELLED row, not an exdate: it counts as gone too.
    const cancelledFirst = async () => {
      seed();
      const s = await weeklySeries();
      await patch({ key: s.occ('2026-10-20'), scope: 'single', changes: { title: 'Only this' } });
      await del({ key: s.occ('2026-10-20'), scope: 'single' });
      assertSame([overrides(s.id).map((o) => [iso(o.originalStartsAt), o.status]), s.row.exdates.length], [[[iso(at('2026-10-20 10:00')), 'CANCELLED']], 0], 'a CANCELLED row, no exdate');
      assertSame((await itemOf(s.occ('2026-10-27'))).body.series.first, true, 'the second reads as the first');
      return s;
    };
    const cancelled = await cancelledFirst();
    await del({ key: cancelled.occ('2026-10-27'), scope: 'following' });
    assert(cancelled.row.isDeleted === true, 'a CANCELLED first one counts: the whole series goes');
    const edited = await cancelledFirst();
    const inPlace = await patch({ key: edited.occ('2026-10-27'), scope: 'following', changes: { title: 'Dentist visit' } });
    assertSame([inPlace.body, tables.nativeEvent.length, edited.row.title, edited.row.rrule], [{ status: 'ok', key: edited.occ('2026-10-27') }, 1, 'Dentist visit', 'FREQ=WEEKLY'], 'an edit from there changes the series in place');
    seed();
    const third = await weeklySeries();
    await del({ key: third.occ('2026-11-03'), scope: 'following' });
    assertSame([third.row.isDeleted, third.row.rrule], [false, 'FREQ=WEEKLY;UNTIL=20261103T095959'], 'a later one cuts');
  });

  await check('3b COUNT on "this and after": the new series has what is left, counted in slots (a skipped one counts); the head gets only an UNTIL; events and reminders', async () => {
    seed();
    const s = seedSeries('count-weekly', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Course', startsAt: at('2026-10-20 10:00'), rrule: 'FREQ=WEEKLY;COUNT=10', exdates: [at('2026-11-03 10:00')] });
    const r = await patch({ key: `famcal|${s.id}#${iso(at('2026-11-24 10:00'))}`, scope: 'following', changes: { title: 'Course, part 2' } });
    assert(r.status === 200, `${r.status} ${r.text}`);
    assertSame([s.rrule, lastEvent().rrule], ['FREQ=WEEKLY;UNTIL=20261124T095959', 'FREQ=WEEKLY;COUNT=5'], 'head and tail');
    const n = rec.expandSeries(lastEvent(), { from: at('2026-11-01 00:00'), to: at('2027-06-01 00:00') }, []).length;
    assertSame(n, 5, 'five left');
    const rem = seedSeries('count-reminder', { calendarId: 'cal-tal', creatorUserId: TAL, kind: 'REMINDER', title: 'Pills', startsAt: at('2026-10-20 17:30'), rrule: 'FREQ=DAILY;COUNT=10' });
    const m = await patch({ key: `famcal|${rem.id}#${iso(at('2026-10-23 17:30'))}`, scope: 'following', changes: { start: '2026-10-23T18:00' } });
    assert(m.status === 200, `${m.status} ${m.text}`);
    assertSame([rem.rrule, lastEvent().rrule], ['FREQ=DAILY;UNTIL=20261023T172959', 'FREQ=DAILY;COUNT=7'], 'a reminder too');
  });

  await check('3b fixed days read the rule that will be stored: a day move that also picks one of the five is not refused, and the new part starts on the date entered', async () => {
    seed();
    const series = seedSeries('bot-weekly', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Piano', startsAt: at('2026-10-20 16:00'), rrule: 'FREQ=WEEKLY;BYDAY=TU' });
    const k = `famcal|${series.id}#${iso(at('2026-10-27 16:00'))}`;
    assert((await patch({ key: k, scope: 'single', changes: { start: '2026-10-28T16:00', end: '2026-10-28T17:00' } })).status === 200, 'moved to Wednesday alone');
    const asked = { seriesCuid: series.id, instanceStartsAt: at('2026-10-27 16:00'), scope: 'following', actingUserId: TAL, occurrenceTimes: true, startsAt: at('2026-10-29 16:00'), endsAt: at('2026-10-29 17:00') };
    assertSame([await store.refusesFixedDays(asked), await store.refusesFixedDays({ ...asked, rrule: 'FREQ=WEEKLY' })], [true, false], 'the bot\'s early answer, without and with the new rule');
    const r = await patch({ key: k, scope: 'following', changes: { repeat: 'weekly', start: '2026-10-29T16:00', end: '2026-10-29T17:00' } });
    const tail = lastEvent();
    assertSame([r.status, r.body.key, tail.rrule, iso(tail.startsAt)], [200, `famcal|${tail.id}#${iso(at('2026-10-29 16:00'))}`, 'FREQ=WEEKLY', iso(at('2026-10-29 16:00'))], 'every Thursday from the 29th');
  });

  await check('3b repeat: the choice it already has is no change, an end and a WKST aside; nothing is written', async () => {
    seed();
    const { occ } = await weeklySeries();
    const until = seedSeries('until-daily', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Course', startsAt: at('2026-10-20 10:00'), rrule: 'FREQ=DAILY;INTERVAL=1;WKST=MO;UNTIL=20261031' });
    prismaCalls.length = 0;
    const a = await patch({ key: occ('2026-10-27'), scope: 'following', changes: { repeat: 'weekly' } });
    const b = await patch({ key: `famcal|${until.id}#${iso(at('2026-10-22 10:00'))}`, scope: 'following', changes: { repeat: 'daily' } });
    assertSame([a.body.key, b.body.key, tables.nativeEvent.length], [occ('2026-10-27'), `famcal|${until.id}#${iso(at('2026-10-22 10:00'))}`, 2], 'the same keys, no new series');
    assert(!prismaCalls.some((c) => /\.(update|upsert|create|deleteMany)$/.test(c)), `it wrote: ${prismaCalls}`);
  });

  await check('3b the store drops a series-level field equal to what the series has, so it asks no scope for it', async () => {
    seed();
    const { id } = await weeklySeries();
    const same = await store.updateNativeEvent({ seriesCuid: id, instanceStartsAt: at('2026-10-27 10:00'), scope: 'single', actingUserId: TAL, title: 'Only this', calendarId: 'cal-tal', rrule: 'FREQ=WEEKLY' });
    assertSame([same.key.seriesId, iso(same.key.slot), overrides(id).map((o) => o.title)], [id, iso(at('2026-10-27 10:00')), ['Only this']], 'a single edit, no scope refusal');
    const reminder = await post(reminderBody({ repeat: 'daily' }));
    const e = await thrownBy(() => store.updateNativeEvent({ seriesCuid: idOf(reminder.body.key), instanceStartsAt: at('2026-10-21 17:30'), scope: 'single', actingUserId: TAL, forUserId: null, title: 'x' }));
    assert(e === null, `the same recipient: ${e}`);
  });

  await check('3b calendar: "all" moves the series, "this and after" puts the rest on the new calendar, a one-off moves itself; "only this one" is refused on a series; the same calendar is no change', async () => {
    seed();
    seedRecurrenceCache();
    const { id, occ } = await weeklySeries();
    const all = await patch({ key: occ('2026-10-27'), scope: 'all', changes: { calendarId: 'native:cal-tal-family' } });
    assertSame([all.body, eventRow(id).calendarId, tables.nativeEvent.length], [{ status: 'ok', key: occ('2026-10-27') }, 'cal-tal-family', 1], 'all');
    assertSame(cacheUsers(), [11], 'the partner\'s cache goes: the calendar it went to is shared');
    const following = await patch({ key: occ('2026-11-03'), scope: 'following', changes: { calendarId: 'native:cal-noa-edit' } });
    const tail = lastEvent();
    assertSame([following.body, tail.calendarId, eventRow(id).calendarId], [{ status: 'ok', key: `famcal|${tail.id}#${iso(at('2026-11-03 10:00'))}` }, 'cal-noa-edit', 'cal-tal-family'], 'this and after');
    const before = show(tables.nativeEvent);
    const single = await patch({ key: occ('2026-10-27'), scope: 'single', changes: { calendarId: 'native:cal-tal', title: 'x' } });
    assertSame([single.status, single.body, show(tables.nativeEvent) === before, overrides(id).length], [400, { error: 'invalid', field: 'scope' }, true, 0], 'only this one: refused, nothing written');
    const one = await post(eventBody());
    const moved = await patch({ key: one.body.key, scope: 'single', changes: { calendarId: 'native:cal-tal-family' } });
    assertSame([moved.body, eventRow(idOf(one.body.key)).calendarId], [{ status: 'ok', key: one.body.key }, 'cal-tal-family'], 'a one-off');
    prismaCalls.length = 0;
    const same = await patch({ key: one.body.key, scope: 'single', changes: { calendarId: 'native:cal-tal-family' } });
    assert(same.status === 200 && !prismaCalls.some((c) => /\.(update|upsert|create|deleteMany)$/.test(c)), `the same calendar wrote: ${prismaCalls}`);
  });

  await check('3b calendar: the destination must be writable and alive (400 calendarId, never 404); the partner\'s event can\'t go to the user\'s private calendar; a reminder has no calendar move', async () => {
    seed();
    const own = await post(eventBody());
    for (const target of ['native:cal-noa-view', 'native:cal-noa-private', 'native:cal-solo', 'native:nowhere']) {
      const r = await patch({ key: own.body.key, scope: 'single', changes: { calendarId: target } });
      assertSame([r.status, r.body], [400, { error: 'invalid', field: 'calendarId' }], target);
    }
    tables.nativeCalendar.find((c) => c.id === 'cal-tal-family')!.isDeleted = true;
    const gone = await patch({ key: own.body.key, scope: 'single', changes: { calendarId: 'native:cal-tal-family' } });
    assertSame([gone.status, gone.body, eventRow(idOf(own.body.key)).calendarId], [400, { error: 'invalid', field: 'calendarId' }, 'cal-tal'], 'a deleted calendar');
    seed();
    seedRecurrenceCache();
    const noas = seedSeries('noa-shared', { calendarId: 'cal-noa-edit', creatorUserId: NOA, title: 'Ours', startsAt: at('2026-10-21 10:00') });
    const toPrivate = await patch({ key: `famcal|${noas.id}`, scope: 'single', changes: { calendarId: 'native:cal-tal' } });
    assertSame([toPrivate.body, noas.calendarId], [{ error: 'invalid', field: 'calendarId' }, 'cal-noa-edit'], 'the partner\'s event to the user\'s private calendar');
    const toShared = await patch({ key: `famcal|${noas.id}`, scope: 'single', changes: { calendarId: 'native:cal-tal-family' } });
    assertSame([toShared.status, noas.calendarId, cacheUsers()], [200, 'cal-tal-family', [11]], 'to the user\'s shared calendar: both caches go');
    const reminder = await post(reminderBody());
    const r = await patch({ key: reminder.body.key, scope: 'single', changes: { calendarId: 'native:cal-tal-family' } });
    assertSame([r.status, r.body], [400, { error: 'invalid', field: 'calendarId' }], 'a reminder');
    const e = await thrownBy(() => store.updateNativeEvent({ seriesCuid: idOf(reminder.body.key), scope: 'all', actingUserId: TAL, calendarId: 'cal-tal-family' }));
    assert(e instanceof store.NativeScopeError && (e as Row).field === 'calendarId', `the store: ${e}`);
  });

  await check('3b recipient: the creator hands a reminder to the partner and takes it back; done stays done, the open ones start afresh and their pings say who it is for now; armedAt stays', async () => {
    seed();
    seedRecurrenceCache();
    const created = await post(reminderBody({ repeat: 'daily' }));
    const id = idOf(created.body.key);
    const day = (d: string, id_ = id) => `famcal|${id_}#${iso(at(`${d} 17:30`))}`;
    seedState(id, at('2026-10-21 17:30'), 51, { doneAt: at('2026-10-21 17:35') });
    seedState(id, at('2026-10-22 17:30'), 52, { lastPingedAt: at('2026-10-22 17:30') });
    eventRow(id).armedAt = OLD;
    stripped.length = 0;
    tracked.length = 0;
    const r = await patch({ key: day('2026-10-22'), scope: 'all', changes: { forPartner: true } });
    assertSame([r.body, eventRow(id).forUserId, iso(eventRow(id).armedAt)], [{ status: 'ok', key: day('2026-10-22') }, NOA, iso(OLD)], 'for Noa, armedAt kept');
    assertSame(statesOf(id).map((s) => s.pingMessageId), [51], 'the done one stays, the open one starts afresh');
    assertSame(strips(), { moved: [], changed: [], reassigned: [52], names: ['Noa'] }, 'its ping says "now for Noa"');
    assertSame(cacheUsers(), [11], 'Noa\'s cache goes too');
    assertSame(tracked.map((t) => t.meta.changed_fields), [['recipient']], 'analytics');
    const back = await patch({ key: day('2026-10-22'), scope: 'all', changes: { forPartner: false } });
    assertSame([back.status, eventRow(id).forUserId], [200, null], 'taken back');
    const following = await patch({ key: day('2026-10-25'), scope: 'following', changes: { forPartner: true } });
    const tail = lastEvent();
    assertSame([following.body, tail.forUserId, eventRow(id).forUserId, tail.creatorUserId], [{ status: 'ok', key: day('2026-10-25', tail.id) }, NOA, null, TAL], 'this and after: the new series is for Noa');
    const single = await patch({ key: day('2026-10-23'), scope: 'single', changes: { forPartner: true } });
    assertSame([single.status, single.body], [400, { error: 'invalid', field: 'scope' }], 'only this one is refused');
  });

  await check('3b recipient: only the creator, only a partner who can be pinged; the take-back works when the partner no longer can; a new time in the same save says "now for"', async () => {
    seed();
    const onShared = seedSeries('tal-shared-reminder', { calendarId: 'cal-tal-family', creatorUserId: TAL, kind: 'REMINDER', title: 'Bins', startsAt: at('2026-10-21 20:00') });
    const noa = await patch({ key: `famcal|${onShared.id}`, scope: 'single', changes: { forPartner: true } }, { tg: TG.noa });
    assertSame([noa.status, noa.body.error, onShared.forUserId], [403, 'not_allowed', null], 'Noa can edit it but not hand it on');
    tables.user.find((u) => u.id === NOA)!.telegramId = null;
    const noTelegram = await patch({ key: `famcal|${onShared.id}`, scope: 'single', changes: { forPartner: true } });
    assertSame(noTelegram.body, { error: 'invalid', field: 'forPartner' }, 'no Telegram');
    onShared.forUserId = NOA;
    const takeBack = await patch({ key: `famcal|${onShared.id}`, scope: 'single', changes: { forPartner: false } });
    assertSame([takeBack.status, onShared.forUserId], [200, null], 'taken back from a partner who can\'t be pinged');
    tables.user.find((u) => u.id === NOA)!.telegramId = BigInt(TG.noa);
    tables.user.find((u) => u.id === NOA)!.calendarSource = 'GOOGLE';
    const google = await patch({ key: `famcal|${onShared.id}`, scope: 'single', changes: { forPartner: true } });
    assertSame([google.status, onShared.forUserId], [200, NOA], 'a partner with Google connected (Google as a connection)');
    onShared.forUserId = null;
    const solo = await post(reminderBody(), { tg: TG.solo });
    const alone = await patch({ key: solo.body.key, scope: 'single', changes: { forPartner: true } }, { tg: TG.solo });
    assertSame(alone.body, { error: 'invalid', field: 'forPartner' }, 'no partner');
    const e = await thrownBy(() => store.updateNativeEvent({ seriesCuid: onShared.id, scope: 'single', actingUserId: TAL, forUserId: 11 }));
    assert(e instanceof store.NativeRecipientError, `a stranger as the recipient: ${e}`);
    seed();
    const one = await post(reminderBody());
    const oid = idOf(one.body.key);
    seedState(oid, eventRow(oid).startsAt, 61, { lastPingedAt: eventRow(oid).startsAt });
    stripped.length = 0;
    const both = await patch({ key: one.body.key, scope: 'single', changes: { forPartner: true, start: '2026-10-20T18:00' } });
    assertSame([both.status, eventRow(oid).forUserId, statesOf(oid).length], [200, NOA, 0], 'for Noa at 18:00');
    assertSame(strips(), { moved: [], changed: [], reassigned: [61], names: ['Noa'] }, 'the ping says "now for Noa", not "moved"');
  });

  await check('3b item info: the rule (one of the five or custom, with its end), whether this is the first, where it can move, the recipient row, the source', async () => {
    seed();
    const { occ } = await weeklySeries();
    const first = await itemOf(occ('2026-10-20'));
    assertSame([first.body.series.rule, first.body.series.first, first.body.canMoveCalendar, first.body.moveTargets, first.body.canChangeRecipient, first.body.forPartner, first.body.source],
      [{ choice: 'weekly' }, true, true, ['native:cal-tal', 'native:cal-tal-family', 'native:cal-noa-edit'], false, false, 'famcal'], 'the first of a weekly event');
    assertSame((await itemOf(occ('2026-10-27'))).body.series.first, false, 'a later one');
    await del({ key: occ('2026-10-20'), scope: 'single' });
    assertSame((await itemOf(occ('2026-10-27'))).body.series.first, true, 'the first visible one');
    const bot = seedSeries('bot-series', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Piano', startsAt: at('2026-10-20 16:00'), rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20261231' });
    assertSame((await itemOf(`famcal|${bot.id}#${iso(at('2026-10-20 16:00'))}`)).body.series.rule, { choice: 'custom', until: '2026-12-31' }, 'a bot rule');
    const noas = seedSeries('noa-shared', { calendarId: 'cal-noa-edit', creatorUserId: NOA, title: 'Ours', startsAt: at('2026-10-21 10:00') });
    assertSame((await itemOf(`famcal|${noas.id}`)).body.moveTargets, ['native:cal-tal-family', 'native:cal-noa-edit'], 'the partner\'s event: not to the user\'s private calendar');
    const viewed = seedSeries('noa-viewed', { calendarId: 'cal-noa-view', creatorUserId: NOA, title: 'Viewed', startsAt: at('2026-10-21 12:00') });
    assertSame([(await itemOf(`famcal|${viewed.id}`)).body.canMoveCalendar, (await itemOf(`famcal|${viewed.id}`)).body.moveTargets], [false, []], 'a viewer calendar\'s event');
    const mine = await post(reminderBody());
    const m = await itemOf(mine.body.key);
    assertSame([m.body.canMoveCalendar, m.body.moveTargets, m.body.canChangeRecipient, m.body.forPartner], [false, [], true, false], 'the creator\'s reminder');
    const forNoa = await post(reminderBody({ forPartner: true }));
    assertSame([(await itemOf(forNoa.body.key)).body.canChangeRecipient, (await itemOf(forNoa.body.key)).body.forPartner], [true, true], 'one for Noa');
    tables.user.find((u) => u.id === NOA)!.telegramId = null;
    assertSame([(await itemOf(mine.body.key)).body.canChangeRecipient, (await itemOf(forNoa.body.key)).body.canChangeRecipient], [false, true], 'Noa can\'t be pinged: only the take-back');
    const masked = seedSeries('noa-for-tal', { calendarId: 'cal-noa-private', creatorUserId: NOA, forUserId: TAL, kind: 'REMINDER', title: 'Call', startsAt: at('2026-10-21 09:00') });
    assertSame([(await itemOf(`famcal|${masked.id}`)).body.canChangeRecipient, (await itemOf(`famcal|${masked.id}`)).body.forPartner], [false, true], 'the one Noa set for Tal: for her partner, as she set it; only she changes it');
  });

  await check('3b rule validity: the store refuses a bad rule on create and update (NativeRuleError); the bot gets UNKNOWN_ERROR with the ids logged; the home answers 400 repeat', async () => {
    seed();
    const base = { calendarCuid: 'cal-tal', creatorUserId: TAL, title: 'x', startsAt: at('2026-10-20 10:00'), endsAt: at('2026-10-20 11:00'), timeZone: IL };
    const e1 = await thrownBy(() => store.createNativeEvent({ ...base, rrule: 'FREQ=WEEKLY;INTERVAL=-1' }));
    assert(e1 instanceof store.NativeRuleError && tables.nativeEvent.length === 0, `create: ${e1}`);
    // The bot's voice create joins the LLM's days unchecked: a lowercase day must not be stored.
    const eDay = await thrownBy(() => store.createNativeEvent({ ...base, rrule: 'RRULE:FREQ=WEEKLY;BYDAY=tu' }));
    assert(eDay instanceof store.NativeRuleError && tables.nativeEvent.length === 0, `create, BYDAY=tu: ${eDay}`);
    const one = await post(eventBody());
    const e2 = await thrownBy(() => store.updateNativeEvent({ seriesCuid: idOf(one.body.key), scope: 'single', actingUserId: TAL, rrule: 'FREQ=DAILY;COUNT=0' }));
    assert(e2 instanceof store.NativeRuleError && eventRow(idOf(one.body.key)).rrule === null, `update: ${e2}`);
    const { nativeProvider } = await load('src/services/calendar-provider/native-provider.ts');
    captured.length = 0;
    const bot = await nativeProvider.createEvent(tables.user.find((u) => u.id === TAL), 'native:cal-tal', { title: SECRET_TITLE, startTime: at('2026-10-20 10:00'), endTime: at('2026-10-20 11:00'), recurrence: ['RRULE:FREQ=DAILY;INTERVAL=-1'] });
    assertSame([bot.success, bot.error], [false, 'UNKNOWN_ERROR'], 'the bot');
    assert(captured.some((c) => c.extra?.user_id === TAL && c.extra?.calendar_id === 'native:cal-tal') && !show(captured).includes(SECRET_TITLE), `logged with the ids: ${show(captured)}`);
    const { refusalOf } = await load('src/services/calendar-write/write.ts');
    assertSame([refusalOf(new store.NativeRuleError('x')), refusalOf(new store.NativeScopeError('calendarId')), refusalOf(new store.NativeRecipientError()), refusalOf(new store.NativeDestinationError())],
      [{ status: 'invalid', field: 'repeat' }, { status: 'invalid', field: 'calendarId' }, { status: 'invalid', field: 'forPartner' }, { status: 'invalid', field: 'calendarId' }], 'the home\'s answers');
  });

  await check('3b Asia/Jerusalem across the autumn change: a weekly series made daily from November keeps 10:00 on the wall; a COUNT carried across it ends on its day', async () => {
    seed();
    const { id, occ } = await weeklySeries();
    const r = await patch({ key: occ('2026-11-03'), scope: 'following', changes: { repeat: 'daily' } });
    const tail = lastEvent();
    assertSame([r.status, iso(tail.startsAt), eventRow(id).rrule], [200, '2026-11-03T08:00:00.000Z', 'FREQ=WEEKLY;UNTIL=20261103T095959'], 'the new series at 10:00 IST');
    const next = rec.expandSeries(tail, { from: at('2026-11-04 00:00'), to: at('2026-11-05 00:00') }, []);
    assertSame(next.map((i: Row) => iso(i.startsAt)), ['2026-11-04T08:00:00.000Z'], '10:00 the next day');
    const counted = seedSeries('count-dst', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Course', startsAt: at('2026-10-20 10:00'), rrule: 'FREQ=WEEKLY;COUNT=3' });
    await patch({ key: `famcal|${counted.id}#${iso(at('2026-10-27 10:00'))}`, scope: 'following', changes: { repeat: 'daily' } });
    const daily = rec.expandSeries(lastEvent(), { from: at('2026-10-27 00:00'), to: at('2026-12-01 00:00') }, []);
    assertSame([lastEvent().rrule, iso(daily[daily.length - 1].startsAt)], ['FREQ=DAILY;UNTIL=20261103', '2026-11-03T08:00:00.000Z'], 'it still ends on Nov 3');
  });

  // ================= failures and logs =================

  // ================= Hebrew-date repeats: the pair across edits (hebrew-repeats spec §2, §6) =================

  /**
   * A Hebrew birthday as the store writes one: FREQ=YEARLY, the pair, anchored on 30 Cheshvan
   * 5783 (24 Nov 2022) at 10:00. Its days: 2022-11-24, 2023-11-14, 2024-12-01, 2025-11-21 (1
   * Kislev: 5786 has no 30 Cheshvan), 2026-11-10, 2027-11-30, 2028-11-19.
   */
  const hebrewSeries = (id = 'heb', extra: Row = {}) => {
    const row = seedSeries(id, {
      calendarId: 'cal-tal', creatorUserId: TAL, title: 'Grandpa\'s birthday', startsAt: at('2022-11-24 10:00'),
      rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary', hebrewAnchor: '2022-11-24', ...extra,
    });
    const occ = (day: string, time = '10:00', sid = row.id) => `famcal|${sid}#${iso(at(`${day} ${time}`))}`;
    return { id: row.id as string, occ, row };
  };
  const pairOf = (r: Row) => [r.rrule, r.hebrewRule, r.hebrewAnchor];
  const daysOf = async (id: string, from: string, to: string) => {
    const { expandSeries } = await load('src/services/native-calendar/recurrence.ts');
    return expandSeries(eventRow(id), { from: at(`${from} 00:00`), to: at(`${to} 00:00`) }, overrides(id)).map((i: Row) => formatInTimeZone(i.startsAt, IL, 'yyyy-MM-dd'));
  };

  await check('hebrew: "this and after" from a rolled day keeps the pair and the anchor; the tail still falls on 30 Cheshvan in long years', async () => {
    seed();
    const { id, occ } = hebrewSeries();
    const r = await patch({ key: occ('2025-11-21'), scope: 'following', changes: { title: 'Saba' } });
    const tail = lastEvent();
    assertSame([r.status, r.body.key], [200, occ('2025-11-21', '10:00', tail.id)], 'the key is the tail\'s first');
    assertSame(pairOf(tail), ['FREQ=YEARLY', 'anniversary', '2022-11-24'], 'the tail: the anchor copied, not re-derived from 1 Kislev');
    assertSame(pairOf(eventRow(id)), ['FREQ=YEARLY;UNTIL=20251121T095959', 'anniversary', '2022-11-24'], 'the head is cut and keeps its pair');
    assertSame(await daysOf(tail.id, '2020-01-01', '2029-01-01'), ['2025-11-21', '2026-11-10', '2027-11-30', '2028-11-19'], 'the tail\'s days');
    assertSame(await daysOf(id, '2020-01-01', '2029-01-01'), ['2022-11-24', '2023-11-14', '2024-12-01'], 'the head\'s days');
    assertSame((await itemOf(r.body.key)).status, 200, 'the tail\'s key reads');
    const timed = await patch({ key: occ('2026-11-10', '10:00', tail.id), scope: 'following', changes: { start: '2026-11-10T12:00', end: '2026-11-10T13:00' } });
    assertSame([timed.status, pairOf(lastEvent())], [200, ['FREQ=YEARLY', 'anniversary', '2022-11-24']], 'a new time on the same day keeps the anchor');
  });

  await check('hebrew: "this and after" to another day replaces the anchor with the tail\'s new start; COUNT is cut in Hebrew slots', async () => {
    seed();
    const { occ } = hebrewSeries();
    const r = await patch({ key: occ('2026-11-10'), scope: 'following', changes: { start: '2026-11-12T10:00', end: '2026-11-12T11:00' } });
    const tail = lastEvent();
    assertSame([r.status, iso(tail.startsAt), pairOf(tail)], [200, iso(at('2026-11-12 10:00')), ['FREQ=YEARLY', 'anniversary', '2026-11-12']], 'anchored on its new day');
    seed();
    const counted = hebrewSeries('heb-count', { rrule: 'FREQ=YEARLY;COUNT=5' });
    await patch({ key: counted.occ('2025-11-21'), scope: 'following', changes: { title: 'Saba' } });
    assertSame([pairOf(lastEvent()), eventRow(counted.id).rrule], [['FREQ=YEARLY;COUNT=2', 'anniversary', '2022-11-24'], 'FREQ=YEARLY;UNTIL=20251121T095959'], 'three slots before the cut, two left');
    assertSame(await daysOf(lastEvent().id, '2020-01-01', '2035-01-01'), ['2025-11-21', '2026-11-10'], 'the tail has what is left');
  });

  await check('hebrew: "this and after" from the first occurrence changes the series in place: a rename and a new time keep the anchor, a day move replaces it', async () => {
    seed();
    const { id, occ } = hebrewSeries();
    const renamed = await patch({ key: occ('2022-11-24'), scope: 'following', changes: { title: 'Saba', start: '2022-11-24T11:00', end: '2022-11-24T12:00' } });
    assertSame([renamed.status, tables.nativeEvent.length, pairOf(eventRow(id))], [200, 1, ['FREQ=YEARLY', 'anniversary', '2022-11-24']], 'in place, the anchor kept');
    const moved = await patch({ key: occ('2022-11-24', '11:00'), scope: 'following', changes: { start: '2022-11-25T11:00', end: '2022-11-25T12:00' } });
    assertSame([moved.status, tables.nativeEvent.length, pairOf(eventRow(id))], [200, 1, ['FREQ=YEARLY', 'anniversary', '2022-11-25']], 'a day move re-anchors on 1 Kislev 5783');
    assertSame((await daysOf(id, '2022-01-01', '2025-01-01')), ['2022-11-25', '2023-11-14', '2024-12-02'], 'now it follows 1 Kislev');
  });

  await check('hebrew: "all" keeps the pair; a day move shifts the anchor by the same days; a title change leaves it alone', async () => {
    seed();
    const { id, occ } = hebrewSeries();
    await patch({ key: occ('2024-12-01'), scope: 'all', changes: { title: 'Saba' } });
    assertSame(pairOf(eventRow(id)), ['FREQ=YEARLY', 'anniversary', '2022-11-24'], 'a rename');
    const r = await patch({ key: occ('2024-12-01'), scope: 'all', changes: { start: '2024-12-02T10:00', end: '2024-12-02T11:00' } });
    assertSame([r.status, iso(eventRow(id).startsAt), pairOf(eventRow(id))], [200, iso(at('2022-11-25 10:00')), ['FREQ=YEARLY', 'anniversary', '2022-11-25']], 'a day later, the anchor too');
    seed();
    const rem = hebrewSeries('heb-rem', { kind: 'REMINDER', title: 'Light a candle' });
    const remMoved = await patch({ key: rem.occ('2024-12-01'), scope: 'all', changes: { start: '2024-12-02T10:00' } });
    assertSame([remMoved.status, iso(eventRow(rem.id).startsAt), pairOf(eventRow(rem.id))], [200, iso(at('2022-11-25 10:00')), ['FREQ=YEARLY', 'anniversary', '2022-11-25']], 'a reminder: a day later, the anchor too');
    assertSame(await daysOf(rem.id, '2022-01-01', '2025-01-01'), ['2022-11-25', '2023-11-14', '2024-12-02'], 'the reminder keeps its first occurrence');
    seed();
    const bare = hebrewSeries('heb-bare');
    await store.updateNativeEvent({ seriesCuid: bare.id, scope: 'following', actingUserId: TAL, startsAt: at('2022-11-26 10:00'), endsAt: at('2022-11-26 11:00') });
    assertSame([iso(eventRow(bare.id).startsAt), pairOf(eventRow(bare.id))], [iso(at('2022-11-26 10:00')), ['FREQ=YEARLY', 'anniversary', '2022-11-26']], '"this and after" with no occurrence: the anchor moves with the start');
    seed();
    const bareRem = hebrewSeries('heb-bare-rem', { kind: 'REMINDER' });
    await store.updateNativeEvent({ seriesCuid: bareRem.id, scope: 'following', actingUserId: TAL, startsAt: at('2022-11-26 10:00') });
    assertSame([iso(eventRow(bareRem.id).startsAt), pairOf(eventRow(bareRem.id))], [iso(at('2022-11-26 10:00')), ['FREQ=YEARLY', 'anniversary', '2022-11-26']], 'a reminder "this and after" with no occurrence: the anchor too');
    assertSame((await daysOf(bareRem.id, '2022-01-01', '2023-01-01')), ['2022-11-26'], 'its start is still its first occurrence');
  });

  await check('hebrew: a day move keys what was done to rolled years by Hebrew year ("all", "this and after"); "all" from a rolled occurrence takes every year to its new Hebrew day', async () => {
    // The rolled years of hebrewSeries(): 2023-11-14, 2025-11-21, 2028-11-19 (1 Kislev, no 30
    // Cheshvan there). Moved to 1 Kislev, those stay where they are while the others move a day.
    seed();
    const { id, occ } = hebrewSeries();
    assertSame((await del({ key: occ('2025-11-21'), scope: 'single' })).status, 200, 'a rolled year cancelled');
    assertSame((await patch({ key: occ('2028-11-19'), scope: 'single', changes: { title: 'Renamed' } })).status, 200, 'a rolled year renamed');
    assertSame((await patch({ key: occ('2026-11-10'), scope: 'single', changes: { title: 'Plain' } })).status, 200, 'a long year renamed');
    const r = await patch({ key: occ('2024-12-01'), scope: 'all', changes: { start: '2024-12-02T10:00', end: '2024-12-02T11:00' } });
    assertSame([r.status, r.body.key, eventRow(id).hebrewAnchor], [200, occ('2024-12-02'), '2022-11-25'], '"all" from a long year: a day later');
    assertSame(await daysOf(id, '2022-01-01', '2029-01-01'), ['2022-11-25', '2023-11-14', '2024-12-02', '2026-11-11', '2027-12-01', '2028-11-19'], 'the cancelled rolled year stays cancelled');
    const titles = (sid: string) => overrides(sid).filter((o) => o.status === 'OVERRIDE').map((o) => [iso(o.originalStartsAt), o.title]).sort();
    assertSame(titles(id), [[iso(at('2026-11-11 10:00')), 'Plain'], [iso(at('2028-11-19 10:00')), 'Renamed']], 'each rename on its year\'s new day');
    assertSame((await itemOf(r.body.key)).status, 200, 'the key reads');

    seed();
    // From a rolled year (1 Kislev 5784) to 2 Kislev: every year goes to 2 Kislev, the anchor's year too (a yearly move,
    // editor upgrades spec §1); the day shift left the rolled year where it was and refused it.
    const rolled = hebrewSeries();
    await del({ key: rolled.occ('2025-11-21'), scope: 'single' });
    const fromRolled = await patch({ key: rolled.occ('2023-11-14'), scope: 'all', changes: { start: '2023-11-15T10:00', end: '2023-11-15T11:00' } });
    assertSame([fromRolled.status, fromRolled.body.key, iso(eventRow(rolled.id).startsAt), eventRow(rolled.id).hebrewAnchor], [200, rolled.occ('2023-11-15'), iso(at('2022-11-26 10:00')), '2022-11-26'], '"all" from a rolled year: on 2 Kislev');
    assertSame(await daysOf(rolled.id, '2022-01-01', '2029-01-01'), ['2022-11-26', '2023-11-15', '2024-12-03', '2026-11-12', '2027-12-02', '2028-11-20'], 'every year on 2 Kislev, the cancelled one still cancelled');
    seed();
    const asked = hebrewSeries();
    const ask = (instance: string, start: string) => store.refusesFixedDays({ seriesCuid: asked.id, instanceStartsAt: at(`${instance} 10:00`), scope: 'all', actingUserId: TAL, occurrenceTimes: true, startsAt: at(`${start} 10:00`) });
    assertSame([await ask('2023-11-14', '2023-11-15'), await ask('2024-12-01', '2024-12-02'), await ask('2023-11-14', '2023-11-14')], [false, false, false], 'the bot asks first: a rolled year moves like any other');
    const timed = await patch({ key: asked.occ('2023-11-14'), scope: 'all', changes: { start: '2023-11-14T12:00', end: '2023-11-14T13:00' } });
    assertSame([timed.status, eventRow(asked.id).hebrewAnchor, await daysOf(asked.id, '2023-01-01', '2025-01-01')], [200, '2022-11-24', ['2023-11-14', '2024-12-01']], 'a new time from a rolled year keeps the anchor (30 Cheshvan stays)');

    seed();
    const rem = hebrewSeries('heb-rem', { kind: 'REMINDER', title: 'Light a candle' });
    await del({ key: rem.occ('2025-11-21'), scope: 'single' });
    const remMoved = await patch({ key: rem.occ('2024-12-01'), scope: 'all', changes: { start: '2024-12-02T10:00' } });
    assertSame([remMoved.status, remMoved.body.key, eventRow(rem.id).hebrewAnchor], [200, rem.occ('2024-12-02'), '2022-11-25'], 'a reminder "all": a day later');
    assertSame(await daysOf(rem.id, '2022-01-01', '2027-01-01'), ['2022-11-25', '2023-11-14', '2024-12-02', '2026-11-11'], 'the reminder\'s cancelled rolled year stays cancelled');
    seed();
    const rem2 = hebrewSeries('heb-rem2', { kind: 'REMINDER', title: 'Light a candle' });
    const remRolled = await patch({ key: rem2.occ('2023-11-14'), scope: 'all', changes: { start: '2023-11-15T10:00' } });
    assertSame([remRolled.status, remRolled.body.key, eventRow(rem2.id).hebrewAnchor], [200, rem2.occ('2023-11-15'), '2022-11-26'], 'a reminder "all" from a rolled year: on 2 Kislev');

    seed();
    const tailed = hebrewSeries();
    await del({ key: tailed.occ('2025-11-21'), scope: 'single' });
    await patch({ key: tailed.occ('2028-11-19'), scope: 'single', changes: { title: 'Renamed' } });
    const split = await patch({ key: tailed.occ('2024-12-01'), scope: 'following', changes: { start: '2024-12-02T10:00', end: '2024-12-02T11:00' } });
    const tail = lastEvent();
    assertSame([split.status, tail.hebrewAnchor], [200, '2024-12-02'], '"this and after" to 1 Kislev');
    assertSame(await daysOf(tail.id, '2024-01-01', '2029-01-01'), ['2024-12-02', '2026-11-11', '2027-12-01', '2028-11-19'], 'the tail keeps the cancelled rolled year cancelled');
    assertSame(titles(tail.id), [[iso(at('2028-11-19 10:00')), 'Renamed']], 'and the rename on its rolled year');

    seed();
    const remTailed = hebrewSeries('heb-rem3', { kind: 'REMINDER', title: 'Light a candle' });
    await del({ key: remTailed.occ('2025-11-21'), scope: 'single' });
    const remSplit = await patch({ key: remTailed.occ('2024-12-01'), scope: 'following', changes: { start: '2024-12-02T10:00' } });
    assertSame([remSplit.status, lastEvent().hebrewAnchor], [200, '2024-12-02'], 'a reminder "this and after" to 1 Kislev');
    assertSame(await daysOf(lastEvent().id, '2024-01-01', '2027-01-01'), ['2024-12-02', '2026-11-11'], 'the reminder\'s tail keeps the cancelled rolled year cancelled');
  });

  await check('hebrew: a calendar move "this and after" and a recipient change "this and after" each give the tail the pair', async () => {
    seed();
    const { id, occ } = hebrewSeries();
    const moved = await patch({ key: occ('2025-11-21'), scope: 'following', changes: { calendarId: 'native:cal-tal-family' } });
    const tail = lastEvent();
    assertSame([moved.status, tail.calendarId, pairOf(tail), eventRow(id).hebrewRule], [200, 'cal-tal-family', ['FREQ=YEARLY', 'anniversary', '2022-11-24'], 'anniversary'], 'calendar move');
    seed();
    const rem = hebrewSeries('heb-rem', { kind: 'REMINDER', title: 'Light a candle' });
    const handed = await patch({ key: rem.occ('2025-11-21'), scope: 'following', changes: { forPartner: true } });
    const remTail = lastEvent();
    assertSame([handed.status, remTail.forUserId, remTail.kind, pairOf(remTail)], [200, NOA, 'REMINDER', ['FREQ=YEARLY', 'anniversary', '2022-11-24']], 'recipient');
    assertSame(await daysOf(remTail.id, '2025-01-01', '2029-01-01'), ['2025-11-21', '2026-11-10', '2027-11-30', '2028-11-19'], 'the tail keeps the anchor');
  });

  await check('hebrew: a stop clears rrule, hebrewRule and hebrewAnchor together, from a later occurrence and from the first', async () => {
    seed();
    const { id, occ } = hebrewSeries();
    const later = await patch({ key: occ('2025-11-21'), scope: 'following', changes: { repeat: 'none' } });
    const one = lastEvent();
    assertSame([later.status, pairOf(one), iso(one.startsAt)], [200, [null, null, null], iso(at('2025-11-21 10:00'))], 'the one-off has no pair');
    assertSame(pairOf(eventRow(id)), ['FREQ=YEARLY;UNTIL=20251121T095959', 'anniversary', '2022-11-24'], 'the head keeps repeating');
    const first = await patch({ key: occ('2022-11-24'), scope: 'following', changes: { repeat: 'none' } });
    assertSame([first.status, pairOf(eventRow(id))], [200, [null, null, null]], 'from the first: the row is a one-off');
    seed();
    const rem = hebrewSeries('heb-rem', { kind: 'REMINDER' });
    const stopped = await patch({ key: rem.occ('2022-11-24'), scope: 'following', changes: { repeat: 'none' } });
    assertSame([stopped.status, pairOf(eventRow(rem.id))], [200, [null, null, null]], 'a reminder too');
  });

  await check('hebrew: the item info names the anchor; a Hebrew series\' start opens; fixed days stay off', async () => {
    seed();
    const { occ } = hebrewSeries();
    const info = await itemOf(occ('2025-11-21'));
    assertSame([info.status, info.body.series.rule, info.body.series.repeat, info.body.series.fixedDays],
      [200, { choice: 'hebrew', anchor: '2022-11-24' }, { freq: 'yearly', interval: 1, byDay: [], ends: false, hebrew: { anchor: '2022-11-24' } }, false], 'anniversary');
    const y = hebrewSeries('heb-y', { rrule: 'FREQ=YEARLY;COUNT=3' });
    const firstOcc = await itemOf(y.occ('2022-11-24'));
    assertSame([firstOcc.status, firstOcc.body.series.rule, firstOcc.body.series.first], [200, { choice: 'hebrew', until: '2024-12-01', anchor: '2022-11-24' }, true], 'the first occurrence');
    const custom = hebrewSeries('heb-2', { rrule: 'FREQ=YEARLY;INTERVAL=2' });
    assertSame((await itemOf(custom.occ('2022-11-24'))).body.series.rule, { choice: 'custom', anchor: '2022-11-24' }, 'every 2 years is custom');
    const greg = seedSeries('greg', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Wedding', startsAt: at('2022-11-24 10:00'), rrule: 'FREQ=YEARLY' });
    const g = await itemOf(`famcal|${greg.id}#${iso(at('2023-11-24 10:00'))}`);
    assertSame([g.body.series.rule, g.body.series.repeat], [{ choice: 'yearly' }, { freq: 'yearly', interval: 1, byDay: [], ends: false }], 'a Gregorian yearly series is unchanged');
  });

  await check('hebrew: the store creates the pair with the anchor read in the zone, refuses a bad pair, and the key create gives opens', async () => {
    seed();
    const created = await store.createNativeEvent({
      calendarCuid: 'cal-tal', creatorUserId: TAL, title: 'Yahrzeit', startsAt: new Date('2026-02-01T23:30:00Z'), endsAt: new Date('2026-02-02T00:30:00Z'),
      timeZone: IL, rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary',
    });
    assertSame(pairOf(eventRow(created.id)), ['FREQ=YEARLY', 'anniversary', '2026-02-02'], 'anchored on 15 Shvat, the day in Israel');
    const key = `famcal|${created.id}#${created.startsAt.toISOString()}`;
    assertSame([(await itemOf(key)).status, (await itemOf(key)).body.series?.first], [200, true], 'the start is an occurrence');
    assertSame(await store.getNativeSeriesRrule(created.id), 'FREQ=YEARLY', 'week-lookahead reads a yearly rule');
    const rem = await store.createNativeEvent({
      calendarCuid: 'cal-tal', creatorUserId: TAL, title: 'Candle', startsAt: at('2026-02-02 15:00'), endsAt: at('2026-02-02 15:00'), allDay: true,
      timeZone: IL, rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary', kind: 'REMINDER',
    });
    assertSame([iso(eventRow(rem.id).startsAt), eventRow(rem.id).hebrewAnchor], [iso(at('2026-02-02 00:00')), '2026-02-02'], 'a date-only reminder, anchored on its day');
    const before = tables.nativeEvent.length;
    const base = { calendarCuid: 'cal-tal', creatorUserId: TAL, title: 'x', startsAt: at('2026-02-02 10:00'), endsAt: at('2026-02-02 11:00'), timeZone: IL };
    for (const bad of [
      { rrule: 'FREQ=WEEKLY', hebrewRule: 'anniversary' },
      { rrule: 'FREQ=YEARLY;BYMONTH=2', hebrewRule: 'anniversary' },
      { rrule: null, hebrewRule: 'anniversary' },
      { rrule: 'FREQ=YEARLY', hebrewRule: 'yahrzeit' },
      { rrule: 'FREQ=YEARLY', hebrewRule: 'monthly' },
      { rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary', hebrewAnchor: '2026-02-03' },
      { rrule: 'FREQ=YEARLY', hebrewAnchor: '2026-02-02' },
    ]) {
      const e = await thrownBy(() => store.createNativeEvent({ ...base, ...bad }));
      assert(e instanceof rec.NativeRuleError, `${show(bad)}: ${e}`);
    }
    assertSame(tables.nativeEvent.length, before, 'nothing written');
  });

  await check('hebrew: the store takes a rule change with the pair: Hebrew to Gregorian yearly, Gregorian to Hebrew', async () => {
    seed();
    const { id } = hebrewSeries();
    const update = (seriesCuid: string, day: string, o: Row) => store.updateNativeEvent({ seriesCuid, instanceStartsAt: at(`${day} 10:00`), scope: 'following', actingUserId: TAL, ...o });
    await update(id, '2025-11-21', { rrule: 'FREQ=YEARLY', hebrewRule: null });
    assertSame(pairOf(lastEvent()), ['FREQ=YEARLY', null, null], 'to Gregorian yearly');
    assertSame(await daysOf(lastEvent().id, '2025-01-01', '2028-01-01'), ['2025-11-21', '2026-11-21', '2027-11-21'], 'on the Gregorian date from there');
    seed();
    const greg = seedSeries('greg', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Wedding', startsAt: at('2022-11-24 10:00'), rrule: 'FREQ=YEARLY' });
    await update(greg.id, '2024-11-24', { rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary' });
    assertSame(pairOf(lastEvent()), ['FREQ=YEARLY', 'anniversary', '2024-11-24'], 'to Hebrew, anchored on the tail\'s start (23 Cheshvan 5785)');
    assertSame(await daysOf(lastEvent().id, '2024-01-01', '2026-01-01'), ['2024-11-24', '2025-11-14'], 'its Hebrew days');
    seed();
    const one = seedSeries('one', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Bar mitzvah', startsAt: at('2026-02-02 10:00') });
    await store.updateNativeEvent({ seriesCuid: one.id, scope: 'all', actingUserId: TAL, rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary', startsAt: at('2026-02-03 10:00'), endsAt: at('2026-02-03 11:00') });
    assertSame(pairOf(eventRow(one.id)), ['FREQ=YEARLY', 'anniversary', '2026-02-03'], 'a one-off that starts repeating is anchored on its (new) start');
    const rem = seedSeries('one-rem', { calendarId: 'cal-tal', creatorUserId: TAL, kind: 'REMINDER', title: 'Candle', startsAt: at('2026-02-02 18:00') });
    await store.updateNativeEvent({ seriesCuid: rem.id, scope: 'all', actingUserId: TAL, rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary' });
    assertSame(pairOf(eventRow(rem.id)), ['FREQ=YEARLY', 'anniversary', '2026-02-02'], 'a reminder too');
    const plain = seedSeries('plain', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Plain', startsAt: at('2026-02-02 10:00') });
    for (const bad of [{ rrule: 'FREQ=WEEKLY', hebrewRule: 'anniversary' }, { rrule: null, hebrewRule: 'anniversary' }, { rrule: 'FREQ=YEARLY', hebrewRule: 'yahrzeit' }, { hebrewRule: 'monthly' }]) {
      const e = await thrownBy(() => store.updateNativeEvent({ seriesCuid: plain.id, scope: 'all', actingUserId: TAL, ...bad }));
      assert(e instanceof rec.NativeRuleError, `${show(bad)}: ${e}`);
    }
    assertSame(pairOf(eventRow(plain.id)), [null, null, null], 'a bad pair is refused, nothing written');
    seed();
    const same = hebrewSeries('heb-same');
    // A rule change takes 'following': sent for every occurrence, only a real change is refused.
    const all = (o: Row) => thrownBy(() => store.updateNativeEvent({ seriesCuid: same.id, instanceStartsAt: at('2023-11-14 10:00'), scope: 'all', actingUserId: TAL, title: 'Saba', ...o }));
    assertSame(await all({ rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary' }), null, 'the pair it already has is no change');
    assertSame((await all({ rrule: 'FREQ=YEARLY' }) as Row)?.name, 'NativeScopeError', 'a rule alone (Gregorian) is a change');
    assertSame([pairOf(eventRow(same.id)), eventRow(same.id).title, tables.nativeEvent.length], [['FREQ=YEARLY', 'anniversary', '2022-11-24'], 'Saba', 1], 'only the title changed');
  });

  await check('H2 create: "hebrew" stores FREQ=YEARLY with the pair, anchored on the start\'s day in the user\'s zone; the key names the start; events and reminders, timed and all-day', async () => {
    seed();
    const r = await post(eventBody({ repeat: 'hebrew', start: '2023-11-14T10:00', end: '2023-11-14T11:00' }));
    assert(r.status === 200, `${r.status} ${r.text}`);
    const row = eventRow(idOf(r.body.key));
    assertSame(pairOf(row), ['FREQ=YEARLY', 'anniversary', '2023-11-14'], 'the pair');
    assertSame(r.body.key, `famcal|${row.id}#${iso(row.startsAt)}`, 'the key names the start');
    assertSame((await itemOf(r.body.key)).status, 200, 'the key opens the sheet');
    const allDay = await post(eventBody({ repeat: 'hebrew', allDay: true, start: '2026-02-02', end: '2026-02-02' }));
    assertSame(pairOf(eventRow(idOf(allDay.body.key))), ['FREQ=YEARLY', 'anniversary', '2026-02-02'], 'an all-day event, anchored on its day');
    const rem = await post(reminderBody({ repeat: 'hebrew', start: '2026-02-02T17:30' }));
    assertSame([rem.status, pairOf(eventRow(idOf(rem.body.key))), rem.body.key === `famcal|${idOf(rem.body.key)}#${iso(at('2026-02-02 17:30'))}`], [200, ['FREQ=YEARLY', 'anniversary', '2026-02-02'], true], 'a reminder');
    const dateOnly = await post(reminderBody({ repeat: 'hebrew', allDay: true, start: '2026-02-02' }));
    assertSame([dateOnly.status, pairOf(eventRow(idOf(dateOnly.body.key)))], [200, ['FREQ=YEARLY', 'anniversary', '2026-02-02']], 'a date-only reminder');
    const plain = await post(eventBody({ repeat: 'yearly' }));
    assertSame(pairOf(eventRow(idOf(plain.body.key))), ['FREQ=YEARLY', null, null], 'yearly still writes no pair');
  });

  await check('H2: the yahrzeit repeat is gone: a create or an update sending repeat "yahrzeit" answers 400 repeat, nothing written', async () => {
    seed();
    const made = await post(eventBody({ repeat: 'yahrzeit' }));
    assertSame([made.status, made.body], [400, { error: 'invalid', field: 'repeat' }], 'create');
    const rem = await post(reminderBody({ repeat: 'yahrzeit', start: '2026-02-02T17:30' }));
    assertSame([rem.status, rem.body], [400, { error: 'invalid', field: 'repeat' }], 'create a reminder');
    assertSame(tables.nativeEvent.length, 0, 'nothing written by a create');
    const heb = hebrewSeries();
    const edit = await patch({ key: heb.occ('2026-11-10'), scope: 'following', changes: { repeat: 'yahrzeit' } });
    assertSame([edit.status, edit.body, tables.nativeEvent.length, pairOf(eventRow(heb.id))], [400, { error: 'invalid', field: 'repeat' }, 1, ['FREQ=YEARLY', 'anniversary', '2022-11-24']], 'update');
  });

  await check('H2 create: a Google calendar and a Google key are refused with 400 repeat, before anything is read or written; a former Google user with no Google calendars gets it on FamCal', async () => {
    seed();
    const onGoogle = await post(eventBody({ repeat: 'hebrew', calendarId: 'tal@example.com' }));
    assertSame([onGoogle.status, onGoogle.body], [400, { error: 'invalid', field: 'repeat' }], 'a Google calendar id');
    const edit = await patch({ key: 'google|tal@example.com|abc123', scope: 'following', changes: { repeat: 'hebrew' } });
    assertSame([edit.status, edit.body], [400, { error: 'invalid', field: 'repeat' }], 'a Google key');
    assertSame(tables.nativeEvent.length, 0, 'nothing written');
    // Google as a connection: a user whose old source was Google, with no Google calendars
    // chosen, has FamCal now, so an event with no calendar lands on their FamCal main and a
    // Hebrew repeat is kept there.
    const dan = await post(eventBody({ repeat: 'hebrew' }), { tg: TG.dan });
    assertSame([dan.status, String(dan.body.key).startsWith('famcal|')], [200, true], 'a former Google user with no Google calendars gets it on FamCal');
    const yearly = await post(eventBody({ repeat: 'yearly', calendarId: 'tal@example.com' }));
    assert(yearly.body.field !== 'repeat', `a Gregorian yearly on Google is not refused for its repeat: ${yearly.text}`);
  });

  await check('H2 edit: a one-off or a Gregorian series picks a Hebrew choice (anchored on the opened day), a Hebrew series picks yearly; the choice it has is no change', async () => {
    seed();
    const one = await post(eventBody());
    const picked = await patch({ key: one.body.key, scope: 'single', changes: { repeat: 'hebrew' } });
    assertSame([picked.status, pairOf(eventRow(idOf(one.body.key)))], [200, ['FREQ=YEARLY', 'anniversary', '2026-10-20']], 'a one-off starts repeating by its Hebrew date');
    assertSame(picked.body.key, `famcal|${idOf(one.body.key)}#${iso(at('2026-10-20 10:00'))}`, 'its key gains the start');
    seed();
    seedSeries('greg', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Wedding', startsAt: at('2022-11-24 10:00'), rrule: 'FREQ=YEARLY' });
    const toHebrew = await patch({ key: `famcal|greg#${iso(at('2024-11-24 10:00'))}`, scope: 'following', changes: { repeat: 'hebrew' } });
    assertSame([toHebrew.status, pairOf(lastEvent()), pairOf(eventRow('greg'))[1]], [200, ['FREQ=YEARLY', 'anniversary', '2024-11-24'], null], 'a Gregorian series, from the opened occurrence: anchored on its day');
    assertSame(await daysOf(lastEvent().id, '2024-01-01', '2026-01-01'), ['2024-11-24', '2025-11-14'], 'its Hebrew days');
    seed();
    const heb = hebrewSeries();
    const same = await patch({ key: heb.occ('2023-11-14'), scope: 'following', changes: { repeat: 'hebrew' } });
    assertSame([same.status, same.body.key, tables.nativeEvent.length, pairOf(eventRow(heb.id))], [200, heb.occ('2023-11-14'), 1, ['FREQ=YEARLY', 'anniversary', '2022-11-24']], 'the choice it has is no change, nothing written');
    seed();
    const heb2 = hebrewSeries();
    const back = await patch({ key: heb2.occ('2025-11-21'), scope: 'following', changes: { repeat: 'yearly' } });
    assertSame([back.status, pairOf(lastEvent())], [200, ['FREQ=YEARLY', null, null]], 'Hebrew to yearly sends the pair cleared');
    assertSame(await daysOf(lastEvent().id, '2025-01-01', '2028-01-01'), ['2025-11-21', '2026-11-21', '2027-11-21'], 'on the Gregorian date from there');
    seed();
    const heb3 = hebrewSeries();
    const stop = await patch({ key: heb3.occ('2025-11-21'), scope: 'following', changes: { repeat: 'none', start: '2025-11-21T10:00', end: '2025-11-21T11:00' } });
    assertSame([stop.status, pairOf(lastEvent())], [200, [null, null, null]], 'a stop clears all three');
    seed();
    const rem = hebrewSeries('heb-rem', { kind: 'REMINDER', title: 'Light a candle' });
    const remBack = await patch({ key: rem.occ('2026-11-10'), scope: 'following', changes: { repeat: 'yearly' } });
    assertSame([remBack.status, pairOf(lastEvent())], [200, ['FREQ=YEARLY', null, null]], 'a reminder too');
  });

  await check('H2 edit: a COUNT carried between Gregorian yearly and Hebrew yearly is the remaining COUNT, an UNTIL is kept; the other frequencies still turn a COUNT into its last day', async () => {
    seed();
    seedSeries('greg-c', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Wedding', startsAt: at('2022-11-24 10:00'), rrule: 'FREQ=YEARLY;COUNT=5' });
    const toHebrew = await patch({ key: `famcal|greg-c#${iso(at('2024-11-24 10:00'))}`, scope: 'following', changes: { repeat: 'hebrew' } });
    assertSame([toHebrew.status, pairOf(lastEvent())], [200, ['FREQ=YEARLY;COUNT=3', 'anniversary', '2024-11-24']], 'Gregorian to Hebrew: five, two before the cut, three left');
    seed();
    const heb = hebrewSeries('heb-c', { rrule: 'FREQ=YEARLY;COUNT=5' });
    const toGreg = await patch({ key: heb.occ('2025-11-21'), scope: 'following', changes: { repeat: 'yearly' } });
    assertSame([toGreg.status, pairOf(lastEvent())], [200, ['FREQ=YEARLY;COUNT=2', null, null]], 'Hebrew to Gregorian: three Hebrew slots before the cut, two left');
    seed();
    const heb3 = hebrewSeries('heb-c3', { rrule: 'FREQ=YEARLY;COUNT=5' });
    const first = await patch({ key: heb3.occ('2022-11-24'), scope: 'following', changes: { repeat: 'hebrew' } });
    assertSame([first.status, tables.nativeEvent.length, pairOf(eventRow(heb3.id))], [200, 1, ['FREQ=YEARLY;COUNT=5', 'anniversary', '2022-11-24']], 'the choice it has, from the first occurrence: nothing changes');
    seed();
    seedSeries('greg-u', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Wedding', startsAt: at('2022-11-24 10:00'), rrule: 'FREQ=YEARLY;UNTIL=20281231' });
    const until = await patch({ key: `famcal|greg-u#${iso(at('2024-11-24 10:00'))}`, scope: 'following', changes: { repeat: 'hebrew' } });
    assertSame([until.status, pairOf(lastEvent())], [200, ['FREQ=YEARLY;UNTIL=20281231', 'anniversary', '2024-11-24']], 'a date UNTIL is carried unchanged');
    seed();
    seedSeries('daily-c', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Pills', startsAt: at('2026-10-20 10:00'), rrule: 'FREQ=DAILY;COUNT=10' });
    const fromDaily = await patch({ key: `famcal|daily-c#${iso(at('2026-10-22 10:00'))}`, scope: 'following', changes: { repeat: 'hebrew' } });
    assertSame([fromDaily.status, pairOf(lastEvent())], [200, ['FREQ=YEARLY;UNTIL=20261029', 'anniversary', '2026-10-22']], 'from another frequency a COUNT is still its last day');
  });

  await check('H2 edit: the item info names the anchor for a Hebrew item, in the rule; a Gregorian one has none; a day move to a Hebrew date the anchor\'s year lacks answers 400 start', async () => {
    seed();
    const heb = hebrewSeries();
    assertSame((await itemOf(heb.occ('2025-11-21'))).body.series.rule, { choice: 'hebrew', anchor: '2022-11-24' }, 'the rolled year reports the anchor, not its own day');
    const y = hebrewSeries('heb-y', { rrule: 'FREQ=YEARLY;COUNT=3' });
    assertSame((await itemOf(y.occ('2022-11-24'))).body.series.rule, { choice: 'hebrew', until: '2024-12-01', anchor: '2022-11-24' }, 'a Hebrew series with an end');
    const custom = hebrewSeries('heb-2', { rrule: 'FREQ=YEARLY;INTERVAL=2' });
    assertSame((await itemOf(custom.occ('2022-11-24'))).body.series.rule, { choice: 'custom', anchor: '2022-11-24' }, 'every 2 years: custom, with the anchor');
    const greg = seedSeries('greg', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Wedding', startsAt: at('2022-11-24 10:00'), rrule: 'FREQ=YEARLY' });
    assertSame((await itemOf(`famcal|${greg.id}#${iso(at('2023-11-24 10:00'))}`)).body.series.rule, { choice: 'yearly' }, 'a Gregorian one: no anchor');
    // Anchored on 29 Cheshvan 5784, a short year: 30 Cheshvan picked in 5785 can't be the anchor's day.
    const short = hebrewSeries('heb-short', { startsAt: at('2023-11-13 10:00'), hebrewAnchor: '2023-11-13' });
    const refused = await patch({ key: short.occ('2024-11-30'), scope: 'all', changes: { start: '2024-12-01T10:00', end: '2024-12-01T11:00' } });
    assertSame([refused.status, refused.body], [400, { error: 'invalid', field: 'start' }], 'a day move for all to 30 Cheshvan from a short anchor year');
    const edit = await patch({ key: heb.occ('2023-11-14'), scope: 'following', changes: { title: 'Saba' } });
    assertSame(edit.status, 200, 'a Hebrew item is edited like any other');
  });

  // ================= A yearly series moved with "All" (editor upgrades spec §1, owner ruling 2026-10-25) =================

  /** A Gregorian yearly series as the editor writes one, from `start` ('yyyy-MM-dd HH:mm') at that time. */
  const yearlySeries = (id: string, start: string, extra: Row = {}) => {
    const row = seedSeries(id, { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Dana\'s birthday', startsAt: at(start), rrule: 'FREQ=YEARLY', ...extra });
    const time = start.slice(11);
    const occ = (day: string) => `famcal|${id}#${iso(at(`${day} ${time}`))}`;
    /** "All" from the occurrence on `day`, to `to` at the same time, an hour long. */
    const moveAll = (day: string, to: string) => patch({ key: occ(day), scope: 'all', changes: { start: `${to}T${time}`, end: `${to}T${String(Number(time.slice(0, 2)) + 1).padStart(2, '0')}${time.slice(2)}` } });
    return { id, occ, moveAll, row };
  };
  /** The overrides of a series as [day, status, title], in order. */
  const rowsOf = (id: string) => overrides(id).map((o) => [formatInTimeZone(o.originalStartsAt, IL, 'yyyy-MM-dd'), o.status, o.title]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const yearsOn = (from: number, to: number, monthDay: string, step = 1) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => `${from + i * step}-${monthDay}`);

  await check('yearly "All", far: 1985 picked on this year\'s birthday (from 2020) is the first date; later years keep their slots, exceptions and exdates with them', async () => {
    seed();
    const s = yearlySeries('bd', '2020-03-02 10:00', { exdates: [at('2029-03-02 10:00')] });
    assertSame((await patch({ key: s.occ('2027-03-02'), scope: 'single', changes: { title: 'Renamed' } })).status, 200, 'a later year renamed');
    assertSame((await del({ key: s.occ('2028-03-02'), scope: 'single' })).status, 200, 'a later year cancelled');
    const r = await s.moveAll('2026-03-02', '1985-03-02');
    assertSame([r.status, r.body.key, iso(eventRow(s.id).startsAt), iso(eventRow(s.id).endsAt), eventRow(s.id).rrule], [200, s.occ('2026-03-02'), iso(at('1985-03-02 10:00')), iso(at('1985-03-02 11:00')), 'FREQ=YEARLY'], 'the series from 1985, the opened occurrence where it was');
    const want = yearsOn(1985, 2030, '03-02').filter((d) => !['2028-03-02', '2029-03-02'].includes(d));
    assertSame(await daysOf(s.id, '1980-01-01', '2031-01-01'), want, 'every year on 2 March from 1985, the cancelled and the skipped still out');
    assertSame([rowsOf(s.id), eventRow(s.id).exdates.map(iso).sort()], [[['2027-03-02', 'OVERRIDE', 'Renamed']], [iso(at('2028-03-02 10:00')), iso(at('2029-03-02 10:00'))]], 'the rename and the skips where they were');
    assertSame((await itemOf(r.body.key)).status, 200, 'the key reads');
  });

  await check('yearly "All", near: 28 Feb moved to 1 Mar keeps the first year (2020-03-01, not 29 Feb); a rename moves to its year\'s new day', async () => {
    seed();
    const s = yearlySeries('feb', '2020-02-28 10:00');
    await patch({ key: s.occ('2027-02-28'), scope: 'single', changes: { title: 'Renamed' } });
    const r = await s.moveAll('2026-02-28', '2026-03-01');
    assertSame([r.status, r.body.key, iso(eventRow(s.id).startsAt)], [200, s.occ('2026-03-01'), iso(at('2020-03-01 10:00'))], 'from 1 Mar 2020');
    assertSame(await daysOf(s.id, '2019-01-01', '2029-01-01'), yearsOn(2020, 2028, '03-01'), 'every year on 1 March, leap years too');
    assertSame(rowsOf(s.id), [['2027-03-01', 'OVERRIDE', 'Renamed']], 'the rename on 1 Mar 2027');
  });

  await check('yearly "All", far forward: a later year is the first date; the years before it go, with what was done to them', async () => {
    seed();
    const s = yearlySeries('fwd', '2020-03-02 10:00');
    await patch({ key: s.occ('2022-03-02'), scope: 'single', changes: { title: 'Early' } });
    await del({ key: s.occ('2031-03-02'), scope: 'single' });
    const r = await s.moveAll('2026-03-02', '2030-03-05');
    assertSame([r.status, r.body.key, iso(eventRow(s.id).startsAt)], [200, s.occ('2030-03-05'), iso(at('2030-03-05 10:00'))], 'from 2030, the key on the new first date');
    assertSame(await daysOf(s.id, '2019-01-01', '2034-01-01'), ['2030-03-05', '2032-03-05', '2033-03-05'], 'nothing before 2030; 2031 still skipped');
    assertSame([rowsOf(s.id), eventRow(s.id).exdates.map(iso)], [[], [iso(at('2031-03-05 10:00'))]], 'the rename before the new start is gone, the skip moved with its year');
  });

  await check('yearly "All", near across the year: 31 Dec moved to 1 Jan starts the series on 1 Jan of the year after its first; 1 Jan to 31 Dec on the one before', async () => {
    seed();
    const s = yearlySeries('nye', '2020-12-31 10:00');
    await patch({ key: s.occ('2024-12-31'), scope: 'single', changes: { title: 'Renamed' } });
    const r = await s.moveAll('2026-12-31', '2027-01-01');
    assertSame([r.status, r.body.key, iso(eventRow(s.id).startsAt)], [200, s.occ('2027-01-01'), iso(at('2021-01-01 10:00'))], 'from 1 Jan 2021');
    assertSame(await daysOf(s.id, '2020-01-01', '2028-01-01'), yearsOn(2021, 2027, '01-01'), 'nothing on 31 Dec 2020');
    assertSame(rowsOf(s.id), [['2025-01-01', 'OVERRIDE', 'Renamed']], 'the 2024 rename on 1 Jan 2025');
    const back = yearlySeries('ny', '2020-01-01 10:00');
    const b = await back.moveAll('2026-01-01', '2025-12-31');
    assertSame([b.status, b.body.key, iso(eventRow(back.id).startsAt)], [200, back.occ('2025-12-31'), iso(at('2019-12-31 10:00'))], 'from 31 Dec 2019');
    // Moved on its own to 30 Dec first: its slot's year (2026) is the one that changes, not the days it is from 1 Jan.
    const own = yearlySeries('own', '2020-12-31 10:00');
    await patch({ key: own.occ('2026-12-31'), scope: 'single', changes: { start: '2026-12-30T10:00', end: '2026-12-30T11:00' } });
    const o = await own.moveAll('2026-12-31', '2027-01-01');
    assertSame([o.status, o.body.key, iso(eventRow(own.id).startsAt), rowsOf(own.id), overrides(own.id)[0]?.startsAt ?? null], [200, own.occ('2027-01-01'), iso(at('2021-01-01 10:00')), [['2027-01-01', 'OVERRIDE', null]], null], 'from 1 Jan 2021, the occurrence back on the rule (its row without times)');
  });

  await check('yearly "All", INTERVAL=2: a near move keeps the series\' years; a far one counts them from the new first date', async () => {
    seed();
    const near = yearlySeries('two', '2020-03-02 10:00', { rrule: 'FREQ=YEARLY;INTERVAL=2' });
    const n = await near.moveAll('2026-03-02', '2026-03-10');
    assertSame([n.status, n.body.key, iso(eventRow(near.id).startsAt)], [200, near.occ('2026-03-10'), iso(at('2020-03-10 10:00'))], 'near');
    assertSame(await daysOf(near.id, '2019-01-01', '2029-01-01'), yearsOn(2020, 2028, '03-10', 2), 'the even years, on 10 March');
    seed();
    const far = yearlySeries('two', '2020-03-02 10:00', { rrule: 'FREQ=YEARLY;INTERVAL=2' });
    await patch({ key: far.occ('2024-03-02'), scope: 'single', changes: { title: 'Renamed' } });
    // Every 2 years is a custom repeat, which keeps the 2000 floor.
    const f = await far.moveAll('2026-03-02', '2009-03-02');
    assertSame([f.status, f.body.key, iso(eventRow(far.id).startsAt), eventRow(far.id).rrule], [200, far.occ('2009-03-02'), iso(at('2009-03-02 10:00')), 'FREQ=YEARLY;INTERVAL=2'], 'far: the opened (even) year is no longer one, so the key is the new first date');
    assertSame(await daysOf(far.id, '2009-01-01', '2029-01-01'), yearsOn(2009, 2027, '03-02', 2), 'the odd years from 2009');
    assertSame(rowsOf(far.id), [], 'the even year\'s rename went with its year');
  });

  await check('yearly "All" with an end: a far move turns a COUNT into its last date, an UNTIL moves with the last year, and a far move past the end keeps the picked date', async () => {
    seed();
    const counted = yearlySeries('cnt', '2020-03-02 10:00', { rrule: 'FREQ=YEARLY;COUNT=8' });
    await counted.moveAll('2026-03-02', '1985-03-02');
    assertSame([eventRow(counted.id).rrule, (await daysOf(counted.id, '1980-01-01', '2040-01-01')).slice(-2)], ['FREQ=YEARLY;UNTIL=20270302', ['2026-03-02', '2027-03-02']], 'COUNT: still ends in 2027');
    const near = yearlySeries('cnt-near', '2020-03-02 10:00', { rrule: 'FREQ=YEARLY;COUNT=8' });
    await near.moveAll('2026-03-02', '2026-03-05');
    assertSame([eventRow(near.id).rrule, (await daysOf(near.id, '2019-01-01', '2040-01-01')).slice(-1)], ['FREQ=YEARLY;COUNT=8', ['2027-03-05']], 'a near move keeps the COUNT (the same years)');
    const until = yearlySeries('unt', '2020-03-02 10:00', { rrule: 'FREQ=YEARLY;UNTIL=20270302T235959' });
    await until.moveAll('2026-03-02', '2026-03-05');
    assertSame([eventRow(until.id).rrule, (await daysOf(until.id, '2019-01-01', '2040-01-01')).slice(-1)], ['FREQ=YEARLY;UNTIL=20270305T235959', ['2027-03-05']], 'UNTIL: moved with the last year');
    const past = yearlySeries('past', '2020-03-02 10:00', { rrule: 'FREQ=YEARLY;COUNT=3' });
    const p = await past.moveAll('2022-03-02', '2030-03-05');
    assertSame([p.status, eventRow(past.id).rrule, await daysOf(past.id, '2019-01-01', '2040-01-01')], [200, 'FREQ=YEARLY;UNTIL=20300305', ['2030-03-05']], 'past its end: the picked date alone');
  });

  await check('yearly "All", Hebrew far: 15 Shvat 5710 picked on this year\'s (anchored 15 Shvat 5784) is the first date and the anchor; every year stays on 15 Shvat', async () => {
    seed();
    const s = hebrewSeries('tu', { title: 'Saba', startsAt: at('2024-01-25 10:00'), hebrewAnchor: '2024-01-25' });
    await patch({ key: s.occ('2027-01-23'), scope: 'single', changes: { title: 'Renamed' } });
    const r = await patch({ key: s.occ('2026-02-02'), scope: 'all', changes: { start: '1950-02-02T10:00', end: '1950-02-02T11:00' } });
    assertSame([r.status, r.body.key, iso(eventRow(s.id).startsAt), pairOf(eventRow(s.id))], [200, s.occ('2026-02-02'), iso(at('1950-02-02 10:00')), ['FREQ=YEARLY', 'anniversary', '1950-02-02']], 'from 15 Shvat 5710 (the day shift gave 14 Shvat 5708)');
    assertSame(await daysOf(s.id, '1950-01-01', '1952-01-01'), ['1950-02-02', '1951-01-22'], 'its first years');
    assertSame(await daysOf(s.id, '2024-01-01', '2029-01-01'), ['2024-01-25', '2025-02-13', '2026-02-02', '2027-01-23', '2028-02-12'], 'the later years on 15 Shvat as before');
    assertSame(rowsOf(s.id), [['2027-01-23', 'OVERRIDE', 'Renamed']], 'the rename where it was');
    const info = await itemOf(r.body.key);
    assertSame([info.status, info.body.series.rule], [200, { choice: 'hebrew', anchor: '1950-02-02' }], 'the item info names the new anchor');
  });

  await check('yearly "All", Hebrew 30 Cheshvan anchor: a far pick (30 Cheshvan 5750) is the first date and keeps every year\'s day, rolled ones too', async () => {
    seed();
    const s = hebrewSeries();
    await del({ key: s.occ('2025-11-21'), scope: 'single' });
    const r = await patch({ key: s.occ('2026-11-10'), scope: 'all', changes: { start: '1989-11-28T10:00', end: '1989-11-28T11:00' } });
    assertSame([r.status, r.body.key, iso(eventRow(s.id).startsAt), eventRow(s.id).hebrewAnchor], [200, s.occ('2026-11-10'), iso(at('1989-11-28 10:00')), '1989-11-28'], 'from 30 Cheshvan 5750');
    assertSame(await daysOf(s.id, '1989-01-01', '1991-01-01'), ['1989-11-28', '1990-11-18'], '5751 has no 30 Cheshvan: 1 Kislev');
    assertSame(await daysOf(s.id, '2022-01-01', '2029-01-01'), ['2022-11-24', '2023-11-14', '2024-12-01', '2026-11-10', '2027-11-30', '2028-11-19'], 'the later years as before, the rolled 5786 still cancelled');
  });

  await check('yearly "All", Hebrew Adar II anchor (14 Adar II 5784): a near move puts every year on the picked day of the last Adar; a far one (14 Adar II 5730) is the first date', async () => {
    seed();
    const near = hebrewSeries('purim', { startsAt: at('2024-03-24 10:00'), hebrewAnchor: '2024-03-24' });
    const n = await patch({ key: near.occ('2025-03-14'), scope: 'all', changes: { start: '2025-03-15T10:00', end: '2025-03-15T11:00' } });
    assertSame([n.status, n.body.key, iso(eventRow(near.id).startsAt), eventRow(near.id).hebrewAnchor], [200, near.occ('2025-03-15'), iso(at('2024-03-25 10:00')), '2024-03-25'], 'near: 15 Adar II 5784 is the anchor');
    assertSame(await daysOf(near.id, '2024-01-01', '2028-01-01'), ['2024-03-25', '2025-03-15', '2026-03-04', '2027-03-24'], '15 Adar in a common year, 15 Adar II in a leap one');
    seed();
    const far = hebrewSeries('purim', { startsAt: at('2024-03-24 10:00'), hebrewAnchor: '2024-03-24' });
    const f = await patch({ key: far.occ('2027-03-23'), scope: 'all', changes: { start: '1970-03-22T10:00', end: '1970-03-22T11:00' } });
    assertSame([f.status, f.body.key, eventRow(far.id).hebrewAnchor], [200, far.occ('2027-03-23'), '1970-03-22'], 'far: anchored on 14 Adar II 5730');
    assertSame(await daysOf(far.id, '2024-01-01', '2028-01-01'), ['2024-03-24', '2025-03-14', '2026-03-03', '2027-03-23'], 'the later years as before');
  });

  await check('yearly "All", Hebrew: a near pick the anchor\'s year can\'t have (Adar I, anchored in a common year) is refused, nothing written; the bot is told first', async () => {
    seed();
    const s = hebrewSeries('shvat', { startsAt: at('2025-02-08 10:00'), hebrewAnchor: '2025-02-08' });
    const r = await patch({ key: s.occ('2027-01-18'), scope: 'all', changes: { start: '2027-02-17T10:00', end: '2027-02-17T11:00' } });
    assertSame([r.status, r.body], [400, { error: 'invalid', field: 'start' }], '10 Adar I 5787 from 10 Shvat');
    assertSame([iso(eventRow(s.id).startsAt), eventRow(s.id).hebrewAnchor], [iso(at('2025-02-08 10:00')), '2025-02-08'], 'nothing written');
    const asked = await store.refusesFixedDays({ seriesCuid: s.id, instanceStartsAt: at('2027-01-18 10:00'), scope: 'all', actingUserId: TAL, occurrenceTimes: true, startsAt: at('2027-02-17 10:00') });
    assertSame(asked, true, 'refusesFixedDays');
    const far = await patch({ key: s.occ('2027-01-18'), scope: 'all', changes: { start: '1990-02-04T10:00', end: '1990-02-04T11:00' } });
    assertSame([far.status, eventRow(s.id).hebrewAnchor], [200, '1990-02-04'], 'a far pick is the anchor itself, whatever its year');
  });

  await check('yearly "All" through the store (the bot\'s occurrence times, and a series\' own start), and a yearly reminder', async () => {
    seed();
    const bot = yearlySeries('bot', '2020-03-02 10:00');
    await patch({ key: bot.occ('2027-03-02'), scope: 'single', changes: { title: 'Renamed' } });
    const r = await store.updateNativeEvent({ seriesCuid: bot.id, instanceStartsAt: at('2026-03-02 10:00'), scope: 'all', actingUserId: TAL, occurrenceTimes: true, startsAt: at('1985-03-02 10:00'), endsAt: at('1985-03-02 11:00') });
    assertSame([iso(eventRow(bot.id).startsAt), iso(r.key.slot), rowsOf(bot.id)], [iso(at('1985-03-02 10:00')), iso(at('2026-03-02 10:00')), [['2027-03-02', 'OVERRIDE', 'Renamed']]], 'occurrence times: the bot\'s far move');
    const own = yearlySeries('own', '2020-03-02 10:00');
    await patch({ key: own.occ('2027-03-02'), scope: 'single', changes: { title: 'Renamed' } });
    await store.updateNativeEvent({ seriesCuid: own.id, scope: 'all', actingUserId: TAL, startsAt: at('1985-03-02 10:00'), endsAt: at('1985-03-02 11:00') });
    assertSame([iso(eventRow(own.id).startsAt), rowsOf(own.id)], [iso(at('1985-03-02 10:00')), [['2027-03-02', 'OVERRIDE', 'Renamed']]], 'the series\' own start, far from its first: the same');
    const rem = yearlySeries('rem', '2020-03-02 17:30', { kind: 'REMINDER', title: 'Call Dana' });
    const m = await patch({ key: rem.occ('2026-03-02'), scope: 'all', changes: { start: '1990-03-02T17:30' } });
    assertSame([m.status, m.body.key, iso(eventRow(rem.id).startsAt)], [200, rem.occ('2026-03-02'), iso(at('1990-03-02 17:30'))], 'a yearly reminder: far');
    const remNear = await patch({ key: rem.occ('2026-03-02'), scope: 'all', changes: { start: '2026-03-04T17:30' } });
    assertSame([remNear.status, remNear.body.key, iso(eventRow(rem.id).startsAt)], [200, rem.occ('2026-03-04'), iso(at('1990-03-04 17:30'))], 'and near');
  });

  await check('"All" back onto the series\' own day brings an occurrence moved on its own back (events as reminders); the bot resending the times it shows changes nothing', async () => {
    seed();
    const s = yearlySeries('back', '2020-03-02 10:00');
    await patch({ key: s.occ('2026-03-02'), scope: 'single', changes: { title: 'Party', start: '2026-03-05T10:00', end: '2026-03-05T11:00' } });
    const resend = await store.updateNativeEvent({ seriesCuid: s.id, instanceStartsAt: at('2026-03-02 10:00'), scope: 'all', actingUserId: TAL, occurrenceTimes: true, startsAt: at('2026-03-05 10:00'), endsAt: at('2026-03-05 11:00') });
    assertSame([iso(resend.key.slot), await daysOf(s.id, '2025-01-01', '2028-01-01')], [iso(at('2026-03-02 10:00')), ['2025-03-02', '2026-03-05', '2027-03-02']], 'the bot resending where it is: still moved');
    const r = await s.moveAll('2026-03-02', '2026-03-02');
    assertSame([r.status, r.body.key, iso(eventRow(s.id).startsAt)], [200, s.occ('2026-03-02'), iso(at('2020-03-02 10:00'))], 'the series stays');
    assertSame([await daysOf(s.id, '2025-01-01', '2028-01-01'), rowsOf(s.id), overrides(s.id)[0].startsAt], [['2025-03-02', '2026-03-02', '2027-03-02'], [['2026-03-02', 'OVERRIDE', 'Party']], null], 'every year on 2 March; the rename kept, its own times gone');
    const weekly = seedSeries('wk-back', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Swim', startsAt: at('2026-01-06 10:00'), rrule: 'FREQ=WEEKLY' });
    const wKey = `famcal|${weekly.id}#${iso(at('2026-10-20 10:00'))}`;
    await patch({ key: wKey, scope: 'single', changes: { start: '2026-10-20T12:00', end: '2026-10-20T13:00' } });
    const w = await patch({ key: wKey, scope: 'all', changes: { start: '2026-10-20T10:00', end: '2026-10-20T11:00' } });
    assertSame([w.status, iso(eventRow(weekly.id).startsAt), overrides(weekly.id)[0].startsAt], [200, iso(at('2026-01-06 10:00')), null], 'a weekly occurrence moved to 12:00 comes back to 10:00 too');
    const rem = yearlySeries('rem-back', '2020-03-02 17:30', { kind: 'REMINDER', title: 'Call Dana' });
    await patch({ key: rem.occ('2026-03-02'), scope: 'single', changes: { start: '2026-03-05T17:30' } });
    const m = await patch({ key: rem.occ('2026-03-02'), scope: 'all', changes: { start: '2026-03-02T17:30' } });
    assertSame([m.status, await daysOf(rem.id, '2025-01-01', '2028-01-01')], [200, ['2025-03-02', '2026-03-02', '2027-03-02']], 'a reminder the same');
  });

  await check('yearly "All", Hebrew tail that starts on a rolled day (1 Kislev 5786) moved to 1 Kislev: the anchor moves though the start stays (events and reminders)', async () => {
    for (const kind of ['EVENT', 'REMINDER'] as const) {
      seed();
      const s = hebrewSeries('heb', kind === 'REMINDER' ? { kind, title: 'Light a candle' } : {});
      assertSame((await patch({ key: s.occ('2025-11-21'), scope: 'following', changes: { title: 'Saba' } })).status, 200, `${kind}: the tail`);
      const tail = lastEvent();
      assertSame([iso(tail.startsAt), tail.hebrewAnchor], [iso(at('2025-11-21 10:00')), '2022-11-24'], `${kind}: starts on 1 Kislev 5786, anchored on 30 Cheshvan 5783`);
      const changes = kind === 'REMINDER' ? { start: '2026-11-11T10:00' } : { start: '2026-11-11T10:00', end: '2026-11-11T11:00' };
      const r = await patch({ key: s.occ('2026-11-10', '10:00', tail.id), scope: 'all', changes });
      assertSame([r.status, r.body.key, iso(eventRow(tail.id).startsAt), eventRow(tail.id).hebrewAnchor], [200, s.occ('2026-11-11', '10:00', tail.id), iso(at('2025-11-21 10:00')), '2022-11-25'], `${kind}: anchored on 1 Kislev 5783, its start where it was`);
      assertSame(await daysOf(tail.id, '2025-01-01', '2029-01-01'), ['2025-11-21', '2026-11-11', '2027-12-01', '2028-11-19'], `${kind}: every year on 1 Kislev`);
    }
  });

  await check('yearly "All", near onto 29 Feb: a COUNT whose years change becomes the moved last slot\'s date (a leap year\'s), not five leap years', async () => {
    seed();
    const s = yearlySeries('leap', '2021-03-01 10:00', { rrule: 'FREQ=YEARLY;COUNT=5' });
    const r = await s.moveAll('2024-03-01', '2024-02-29');
    assertSame([r.status, iso(eventRow(s.id).startsAt), eventRow(s.id).rrule, await daysOf(s.id, '2020-01-01', '2050-01-01')], [200, iso(at('2024-02-29 10:00')), 'FREQ=YEARLY;UNTIL=20240229', ['2024-02-29']], 'from 2021: only 2024 had 29 Feb');
    const t = yearlySeries('leap2', '2020-03-01 10:00', { rrule: 'FREQ=YEARLY;COUNT=5' });
    await t.moveAll('2024-03-01', '2024-02-29');
    assertSame([eventRow(t.id).rrule, await daysOf(t.id, '2019-01-01', '2050-01-01')], ['FREQ=YEARLY;UNTIL=20240229', ['2020-02-29', '2024-02-29']], 'from 2020: the leap years in its span');
  });

  await check('"All" on any other rule keeps the day shift: a monthly and a weekly series move by the days, a yearly one with fixed days is refused a day move', async () => {
    seed();
    const monthly = seedSeries('mon', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Rent', startsAt: at('2026-01-15 10:00'), rrule: 'FREQ=MONTHLY' });
    const m = await patch({ key: `famcal|${monthly.id}#${iso(at('2026-10-15 10:00'))}`, scope: 'all', changes: { start: '2026-10-16T10:00', end: '2026-10-16T11:00' } });
    assertSame([m.status, iso(eventRow(monthly.id).startsAt)], [200, iso(at('2026-01-16 10:00'))], 'monthly: a day later');
    const weekly = seedSeries('wkly', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Swim', startsAt: at('2026-01-06 10:00'), rrule: 'FREQ=WEEKLY' });
    const w = await patch({ key: `famcal|${weekly.id}#${iso(at('2026-10-20 10:00'))}`, scope: 'all', changes: { start: '2027-05-04T10:00', end: '2027-05-04T11:00' } });
    assertSame([w.status, iso(eventRow(weekly.id).startsAt)], [200, iso(at('2026-07-21 10:00'))], 'weekly: 196 days later, the same days');
    const fixed = yearlySeries('fixed', '2020-03-02 10:00', { rrule: 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=2' });
    const f = await fixed.moveAll('2026-03-02', '1985-03-02');
    assertSame([f.status, f.body, iso(eventRow(fixed.id).startsAt)], [400, { error: 'invalid', field: 'start' }, iso(at('2020-03-02 10:00'))], 'a yearly rule with fixed days: refused (no year reason)');
  });

  // ================= alerts per event (editor upgrades spec §2) =================

  const alertOf = (id: string) => [eventRow(id).ownAlerts, eventRow(id).alertMinutes];
  const enableAlerts = () => {
    tables.adminSettings = [{ id: 'global', remindersEnabled: true }];
    tables.user.find((u) => u.id === TAL)!.remindersEnabled = true;
  };

  await check('alerts, editor info: alertsOn needs the admin switch, the user\'s own switch, a plan with reminders and Telegram; defaultLead is the user\'s lead (0 = at start)', async () => {
    seed();
    const tal = () => tables.user.find((u) => u.id === TAL)!;
    const on = async () => (await editorOf()).body;
    assertSame([(await on()).alertsOn, (await on()).defaultLead], [false, 0], 'nothing enabled yet: the admin switch and the user\'s own are off');
    enableAlerts();
    assertSame([(await on()).alertsOn, (await on()).defaultLead], [true, 0], 'all four: on, at start');
    tal().defaultReminderMinutes = 15;
    assert((await on()).defaultLead === 15, 'the user\'s lead');
    redisStore.clear();
    tables.adminSettings[0].remindersEnabled = false;
    assert((await on()).alertsOn === false, 'admin switch off');
    tables.adminSettings[0].remindersEnabled = true;
    redisStore.clear();
    tal().remindersEnabled = false;
    assert((await on()).alertsOn === false, 'the user\'s own switch off');
    tal().remindersEnabled = true;
    noReminderPlan.add(TAL);
    assert((await on()).alertsOn === false, 'a plan without reminders');
    noReminderPlan.delete(TAL);
    assert((await on()).alertsOn === true, 'back on');
    const { alertsOnFor } = await load('src/services/calendar-write/item-info.ts');
    assert((await alertsOnFor({ id: TAL, telegramId: null, remindersEnabled: true })) === false, 'no Telegram chat');
    assert((await alertsOnFor({ id: TAL, telegramId: 5, remindersEnabled: true })) === true, 'with one');
  });

  await check('alerts, create: Default is stored as the default, None as an own empty list, a lead as that lead; the field omitted is the default', async () => {
    seed();
    const rows: Array<[unknown, unknown[]]> = [[undefined, [false, []]], ['default', [false, []]], ['none', [true, []]], [0, [true, [0]]], [15, [true, [15]]], [1440, [true, [1440]]]];
    for (const [alert, want] of rows) {
      const r = await post(eventBody(alert === undefined ? {} : { alert }));
      assert(r.status === 200, `${show(alert)}: ${r.status} ${r.text}`);
      assertSame(alertOf(idOf(r.body.key)), want, `alert ${show(alert)}`);
    }
    const repeating = await post(eventBody({ repeat: 'weekly', alert: 30 }));
    assertSame(alertOf(idOf(repeating.body.key)), [true, [30]], 'a series');
  });

  await check('alerts, validation: a value off the list, of another type, or sent for a reminder or a Google calendar is 400 field alert, and nothing is written', async () => {
    seed();
    for (const alert of [7, 45, 2880, -5, 1.5, '30', 'never', true, null, {}, []]) {
      const r = await post(eventBody({ alert }));
      assertSame([r.status, r.body], [400, { error: 'invalid', field: 'alert' }], `create alert ${show(alert)}`);
    }
    assertSame((await post(reminderBody({ alert: 15 }))).body, { error: 'invalid', field: 'alert' }, 'a reminder');
    assertSame((await post(reminderBody({ alert: 'default' }))).body, { error: 'invalid', field: 'alert' }, 'a reminder, even the default');
    assertSame((await post(eventBody({ alert: 15, calendarId: 'avi@gmail.com' }))).body, { error: 'invalid', field: 'alert' }, 'a Google calendar');
    assert(eventsAll().length === 0, 'something was written');
    const one = await post(eventBody());
    for (const alert of [7, '30', null, false]) {
      assertSame((await patch({ key: one.body.key, scope: 'single', changes: { alert } })).body, { error: 'invalid', field: 'alert' }, `patch alert ${show(alert)}`);
    }
    const reminder = await post(reminderBody());
    assertSame((await patch({ key: reminder.body.key, scope: 'single', changes: { alert: 5 } })).body, { error: 'invalid', field: 'alert' }, 'a patch of a reminder');
    assertSame(alertOf(idOf(one.body.key)), [false, []], 'the event is as it was');
  });

  await check('alerts, edit a one-off: a lead, None, back to Default; the same value writes nothing; the item info reads it back', async () => {
    seed();
    const one = await post(eventBody());
    const id = idOf(one.body.key);
    assertSame((await patch({ key: one.body.key, scope: 'single', changes: { alert: 15 } })).body, { status: 'ok', key: one.body.key }, 'set');
    assertSame([alertOf(id), (await itemOf(one.body.key)).body.alert], [[true, [15]], 15], '15');
    await patch({ key: one.body.key, scope: 'single', changes: { alert: 'none' } });
    assertSame([alertOf(id), (await itemOf(one.body.key)).body.alert], [[true, []], 'none'], 'none');
    prismaCalls.length = 0;
    const same = await patch({ key: one.body.key, scope: 'single', changes: { alert: 'none' } });
    assert(same.status === 200 && !prismaCalls.some((c) => /\.(update|upsert|create|deleteMany)$/.test(c)), `the same alert wrote: ${prismaCalls}`);
    await patch({ key: one.body.key, scope: 'single', changes: { alert: 'default' } });
    assertSame([alertOf(id), (await itemOf(one.body.key)).body.alert], [[false, []], 'default'], 'default');
    assert(tracked.some((t) => t.action === 'calendar_item_edited' && (t.meta.changed_fields as string[]).includes('alert')), 'the analytics name the field');
  });

  await check('alerts, item info: an off-list stored lead reads as it is; a reminder has none', async () => {
    seed();
    seedSeries('mig', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Migrated', startsAt: at('2026-10-20 10:00'), ownAlerts: true, alertMinutes: [45] });
    assert((await itemOf('famcal|mig')).body.alert === 45, 'the migrated lead');
    const reminder = await post(reminderBody());
    const r = await itemOf(reminder.body.key);
    assert(r.status === 200 && !('alert' in r.body), `a reminder carries ${show(r.body.alert)}`);
  });

  await check('alerts, a series: an alert change needs "this and after" or "all" (like a calendar); "only this one" is 400 scope and writes nothing', async () => {
    seed();
    const { id, occ } = await weeklySeries();
    const before = show(tables.nativeEvent);
    const single = await patch({ key: occ('2026-10-27'), scope: 'single', changes: { alert: 15 } });
    assertSame([single.status, single.body, show(tables.nativeEvent) === before, overrides(id).length], [400, { error: 'invalid', field: 'scope' }, true, 0], 'single refused');
    const all = await patch({ key: occ('2026-10-27'), scope: 'all', changes: { alert: 10 } });
    assertSame([all.body, alertOf(id), tables.nativeEvent.length], [{ status: 'ok', key: occ('2026-10-27') }, [true, [10]], 1], 'all sets the series row');
    const following = await patch({ key: occ('2026-11-03'), scope: 'following', changes: { alert: 'none' } });
    const tail = lastEvent();
    assertSame([following.status, alertOf(id), alertOf(tail.id)], [200, [true, [10]], [true, []]], 'following: the tail gets it, the head keeps its own');
    const firstOcc = await patch({ key: occ('2026-10-20'), scope: 'following', changes: { alert: 60 } });
    assertSame([firstOcc.status, alertOf(id), tables.nativeEvent.length], [200, [true, [60]], 2], 'following from the first occurrence is the whole series');
  });

  await check('alerts, a split carries the alert: a rename "this and after" keeps the tail\'s alert; a repeat stop gives the one-off the alert it ends up with; a reminder\'s copies stay default', async () => {
    seed();
    const { id, occ } = await weeklySeries({ alert: 30 });
    assertSame(alertOf(id), [true, [30]], 'created');
    await patch({ key: occ('2026-11-03'), scope: 'following', changes: { title: 'Renamed' } });
    assertSame([alertOf(id), alertOf(lastEvent().id)], [[true, [30]], [true, [30]]], 'the tail keeps it');
    const { occ: occ2 } = await weeklySeries({ alert: 15 });
    await patch({ key: occ2('2026-11-03'), scope: 'following', changes: { repeat: 'none' } });
    assertSame(alertOf(lastEvent().id), [true, [15]], 'a stop: the one-off keeps the series\' alert');
    const { occ: occ3 } = await weeklySeries({ alert: 15 });
    await patch({ key: occ3('2026-11-03'), scope: 'following', changes: { repeat: 'none', alert: 'none' } });
    assertSame(alertOf(lastEvent().id), [true, []], 'a stop with an alert change: the one-off has the new one');
    const first = await weeklySeries({ alert: 15 });
    const rows = tables.nativeEvent.length;
    await patch({ key: first.occ('2026-10-20'), scope: 'following', changes: { repeat: 'none', alert: 'none' } });
    assertSame([eventRow(first.id).rrule, alertOf(first.id), tables.nativeEvent.length - rows], [null, [true, []], 0], 'a stop from the first occurrence with an alert change: the series row is the one-off with the new alert');
    const rem = await post(reminderBody({ repeat: 'daily' }));
    await patch({ key: `famcal|${idOf(rem.body.key)}#${iso(at('2026-10-22 17:30'))}`, scope: 'following', changes: { start: '2026-10-22T18:00' } });
    assertSame(alertOf(lastEvent().id), [false, []], 'a reminder\'s tail');
  });

  await check('alerts, the store itself: an alert equal to the series\' own is no change (any scope); a different one on a series is refused for "only this one" with nothing written', async () => {
    seed();
    const { id } = await weeklySeries({ alert: 15 });
    const slot = at('2026-10-27 10:00');
    const same = await store.updateNativeEvent({ seriesCuid: id, instanceStartsAt: slot, scope: 'single', actingUserId: TAL, title: 'Only this', alert: 15 });
    assertSame([same.key.seriesId, overrides(id).map((o) => o.title)], [id, ['Only this']], 'equal: a single edit, no scope refusal');
    const before = show(tables.nativeEvent);
    const e = await thrownBy(() => store.updateNativeEvent({ seriesCuid: id, instanceStartsAt: slot, scope: 'single', actingUserId: TAL, alert: 'none' }));
    assert(e !== null && (e as Row).field === 'scope', `a series\' alert for one occurrence: ${e}`);
    assert(show(tables.nativeEvent) === before, 'something was written');
  });

  await check('alerts, a cross-source move with an alert change in the same save is "move alone"; the store refuses an alert for a reminder', async () => {
    seed();
    const one = await post(eventBody());
    const r = await patch({ key: one.body.key, scope: 'single', changes: { calendarId: 'avi@gmail.com', alert: 15 } });
    assertSame([r.status, r.body], [400, { error: 'invalid', field: 'moveAlone' }], 'a move with an alert');
    const reminder = await post(reminderBody());
    const e = await thrownBy(() => store.updateNativeEvent({ seriesCuid: idOf(reminder.body.key), scope: 'single', actingUserId: TAL, alert: 15 }));
    assert(e !== null && (e as Row).field === 'alert', `the store accepted an alert for a reminder: ${e}`);
    const made = await thrownBy(() => store.createNativeEvent({ calendarCuid: 'cal-tal', creatorUserId: TAL, title: 'r', startsAt: at('2026-10-21 09:00'), endsAt: at('2026-10-21 09:00'), timeZone: IL, kind: 'REMINDER', alert: 15 }));
    assert(made !== null && (made as Row).field === 'alert', `the store created a reminder with an alert: ${made}`);
    const plain = await thrownBy(() => store.createNativeEvent({ calendarCuid: 'cal-tal', creatorUserId: TAL, title: 'r', startsAt: at('2026-10-21 09:00'), endsAt: at('2026-10-21 09:00'), timeZone: IL, kind: 'REMINDER', alert: 'default' }));
    assert(plain === null, `the default is fine for a reminder: ${plain}`);
  });

  await check('a store failure is 500 with no title in the response, the capture or the console', async () => {
    seed();
    failCreateWith = `Invalid prisma.nativeEvent.create() invocation: { title: "${SECRET_TITLE}" }`;
    const r = await post(eventBody({ title: SECRET_TITLE }));
    assertSame([r.status, r.body, cacheOf(r)], [500, { error: 'internal_error' }, NOT_STORED], 'response');
    assert(captured.length === 1 && captured[0].ctx === 'calendar-items-create', `captured ${show(captured)}`);
    assertSame(captured[0].extra, { user_id: TAL }, 'context: the user id only');
    assert(captured[0].message === 'Error P2002', `message ${captured[0].message}`);
    assert(!show(captured).includes(SECRET_TITLE) && !r.text.includes(SECRET_TITLE), 'a title leaked');
  });

  await check('nothing in the run logged a title', async () => {
    seed();
    const created = await post(eventBody({ title: SECRET_TITLE, repeat: 'weekly' }));
    await patch({ key: created.body.key, scope: 'all', changes: { title: `${SECRET_TITLE} 2`, start: '2026-10-20T12:00' } });
    await post(reminderBody({ title: SECRET_TITLE }));
    await del({ key: created.body.key, scope: 'all' });
    await post(eventBody({ title: '' }));
    await itemOf(created.body.key);
    const everything = [...consoleLines, show(captured), show(tracked)].join('\n');
    assert(!everything.includes(SECRET_TITLE), `a title reached ${everything.split('\n').find((l) => l.includes(SECRET_TITLE))}`);
  });

  Object.assign(console, quiet);
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

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
import { fromZonedTime } from 'date-fns-tz';

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
  nativeEvent: () => ({ description: null, location: null, allDay: false, rrule: null, exdates: [], reminderMinutes: null, isDeleted: false, kind: 'EVENT', forUserId: null, armedAt: null }),
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

function table(name: string) {
  const find = (where?: Where) => tables[name].filter((r) => !where || matches(r, where));
  const insert = (data: Row) => {
    const row: Row = { id: `${name}-${++nextId}`, ...DEFAULTS[name]?.(), createdAt: new Date() };
    apply(row, data);
    tables[name].push(row);
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
      return { ...row };
    }),
    upsert: async ({ where, create, update }: Args) => rec('upsert', () => {
      const row = find(where)[0];
      if (!row) return insert(create!);
      apply(row, update!);
      return { ...row };
    }),
    updateMany: async ({ where, data }: Args) => rec('updateMany', () => {
      const rows = find(where);
      rows.forEach((r) => apply(r, data!));
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
for (const name of ['user', 'pairing', 'nativeCalendar', 'nativeEvent', 'nativeEventInstance', 'nativeReminderState', 'adminSettings']) {
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
const stripped: { pings: Row[]; original: Row; updates: Row; editorId: number }[] = [];
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
    stripMovedPings: async (pings: Row[], original: Row, updates: Row, editor: Row) => {
      stripped.push({ pings, original, updates, editorId: editor.id });
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

  await check('editor: no partner, a partner who cannot be pinged, no plan for reminders, no Telegram, Google', async () => {
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
    assertSame([dan.body.kinds, dan.body.calendars], [{ event: false, reminder: false }, []], 'a Google user has neither');
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
      ['a key from Google', { key: 'google|cal|id', scope: 'single', changes: { title: 'x' } }, 'key'],
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

  await check('create event: on a private calendar the partner\'s cache stays; on a shared one it goes; a Google user is refused', async () => {
    seed();
    seedRecurrenceCache();
    await post(eventBody());
    assertSame(cacheUsers(), [NOA, 11], 'a private calendar clears only the user\'s');
    seedRecurrenceCache();
    await post(eventBody({ calendarId: 'native:cal-tal-family' }));
    assertSame(cacheUsers(), [11], 'a shared calendar clears the partner\'s too');
    const dan = await post(eventBody(), { tg: TG.dan });
    assert(dan.status === 403 && dan.body.error === 'not_allowed', `Google user ${dan.status} ${dan.text}`);
  });

  await check('create event: analytics with source app under the bot\'s action name, no title in them', async () => {
    seed();
    await post(eventBody({ title: SECRET_TITLE }));
    assertSame(tracked.map((t) => [t.userId, t.action, t.meta.source]), [[TAL, 'voice_event_created', 'app']], 'tracked');
    assert(!show(tracked).includes(SECRET_TITLE), 'a title reached analytics');
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

  await check('create reminder: for a partner who cannot be pinged is invalid; with no plan, no Telegram or on Google it is 403', async () => {
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
    const dan = await post(reminderBody(), { tg: TG.dan });
    assertSame([dan.status, dan.body.error], [403, 'not_allowed'], 'Google');
    assert(eventsAll().length === 0, 'a refused reminder wrote');
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
      series: { recurring: false, start: '2026-10-20T10:00', repeat: null, fixedDays: false },
      calendar: { id: 'native:cal-tal', name: 'Tal', color: '#039BE5' },
      forName: null, scopes: ['single'],
    }, 'a one-off');
    const weekly = await post(eventBody({ repeat: 'weekly' }));
    const occurrence = `famcal|${idOf(weekly.body.key)}#${iso(at('2026-11-03 10:00'))}`;
    const w = await itemOf(occurrence);
    assertSame(
      [w.body.occurrence.start, w.body.series, w.body.scopes],
      ['2026-11-03T10:00', { recurring: true, start: '2026-10-20T10:00', repeat: { freq: 'weekly', interval: 1, byDay: [], ends: false }, fixedDays: false }, ['single', 'following', 'all']],
      'an occurrence of a weekly series'
    );
    const allDay = await post(eventBody({ allDay: true, start: '2026-10-20', end: '2026-10-22' }));
    assertSame((await itemOf(allDay.body.key)).body.occurrence, { start: '2026-10-20', end: '2026-10-22', allDay: true, title: 'Dentist', location: '', description: '' }, 'all-day: dates, the end inclusive');
  });

  await check('item: the bot\'s rules read as they are (BYDAY, INTERVAL, UNTIL)', async () => {
    seed();
    const s = seedSeries('bot-series', { calendarId: 'cal-tal', creatorUserId: TAL, title: 'Piano', startsAt: at('2026-10-20 16:00'), rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20261231' });
    const r = await itemOf(`famcal|${s.id}#${iso(at('2026-10-20 16:00'))}`);
    assertSame(r.body.series.repeat, { freq: 'weekly', interval: 2, byDay: ['TU', 'TH'], ends: true }, 'repeat');
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
    assertSame((await itemOf(shared.body.key, { tg: TG.noa })).body, { ...(await itemOf(shared.body.key)).body, calendar: { id: 'native:cal-tal-family', name: 'Family', color: '#039BE5' }, canEdit: true, canDelete: true }, 'the partner reads and edits the shared calendar\'s event');
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

  await check('edit event, all of them: a title change keeps the overrides; a time change shifts the series and drops them', async () => {
    seed();
    const { id, occ } = await weeklySeries();
    await patch({ key: occ('2026-11-03'), scope: 'single', changes: { location: 'Home' } });
    const title = await patch({ key: occ('2026-10-27'), scope: 'all', changes: { title: 'Dentist visit' } });
    assertSame(title.body, { status: 'ok', key: occ('2026-10-27') }, 'title: same key');
    assertSame([eventRow(id).title, overrides(id).length, iso(eventRow(id).startsAt)], ['Dentist visit', 1, iso(at('2026-10-20 10:00'))], 'title: the series, the override stays, the start stays');
    const time = await patch({ key: occ('2026-10-27'), scope: 'all', changes: { start: '2026-10-27T11:30', end: '2026-10-27T12:30' } });
    assert(time.status === 200 && time.body.key === occ('2026-10-27', '11:30'), `time: ${time.status} ${time.text}`);
    assertSame([iso(eventRow(id).startsAt), iso(eventRow(id).endsAt), overrides(id).length], [iso(at('2026-10-20 11:30')), iso(at('2026-10-20 12:30')), 0], 'time: every occurrence moves, overrides go');
    assert((await itemOf(time.body.key)).body.occurrence.start === '2026-10-27T11:30', 'the returned key reads');
    const longer = await patch({ key: time.body.key, scope: 'all', changes: { end: '2026-10-27T13:30' } });
    assert(longer.body.key === time.body.key, 'a longer event keeps its key');
    assert(iso(eventRow(id).endsAt) === iso(at('2026-10-20 13:30')) && iso(eventRow(id).startsAt) === iso(at('2026-10-20 11:30')), 'only the end moved');
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

  await check('edit reminder, a rule with fixed days: a day move for every one is refused; this one moves', async () => {
    seed();
    const series = seedSeries('bot-reminder', { calendarId: 'cal-tal', creatorUserId: TAL, kind: 'REMINDER', title: 'Bins', startsAt: at('2026-10-20 20:00'), rrule: 'FREQ=WEEKLY;BYDAY=TU' });
    const key = `famcal|${series.id}#${iso(at('2026-10-27 20:00'))}`;
    const all = await patch({ key, scope: 'all', changes: { start: '2026-10-28T20:00' } });
    assertSame([all.status, all.body, iso(series.startsAt)], [400, { error: 'invalid', field: 'start' }, iso(at('2026-10-20 20:00'))], 'all');
    const single = await patch({ key, scope: 'single', changes: { start: '2026-10-28T20:00' } });
    assert(single.status === 200 && iso(overrides(series.id)[0]?.startsAt) === iso(at('2026-10-28 20:00')), `single: ${single.status} ${single.text}`);
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

  // ================= failures and logs =================

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

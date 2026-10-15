// Smoke test: Telegram initData never travels in a URL. initData stays valid for 24h
// and URLs end up in edge logs and Sentry, so a leaked admin initData was a day of full
// admin access. The Mini App used to put it in the query of 9 fetches (7 in the admin
// panel, calendars, share-story), and 21 route reads took it from there. Now the
// clients send the X-Telegram-Init-Data header (initDataHeaders), and every route reads
// the header, then a string initData in the JSON body, and never the query
// (requestInitData).
//
// The routes, admin-auth, api-auth, telegram-auth and the services behind them run for
// real. Faked at the boundaries: Prisma (in memory), Redis (in memory), the rate limiter
// (always allows), Telegram and messaging (record every send), error capture, and fetch
// (blocked). No network, no DB.
//
// The check named [guard] already passes before the fix and must keep passing. The
// others fail until the fix lands.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-initdata-header.ts

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

// Test values, used only when the fake env left them unset.
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

// ---- Fake Prisma: in-memory tables, any model ----

const DB: Record<string, Row[]> = {};

const num = (x: unknown) => (x instanceof Date ? x.getTime() : Number(x));
function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') return a != null && b != null && String(a) === String(b);
  return a === b;
}
const isPlain = (v: unknown): v is Row =>
  v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);

function matches(row: Row, where?: Row): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    if (k === 'AND') return ([] as Row[]).concat(cond).every(c => matches(row, c));
    if (k === 'OR') return (cond as Row[]).some(c => matches(row, c));
    if (k === 'NOT') return !([] as Row[]).concat(cond).some(c => matches(row, c));
    const v = row[k];
    if (isPlain(cond)) {
      if ('equals' in cond && !same(v ?? null, cond.equals)) return false;
      if ('in' in cond && !(cond.in as unknown[]).some(x => same(v, x))) return false;
      if ('notIn' in cond && (cond.notIn as unknown[]).some(x => same(v, x))) return false;
      if ('not' in cond && (isPlain(cond.not) ? matches(row, { [k]: cond.not }) : same(v ?? null, cond.not))) return false;
      if ('gt' in cond && !(v != null && num(v) > num(cond.gt))) return false;
      if ('gte' in cond && !(v != null && num(v) >= num(cond.gte))) return false;
      if ('lt' in cond && !(v != null && num(v) < num(cond.lt))) return false;
      if ('lte' in cond && !(v != null && num(v) <= num(cond.lte))) return false;
      if ('has' in cond && !(Array.isArray(v) && v.includes(cond.has))) return false;
      return true;
    }
    return same(v ?? null, cond);
  });
}

function pick(row: Row | undefined, select?: Row): Row | null {
  if (!row) return null;
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]]));
}

function sorted(rows: Row[], orderBy?: Row | Row[]): Row[] {
  const keys = ([] as Row[]).concat(orderBy ?? []).flatMap(o => Object.entries(o));
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
    else if (isPlain(v) && 'decrement' in v) row[k] = (row[k] ?? 0) - v.decrement;
    else if (isPlain(v) && 'set' in v) row[k] = v.set;
    else if (isPlain(v) && ('connect' in v || 'create' in v || 'disconnect' in v)) continue;
    else row[k] = v;
  }
}

const DEFAULTS: Record<string, () => Row> = {
  pairingInvite: () => ({ acceptedAt: null, acceptedByUserId: null, revokedAt: null }),
  pairing: () => ({ unlinkedAt: null, unlinkedByUserId: null, acceptedAt: null }),
  subscription: () => ({ currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, trialStartedAt: null }),
  usageCounter: () => ({ textSummariesUsed: 0, voiceSummariesUsed: 0, voiceEventsCreated: 0, remindersTriggered: 0, cycleStartDate: new Date() }),
};
let seq = 0;

function model(name: string): Row {
  const t = () => (DB[name] ??= []);
  const create = (data: Row): Row => {
    const now = new Date();
    const id = name === 'user' ? Math.max(0, ...t().map(r => Number(r.id))) + 1 : `${name}-${++seq}`;
    const row: Row = { id, createdAt: now, updatedAt: now, ...(DEFAULTS[name]?.() ?? {}) };
    applyData(row, data);
    t().push(row);
    return row;
  };
  const updateOne = (where: Row, data: Row): Row => {
    const row = t().find(r => matches(r, where));
    if (!row) throw Object.assign(new Error(`No ${name} record was found for an update.`), { code: 'P2025' });
    applyData(row, data);
    if ('updatedAt' in row) row.updatedAt = new Date();
    return row;
  };
  return {
    findUnique: async (a: Row = {}) => pick(t().find(r => matches(r, a.where)), a.select),
    findUniqueOrThrow: async (a: Row = {}) => {
      const r = t().find(x => matches(x, a.where));
      if (!r) throw Object.assign(new Error(`No ${name} found`), { code: 'P2025' });
      return pick(r, a.select);
    },
    findFirst: async (a: Row = {}) => pick(sorted(t().filter(r => matches(r, a.where)), a.orderBy)[0], a.select),
    findMany: async (a: Row = {}) =>
      sorted(t().filter(r => matches(r, a.where)), a.orderBy).slice(0, a.take ?? undefined).map(r => pick(r, a.select)),
    count: async (a: Row = {}) => t().filter(r => matches(r, a.where)).length,
    create: async (a: Row) => pick(create(a.data), a.select),
    createMany: async (a: Row) => ({ count: ([] as Row[]).concat(a.data).map(create).length }),
    update: async (a: Row) => pick(updateOne(a.where, a.data), a.select),
    updateMany: async (a: Row) => {
      const rows = t().filter(r => matches(r, a.where));
      rows.forEach(r => applyData(r, a.data));
      return { count: rows.length };
    },
    upsert: async (a: Row) => {
      const row = t().find(r => matches(r, a.where));
      return row ? pick(updateOne(a.where, a.update), a.select) : pick(create({ ...a.where, ...a.create }), a.select);
    },
    delete: async (a: Row) => {
      const i = t().findIndex(r => matches(r, a.where));
      if (i < 0) throw Object.assign(new Error(`No ${name} record to delete`), { code: 'P2025' });
      return t().splice(i, 1)[0];
    },
    deleteMany: async (a: Row = {}) => {
      const keep = t().filter(r => !matches(r, a.where));
      const count = t().length - keep.length;
      DB[name] = keep;
      return { count };
    },
    groupBy: async () => [],
    aggregate: async () => ({ _count: {}, _sum: {}, _max: {}, _min: {} }),
  };
}

const models: Record<string, Row> = {};
const fakePrisma: Row = new Proxy({} as Row, {
  get(_t, prop) {
    if (typeof prop !== 'string' || prop === 'then') return undefined;
    if (prop === '$transaction') {
      return async (arg: unknown) => (typeof arg === 'function' ? arg(fakePrisma) : Promise.all(arg as Promise<unknown>[]));
    }
    if (prop.startsWith('$')) return async () => [];
    return (models[prop] ??= model(prop));
  },
});

// ---- Fake Redis (Upstash parses JSON on read) ----

const redisStore = new Map<string, string>();
const decode = (raw: string | undefined) => {
  if (raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return raw; }
};
const encode = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
const redisImpl: Row = {
  get: async (k: string) => decode(redisStore.get(k)),
  set: async (k: string, v: unknown, o?: Row) => {
    if (o?.nx && redisStore.has(k)) return null;
    redisStore.set(k, encode(v));
    return 'OK';
  },
  del: async (...ks: unknown[]) => ks.flat().reduce((n: number, k) => n + (redisStore.delete(String(k)) ? 1 : 0), 0),
  getdel: async (k: string) => { const raw = redisStore.get(k); redisStore.delete(k); return decode(raw); },
  incr: async (k: string) => { const n = Number(redisStore.get(k) ?? 0) + 1; redisStore.set(k, String(n)); return n; },
  exists: async (...ks: string[]) => ks.filter(k => redisStore.has(k)).length,
  mget: async (...ks: unknown[]) => ks.flat().map(k => decode(redisStore.get(String(k)))),
  scan: async () => [0, []],
  keys: async () => [],
  expire: async () => 1,
  ttl: async () => -1,
};
const fakeRedis = new Proxy(redisImpl, {
  get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? (async () => null)),
});

// ---- Telegram / messaging: every send is recorded ----

const sent: string[] = [];
const recorder = (prefix: string): Row =>
  new Proxy({} as Row, {
    get: (_t, p) =>
      typeof p !== 'string' || p === 'then'
        ? undefined
        : async () => {
            sent.push(`${prefix}.${p}`);
            if (p === 'streamMessage') return { finalize: async () => 1, cancel: async () => undefined, update: async () => undefined };
            return { message_id: 1 };
          },
  });

// ---- Boundaries: stubs in require's cache, served to import() by a load hook ----

const Module = nodeRequire('module');
const stubs: Record<string, Row> = {};
(globalThis as Row).__smokeStubs = stubs;
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
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

function stub(rel: string, exports: Row) {
  const filename = path.join(ROOT, rel);
  stubs[filename] = exports;
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  Module._cache[filename] = mod;
}

const captured: string[] = [];

function installStubs() {
  stub('src/utils/prisma.ts', { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() });
  stub('src/utils/redis.ts', { redis: fakeRedis });
  stub('src/lib/rate-limit.ts', {
    settingsRateLimiter: {}, commandRateLimiter: {}, generalRateLimiter: {},
    checkRateLimit: async () => ({ success: true, limit: 99, remaining: 99, reset: 0 }),
    getRateLimitHeaders: () => ({}),
  });
  const capture = (e: unknown, ctx: string) => { captured.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`); };
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
  const bot = recorder('bot');
  const telegram = {
    getBot: () => bot,
    initBot: () => bot,
    getMessagingService: () => recorder('tg'),
    setUserMenuButton: async () => { sent.push('setUserMenuButton'); },
  };
  stub('src/services/telegram/index.ts', telegram);
  stub('src/services/telegram/bot.ts', telegram);
  const messaging = {
    ...nodeRequire(path.join(ROOT, 'src/services/messaging/types.ts')),
    getMessagingService: (platform: unknown) => recorder(String(platform)),
    getTelegramService: () => recorder('telegram'),
    getWhatsAppService: () => recorder('whatsapp'),
    detectPlatform: () => 'telegram',
  };
  stub('src/services/messaging/index.ts', messaging);
  stub('src/services/messaging/factory.ts', messaging);
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`network blocked in smoke: ${String(input instanceof Request ? input.url : input)}`);
  }) as typeof fetch;
}

// ---- Fixtures ----

const DAY = 86_400_000;
const TG_ID = 111111111;

function baseUser(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', culture: 'default',
    messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null, calendarSource: 'NATIVE',
    pairingId: null, remindersEnabled: false, suspendedAt: null, unreachableSince: null, whatsappPhone: null,
    whatsappBsuid: null, telegramId: null, isAdmin: false, globalRules: [], voiceInputEnabled: true,
    textSummaryEnabled: true, voiceSummaryEnabled: false, weatherEnabled: true, locationForced: false,
    createdAt: new Date(Date.now() - 30 * DAY), updatedAt: new Date(Date.now() - DAY),
    ...o,
  };
}

/** 9 = Telegram user 111111111, an admin with a native calendar. 42 = another user. */
function seed() {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  sent.length = 0;
  captured.length = 0;
  DB.user = [
    baseUser({ id: 9, name: 'Tal', telegramId: BigInt(TG_ID), isAdmin: true }),
    baseUser({ id: 42, name: 'Other', telegramId: BigInt(222222222) }),
  ];
  DB.nativeCalendar = [{
    id: 'cal-9', ownerUserId: 9, name: 'Family', color: '#336699', labels: ['primary'], privacy: 'PRIVATE',
    isDeleted: false, personName: null, personEnglishName: null, personGender: null, rules: [], createdAt: new Date(Date.now() - 9 * DAY),
  }];
}

/** Valid Telegram initData for a Telegram user id, signed with the bot token. */
function initDataFor(tgId: number): string {
  const params: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAH-smoke',
    user: JSON.stringify({ id: tgId, first_name: 'Test' }),
  };
  const checkString = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN ?? '').digest();
  const hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  return [...Object.entries(params), ['hash', hash]].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Every .ts/.tsx file under a repo directory, as repo-relative paths. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (/\.tsx?$/.test(entry.name)) out.push(child);
    }
  };
  walk(dir);
  return out;
}

/** Every route read of initData before the fix: 13 query-only, 8 body-then-query. */
type Case = { route: string; method: string; url: string; body?: Row; params?: Row };
const CASES: Case[] = [
  { route: 'app/api/admin/settings/route.ts', method: 'GET', url: '/api/admin/settings' },
  { route: 'app/api/admin/user-activity/route.ts', method: 'GET', url: '/api/admin/user-activity?limit=5' },
  { route: 'app/api/admin/feedback/route.ts', method: 'GET', url: '/api/admin/feedback?limit=5' },
  { route: 'app/api/admin/subscription/route.ts', method: 'DELETE', url: '/api/admin/subscription?user_id=42' },
  { route: 'app/api/admin/user-overrides/route.ts', method: 'GET', url: '/api/admin/user-overrides?list=all' },
  { route: 'app/api/admin/user-overrides/route.ts', method: 'DELETE', url: '/api/admin/user-overrides?user_id=42' },
  { route: 'app/api/admin/users/blocklist/route.ts', method: 'GET', url: '/api/admin/users/blocklist' },
  { route: 'app/api/admin/analytics/route.ts', method: 'GET', url: '/api/admin/analytics?days=7' },
  { route: 'app/api/native-calendars/route.ts', method: 'GET', url: `/api/native-calendars?user_id=${TG_ID}` },
  { route: 'app/api/native-calendars/route.ts', method: 'POST', url: `/api/native-calendars?user_id=${TG_ID}`, body: { name: 'Kids' } },
  { route: 'app/api/native-calendars/[id]/route.ts', method: 'PATCH', url: `/api/native-calendars/cal-9?user_id=${TG_ID}`, body: { name: 'Home' }, params: { id: 'cal-9' } },
  { route: 'app/api/native-calendars/[id]/route.ts', method: 'DELETE', url: `/api/native-calendars/cal-9?user_id=${TG_ID}`, body: {}, params: { id: 'cal-9' } },
  { route: 'app/api/pair/route.ts', method: 'GET', url: `/api/pair?user_id=${TG_ID}` },
  { route: 'app/api/pair/route.ts', method: 'DELETE', url: `/api/pair?user_id=${TG_ID}`, body: {} },
  { route: 'app/api/pair/invite/route.ts', method: 'POST', url: `/api/pair/invite?user_id=${TG_ID}`, body: {} },
  { route: 'app/api/pair/invite/route.ts', method: 'GET', url: `/api/pair/invite?user_id=${TG_ID}` },
  { route: 'app/api/pair/invite/route.ts', method: 'DELETE', url: `/api/pair/invite?user_id=${TG_ID}`, body: {} },
  { route: 'app/api/pair/accept/route.ts', method: 'POST', url: `/api/pair/accept?user_id=${TG_ID}`, body: { token: 'no-such-token' } },
  { route: 'app/api/oauth/start/route.ts', method: 'POST', url: '/api/oauth/start', body: { user_id: String(TG_ID) } },
  { route: 'app/api/subscription/route.ts', method: 'GET', url: `/api/subscription?user_id=${TG_ID}` },
  { route: 'app/api/weather-image/sign/route.ts', method: 'GET', url: `/api/weather-image/sign?user_id=${TG_ID}&source=summary` },
];

async function main() {
  installStubs();
  const { NextRequest } = nodeRequire('next/server');

  // The routes log refused attempts and service failures; keep the output to the results.
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  Object.assign(console, { log: () => {}, warn: () => {}, error: () => {} });

  const call = async (c: Case, o: { query?: string; header?: string; body?: Row }): Promise<number> => {
    seed();
    const mod = await load(c.route);
    const sep = c.url.includes('?') ? '&' : '?';
    const url = `http://localhost${c.url}${o.query ? `${sep}initData=${encodeURIComponent(o.query)}` : ''}`;
    const body = o.body ?? c.body;
    const req = new NextRequest(url, {
      method: c.method,
      headers: { 'content-type': 'application/json', ...(o.header ? { 'x-telegram-init-data': o.header } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res: Response = await mod[c.method](req, { params: Promise.resolve(c.params ?? {}) });
    return res.status;
  };
  const label = (c: Case) => `${c.method} ${c.url.split('?')[0]}`;

  await check('#1 requestInitData: the header first, then a non-empty string body initData, never the query', async () => {
    const { requestInitData } = await load('src/lib/request-init-data.ts');
    const { INIT_DATA_HEADER } = await load('src/lib/read-init-data.ts');
    assert(INIT_DATA_HEADER === 'X-Telegram-Init-Data', `INIT_DATA_HEADER is ${show(INIT_DATA_HEADER)}`);
    const r = (headers: Record<string, string> = {}, q = '') => new Request(`http://localhost/api/x${q}`, { headers });
    const got = {
      header: requestInitData(r({ 'x-telegram-init-data': 'from-header' }), { initData: 'from-body' }),
      body: requestInitData(r(), { initData: 'from-body' }),
      emptyBody: requestInitData(r(), { initData: '' }),
      numberBody: requestInitData(r(), { initData: 5 }),
      nullBody: requestInitData(r(), null),
      stringBody: requestInitData(r(), 'initData'),
      query: requestInitData(r({}, '?initData=from-query')),
      queryAndBody: requestInitData(r({}, '?initData=from-query'), {}),
    };
    const want = {
      header: 'from-header', body: 'from-body', emptyBody: undefined, numberBody: undefined,
      nullBody: undefined, stringBody: undefined, query: undefined, queryAndBody: undefined,
    };
    assert(show(got) === show(want), `got ${show(got)}`);
  });

  await check('#2 initDataHeaders: the header with the SDK\'s initData inside Telegram, none outside it', async () => {
    const g = globalThis as Row;
    const reads: Row = {};
    try {
      g.window = { location: { hash: '' }, sessionStorage: { getItem: () => null } };
      const { initDataHeaders } = await load('src/lib/read-init-data.ts');
      reads.browser = initDataHeaders();
      g.window.Telegram = { WebApp: { initData: 'signed-init-data' } };
      reads.telegram = initDataHeaders();
    } finally {
      delete g.window;
    }
    assert(show(reads.browser) === '{}', `outside Telegram: ${show(reads.browser)}`);
    assert(show(reads.telegram) === show({ 'X-Telegram-Init-Data': 'signed-init-data' }), `inside Telegram: ${show(reads.telegram)}`);
  });

  await check(`#3 every one of the ${CASES.length} route reads refuses a valid initData in the query (401)`, async () => {
    const wrong: string[] = [];
    for (const c of CASES) {
      const status = await call(c, { query: initDataFor(TG_ID) });
      if (status !== 401) wrong.push(`${label(c)} -> ${status}`);
    }
    assert(wrong.length === 0, wrong.join('; '));
  });

  await check(`#4 every one of the ${CASES.length} route reads accepts the X-Telegram-Init-Data header (not 401/403)`, async () => {
    const wrong: string[] = [];
    for (const c of CASES) {
      const status = await call(c, { header: initDataFor(TG_ID) });
      if (status === 401 || status === 403) wrong.push(`${label(c)} -> ${status}`);
    }
    assert(wrong.length === 0, `${wrong.join('; ')} ${captured.join(' | ')}`);
  });

  await check('#5 [guard] the routes that read a body still take initData from it (not 401/403)', async () => {
    const wrong: string[] = [];
    for (const c of CASES.filter(x => x.body)) {
      const status = await call(c, { body: { ...c.body, initData: initDataFor(TG_ID) } });
      if (status === 401 || status === 403) wrong.push(`${label(c)} -> ${status}`);
    }
    assert(wrong.length === 0, wrong.join('; '));
  });

  await check('#6 GET /api/native-calendars: ?initData=<valid> is 401; the same initData in the header is 200 with the calendar', async () => {
    const c = CASES.find(x => x.method === 'GET' && x.route === 'app/api/native-calendars/route.ts') as Case;
    const viaQuery = await call(c, { query: initDataFor(TG_ID) });
    seed();
    const { GET } = await load(c.route);
    const res: Response = await GET(new NextRequest(`http://localhost${c.url}`, { headers: { 'x-telegram-init-data': initDataFor(TG_ID) } }));
    const body = await res.clone().json().catch(() => ({}));
    assert(viaQuery === 401, `query: status ${viaQuery}`);
    assert(res.status === 200 && body.calendars?.[0]?.rawId === 'cal-9', `header: status ${res.status} ${show(body)}`);
  });

  await check('#7 no route or lib code reads initData with .get(\'initData\')', () => {
    const re = /\.get\(\s*['"`]initData['"`]\s*\)/;
    const hits = [...sourceFiles('app/api'), ...sourceFiles('src/lib')].filter(f => re.test(readSource(f)));
    assert(hits.length === 0, `still read from a query: ${hits.join(', ')}`);
  });

  await check('#8 no browser or bot code builds a URL with initData= or a URLSearchParams with an initData key', () => {
    // The Sentry scrubber names the pattern it removes.
    const allowed = new Set(['src/lib/sentry-scrub.ts']);
    const files = [
      ...sourceFiles('app').filter(f => !f.startsWith(`app${path.sep}api${path.sep}`)),
      ...sourceFiles('components'),
      ...sourceFiles('src'),
    ].filter(f => !allowed.has(f.split(path.sep).join('/')));
    const hits: string[] = [];
    for (const f of files) {
      const src = readSource(f);
      if (/initData=/.test(src)) hits.push(`${f} (initData=)`);
      if (/new URLSearchParams\(\s*\{[^}]*\binitData\s*:/.test(src)) hits.push(`${f} (URLSearchParams initData)`);
    }
    assert(hits.length === 0, hits.join(', '));
  });

  await check('#9 calendars and pair read initData through readInitData for every call', () => {
    const bad: string[] = [];
    for (const rel of ['app/[locale]/calendars/CalendarsClient.tsx', 'app/[locale]/pair/PairClient.tsx']) {
      const fn = readSource(rel).match(/function getInitData\(\)[^{]*\{([^}]*)\}/)?.[1]?.trim() ?? '(not found)';
      if (fn !== 'return readInitData();') bad.push(`${rel}: ${fn}`);
    }
    assert(bad.length === 0, bad.join('; '));
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

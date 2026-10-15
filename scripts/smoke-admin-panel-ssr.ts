// Smoke test for the admin panel's server HTML. The page looked up any ?user_id with no
// credential, and when that id was an admin's it rendered the user counts and every
// AdminSettings toggle into the HTML. Its Unauthorized-vs-panel answer also told anyone
// which ids are admins. Now the page renders the same client shell for every request and
// looks no one up; AdminPanelClient loads the toggles from GET /api/admin/settings and
// the counts from the new GET /api/admin/stats, both admin-only, with initData in the
// X-Telegram-Init-Data header, and shows the old Unauthorized card on 401/403.
//
// The page, both routes, admin-auth and telegram-auth run for real, and the client's
// loader calls the real routes through a fetch shim. Faked at the boundaries: Prisma (in
// memory, every call counted), Redis (in memory), the rate limiter (always allows),
// Telegram and messaging (record every send), error capture, and any other fetch
// (blocked). No network, no DB.
//
// The check named [guard] already passes before the fix and must keep passing. The
// others fail until the fix lands.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-admin-panel-ssr.ts

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

/** Every Prisma call, as model.method. `dbDown` makes every call fail, as an outage does. */
const prismaCalls: string[] = [];
const dbState = { down: false };
const models: Record<string, Row> = {};
const fakePrisma: Row = new Proxy({} as Row, {
  get(_t, prop) {
    if (typeof prop !== 'string' || prop === 'then') return undefined;
    if (prop === '$transaction') {
      return async (arg: unknown) => (typeof arg === 'function' ? arg(fakePrisma) : Promise.all(arg as Promise<unknown>[]));
    }
    if (prop.startsWith('$')) return async () => [];
    const m = (models[prop] ??= model(prop));
    return new Proxy(m, {
      get: (target, method) => (typeof method !== 'string' ? undefined : (...args: unknown[]) => {
        prismaCalls.push(`${prop}.${method}`);
        if (dbState.down) return Promise.reject(new Error('database is down'));
        return target[method](...args);
      }),
    });
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
const ADMIN_TG = 111111111;
const USER_TG = 222222222;

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

/**
 * 9 = the admin (Telegram 111111111). 42 = a set-up Google user (Telegram 222222222).
 * 43 = native with no location, 44 = Google with no token: both need setup. 45 = WhatsApp.
 * The toggles are the opposite of their defaults, so a default can't pass for the DB.
 */
function seed() {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  prismaCalls.length = 0;
  sent.length = 0;
  captured.length = 0;
  dbState.down = false;
  DB.user = [
    baseUser({ id: 9, name: 'Admin', telegramId: BigInt(ADMIN_TG), isAdmin: true }),
    baseUser({ id: 42, name: 'Google', telegramId: BigInt(USER_TG), calendarSource: 'GOOGLE', googleRefreshToken: 'rt', calendarAssignments: [{ id: 'c' }], location: 'Haifa' }),
    baseUser({ id: 43, name: 'NoLocation', telegramId: BigInt(333333333), location: '' }),
    baseUser({ id: 44, name: 'NoToken', telegramId: BigInt(444444444), calendarSource: 'GOOGLE' }),
    baseUser({ id: 45, name: 'WA', messagingPlatform: 'whatsapp', whatsappBsuid: 'IL.1' }),
  ];
  DB.adminSettings = [{
    id: 'global', remindersEnabled: true, earlyAdoptionMode: true, voiceAutoCreateHighConf: true,
    voiceTtsOutcome: true, nativeRemindersEnabled: false,
  }];
}

const TOGGLES = { remindersEnabled: true, earlyAdoptionMode: true, voiceAutoCreateHighConf: true, voiceTtsOutcome: true, nativeRemindersEnabled: false };

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

/** The element tree as the RSC payload would carry it: client props included. */
function serialize(value: unknown): string {
  return JSON.stringify(value, (k, v) => {
    if (k.startsWith('_')) return undefined;
    if (typeof v === 'function') return `[fn ${v.name}]`;
    return v;
  }) ?? '';
}

/** Server-render the element inside the provider the [locale] layout gives a client page. */
function renderHtml(el: unknown, locale: string): string {
  const React = nodeRequire('react');
  const { renderToString } = nodeRequire('react-dom/server');
  const { NextIntlClientProvider } = nodeRequire('next-intl');
  const messages = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${locale}.json`), 'utf8'));
  try {
    return renderToString(React.createElement(NextIntlClientProvider, { locale, messages, timeZone: 'Asia/Jerusalem' }, el));
  } catch (err) {
    return `(render failed: ${err instanceof Error ? err.message : String(err)})`;
  }
}

async function main() {
  installStubs();
  const { NextRequest } = nodeRequire('next/server');

  // The routes log refused attempts; keep the output to the results.
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  Object.assign(console, { log: () => {}, warn: () => {}, error: () => {} });

  const page = async (userId: string): Promise<unknown> => {
    const AdminPanelPage = (await load('app/[locale]/admin-panel/page.tsx')).default;
    return AdminPanelPage({ params: Promise.resolve({ locale: 'en' }), searchParams: Promise.resolve({ user_id: userId }) });
  };
  const get = async (route: string, o: { header?: string; query?: string } = {}): Promise<Response> => {
    const { GET } = await load(`app/api/admin/${route}/route.ts`);
    const url = `http://localhost/api/admin/${route}${o.query ? `?initData=${encodeURIComponent(o.query)}` : ''}`;
    return GET(new NextRequest(url, { headers: o.header ? { 'x-telegram-init-data': o.header } : {} }));
  };
  const json = async (res: Response): Promise<Row> => res.clone().json().catch(() => ({}));

  // The client's loader, run against the real routes. Records what each request carried.
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const ROUTES: Record<string, string> = {
    '/api/admin/settings': 'app/api/admin/settings/route.ts',
    '/api/admin/stats': 'app/api/admin/stats/route.ts',
  };
  const runLoader = async (initData: string): Promise<Row> => {
    const g = globalThis as Row;
    const blocked = globalThis.fetch;
    requests.length = 0;
    g.window = { location: { hash: '' }, sessionStorage: { getItem: () => null }, ...(initData ? { Telegram: { WebApp: { initData } } } : {}) };
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      requests.push({ url: url.pathname + url.search, headers });
      const route = ROUTES[url.pathname];
      if (!route) throw new Error(`blocked in smoke: ${url.pathname}`);
      const { GET } = await load(route);
      return GET(new NextRequest(url.href, { headers }));
    }) as typeof fetch;
    try {
      const { loadAdminPanel } = await load('app/[locale]/admin-panel/AdminPanelClient.tsx');
      assert(typeof loadAdminPanel === 'function', 'AdminPanelClient exports no loadAdminPanel');
      return await loadAdminPanel();
    } finally {
      globalThis.fetch = blocked;
      delete g.window;
    }
  };

  await check('#1 the page for an admin\'s id, a user\'s id and an unknown id: no lookup, only userId and locale as props, no stats or toggles, the same HTML', async () => {
    const outputs: { id: string; props: string; html: string; calls: number }[] = [];
    for (const id of [String(ADMIN_TG), '9', String(USER_TG), '424242']) {
      seed();
      const el = await page(id);
      outputs.push({ id, props: serialize(el).split(id).join('{ID}'), html: renderHtml(el, 'en'), calls: prismaCalls.length });
    }
    const problems: string[] = [];
    for (const o of outputs) {
      if (o.calls) problems.push(`${o.id}: ${o.calls} Prisma calls`);
      if (o.props !== outputs[0].props) problems.push(`${o.id}: props ${o.props} vs ${outputs[0].props}`);
      if (o.html !== outputs[0].html) problems.push(`${o.id}: different HTML`);
      if (/stat-value|role="switch"|aria-checked|Unauthorized|Total Users/.test(o.html)) problems.push(`${o.id}: HTML carries the panel or the Unauthorized card`);
      if (/render failed/.test(o.html)) problems.push(`${o.id}: ${o.html}`);
    }
    const props = (JSON.parse(serialize(await page(String(ADMIN_TG)))) as Row).props ?? {};
    if (show(Object.keys(props).sort()) !== show(['locale', 'userId'])) problems.push(`props keys ${show(Object.keys(props))}`);
    // The same id, admin or not: byte for byte the same
    seed();
    const asAdmin = serialize(await page('9')) + renderHtml(await page('9'), 'en');
    (DB.user[0] as Row).isAdmin = false;
    const asUser = serialize(await page('9')) + renderHtml(await page('9'), 'en');
    if (asAdmin !== asUser) problems.push('the same id renders differently once it is no admin');
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#2 GET /api/admin/stats: none 401, a user\'s initData 403, the admin\'s in the query 401, the admin\'s header 200 with the counts', async () => {
    seed();
    const none = await get('stats');
    const user = await get('stats', { header: initDataFor(USER_TG) });
    const query = await get('stats', { query: initDataFor(ADMIN_TG) });
    const admin = await get('stats', { header: initDataFor(ADMIN_TG) });
    const body = await json(admin);
    assert(none.status === 401 && user.status === 403 && query.status === 401,
      `none ${none.status}, user ${user.status}, admin in the query ${query.status}`);
    assert(!('stats' in (await json(user))) && !('stats' in (await json(none))), 'a refused call carries stats');
    const s = body.stats ?? {};
    assert(admin.status === 200 && s.totalUsers === 5 && s.usersWithOAuth === 1 && s.needSetup === 2 && s.nativeUsers === 3
      && typeof s.usersWithCalendars === 'number', `admin: ${admin.status} ${show(body)} ${captured.join(' | ')}`);
    assert(show(Object.keys(s).sort()) === show(['nativeUsers', 'needSetup', 'totalUsers', 'usersWithCalendars', 'usersWithOAuth']), `keys ${show(Object.keys(s))}`);
  });

  await check('#3 [guard] GET /api/admin/settings with the header: a user\'s initData 403, the admin\'s 200 with the toggles', async () => {
    seed();
    const user = await get('settings', { header: initDataFor(USER_TG) });
    const admin = await get('settings', { header: initDataFor(ADMIN_TG) });
    const body = await json(admin);
    assert(user.status === 403 && !('remindersEnabled' in (await json(user))), `user: ${user.status} ${show(await json(user))}`);
    const toggles = Object.fromEntries(Object.keys(TOGGLES).map(k => [k, body[k]]));
    assert(admin.status === 200 && show(toggles) === show(TOGGLES), `admin: ${admin.status} ${show(body)}`);
  });

  await check('#4 the client loads the panel for the admin: the DB\'s toggles and counts, initData in the header and never in a URL', async () => {
    seed();
    const initData = initDataFor(ADMIN_TG);
    const out = await runLoader(initData);
    const initial = out.initial ?? {};
    assert(out.kind === 'ready', `loader: ${show(out)} ${captured.join(' | ')}`);
    const toggles = Object.fromEntries(Object.keys(TOGGLES).map(k => [k, initial[k]]));
    assert(show(toggles) === show(TOGGLES), `toggles ${show(toggles)}`);
    assert(initial.stats?.totalUsers === 5 && initial.stats?.needSetup === 2, `stats ${show(initial.stats)}`);
    const paths = requests.map(r => r.url).sort();
    assert(show(paths) === show(['/api/admin/settings', '/api/admin/stats']), `requests ${show(paths)}`);
    assert(requests.every(r => r.headers['x-telegram-init-data'] === initData), `headers ${show(requests)}`);
    assert(requests.every(r => !/initData/i.test(r.url)), `a URL carries initData: ${show(requests.map(r => r.url))}`);
  });

  await check('#5 the client: a user\'s initData or none at all is denied (the Unauthorized card); the DB down is an error, not denied', async () => {
    seed();
    const user = await runLoader(initDataFor(USER_TG));
    const none = await runLoader('');
    seed();
    dbState.down = true;
    const down = await runLoader(initDataFor(ADMIN_TG));
    dbState.down = false;
    assert(user.kind === 'denied' && !user.initial, `a user: ${show(user)}`);
    assert(none.kind === 'denied', `no initData: ${show(none)}`);
    assert(down.kind === 'error', `DB down: ${show(down)}`);
  });

  await check('#6 the Unauthorized card says what the page used to say', async () => {
    const React = nodeRequire('react');
    const { AdminUnauthorized } = await load('app/[locale]/admin-panel/AdminPanelClient.tsx');
    assert(typeof AdminUnauthorized === 'function', 'AdminPanelClient exports no AdminUnauthorized');
    const html = renderHtml(React.createElement(AdminUnauthorized), 'he');
    assert(html.includes('>Unauthorized</h1>') && html.includes('This area is restricted to administrators only.'), html);
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

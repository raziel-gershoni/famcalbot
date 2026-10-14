// Smoke test for what the [locale] pages hand out before anyone has proved who they
// are. The server never sees Telegram initData and the pages used to load private data
// for any ?user_id: the pair page even carried the live invite token, which grants
// editor access to the inviter's calendars. A page now renders no user data; the data
// comes from one authenticated POST to /api/page-data, which answers with the props, a
// locale redirect, a notice, or 401/403/404.
//
// The pages, the page-data route, user-service, pairing-service and subscription-service
// run for real. Faked at the boundaries: Prisma (in memory, every call counted), Redis
// (in memory), the rate limiter (always allows), Telegram and messaging (record every
// send), error capture, the Google Calendar list (counted) and fetch (blocked). No
// network, no DB.
//
// Every check here fails until the fix lands. Numbers follow the design's smoke list.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-page-auth.ts

import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
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

// ---- Fake Prisma: in-memory tables, any model ----

const DB: Record<string, Row[]> = {};
const prismaCalls: string[] = [];
/** Every write to the user table: the where it used and the row ids it hit. */
const userWrites: { method: string; where: Row; data: Row; hit: number[] }[] = [];

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
  const recordUser = (method: string, where: Row, data: Row, hit: Row[]) => {
    if (name === 'user') userWrites.push({ method, where, data, hit: hit.map(r => r.id) });
  };
  const create = (data: Row): Row => {
    const now = new Date();
    const id = name === 'user' ? Math.max(0, ...t().map(r => Number(r.id))) + 1 : `${name}-${++seq}`;
    const row: Row = { id, createdAt: now, updatedAt: now, ...(DEFAULTS[name]?.() ?? {}) };
    applyData(row, data);
    t().push(row);
    recordUser('create', {}, data, [row]);
    return row;
  };
  const updateOne = (where: Row, data: Row, method: string): Row => {
    const row = t().find(r => matches(r, where));
    recordUser(method, where, data, row ? [row] : []);
    if (!row) throw Object.assign(new Error(`No ${name} record was found for an update.`), { code: 'P2025' });
    applyData(row, data);
    if ('updatedAt' in row) row.updatedAt = new Date();
    return row;
  };
  const impl: Row = {
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
    update: async (a: Row) => pick(updateOne(a.where, a.data, 'update'), a.select),
    // Checks and sets in one tick, as a single UPDATE ... WHERE does.
    updateMany: async (a: Row) => {
      const rows = t().filter(r => matches(r, a.where));
      recordUser('updateMany', a.where ?? {}, a.data, rows);
      rows.forEach(r => applyData(r, a.data));
      return { count: rows.length };
    },
    upsert: async (a: Row) => {
      const row = t().find(r => matches(r, a.where));
      return row ? pick(updateOne(a.where, a.update, 'upsert'), a.select) : pick(create({ ...a.where, ...a.create }), a.select);
    },
    delete: async (a: Row) => {
      const i = t().findIndex(r => matches(r, a.where));
      if (i < 0) throw Object.assign(new Error(`No ${name} record to delete`), { code: 'P2025' });
      recordUser('delete', a.where, {}, [t()[i]]);
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
  return Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, (...args: unknown[]) => { prismaCalls.push(`${name}.${k}`); return fn(...args); }]),
  );
}

const models: Record<string, Row> = {};
const fakePrisma: Row = new Proxy({} as Row, {
  get(_t, prop) {
    if (typeof prop !== 'string' || prop === 'then') return undefined;
    if (prop === '$transaction') {
      return async (arg: unknown) => {
        prismaCalls.push('$transaction');
        return typeof arg === 'function' ? arg(fakePrisma) : Promise.all(arg as Promise<unknown>[]);
      };
    }
    if (prop.startsWith('$')) return async () => undefined;
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
  // Reads and deletes in one tick, as GETDEL does.
  getdel: async (k: string) => { const raw = redisStore.get(k); redisStore.delete(k); return decode(raw); },
  incr: async (k: string) => { const n = Number(redisStore.get(k) ?? 0) + 1; redisStore.set(k, String(n)); return n; },
  exists: async (...ks: string[]) => ks.filter(k => redisStore.has(k)).length,
  mget: async (...ks: unknown[]) => ks.flat().map(k => decode(redisStore.get(String(k)))),
  scan: async () => [0, []],
  expire: async () => 1,
  ttl: async () => -1,
};
const fakeRedis = new Proxy(redisImpl, {
  get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? (async () => null)),
});

// ---- Telegram / messaging: every send is recorded ----

type Sent = { via: string; platform: string; chatId: unknown; text?: string };
const sent: Sent[] = [];
const captured: string[] = [];

const recorder = (platform: string, prefix: string): Row =>
  new Proxy({} as Row, {
    get: (_t, p) =>
      typeof p !== 'string' || p === 'then'
        ? undefined
        : async (chatId: unknown, ...rest: unknown[]) => {
            sent.push({ via: `${prefix}.${p}`, platform, chatId, text: typeof rest[0] === 'string' ? rest[0] : undefined });
            if (p === 'streamMessage') return { finalize: async () => 1, cancel: async () => undefined, update: async () => undefined };
            return { message_id: 1 };
          },
  });


// ---- Boundaries: stubs in require's cache, served to import() by a load hook ----

const googleCalls: string[] = [];
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
  const bot = recorder('telegram', 'bot');
  const telegram = {
    getBot: () => bot,
    initBot: () => bot,
    getMessagingService: () => recorder('telegram', 'tg'),
    setUserMenuButton: async (chatId: unknown) => { sent.push({ via: 'setUserMenuButton', platform: 'telegram', chatId }); },
  };
  stub('src/services/telegram/index.ts', telegram);
  stub('src/services/telegram/bot.ts', telegram);
  const messaging = {
    ...nodeRequire(path.join(ROOT, 'src/services/messaging/types.ts')),
    getMessagingService: (platform: unknown) => recorder(String(platform), String(platform)),
    getTelegramService: () => recorder('telegram', 'telegram'),
    getWhatsAppService: () => recorder('whatsapp', 'whatsapp'),
    detectPlatform: () => 'telegram',
  };
  stub('src/services/messaging/index.ts', messaging);
  stub('src/services/messaging/factory.ts', messaging);
  // Google: the calendar list is the only Google call a page makes.
  stub('src/services/calendar.ts', {
    ...nodeRequire(path.join(ROOT, 'src/services/calendar.ts')),
    listUserCalendars: async (refreshToken: string) => {
      googleCalls.push(`listUserCalendars(${refreshToken})`);
      return [{ id: 'CAL-SECRET-google@group.calendar.google.com', name: 'CAL-SECRET-google', description: '', primary: false, accessRole: 'writer', backgroundColor: '#123456' }];
    },
  });
  // DashboardClient imports @hebcal/core, which ships ESM only with no require entry, so
  // it cannot load under tsx. A named placeholder stands in; the checks read the props
  // the page hands it, which is what the RSC payload would carry.
  const DashboardClient = () => null;
  stub('app/[locale]/dashboard/DashboardClient.tsx', { __esModule: true, default: DashboardClient });
  globalThis.fetch = (async (input: unknown) => {
    googleCalls.push(`fetch ${String(input)}`);
    throw new Error(`network blocked in smoke: ${String(input)}`);
  }) as typeof fetch;
}

// ---- Fixtures ----

const DAY = 86_400_000;
const INVITE_TOKEN = crypto.randomBytes(32).toString('hex');

function baseUser(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', culture: 'default',
    messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null, calendarSource: 'NATIVE',
    pairingId: null, remindersEnabled: false, suspendedAt: null, unreachableSince: null, whatsappPhone: null,
    whatsappBsuid: null, telegramId: null, isAdmin: false, globalRules: [], voiceInputEnabled: true,
    textSummaryEnabled: true, voiceSummaryEnabled: false, weatherEnabled: true, locationForced: false,
    preferredMorningHour: 7, preferredEveningHour: 20, dailySummaryDays: [0, 1, 2, 3, 4, 5, 6], tomorrowSummaryDays: [0, 1, 2, 3, 4, 5, 6],
    createdAt: new Date(Date.now() - 30 * DAY), updatedAt: new Date(Date.now() - DAY),
    ...o,
  };
}

/**
 * 1 = Dana, Telegram 5550001, Hebrew, NATIVE, paired with 3 and holding an open invite
 * (both visible at once, so one render shows both leaks). 4 = Gina, Telegram 8880004,
 * GOOGLE. 9 = Tal, Telegram 111111111. 42 = WhatsApp-only, Russian. Everything private
 * carries "SECRET".
 */
function seed() {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  prismaCalls.length = 0;
  googleCalls.length = 0;
  sent.length = 0;
  captured.length = 0;
  DB.user = [
    baseUser({ id: 1, name: 'Dana', telegramId: BigInt(5550001), language: 'he', location: 'LOC-SECRET-1', pairingId: 'pair-1' }),
    baseUser({ id: 3, name: 'PARTNER-SECRET-NAME', telegramId: BigInt(5550003), language: 'he', pairingId: 'pair-1' }),
    baseUser({
      id: 4, name: 'Gina', telegramId: BigInt(8880004), calendarSource: 'GOOGLE', location: 'LOC-SECRET-4',
      googleRefreshToken: 'google-rt-test',
      calendarAssignments: [{ calendarId: 'CAL-SECRET-mine@gmail.com', labels: ['primary', 'yours'], name: 'CAL-SECRET-mine', color: '#000000', rules: ['CAL-SECRET-rule'] }],
    }),
    baseUser({ id: 9, name: 'Tal', telegramId: BigInt(111111111) }),
    baseUser({ id: 42, name: 'WA-User', language: 'ru', location: 'LOC-SECRET-42', messagingPlatform: 'whatsapp', whatsappBsuid: 'IL.123' }),
  ];
  DB.pairing = [{
    id: 'pair-1', status: 'ACTIVE', inviterUserId: 1, inviteeUserId: 3, acceptedAt: new Date(Date.now() - 3 * DAY),
    unlinkedAt: null, unlinkedByUserId: null, createdAt: new Date(Date.now() - 4 * DAY),
  }];
  DB.pairingInvite = [{
    id: 'inv-1', token: INVITE_TOKEN, inviterUserId: 1, expiresAt: new Date(Date.now() + 6 * DAY),
    acceptedAt: null, acceptedByUserId: null, revokedAt: null, createdAt: new Date(Date.now() - DAY),
  }];
  const cal = (id: string, ownerUserId: number, name: string, o: Row = {}): Row => ({
    id, ownerUserId, name, color: '#336699', labels: ['kids'], privacy: 'PRIVATE', isDeleted: false,
    personName: null, personEnglishName: null, personGender: null, rules: [], createdAt: new Date(Date.now() - 9 * DAY), ...o,
  });
  DB.nativeCalendar = [
    cal('cal-1', 1, 'CAL-SECRET-dana', { personName: 'KID-SECRET', rules: ['KID-SECRET-rule'] }),
    cal('cal-3', 3, 'CAL-SECRET-partner', { privacy: 'SHARED_EDITOR' }),
    cal('cal-4', 4, 'CAL-SECRET-gina-native'),
    cal('cal-42', 42, 'CAL-SECRET-wa'),
  ];
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

async function fullBody(res: Response): Promise<string> {
  try { return JSON.stringify(await res.clone().json()); } catch { return '(non-json)'; }
}

/** The body, cut short for a failure message. */
async function bodyOf(res: Response): Promise<string> {
  const text = await fullBody(res);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/** Call a page server component as Next does. A redirect or notFound comes back as `thrown`. */
async function callPage(rel: string, locale: string, userId: string): Promise<{ el?: unknown; thrown?: string }> {
  const page = (await load(rel)).default;
  try {
    return { el: await page({ params: Promise.resolve({ locale }), searchParams: Promise.resolve({ user_id: userId }) }) };
  } catch (err) {
    return { thrown: String((err as Row)?.digest ?? (err instanceof Error ? err.message : err)) };
  }
}

/** The element tree as the RSC payload would carry it: client props included. */
function serialize(value: unknown): string {
  try {
    return JSON.stringify(value, (k, v) => {
      if (k.startsWith('_')) return undefined;
      if (typeof v === 'bigint') return `${v}n`;
      if (v instanceof Set) return [...v];
      if (v instanceof Map) return Object.fromEntries(v);
      if (typeof v === 'function') return `[fn ${v.name}]`;
      return v;
    }) ?? '';
  } catch (err) {
    return `(unserializable: ${err instanceof Error ? err.message : String(err)})`;
  }
}

/** Server-render the element inside the providers the app layout gives a client page. */
function renderHtml(el: unknown, locale: string): string {
  const React = nodeRequire('react');
  const { renderToString } = nodeRequire('react-dom/server');
  const { NextIntlClientProvider } = nodeRequire('next-intl');
  const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
  const noop = () => undefined;
  const router = { push: noop, replace: noop, refresh: noop, prefetch: noop, back: noop, forward: noop };
  const messages = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${locale}.json`), 'utf8'));
  try {
    return renderToString(
      React.createElement(AppRouterContext.Provider, { value: router },
        React.createElement(NextIntlClientProvider, { locale, messages, timeZone: 'Asia/Jerusalem' }, el)),
    );
  } catch (err) {
    return `(render failed: ${err instanceof Error ? err.message : String(err)})`;
  }
}

async function main() {
  installStubs();

  const { NextRequest } = nodeRequire('next/server');
  const { createSessionToken } = await load('src/lib/session-auth.ts');
  const waCookie = `famcal_session=${createSessionToken(42)}`;

  const req = (url: string, o: { body?: unknown; cookie?: string } = {}) =>
    new NextRequest(`http://localhost${url}`, {
      method: o.body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(o.cookie ? { cookie: o.cookie } : {}) },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
  const pageData = async (body: Row, cookie?: string): Promise<Response> => {
    const { POST } = await load('app/api/page-data/route.ts');
    return POST(req('/api/page-data', { body, cookie }));
  };

  // ---- The pages themselves render no user data ----

  await check('#1 /he/pair?user_id=1 with no credential: neither the props nor the HTML carry the invite token or the partner', async () => {
    seed();
    const r = await callPage('app/[locale]/pair/page.tsx', 'he', '1');
    const props = r.thrown ?? serialize(r.el);
    const html = r.el ? renderHtml(r.el, 'he') : '';
    const leaks: string[] = [];
    for (const [label, secret] of [['invite token', INVITE_TOKEN], ['partner name', 'PARTNER-SECRET-NAME']]) {
      if (props.includes(secret)) leaks.push(`props carry the ${label}`);
      if (html.includes(secret)) leaks.push(`HTML carries the ${label}`);
    }
    assert(leaks.length === 0, leaks.join('; '));
  });

  await check('#2 dashboard, settings, calendars, select-calendars, subscription: no private data, no Prisma or Google call', async () => {
    const pages: [string, string, string][] = [
      ['dashboard', 'en', '8880004'],
      ['settings', 'he', '5550001'],
      ['calendars', 'he', '5550001'],
      ['select-calendars', 'en', '8880004'],
      ['subscription', 'he', '5550001'],
    ];
    const problems: string[] = [];
    for (const [name, locale, userId] of pages) {
      seed();
      try {
        const r = await callPage(`app/[locale]/${name}/page.tsx`, locale, userId);
        const out = r.thrown ?? serialize(r.el);
        const secrets = [...new Set(out.match(/[A-Z]+-SECRET[\w@.-]*/g) ?? [])];
        if (secrets.length) problems.push(`${name} carries ${secrets.join(', ')}`);
        if (prismaCalls.length) problems.push(`${name} made ${prismaCalls.length} Prisma calls`);
        if (googleCalls.length) problems.push(`${name} called Google: ${googleCalls.join(', ')}`);
      } catch (err) {
        problems.push(`${name} threw ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  // ---- /api/page-data: one authenticated POST ----

  await check('#3 page-data pair with no credential is 401', async () => {
    seed();
    const res = await pageData({ page: 'pair', user_id: 1, locale: 'he' });
    assert(res.status === 401, `status ${res.status} ${await bodyOf(res)}`);
    assert(!(await fullBody(res)).includes(INVITE_TOKEN), 'the 401 carries the invite token');
  });

  await check('#4 page-data pair with the owner\'s initData is 200 and carries the invite token', async () => {
    seed();
    const res = await pageData({ page: 'pair', user_id: 5550001, locale: 'he', initData: initDataFor(5550001) });
    assert(res.status === 200, `status ${res.status} ${await bodyOf(res)}`);
    assert((await fullBody(res)).includes(INVITE_TOKEN), `no invite token in ${await bodyOf(res)}`);
  });

  await check('#5 page-data pair with another user\'s initData and user_id=1 is 401', async () => {
    seed();
    const res = await pageData({ page: 'pair', user_id: 1, locale: 'he', initData: initDataFor(111111111) });
    assert(res.status === 401, `status ${res.status} ${await bodyOf(res)}`);
    assert(!(await fullBody(res)).includes(INVITE_TOKEN), 'the response carries the invite token');
  });

  await check('#6 page-data settings on the WA cookie: the props carry row 42\'s location', async () => {
    seed();
    const res = await pageData({ page: 'settings', user_id: 42, locale: 'ru' }, waCookie);
    assert(res.status === 200, `status ${res.status} ${await bodyOf(res)}`);
    assert((await fullBody(res)).includes('LOC-SECRET-42'), `no row 42 location in ${await bodyOf(res)}`);
  });

  await check('#7 page-data settings in the wrong locale: a redirect to /ru/settings?user_id=42, no props', async () => {
    seed();
    const res = await pageData({ page: 'settings', user_id: 42, locale: 'he' }, waCookie);
    const body = await fullBody(res);
    assert(body.includes('redirect') && body.includes('/ru/settings?user_id=42'), `status ${res.status} ${await bodyOf(res)}`);
    assert(!body.includes('LOC-SECRET-42'), `the redirect carries props: ${await bodyOf(res)}`);
  });

  await check('#8 page-data calendars for a GOOGLE user: notice notNative, no calendars', async () => {
    seed();
    const res = await pageData({ page: 'calendars', user_id: 8880004, locale: 'en', initData: initDataFor(8880004) });
    const body = await fullBody(res);
    assert(body.includes('notNative'), `status ${res.status} ${await bodyOf(res)}`);
    assert(!body.includes('CAL-SECRET'), `the notice carries calendars: ${await bodyOf(res)}`);
  });

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

// Smoke test for the two signed hand-offs that used to trust a bare user_id: the Google
// OAuth state and the share-story weather image. /refresh-token created an OAuth state
// for any user_id with no credential, and the callback wrote the Google token by
// telegramId; now /api/oauth/start creates the state only for a proved user, marks it
// with a u1_ prefix, and the callback writes by DB id. weather-image/sign signed a URL
// for any user_id given anyone's initData, and the signature left out source and msg;
// now it is bound to the proved user and covers both. Also: check-token-refresh on a
// WhatsApp session.
//
// Review fixes (#10-#13): /refresh-token is reached from the dashboard by a full page load
// (a different root layout) with no #tgWebAppData hash, so it needs the Telegram SDK of
// its own and an initData reader that falls back to the SDK's sessionStorage copy;
// check-token-refresh takes initData in a header, never the URL; and with no credential
// the page says what PageGate says, Telegram hint included.
//
// The pages, the routes, user-service and the signing run for real. Faked at the
// boundaries: Prisma (in memory), Redis (in memory), the rate limiter (always allows),
// Telegram and messaging (record every send), error capture, and fetch (the Google token
// endpoint answers with a test token; anything else is blocked). No network, no DB.
//
// Checks named [guard] already pass before the fix and must keep passing. The others
// fail until the fix lands. Numbers follow the design's smoke list.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-oauth-weather.ts

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

/** JSON that can show a BigInt telegramId. */
const show = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));

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
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BOTH_SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events';
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
  // Google's token endpoint grants a refresh token with both calendar scopes.
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    googleCalls.push(url);
    if (url === GOOGLE_TOKEN_URL) {
      return new Response(JSON.stringify({ refresh_token: 'google-rt-new', scope: BOTH_SCOPES, access_token: 'test' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`network blocked in smoke: ${url}`);
  }) as typeof fetch;
}

// ---- Fixtures ----

const DAY = 86_400_000;

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
 * 9 = Telegram user 111111111. 42 = WhatsApp-only (DB id 42). 7 = a Telegram user whose
 * telegramId is 42, the WhatsApp user's DB id.
 */
function seed() {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  prismaCalls.length = 0;
  userWrites.length = 0;
  googleCalls.length = 0;
  sent.length = 0;
  captured.length = 0;
  DB.user = [
    baseUser({ id: 9, name: 'Tal', telegramId: BigInt(111111111) }),
    baseUser({ id: 42, name: 'WA-User', messagingPlatform: 'whatsapp', whatsappBsuid: 'IL.123' }),
    baseUser({ id: 7, name: 'Victim', telegramId: BigInt(42) }),
  ];
  DB.oAuthState = [];
  DB.nativeCalendar = [{
    id: 'cal-42', ownerUserId: 42, name: 'WA calendar', color: '#336699', labels: ['primary'], privacy: 'PRIVATE',
    isDeleted: false, personName: null, personEnglishName: null, personGender: null, rules: [], createdAt: new Date(Date.now() - 9 * DAY),
  }];
}

const writesHitting = (id: number) => userWrites.filter(w => w.hit.includes(id));

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

/** Run the OAuth callback page as Next does; its success path ends in a redirect, which throws. */
async function runCallback(state: string): Promise<string> {
  const page = (await load('app/oauth-callback/page.tsx')).default;
  try {
    await page({ searchParams: Promise.resolve({ code: 'test-code', state }) });
    return 'rendered a page';
  } catch (err) {
    return String((err as Row)?.digest ?? (err instanceof Error ? err.message : err));
  }
}

async function main() {
  installStubs();

  const { NextRequest } = nodeRequire('next/server');
  const { createSessionToken } = await load('src/lib/session-auth.ts');
  const waCookie = `famcal_session=${createSessionToken(42)}`;

  const req = (url: string, o: { body?: unknown; cookie?: string } = {}) =>
    new NextRequest(url.startsWith('http') ? url : `http://localhost${url}`, {
      method: o.body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(o.cookie ? { cookie: o.cookie } : {}) },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
  const oauthStart = async (body: Row, cookie?: string): Promise<Response> => {
    const { POST } = await load('app/api/oauth/start/route.ts');
    return POST(req('/api/oauth/start', { body, cookie }));
  };
  /** initData goes in the X-Telegram-Init-Data header, as share-story sends it. */
  const sign = async (query: string, initData?: string): Promise<Response> => {
    const { GET } = await load('app/api/weather-image/sign/route.ts');
    const request = req(`/api/weather-image/sign?${query}`);
    if (initData) request.headers.set('x-telegram-init-data', initData);
    return GET(request);
  };

  // ---- Google OAuth state ----

  await check('#1 the /refresh-token page creates no OAuth state', async () => {
    seed();
    const page = (await load('app/refresh-token/page.tsx')).default;
    await page({ searchParams: Promise.resolve({ user_id: '111111111' }) });
    const creates = prismaCalls.filter(c => c === 'oAuthState.create');
    assert(creates.length === 0 && DB.oAuthState.length === 0, `OAuth states created: ${show(DB.oAuthState)}`);
  });

  await check('#2 oauth/start with no credential is 401 and creates no state', async () => {
    seed();
    const res = await oauthStart({ user_id: 42 });
    assert(res.status === 401, `status ${res.status} ${await bodyOf(res)}`);
    assert(DB.oAuthState.length === 0, `OAuth states created: ${show(DB.oAuthState)}`);
  });

  let startedState: string | null = null;
  await check('#3 oauth/start on the WA cookie: a state {userId: 42n, token u1_...} and its OAuth URL', async () => {
    seed();
    const res = await oauthStart({ user_id: 42 }, waCookie);
    assert(res.status === 200, `status ${res.status} ${await bodyOf(res)}`);
    assert(DB.oAuthState.length === 1, `OAuth states: ${show(DB.oAuthState)}`);
    const st = DB.oAuthState[0];
    assert(String(st.userId) === '42' && /^u1_/.test(st.token), `state ${show(st)}`);
    assert(st.expiresAt instanceof Date && st.expiresAt.getTime() > Date.now(), `state expiresAt ${show(st.expiresAt)}`);
    const { oauthUrl } = await res.clone().json();
    assert(typeof oauthUrl === 'string' && new URL(oauthUrl).searchParams.get('state') === st.token, `oauthUrl ${oauthUrl}`);
    startedState = st.token;
  });

  await check('#4 the callback with a u1_ state for user 42 parks the Google token for owner 42, never row 7, and writes no user', async () => {
    seed();
    // The state #3 created, or the same shape when oauth/start is missing.
    const token = startedState ?? `u1_${crypto.randomBytes(32).toString('hex')}`;
    DB.oAuthState.push({ id: 'st-42', userId: BigInt(42), token, createdAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60_000) });
    const ended = await runCallback(token);
    // The token waits for the owner's claim (smoke-google-connect.ts covers the claim)
    const parked = [...redisStore.entries()].filter(([k]) => k.startsWith('oauth:pending:')).map(([, v]) => JSON.parse(v));
    assert(parked.length === 1 && parked[0].ownerUserId === 42, `ended with ${ended}; parked: ${show(parked)}; ${captured.join(' | ')}`);
    assert(writesHitting(7).length === 0 && userWrites.length === 0, `user writes: ${show(userWrites.map(w => ({ where: w.where, hit: w.hit })))}`);
  });

  await check('#5 the callback with a legacy state (no u1_ prefix) writes no user', async () => {
    seed();
    const token = crypto.randomBytes(32).toString('hex');
    DB.oAuthState.push({ id: 'st-old', userId: BigInt(111111111), token, createdAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60_000) });
    const ended = await runCallback(token);
    assert(userWrites.length === 0, `ended with ${ended}; user writes: ${show(userWrites.map(w => ({ where: w.where, hit: w.hit })))}`);
  });

  // ---- weather-image signing ----

  await check('#6 sign ?user_id=42 with initData for Telegram 111111111 (DB 9) is 401', async () => {
    seed();
    const res = await sign('user_id=42&source=summary', initDataFor(111111111));
    assert(res.status === 401, `status ${res.status} ${await bodyOf(res)}`);
  });

  let signedUrl = '';
  await check('#7 [guard] sign ?user_id=9 with the user\'s own initData is 200', async () => {
    seed();
    const res = await sign('user_id=9&source=summary&msg=5', initDataFor(111111111));
    assert(res.status === 200, `status ${res.status} ${await bodyOf(res)}`);
    const { url } = await res.clone().json();
    assert(typeof url === 'string' && url.includes('sig='), `url ${url}`);
    signedUrl = url;
  });

  await check('#8 the signed URL with msg or source changed is 401 (the untouched one still works)', async () => {
    seed();
    assert(signedUrl, 'no signed URL from #7');
    redisStore.set('story:text:9:5', 'Summary five: 08:00 dentist');
    redisStore.set('story:text:9:7', 'Summary seven: someone else\'s day');
    redisStore.set('story:img:9', Buffer.from('cached image').toString('base64'));
    const { GET } = await load('app/api/weather-image/route.ts');
    const fetchImage = (mutate: (u: URL) => void) => {
      const u = new URL(signedUrl);
      mutate(u);
      return GET(req(`http://localhost/api/weather-image?${u.searchParams.toString()}`)) as Promise<Response>;
    };
    const untouched = await fetchImage(() => undefined);
    assert(untouched.status === 200, `the untouched URL got ${untouched.status} ${await bodyOf(untouched)}`);
    const msg = await fetchImage(u => u.searchParams.set('msg', '7'));
    assert(msg.status === 401, `msg changed to 7: status ${msg.status}`);
    const source = await fetchImage(u => u.searchParams.set('source', 'cached'));
    assert(source.status === 401, `source changed to cached: status ${source.status}`);
  });

  await check('#8b sign takes initData from the X-Telegram-Init-Data header, never the URL: the user\'s own initData in the query is 401', async () => {
    seed();
    const res = await sign(`user_id=9&source=summary&msg=5&initData=${encodeURIComponent(initDataFor(111111111))}`);
    assert(res.status === 401, `initData in the query string: status ${res.status} (want 401)`);
  });

  // ---- check-token-refresh ----

  await check('#9 check-token-refresh on the WA cookie is 200 and reads row 42 (refreshed), not row 7', async () => {
    seed();
    // Row 42 just got a token; row 7 (telegramId 42) has none.
    const row42 = DB.user.find(u => u.id === 42) as Row;
    row42.googleRefreshToken = 'google-rt-42';
    row42.updatedAt = new Date();
    const { GET } = await load('app/api/check-token-refresh/route.ts');
    const res = await GET(req(`/api/check-token-refresh?user_id=42&since=${Date.now() - 60_000}`, { cookie: waCookie }));
    assert(res.status === 200, `status ${res.status} ${await bodyOf(res)}`);
    const body = await res.clone().json();
    assert(body.refreshed === true, `body ${await bodyOf(res)} (row 7 has no token, row 42 has a fresh one)`);
  });

  // ---- /refresh-token inside Telegram (review fixes) ----

  const SDK = 'https://telegram.org/js/telegram-web-app.js';
  const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  await check('#10 /refresh-token has a root layout that loads the Telegram SDK before hydration; no inline-URL <script>', async () => {
    const layout = (await load('app/refresh-token/layout.tsx')).default;
    const tree = layout({ children: 'PAGE' }) as Row;
    const elements: Row[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      elements.push(node as Row);
      walk((node as Row).props?.children);
    };
    walk(tree);
    assert(tree.type === 'html' && elements.some(e => e.type === 'body'), `layout root: ${String(tree.type)}`);
    const sdk = elements.find(e => e.props?.src === SDK);
    assert(sdk && sdk.props.strategy === 'beforeInteractive', `SDK script: ${show(sdk?.props ?? null)}`);
    // The old tag: a <script> whose body was the URL text, which loads nothing
    assert(!/__html:\s*`https:\/\/telegram\.org/.test(readSource('app/refresh-token/RefreshTokenClient.tsx')),
      'RefreshTokenClient still renders the inline <script> whose body is the SDK URL');
  });

  await check('#11 dashboard -> /refresh-token (full load, SDK not run yet, no hash): initData comes from the SDK\'s sessionStorage copy and oauth/start accepts it', async () => {
    seed();
    const launch = initDataFor(111111111);
    const store = new Map<string, string>();
    const fakeWindow: Row = {
      location: { hash: '' },
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); } },
    };
    const g = globalThis as Row;
    const reads: Record<string, string> = {};
    try {
      g.window = fakeWindow;
      const { readInitData } = await load('src/lib/read-init-data.ts');
      reads.browser = readInitData();
      fakeWindow.location.hash = `#tgWebAppData=${encodeURIComponent(launch)}&tgWebAppVersion=8.0`;
      reads.directLaunch = readInitData();
      // The dashboard's SDK stored its launch params; /refresh-token loads with no hash
      fakeWindow.location.hash = '';
      store.set('__telegram__initParams', JSON.stringify({ tgWebAppData: launch, tgWebAppVersion: '8.0', tgWebAppPlatform: 'ios' }));
      reads.afterFullLoad = readInitData();
      fakeWindow.Telegram = { WebApp: { initData: 'from-sdk' } };
      reads.sdk = readInitData();
    } finally {
      delete g.window;
    }
    assert(reads.browser === '', `a plain browser read ${show(reads.browser)}`);
    assert(reads.directLaunch === launch, `a direct launch read ${show(reads.directLaunch)}`);
    assert(reads.sdk === 'from-sdk', `with the SDK loaded it read ${show(reads.sdk)}`);
    assert(reads.afterFullLoad === launch, `after the full page load it read ${show(reads.afterFullLoad)}`);
    const res = await oauthStart({ user_id: '111111111', initData: reads.afterFullLoad });
    assert(res.status === 200, `oauth/start: status ${res.status} ${await bodyOf(res)}`);
    assert(DB.oAuthState.length === 1 && String(DB.oAuthState[0].userId) === '9', `OAuth states: ${show(DB.oAuthState)}`);
    for (const rel of ['app/refresh-token/RefreshTokenClient.tsx', 'app/[locale]/PageGate.tsx']) {
      assert(readSource(rel).includes("from '@/src/lib/read-init-data'"), `${rel} does not use the shared initData reader`);
    }
  });

  await check('#12 check-token-refresh takes initData from the X-Telegram-Init-Data header, not the URL', async () => {
    seed();
    const row9 = DB.user.find(u => u.id === 9) as Row;
    row9.googleRefreshToken = 'google-rt-9';
    row9.updatedAt = new Date();
    const { GET } = await load('app/api/check-token-refresh/route.ts');
    const url = `http://localhost/api/check-token-refresh?user_id=111111111&since=${Date.now() - 60_000}`;
    const viaHeader: Response = await GET(new NextRequest(url, { headers: { 'x-telegram-init-data': initDataFor(111111111) } }));
    assert(viaHeader.status === 200, `header: status ${viaHeader.status} ${await bodyOf(viaHeader)}`);
    assert((await viaHeader.clone().json()).refreshed === true, `header: ${await bodyOf(viaHeader)}`);
    const viaQuery: Response = await GET(new NextRequest(`${url}&initData=${encodeURIComponent(initDataFor(111111111))}`));
    assert(viaQuery.status === 401, `initData in the query string: status ${viaQuery.status} (want 401)`);
    const poll = readSource('app/refresh-token/RefreshTokenClient.tsx').match(/fetch\(`\/api\/check-token-refresh[^`]*`/)?.[0] ?? '';
    assert(poll && !poll.includes('initData'), `the client's poll URL: ${poll || '(not found)'}`);
  });

  await check('#13 /refresh-token with no credential says what the gate says: browser = expired link + Telegram hint; Telegram = reopen from the bot', async () => {
    seed();
    (DB.user.find(u => u.id === 9) as Row).language = 'he';
    const page = (await load('app/refresh-token/page.tsx')).default;
    const el = (await page({ searchParams: Promise.resolve({ user_id: '111111111' }) })) as Row;
    const t = el?.props?.translations as Row;
    const he = JSON.parse(readSource('messages/he.json'));
    const { startErrorLines } = await load('app/refresh-token/RefreshTokenClient.tsx');
    assert(typeof startErrorLines === 'function', 'RefreshTokenClient exports no startErrorLines');
    const browser: string[] = startErrorLines(401, '', t);
    assert(browser.includes(he.pageGate.browserBody) && browser.includes(he.pageGate.browserTelegramHint),
      `in a browser (401, no initData): ${show(browser)}`);
    const telegram: string[] = startErrorLines(401, 'initData', t);
    assert(telegram.includes(he.pageGate.telegramBody) && !telegram.includes(he.pageGate.browserBody),
      `inside Telegram (401): ${show(telegram)}`);
    const failed: string[] = startErrorLines(500, '', t);
    assert(failed.length === 1 && failed[0] === he.refreshToken.startFailed, `on a 500: ${show(failed)}`);
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

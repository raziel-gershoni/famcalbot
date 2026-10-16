// Smoke test for who a Mini App API request acts on. A request proves its user one of
// two ways: Telegram initData, where user_id is the telegramId (or, from an old button,
// that user's own DB id), or the WhatsApp magic-link cookie, where user_id is the DB id.
// The route must act on the row that credential proved, never on a row that only shares
// the number. Also covers the 24h initData window, suspended users, the one-use magic
// token, the Telegram link builders, and the rate-limit bucket (one per proved user).
//
// The routes, user-service, pairing-service, subscription-service, session-auth,
// telegram-auth and magic-link run for real. Faked at the boundaries: Prisma (in memory),
// Redis (in memory), the rate limiter (records each key; allows unless a check says no),
// Telegram and messaging (record every send), error capture, Next's after() (queued, then
// run), and fetch (blocked).
// No network, no DB.
//
// Checks named [guard] already pass before the fix and must keep passing. The others
// fail until the fix lands. Numbers follow the design's smoke list.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-auth-identity.ts

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
const commandRuns: { command: string; chatId: unknown; platform: unknown }[] = [];
const captured: string[] = [];
/** Every rate-limit check: the limiter's name and the key it was given. */
const rateChecks: { limiter: string; key: string }[] = [];
/** When false the fake limiter says no, as a spent bucket does. */
let rateAllow = true;

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

const afterQueue: (() => unknown)[] = [];
async function drainAfter() {
  while (afterQueue.length) await afterQueue.shift()!();
}

function installStubs(messagingTypes: Row) {
  // A stub goes into require's cache (static imports) and is served to import() by a
  // load hook (the code also does `await import('@/src/utils/prisma')` and the like).
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
  const stub = (rel: string, exports: Row) => {
    const filename = path.join(ROOT, rel);
    stubs[filename] = exports;
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  stub('src/utils/prisma.ts', { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() });
  stub('src/utils/redis.ts', { redis: fakeRedis });
  stub('src/lib/rate-limit.ts', {
    settingsRateLimiter: { name: 'settings' }, commandRateLimiter: { name: 'command' }, generalRateLimiter: { name: 'general' },
    // The real checkRateLimit hands String(identifier) to limiter.limit(): record that key.
    checkRateLimit: async (limiter: Row, identifier: string | number) => {
      rateChecks.push({ limiter: String(limiter?.name), key: String(identifier) });
      return { success: rateAllow, limit: 99, remaining: rateAllow ? 99 : 0, reset: 0 };
    },
    getRateLimitHeaders: () => ({}),
  });
  const capture = (e: unknown, ctx: string) => { captured.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`); };
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
  const bot = recorder('telegram', 'bot');
  const tgService = recorder('telegram', 'tg');
  const runner = (command: string) => async (chatId: unknown, _userId: unknown, platform: unknown) => {
    commandRuns.push({ command, chatId, platform });
  };
  const telegram = {
    getBot: () => bot,
    initBot: () => bot,
    getMessagingService: () => tgService,
    setUserMenuButton: async (chatId: unknown, language: unknown) => {
      sent.push({ via: 'setUserMenuButton', platform: 'telegram', chatId, text: String(language) });
    },
    handleSummaryCommand: runner('summary'),
    handleWeatherCommand: runner('weather'),
    handleLookaheadCommand: runner('lookahead'),
    handleNextWeekCommand: runner('nextweek'),
  };
  stub('src/services/telegram/index.ts', telegram);
  stub('src/services/telegram/bot.ts', telegram);
  const messaging = {
    ...messagingTypes,
    getMessagingService: (platform: unknown) => recorder(String(platform), String(platform)),
    getTelegramService: () => recorder('telegram', 'telegram'),
    getWhatsAppService: () => recorder('whatsapp', 'whatsapp'),
    detectPlatform: () => 'telegram',
  };
  stub('src/services/messaging/index.ts', messaging);
  stub('src/services/messaging/factory.ts', messaging);

  // Next's after() needs a live request scope; queue the task and run it after the response.
  const nextServer = nodeRequire('next/server');
  nextServer.after = (task: unknown) => {
    afterQueue.push(typeof task === 'function' ? (task as () => unknown) : () => task);
  };

  globalThis.fetch = (async (input: unknown) => {
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
    createdAt: new Date(Date.now() - 30 * DAY), updatedAt: new Date(Date.now() - DAY),
    ...o,
  };
}

/**
 * 9 = Telegram user 111111111. 42 = WhatsApp-only, BSUID only (no phone). 1 = NATIVE
 * Telegram user with an open invite. 3 = no channel at all. With `collision`, 7 is a
 * Telegram user whose telegramId is 42, the WhatsApp user's DB id.
 */
function seed(opts: { collision?: boolean } = {}) {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  prismaCalls.length = 0;
  userWrites.length = 0;
  sent.length = 0;
  commandRuns.length = 0;
  captured.length = 0;
  afterQueue.length = 0;
  rateChecks.length = 0;
  rateAllow = true;
  DB.user = [
    baseUser({ id: 9, name: 'Tal', telegramId: BigInt(111111111) }),
    baseUser({ id: 42, name: 'WA-User', messagingPlatform: 'whatsapp', whatsappBsuid: 'IL.123' }),
    baseUser({ id: 1, name: 'Dana', telegramId: BigInt(5550001), language: 'he' }),
    baseUser({ id: 3, name: 'No-Channel' }),
  ];
  if (opts.collision) DB.user.push(baseUser({ id: 7, name: 'Victim', telegramId: BigInt(42) }));
  DB.pairingInvite = [{
    id: 'inv-1', token: INVITE_TOKEN, inviterUserId: 1, expiresAt: new Date(Date.now() + 6 * DAY),
    acceptedAt: null, acceptedByUserId: null, revokedAt: null, createdAt: new Date(Date.now() - DAY),
  }];
  const cal = (id: string, ownerUserId: number, name: string): Row => ({
    id, ownerUserId, name, color: '#336699', labels: ['primary'], privacy: 'PRIVATE', isDeleted: false,
    personName: null, personEnglishName: null, personGender: null, rules: [], createdAt: new Date(Date.now() - 9 * DAY),
  });
  DB.nativeCalendar = [cal('cal-42', 42, 'WA calendar'), cal('cal-1', 1, 'Dana calendar'), cal('cal-9', 9, 'Tal calendar')];
}

const userRow = (id: number) => DB.user.find(u => u.id === id) as Row;
const writesHitting = (id: number) => userWrites.filter(w => w.hit.includes(id));

/** Valid Telegram initData for a Telegram user id, signed with the bot token, `ageSec` old. */
function initDataFor(tgId: number, ageSec = 0): string {
  const params: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000) - ageSec),
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

async function main() {
  installStubs(await load('src/services/messaging/types.ts'));

  const { NextRequest } = nodeRequire('next/server');
  const { createSessionToken } = await load('src/lib/session-auth.ts');
  const waCookie = `famcal_session=${createSessionToken(42)}`;

  const req = (url: string, o: { method?: string; body?: unknown; cookie?: string } = {}) =>
    new NextRequest(`http://localhost${url}`, {
      method: o.method ?? (o.body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', ...(o.cookie ? { cookie: o.cookie } : {}) },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });

  const settingsBody = { language: 'he', location: 'Haifa', messagingPlatform: 'whatsapp', textSummaryEnabled: true };
  const postSettings = async (userId: string | number, extra: { cookie?: string; initData?: string } = {}) => {
    const { POST } = await load('app/api/settings/route.ts');
    const body = extra.initData ? { location: 'Haifa', initData: extra.initData } : settingsBody;
    return POST(req(`/api/settings?user_id=${userId}`, { body, cookie: extra.cookie })) as Promise<Response>;
  };

  // ---- Settings: which row a save writes ----

  await check('#1 settings: WA cookie with ?user_id=42 saves row 42 (200, update where {id:42})', async () => {
    seed();
    const res = await postSettings(42, { cookie: waCookie });
    assert(res.status === 200, `status ${res.status} ${await bodyOf(res)}; ${captured.join(' | ')}`);
    const w = userWrites.find(x => x.method === 'update' && x.where.id === 42 && x.where.telegramId === undefined);
    assert(w, `user writes: ${show(userWrites.map(x => x.where))}`);
    assert(userRow(42).location === 'Haifa', `row 42 location is ${userRow(42).location}`);
  });

  await check('#2 settings: WA cookie for DB id 42 leaves row 7 (telegramId 42) untouched', async () => {
    seed({ collision: true });
    const before = show(userRow(7));
    await postSettings(42, { cookie: waCookie });
    assert(writesHitting(7).length === 0, `row 7 written: ${show(writesHitting(7))}`);
    assert(show(userRow(7)) === before, `row 7 changed to ${show(userRow(7))}`);
    const menu = sent.filter(s => s.via === 'setUserMenuButton' && Number(s.chatId) === 42);
    assert(menu.length === 0, `menu button set on Telegram chat 42 (row 7): ${show(menu)}`);
  });

  await check('#3 [guard] settings: TG initData 111111111 with ?user_id=111111111 saves row 9', async () => {
    seed();
    const res = await postSettings(111111111, { initData: initDataFor(111111111) });
    assert(res.status === 200, `status ${res.status} ${await bodyOf(res)}`);
    assert(userRow(9).location === 'Haifa', `row 9 location is ${userRow(9).location}`);
  });

  await check('#4 settings: TG initData 111111111 with ?user_id=9 (old DB-id button) saves row 9', async () => {
    seed();
    const res = await postSettings(9, { initData: initDataFor(111111111) });
    assert(res.status === 200, `status ${res.status} ${await bodyOf(res)}`);
    assert(userRow(9).location === 'Haifa', `row 9 location is ${userRow(9).location}`);
  });

  await check('#5 [guard] settings: WA cookie 42 with ?user_id=7 is 401 and writes nothing', async () => {
    seed({ collision: true });
    const res = await postSettings(7, { cookie: waCookie });
    assert(res.status === 401, `status ${res.status} ${await bodyOf(res)}`);
    assert(userWrites.length === 0, `writes: ${show(userWrites)}`);
  });

  await check('#6 [guard] settings: TG initData 111111111 with ?user_id=42 is 401 and writes nothing', async () => {
    seed();
    const res = await postSettings(42, { initData: initDataFor(111111111) });
    assert(res.status === 401, `status ${res.status} ${await bodyOf(res)}`);
    assert(userWrites.length === 0, `writes: ${show(userWrites)}`);
  });

  // ---- The other routes, on a WhatsApp session ----

  await check('#7 select-calendars: WA cookie saves with update where {id:42}', async () => {
    seed();
    const { POST } = await load('app/api/select-calendars/route.ts');
    const calendarAssignments = [{ calendarId: 'wa@example.com', labels: ['primary', 'yours'], name: 'Me', color: '#000000' }];
    const res = await POST(req('/api/select-calendars?user_id=42', { body: { calendarAssignments }, cookie: waCookie }));
    const w = userWrites.find(x => x.method === 'update' && x.where.id === 42 && 'calendarAssignments' in x.data);
    assert(w, `status ${res.status} ${await bodyOf(res)}; user writes: ${show(userWrites.map(x => x.where))}`);
    assert(res.status === 200, `status ${res.status} ${await bodyOf(res)}`);
  });

  await check('#8 native-calendars GET: WA cookie lists row 42\'s own calendar (200)', async () => {
    seed();
    const { GET } = await load('app/api/native-calendars/route.ts');
    const res = await GET(req('/api/native-calendars?user_id=42', { cookie: waCookie }));
    assert(res.status === 200, `status ${res.status} ${await bodyOf(res)}`);
    const body = await fullBody(res);
    assert(body.includes('"cal-42"') && !body.includes('"cal-9"'), `calendars: ${body}`);
  });

  await check('#9 pair GET and pair/invite POST: WA cookie gets 200, the invite is row 42\'s', async () => {
    seed();
    const pair = await load('app/api/pair/route.ts');
    const invite = await load('app/api/pair/invite/route.ts');
    const r1 = await pair.GET(req('/api/pair?user_id=42', { cookie: waCookie }));
    assert(r1.status === 200, `pair GET status ${r1.status} ${await bodyOf(r1)}`);
    const r2 = await invite.POST(req('/api/pair/invite?user_id=42', { body: {}, cookie: waCookie }));
    assert(r2.status === 200, `pair/invite POST status ${r2.status} ${await bodyOf(r2)}`);
    assert(DB.pairingInvite.some(i => i.inviterUserId === 42), `invites: ${show(DB.pairingInvite.map(i => i.inviterUserId))}`);
  });

  await check('#10 pair/accept: WA cookie accepts as user 42 (acceptInvite(token, 42))', async () => {
    seed();
    const { POST } = await load('app/api/pair/accept/route.ts');
    const res = await POST(req('/api/pair/accept?user_id=42', { body: { token: INVITE_TOKEN }, cookie: waCookie }));
    const inv = DB.pairingInvite.find(i => i.token === INVITE_TOKEN) as Row;
    assert(inv.acceptedByUserId === 42, `status ${res.status} ${await bodyOf(res)}; acceptedByUserId=${inv.acceptedByUserId}`);
    assert(res.status === 200, `status ${res.status} ${await bodyOf(res)}`);
  });

  // ---- Where a command's answer goes ----

  await check('#11 resolveCommandTarget: WA session -> WhatsApp bsuid, TG -> 111111111, no channel -> null', async () => {
    seed();
    const { resolveCommandTarget } = await load('src/lib/command-target.ts');
    const { getUserById } = await load('src/services/user-service.ts');
    const wa = await resolveCommandTarget(await getUserById(42), 'session');
    assert(wa?.platform === 'whatsapp' && wa.chatId === 'IL.123', `WA session user: ${show(wa)}`);
    const tg = await resolveCommandTarget(await getUserById(9), 'telegram');
    assert(tg?.platform === 'telegram' && tg.chatId === 111111111, `TG user: ${show(tg)}`);
    const none = await resolveCommandTarget(await getUserById(3), 'session');
    assert(none === null, `user with no channel: ${show(none)}`);
  });

  await check('#12 execute-command: a BSUID-only WA session never streams to Telegram chat 42; the summary runs on WA', async () => {
    seed();
    const { POST } = await load('app/api/execute-command/route.ts');
    const res = await POST(req('/api/execute-command', { body: { user_id: 42, command: 'summary' }, cookie: waCookie }));
    await drainAfter();
    const toChat42 = sent.filter(s => s.platform === 'telegram' && Number(s.chatId) === 42);
    assert(toChat42.length === 0, `Telegram calls to chat 42: ${show(toChat42)}`);
    const run = commandRuns.find(r => r.command === 'summary');
    assert(run?.chatId === 'IL.123' && run.platform === 'whatsapp', `summary ran as ${show(run)}; status ${res.status} ${await bodyOf(res)}`);
    assert(res.status === 200, `status ${res.status} ${await bodyOf(res)}`);
  });

  // ---- Feedback, subscription ----

  await check('#13 feedback: WA cookie with user_id 42 is 200 and stored for user 42', async () => {
    seed();
    const { POST } = await load('app/api/feedback/route.ts');
    const res = await POST(req('/api/feedback', { body: { text: 'The weekly view is great, thanks!', user_id: 42 }, cookie: waCookie }));
    assert(res.status === 200, `status ${res.status} ${await bodyOf(res)}`);
    assert((DB.userFeedback ?? []).some(f => f.userId === 42), `feedback rows: ${show(DB.userFeedback)}`);
  });

  await check('#14 subscription/upgrade: WA-only user gets 400 "linked Telegram"', async () => {
    seed();
    const { POST } = await load('app/api/subscription/upgrade/route.ts');
    const res = await POST(req('/api/subscription/upgrade', { body: { user_id: 42, plan: 'PRO' }, cookie: waCookie }));
    const body = await fullBody(res);
    assert(res.status === 400 && /linked Telegram/.test(body), `status ${res.status} ${body}`);
  });

  await check('#15 subscription/upgrade: TG initData with user_id=9 sends the invoice to chat 111111111', async () => {
    seed();
    const { POST } = await load('app/api/subscription/upgrade/route.ts');
    const res = await POST(req('/api/subscription/upgrade', { body: { user_id: 9, plan: 'PRO', initData: initDataFor(111111111) } }));
    const invoices = sent.filter(s => s.via === 'bot.sendInvoice');
    assert(invoices.length === 1 && Number(invoices[0].chatId) === 111111111,
      `status ${res.status} ${await bodyOf(res)}; invoices: ${show(invoices)}`);
  });

  await check('#16 GET /api/subscription with no credential is 401', async () => {
    seed();
    const { GET } = await load('app/api/subscription/route.ts');
    const res = await GET(req('/api/subscription?user_id=42'));
    assert(res.status === 401, `status ${res.status} ${await bodyOf(res)}`);
  });

  // ---- Suspension and the initData window ----

  await check('#17 suspended users get 403, on the WA session and on Telegram', async () => {
    seed();
    userRow(42).suspendedAt = new Date(Date.now() - DAY);
    const wa = await postSettings(42, { cookie: waCookie });
    assert(wa.status === 403, `WA status ${wa.status} ${await bodyOf(wa)}`);
    userRow(9).suspendedAt = new Date(Date.now() - DAY);
    const tg = await postSettings(111111111, { initData: initDataFor(111111111) });
    assert(tg.status === 403, `TG status ${tg.status} ${await bodyOf(tg)}`);
    assert(userWrites.length === 0, `a suspended user's save was written: ${show(userWrites)}`);
  });

  await check('#18 initData 30 minutes old still saves (200)', async () => {
    seed();
    const res = await postSettings(111111111, { initData: initDataFor(111111111, 30 * 60) });
    assert(res.status === 200, `status ${res.status} ${await bodyOf(res)}`);
  });

  await check('#19 [guard] initData 25 hours old is 401', async () => {
    seed();
    const res = await postSettings(111111111, { initData: initDataFor(111111111, 25 * 3600) });
    assert(res.status === 401, `status ${res.status} ${await bodyOf(res)}`);
    assert(userWrites.length === 0, `writes: ${show(userWrites)}`);
  });

  // ---- Magic link: one use ----

  await check('#21 two concurrent validateMagicToken calls on one token: exactly one gets the data', async () => {
    seed();
    const { generateMagicLink, validateMagicToken } = await load('src/services/magic-link.ts');
    const token = new URL(await generateMagicLink(42, 'en')).searchParams.get('token');
    assert(token, 'no token in the magic link');
    const got = (await Promise.all([validateMagicToken(token), validateMagicToken(token)])).filter(Boolean);
    assert(got.length === 1, `${got.length} calls got the data: ${show(got)}`);
    assert(got[0].userId === 42, `data: ${show(got[0])}`);
  });

  // ---- Telegram link builders carry the telegramId ----

  await check('#22 the §3.6 link builders no longer put the DB id in user_id', () => {
    const files = [
      'src/cron/handlers.ts',
      'src/services/voice/handler.ts',
      'src/services/forward-event/handler.ts',
      'src/services/image-event/handler.ts',
      'src/services/kid-name-callbacks.ts',
      'src/services/subscription-reminders.ts',
    ];
    const bad = /user_id=\$\{(?:user\.id|sub\.userId|pending\.userId)\}/;
    const found: string[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
      assert(lines.some(l => l.includes('user_id=${')), `${f} builds no user_id link any more`);
      lines.forEach((l, i) => { if (bad.test(l)) found.push(`${f}:${i + 1}`); });
    }
    assert(found.length === 0, `DB id in a Telegram link at ${found.join(', ')}`);
  });

  // ---- Rate limit: one bucket per proved user ----

  const keysOf = (limiter: string) => rateChecks.filter(c => c.limiter === limiter).map(c => c.key);

  await check('#23 rate limit: TG initData 111111111 with user_id 111111111, 0111111111, 9 and 09 all use bucket u9', async () => {
    seed();
    for (const userId of ['111111111', '0111111111', '9', '09']) {
      const res = await postSettings(userId, { initData: initDataFor(111111111) });
      assert(res.status === 200, `user_id=${userId}: status ${res.status} ${await bodyOf(res)}`);
    }
    assert(show(keysOf('settings')) === show(['u9', 'u9', 'u9', 'u9']), `rate checks: ${show(rateChecks)}`);
  });

  await check('#24 rate limit: WA cookie 42 with user_id 42 and 042 uses bucket u42, on settings and on execute-command', async () => {
    seed();
    for (const userId of ['42', '042']) {
      const res = await postSettings(userId, { cookie: waCookie });
      assert(res.status === 200, `user_id=${userId}: status ${res.status} ${await bodyOf(res)}`);
    }
    const { POST } = await load('app/api/execute-command/route.ts');
    const res = await POST(req('/api/execute-command', { body: { user_id: 42, command: 'summary' }, cookie: waCookie }));
    await drainAfter();
    assert(res.status === 200, `execute-command: status ${res.status} ${await bodyOf(res)}`);
    assert(show(keysOf('settings')) === show(['u42', 'u42']), `rate checks: ${show(rateChecks)}`);
    assert(show(keysOf('command')) === show(['u42']), `rate checks: ${show(rateChecks)}`);
  });

  await check('#25 rate limit: TG user 7 (telegramId 42) and WA user 42, both sending user_id=42, get separate buckets', async () => {
    seed({ collision: true });
    const tg = await postSettings(42, { initData: initDataFor(42) });
    assert(tg.status === 200, `TG: status ${tg.status} ${await bodyOf(tg)}`);
    const wa = await postSettings(42, { cookie: waCookie });
    assert(wa.status === 200, `WA: status ${wa.status} ${await bodyOf(wa)}`);
    assert(show(keysOf('settings')) === show(['u7', 'u42']), `rate checks: ${show(rateChecks)}`);
  });

  await check('#26 [guard] the limiter sees only proved users: 400, 401, 404 and 403 come first; a spent bucket is 429', async () => {
    seed();
    rateAllow = false;
    const { POST } = await load('app/api/settings/route.ts');
    const noId = await POST(req('/api/settings', { body: settingsBody, cookie: waCookie }));
    assert(noId.status === 400, `no user_id: status ${noId.status} ${await bodyOf(noId)}`);
    const wrongId = await postSettings(7, { cookie: waCookie });
    assert(wrongId.status === 401, `WA cookie 42 with user_id=7: status ${wrongId.status} ${await bodyOf(wrongId)}`);
    const noRow = await postSettings(222222222, { initData: initDataFor(222222222) });
    assert(noRow.status === 404, `TG user with no row: status ${noRow.status} ${await bodyOf(noRow)}`);
    userRow(9).suspendedAt = new Date(Date.now() - DAY);
    const suspended = await postSettings(111111111, { initData: initDataFor(111111111) });
    assert(suspended.status === 403, `suspended: status ${suspended.status} ${await bodyOf(suspended)}`);
    assert(rateChecks.length === 0, `the limiter was asked about a refused request: ${show(rateChecks)}`);
    const spent = await postSettings(42, { cookie: waCookie });
    assert(spent.status === 429, `spent bucket: status ${spent.status} ${await bodyOf(spent)}`);
    assert(userWrites.length === 0, `a refused save was written: ${show(userWrites)}`);
  });

  await check('#27 [guard] only src/lib/api-auth.ts calls a limiter, so no other key shares a bucket', () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(e.name) && /\bcheckRateLimit\(|RateLimiter\.limit\(/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) {
          callers.push(rel);
        }
      }
    };
    walk('app');
    walk('src');
    const others = callers.filter(f => f !== path.join('src', 'lib', 'rate-limit.ts') && f !== path.join('src', 'lib', 'api-auth.ts'));
    assert(others.length === 0, `a limiter is also called from ${others.join(', ')}`);
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

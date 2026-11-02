// The world the web sign-in smokes run in (smoke-signin-methods.ts, smoke-signin-calendar-match.ts): the real modules,
// with fakes at the boundaries only. Prisma and Upstash in memory (Prisma with the signInIdentity -> user relation the
// email lookups select; Upstash with the two Lua scripts the limits and countWithin run), Next's after() (queued, run by
// drainAfter()), the rate limiter (records nothing, allows), error capture (recorded), Telegram and WhatsApp (every
// send recorded, or refused on demand), the OIDC exchange (oidc.ts: scripted claims, the state checked as openid-client
// checks it), the calendar's Google account (google-sync/client.ts: scripted per refresh token), the admin notifier,
// and fetch (Resend answered and recorded; anything else blocked).
// Every console line is kept, so a smoke can check that no address, code or token reached one. No network, no DB.
// scripts/lib/ is not a smoke (ci-smokes.sh runs scripts/smoke-*.ts only).

import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export const ROOT = path.resolve(__dirname, '..', '..');
const nodeRequire = createRequire(__filename);
export const BASE = 'https://famcal.bot';
export const DAY = 86_400_000;

// Test values only (the fake env of ci-smokes.sh leaves these unset)
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.TELEGRAM_BOT_TOKEN ||= '000000:fake';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.NEXT_PUBLIC_APP_URL = BASE;
process.env.RESEND_API_KEY = 're_smoke_only';

// ---- Checks ----

export type Result = { name: string; ok: boolean; reason?: string };
export const results: Result[] = [];

export async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** JSON that can show a BigInt and survives a cycle. */
export function show(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
  } catch {
    return String(value);
  }
}

// ---- Console: every line is kept (this check's in `logs`, the whole run's in `everyLog`) ----

export const logs: string[] = [];
export const everyLog: string[] = [];
const realLog = console.log;
const lineOf = (args: unknown[]) => args.map(a => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : show(a))).join(' ');
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  console[level] = (...args: unknown[]) => {
    const line = lineOf(args);
    logs.push(line);
    everyLog.push(line);
  };
}

export function report(): never {
  let failed = 0;
  for (const r of results) {
    realLog(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  if (failed) realLog(`\nlog lines of the run:\n${everyLog.map(l => `  ${l}`).join('\n')}`);
  realLog(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

// ---- Fake Prisma: in-memory tables, any model ----

export const DB: Record<string, Row[]> = {};
export const prismaCalls: string[] = [];

const num = (x: unknown) => (x instanceof Date ? x.getTime() : Number(x));
function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') return a != null && b != null && String(a) === String(b);
  return a === b;
}
const isPlain = (v: unknown): v is Row => v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);

function matches(row: Row, where?: Row): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    if (k === 'AND') return ([] as Row[]).concat(cond).every(c => matches(row, c));
    if (k === 'OR') return (cond as Row[]).some(c => matches(row, c));
    if (k === 'NOT') return !([] as Row[]).concat(cond).some(c => matches(row, c));
    // A compound unique key (kind_subject, userId_kind): its fields, all of them
    if (isPlain(cond) && k.includes('_') && !(k in row)) return matches(row, cond);
    const v = row[k];
    if (isPlain(cond)) {
      if ('equals' in cond && !same(v ?? null, cond.equals)) return false;
      if ('in' in cond && !(cond.in as unknown[]).some(x => same(v, x))) return false;
      if ('notIn' in cond && (cond.notIn as unknown[]).some(x => same(v, x))) return false;
      if ('not' in cond && (isPlain(cond.not) ? matches(row, { [k]: cond.not }) : same(v ?? null, cond.not))) return false;
      if ('startsWith' in cond && !(typeof v === 'string' && v.startsWith(String(cond.startsWith)))) return false;
      if ('gt' in cond && !(v != null && num(v) > num(cond.gt))) return false;
      if ('gte' in cond && !(v != null && num(v) >= num(cond.gte))) return false;
      if ('lt' in cond && !(v != null && num(v) < num(cond.lt))) return false;
      if ('lte' in cond && !(v != null && num(v) <= num(cond.lte))) return false;
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

/** The relations the code under test reads through select/include (many-to-one, by the foreign key). */
const RELATIONS: Record<string, Record<string, { table: string; fk: string }>> = {
  signInIdentity: { user: { table: 'user', fk: 'userId' } },
};

/** A row as findUnique/findFirst/findMany answer it: `select` picks columns and relations, `include` adds relations. */
function shape(name: string, row: Row | undefined, args: Row): Row | null {
  if (!row) return null;
  const relations = RELATIONS[name] ?? {};
  const related = (key: string, arg: unknown): Row | null => {
    const { table, fk } = relations[key];
    const target = (DB[table] ?? []).find(r => same(r.id, row[fk]));
    if (!target) return null;
    return isPlain(arg) && isPlain(arg.select) ? pick(target, arg.select) : { ...target };
  };
  if (args.select) {
    const columns = Object.fromEntries(Object.entries(args.select).filter(([k]) => !(k in relations)));
    const out = pick(row, columns) as Row;
    for (const key of Object.keys(relations)) if (args.select[key]) out[key] = related(key, args.select[key]);
    return out;
  }
  const out = { ...row };
  for (const key of Object.keys(relations)) if (args.include?.[key]) out[key] = related(key, args.include[key]);
  return out;
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
    else if (isPlain(v) && 'set' in v) row[k] = v.set;
    else if (isPlain(v) && ('connect' in v || 'create' in v || 'disconnect' in v)) continue;
    else row[k] = v;
  }
}

/** The unique constraints Postgres would enforce, per model (a null column never collides). */
const UNIQUE: Record<string, string[][]> = {
  signInIdentity: [['kind', 'subject'], ['userId', 'kind']],
  user: [['telegramId'], ['whatsappPhone'], ['whatsappBsuid']],
};
function assertUnique(name: string, row: Row, all: Row[]) {
  for (const cols of UNIQUE[name] ?? []) {
    if (cols.some(c => row[c] == null)) continue;
    if (all.some(o => o !== row && cols.every(c => same(o[c], row[c])))) {
      throw Object.assign(new Error(`Unique constraint failed on the fields: (${cols.join(',')})`), { code: 'P2002' });
    }
  }
}

const DEFAULTS: Record<string, () => Row> = {
  signInIdentity: () => ({ lastUsedAt: null }),
};

function model(name: string): Row {
  const t = () => (DB[name] ??= []);
  const create = (data: Row): Row => {
    const now = new Date();
    const row: Row = { id: Math.max(0, ...t().map(r => Number(r.id) || 0)) + 1, createdAt: now, updatedAt: now, ...(DEFAULTS[name]?.() ?? {}) };
    applyData(row, data);
    assertUnique(name, row, t());
    t().push(row);
    return row;
  };
  const writeOne = (row: Row, data: Row) => {
    const next = { ...row };
    applyData(next, data);
    assertUnique(name, next, t().filter(r => r !== row));
    Object.assign(row, next);
    if ('updatedAt' in row) row.updatedAt = new Date();
  };
  const impl: Row = {
    findUnique: async (a: Row = {}) => shape(name, t().find(r => matches(r, a.where)), a),
    findFirst: async (a: Row = {}) => shape(name, sorted(t().filter(r => matches(r, a.where)), a.orderBy)[0], a),
    findMany: async (a: Row = {}) =>
      sorted(t().filter(r => matches(r, a.where)), a.orderBy).slice(0, a.take ?? undefined).map(r => shape(name, r, a)),
    count: async (a: Row = {}) => t().filter(r => matches(r, a.where)).length,
    create: async (a: Row) => pick(create(a.data), a.select),
    update: async (a: Row) => {
      const row = t().find(r => matches(r, a.where));
      if (!row) throw Object.assign(new Error(`No ${name} record was found for an update.`), { code: 'P2025' });
      writeOne(row, a.data);
      return pick(row, a.select);
    },
    // Checks and sets in one tick, as a single UPDATE ... WHERE does.
    updateMany: async (a: Row) => {
      const rows = t().filter(r => matches(r, a.where));
      rows.forEach(r => writeOne(r, a.data));
      return { count: rows.length };
    },
    upsert: async (a: Row) => {
      const row = t().find(r => matches(r, a.where));
      if (row) {
        writeOne(row, a.update);
        return pick(row, a.select);
      }
      return pick(create({ ...a.where, ...a.create }), a.select);
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
  };
  return Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, (...args: unknown[]) => { prismaCalls.push(`${name}.${k}`); return fn(...args); }]),
  );
}

const models: Record<string, Row> = {};
export const fakePrisma: Row = new Proxy({} as Row, {
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

// ---- Fake Upstash Redis (it parses JSON on read). An unknown command throws, so a smoke shows what it needs. ----

export const redisStore = new Map<string, string>();
/** The sets the capped-set Lua script (Task 3's Add email account limit) keeps; a set is no string, so it lives apart. */
const redisSets = new Map<string, Set<string>>();
const decode = (raw: string | undefined) => {
  if (raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return raw; }
};
const encode = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
const incrBy = (k: string, n: number) => {
  const next = Number(redisStore.get(k) ?? 0) + n;
  redisStore.set(k, String(next));
  return next;
};
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
  incr: async (k: string) => incrBy(k, 1),
  incrby: async (k: string, n: number) => incrBy(k, Number(n)),
  decr: async (k: string) => incrBy(k, -1),
  expire: async (k: string) => (redisStore.has(k) ? 1 : 0),
  pexpire: async (k: string) => (redisStore.has(k) ? 1 : 0),
  expireat: async (k: string) => (redisStore.has(k) ? 1 : 0),
  ttl: async (k: string) => (redisStore.has(k) ? 600 : -2),
  pttl: async (k: string) => (redisStore.has(k) ? 600_000 : -2),
  exists: async (...ks: unknown[]) => ks.flat().filter(k => redisStore.has(String(k))).length,
  mget: async (...ks: unknown[]) => ks.flat().map(k => decode(redisStore.get(String(k)))),
  scan: async (_cursor: unknown, o?: Row) => [0, [...redisStore.keys()].filter(k => !o?.match || glob(String(o.match)).test(k))],
  keys: async (pattern: string) => [...redisStore.keys()].filter(k => glob(pattern).test(k)),
  // The two Lua scripts the code under test runs (Task 3's limits, Task 5's countWithin): a counter, and a set with a
  // cap. The fake has no clock, so an expiry is not modelled; any other script throws, so a smoke shows what it needs.
  eval: async (script: string, keys: string[], args: string[]) => {
    const [key] = keys;
    if (script.includes("'SADD'")) {
      const set = redisSets.get(key) ?? new Set<string>();
      const added = !set.has(args[0]);
      set.add(args[0]);
      redisSets.set(key, set);
      if (added && set.size > Number(args[2])) {
        set.delete(args[0]);
        return 0;
      }
      return 1;
    }
    if (script.includes("'INCR'")) return incrBy(key, 1);
    throw new Error(`the fake Redis does not know this script: ${script.slice(0, 60)}`);
  },
};
const batch = () => {
  const ops: [string, unknown[]][] = [];
  const chain: Row = new Proxy({} as Row, {
    get: (_t, name) => {
      if (name === 'then' || typeof name !== 'string') return undefined;
      if (name === 'exec') {
        return async () => {
          const out: unknown[] = [];
          for (const [op, args] of ops) out.push(await fakeRedis[op](...args));
          return out;
        };
      }
      return (...args: unknown[]) => { ops.push([name, args]); return chain; };
    },
  });
  return chain;
};
redisImpl.pipeline = batch;
redisImpl.multi = batch;
export const fakeRedis: Row = new Proxy(redisImpl, {
  get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? (() => { throw new Error(`the fake Redis has no ${p}()`); })),
});

// ---- What the world saw ----

/** Next's after(): its task is queued while the request runs, and run by drainAfter() (the sign-in request mails after its answer). */
const afterQueue: (() => unknown)[] = [];
export async function drainAfter(): Promise<void> {
  while (afterQueue.length) await afterQueue.shift()!();
}

export const sent: { platform: 'telegram' | 'whatsapp'; chatId: string; text: string }[] = [];
export const captured: { context: string; message: string; extra: Row }[] = [];
export const everyCapture: { context: string; message: string; extra: Row }[] = [];
export const mails: { to: string[]; body: Row; idempotencyKey: string | null }[] = [];
export const everyMail: { to: string[]; body: Row; idempotencyKey: string | null }[] = [];

/** The scripted boundaries. A check sets what it needs after resetWorld(). */
export const world = {
  telegramFails: false,
  whatsappFails: false,
  oidc: { telegram: true, google: true } as Record<string, boolean>,
  /** What Google's token says (finishAuthorization's answer) */
  claims: null as Row | null,
  /** The calendar account per refresh token: an address, an Error to throw, or a function run at the ask */
  accounts: {} as Record<string, string | Error | (() => string)>,
  /** The refresh tokens Google was asked about, in order */
  googleAsks: [] as string[],
};

export function resetWorld(): void {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  redisSets.clear();
  afterQueue.length = 0;
  prismaCalls.length = 0;
  sent.length = 0;
  captured.length = 0;
  mails.length = 0;
  logs.length = 0;
  Object.assign(world, { telegramFails: false, whatsappFails: false, oidc: { telegram: true, google: true }, claims: null, accounts: {}, googleAsks: [] });
}

function chatService(platform: 'telegram' | 'whatsapp'): Row {
  const service: Row = {
    sendMessage: async (chatId: unknown, text: string) => {
      if (platform === 'telegram' ? world.telegramFails : world.whatsappFails) throw new Error(`${platform} refused the send (smoke)`);
      sent.push({ platform, chatId: String(chatId), text });
      return platform === 'telegram' ? 1 : 'wamid.smoke';
    },
  };
  return new Proxy(service, {
    get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? (() => { throw new Error(`the fake ${platform} service has no ${p}()`); })),
  });
}

// ---- Fixtures ----

let identitySeq = 1000;

export function baseUser(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', culture: 'default',
    messagingPlatform: 'telegram', googleRefreshToken: '', googleScopes: [], calendarAssignments: null, calendarSource: 'NATIVE',
    pairingId: null, remindersEnabled: false, suspendedAt: null, unreachableSince: null, whatsappPhone: null, whatsappBsuid: null,
    telegramId: null, isAdmin: false, globalRules: [], voiceInputEnabled: true, textSummaryEnabled: true, voiceSummaryEnabled: false,
    weatherEnabled: true, sessionsValidAfter: null, googleAccountKey: null, googleCalendarSignIn: true,
    createdAt: new Date(Date.now() - 30 * DAY), updatedAt: new Date(Date.now() - DAY),
    ...o,
  };
}

export function identityRow(o: Row): Row {
  return { id: ++identitySeq, createdAt: new Date(Date.now() - DAY), lastUsedAt: null, ...o };
}

/** Valid Telegram initData for a Telegram user id, signed with the bot token. */
export function initDataFor(tgId: number): string {
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

export const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

/** A request to famcal.bot: JSON, from famcal.bot (origin: null sends none, or another one), with the client address set. */
export function request(url: string, o: { method?: string; body?: unknown; cookie?: string; initData?: string; origin?: string | null } = {}): Row {
  const { NextRequest } = nodeRequire('next/server');
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-real-ip': '203.0.113.9', 'accept-language': 'en' };
  if (o.origin !== null) headers.origin = o.origin ?? BASE;
  if (o.cookie) headers.cookie = o.cookie;
  if (o.initData) headers['x-telegram-init-data'] = o.initData;
  return new NextRequest(`${BASE}${url}`, {
    method: o.method ?? (o.body === undefined ? 'GET' : 'POST'),
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
}

/** The session cookie header for a person, as the finishing step sets it. */
export async function sessionCookie(userId: number, method: string, signedInAt = Date.now() - 60_000): Promise<string> {
  const { createSessionToken, SESSION_COOKIE_NAME } = await load('src/lib/session-auth.ts');
  return `${SESSION_COOKIE_NAME}=${createSessionToken(userId, method, signedInAt)}`;
}

/** The flow cookie header for a one-time sign-in flow, as a start route sets it. */
export async function flowCookie(flow: Row): Promise<string> {
  const { NextResponse } = nodeRequire('next/server');
  const { startFlow, SIGNIN_COOKIE_NAME } = await load('src/services/web-signin/flow.ts');
  const res = NextResponse.json({});
  await startFlow(res, flow);
  const value = res.cookies.get(SIGNIN_COOKIE_NAME)?.value;
  if (!value) throw new Error('startFlow set no cookie');
  return `${SIGNIN_COOKIE_NAME}=${value}`;
}

export async function body(res: Response): Promise<Row> {
  try { return await res.clone().json(); } catch { return { nonJson: true }; }
}

// ---- The stand-ins ----

export async function installSigninWorld(): Promise<void> {
  const types = await load('src/services/messaging/types.ts');
  // A stub goes into require's cache (static imports) and is served to import() by a load hook.
  const Module = nodeRequire('module');
  const stubs: Record<string, Row> = {};
  (globalThis as Row).__signinStubs = stubs;
  if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
  Module.registerHooks({
    load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
      const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
      if (!(file in stubs)) return nextLoad(url, context);
      const names = Object.keys(stubs[file]).filter(n => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
      const source = [
        `const s = globalThis.__signinStubs[${JSON.stringify(file)}];`,
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
  const limiter = (name: string) => ({ name });
  stub('src/lib/rate-limit.ts', {
    commandRateLimiter: limiter('command'), settingsRateLimiter: limiter('settings'), generalRateLimiter: limiter('general'),
    tokenPollRateLimiter: limiter('token-poll'), calendarRateLimiter: limiter('calendar'), reminderActionRateLimiter: limiter('reminder-action'),
    calendarWriteRateLimiter: limiter('calendar-write'),
    checkRateLimit: async () => ({ success: true, limit: 99, remaining: 99, reset: 0 }),
    getRateLimitHeaders: () => ({}),
  });
  const capture = (e: unknown, context: string, extra: Row = {}) => {
    const entry = { context, message: e instanceof Error ? e.message : String(e), extra };
    captured.push(entry);
    everyCapture.push(entry);
  };
  stub('src/lib/error-capture.ts', {
    captureError: capture,
    captureWarning: (message: string, context: string, extra?: Row) => capture(new Error(message), context, extra),
    captureInfo: () => undefined,
  });
  stub('src/utils/error-notifier.ts', {
    getAdminUserIds: async () => [], notifyAdminError: async () => undefined, notifyAdminWarning: async () => undefined, notifyAdminFeedback: async () => undefined,
  });
  const telegram = { getBot: () => ({}), initBot: () => ({}), getMessagingService: () => chatService('telegram'), setUserMenuButton: async () => undefined };
  stub('src/services/telegram/bot.ts', telegram);
  stub('src/services/telegram/index.ts', telegram);
  const messaging = {
    ...types,
    getWhatsAppService: () => chatService('whatsapp'),
    getTelegramService: () => chatService('telegram'),
    getMessagingService: (platform: unknown) => chatService(platform === 'whatsapp' ? 'whatsapp' : 'telegram'),
    detectPlatform: () => 'telegram',
  };
  stub('src/services/messaging/index.ts', messaging);
  stub('src/services/messaging/factory.ts', messaging);
  // The OIDC exchange: openid-client and the network never load. The state is checked as authorizationCodeGrant does.
  const random = () => crypto.randomBytes(32).toString('base64url');
  stub('src/services/web-signin/oidc.ts', {
    providerConfigured: (provider: string) => world.oidc[provider] === true,
    newOidcChecks: () => ({ state: random(), nonce: random(), codeVerifier: random() }),
    redirectUri: (provider: string) => `${BASE}/api/auth/${provider}/callback`,
    describeOidcError: (error: unknown) => (error instanceof Error ? error.name : 'unknown'),
    authorizationUrl: async (provider: string, flow: Row) =>
      new URL(provider === 'google'
        ? `https://accounts.google.com/o/oauth2/v2/auth?state=${flow.state}&nonce=${flow.nonce}`
        : `https://oauth.telegram.org/auth?state=${flow.state}`),
    finishAuthorization: async (_provider: string, callbackUrl: URL, flow: Row) => {
      if (callbackUrl.searchParams.get('state') !== flow.state) {
        throw Object.assign(new Error('unexpected "state" response parameter value'), { code: 'OAUTH_INVALID_RESPONSE' });
      }
      if (!world.claims) throw new Error('the smoke set no claims');
      return world.claims;
    },
  });
  // The calendar's Google account: syncGoogle(token).account() is the one way the code asks it (getGoogleAuth + googleAccountOf).
  stub('src/services/google-sync/client.ts', {
    syncGoogle: (refreshToken: string) => ({
      api: {},
      account: async () => {
        world.googleAsks.push(refreshToken);
        const answer = world.accounts[refreshToken];
        if (answer === undefined) throw new Error(`no account scripted for ${refreshToken}`);
        if (answer instanceof Error) throw answer;
        return typeof answer === 'function' ? answer() : answer;
      },
    }),
    CALLS_PER_RUN: 100,
    counted: async (_budget: unknown, call: () => Promise<unknown>) => call(),
    BudgetSpent: class BudgetSpent extends Error {},
    __useSyncGoogleForTests: () => undefined,
  });

  // after() works only inside a request: queue its task for drainAfter()
  nodeRequire('next/server').after = (task: unknown) => {
    afterQueue.push(typeof task === 'function' ? (task as () => unknown) : () => task);
  };

  // fetch: Resend is answered and its request recorded; everything else is blocked.
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://api.resend.com/emails') {
      const raw = input instanceof Request ? await input.text() : String(init?.body ?? '');
      const parsed: Row = JSON.parse(raw || '{}');
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      const mail = { to: ([] as string[]).concat(parsed.to ?? []), body: parsed, idempotencyKey: headers.get('idempotency-key') };
      mails.push(mail);
      everyMail.push(mail);
      return new Response(JSON.stringify({ id: `re_smoke_${everyMail.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`network blocked in smoke: ${url}`);
  }) as typeof fetch;
}

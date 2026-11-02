// Smoke test for the web session (spec 2026-11-02-web-sign-in §2.4, §2.13, §2.16, §3; plan Task 2):
// - the __Host-famcal_session cookie lasts by how the person signed in: 30 days for Telegram, Google or an email code,
//   24 hours for a WhatsApp link;
// - a cookie made before 6b reads as a WhatsApp link's, signed in at its iat;
// - renewal happens only in page-data, only for a famcal.bot sign-in's cookie, after a day, and keeps its method and
//   first sign-in time;
// - every session signed in before the row's sessionsValidAfter is refused, to the millisecond;
// - a refused cookie is cleared with the answer, so neither /signin nor /dashboard loops;
// - a ban and a suspension end sessions;
// - every sign-in ends in one finishing step, which refuses a suspended or banned account with its page, by one rule
//   (signInRefusal) that Add Google and the calendar match share;
// - the WhatsApp link still lands on Select calendars;
// - /dashboard with no user_id opens the signed-in browser's own calendar;
// - a session's end can be kept (a WhatsApp link's cookie after Remove);
// - every landing and every /signin?status= is written in the person's language, English unprefixed, an unknown
//   language as English (localePrefix 'as-needed'), by the one path builder src/site/signin.ts;
// - no log line holds a cookie.
//
// session-auth, api-auth, web-session, src/site/signin, user-service, user-moderation, subscription-service, magic-link,
// the magic and page-data routes and the dashboard page run for real. Faked at the boundaries: Prisma (in memory), Redis (in memory),
// the rate limiter (allows), error capture (recorded), the page loader behind page-data (records whom it loaded for),
// next/headers (a cookie jar), the dashboard's two client components (named placeholders), and fetch (blocked).
// No network, no DB.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-web-session.ts

import path from 'path';
import fs from 'fs';
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
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
// The site's address: the finishing step's redirects and /signin are absolute on it.
process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.bot';

const BASE = 'https://famcal.bot';
const NAME = '__Host-famcal_session';
const DAY = 86_400_000;
const WEB_TTL = 30 * 24 * 3600;
const WA_TTL = 24 * 3600;
const PHONE = '972500000042';

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
/** Every write to the user table: the method, the where, the data and the row ids it hit. */
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
      if ('not' in cond && same(v ?? null, cond.not)) return false;
      if ('gt' in cond && !(v != null && num(v) > num(cond.gt))) return false;
      if ('lt' in cond && !(v != null && num(v) < num(cond.lt))) return false;
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

function applyData(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (isPlain(v) && 'increment' in v) row[k] = (row[k] ?? 0) + v.increment;
    else if (isPlain(v) && 'set' in v) row[k] = v.set;
    else row[k] = v;
  }
}

function model(name: string): Row {
  const t = () => (DB[name] ??= []);
  const record = (method: string, where: Row, data: Row, rows: Row[]) => {
    if (name === 'user') userWrites.push({ method, where, data, hit: rows.map(r => r.id) });
  };
  const create = (data: Row): Row => {
    const row: Row = { id: Math.max(0, ...t().map(r => Number(r.id) || 0)) + 1, createdAt: new Date() };
    // A real row has every column: the one a ban does not name is null, not missing.
    if (name === 'blockedIdentifier') Object.assign(row, { telegramId: null, whatsappPhone: null });
    applyData(row, data);
    t().push(row);
    record('create', {}, data, [row]);
    return row;
  };
  return {
    findUnique: async (a: Row = {}) => pick(t().find(r => matches(r, a.where)), a.select),
    findFirst: async (a: Row = {}) => pick(t().find(r => matches(r, a.where)), a.select),
    findMany: async (a: Row = {}) => t().filter(r => matches(r, a.where)).map(r => pick(r, a.select)),
    count: async (a: Row = {}) => t().filter(r => matches(r, a.where)).length,
    create: async (a: Row) => pick(create(a.data), a.select),
    update: async (a: Row) => {
      const row = t().find(r => matches(r, a.where));
      record('update', a.where, a.data, row ? [row] : []);
      if (!row) throw Object.assign(new Error(`No ${name} record was found for an update.`), { code: 'P2025' });
      applyData(row, a.data);
      return pick(row, a.select);
    },
    updateMany: async (a: Row) => {
      const rows = t().filter(r => matches(r, a.where));
      record('updateMany', a.where ?? {}, a.data, rows);
      rows.forEach(r => applyData(r, a.data));
      return { count: rows.length };
    },
    upsert: async (a: Row) => {
      const row = t().find(r => matches(r, a.where));
      if (row) { applyData(row, a.update); return pick(row, a.select); }
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
}

const models: Record<string, Row> = {};
const fakePrisma: Row = new Proxy({} as Row, {
  get(_t, prop) {
    if (typeof prop !== 'string' || prop === 'then') return undefined;
    if (prop === '$transaction') {
      return async (arg: unknown) => (typeof arg === 'function' ? arg(fakePrisma) : Promise.all(arg as Promise<unknown>[]));
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
  set: async (k: string, v: unknown) => { redisStore.set(k, encode(v)); return 'OK'; },
  del: async (...ks: unknown[]) => ks.flat().reduce((n: number, k) => n + (redisStore.delete(String(k)) ? 1 : 0), 0),
  getdel: async (k: string) => { const raw = redisStore.get(k); redisStore.delete(k); return decode(raw); },
  incr: async (k: string) => { const n = Number(redisStore.get(k) ?? 0) + 1; redisStore.set(k, String(n)); return n; },
  expire: async () => 1,
};
const fakeRedis = new Proxy(redisImpl, {
  get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? (async () => null)),
});

// ---- Boundaries ----

const captured: string[] = [];
/** The browser's cookies, as next/headers hands them to a server page. */
const jar = new Map<string, string>();
/** The users the page loader behind page-data loaded a page for. */
const loaded: number[] = [];

function installStubs() {
  // A stub goes into require's cache (static imports) and is served to import() by a load hook.
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
    settingsRateLimiter: { name: 'settings' }, calendarRateLimiter: { name: 'calendar' }, commandRateLimiter: { name: 'command' }, generalRateLimiter: { name: 'general' },
    checkRateLimit: async () => ({ success: true, limit: 99, remaining: 99, reset: 0 }),
    getRateLimitHeaders: () => ({}),
  });
  const capture = (e: unknown, ctx: string) => { captured.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`); };
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
  // What each page loads is smoke-page-auth's; here only whom page-data loaded one for.
  stub('src/lib/page-data.ts', {
    isPageName: (p: unknown) => p === 'dashboard' || p === 'settings',
    loadPageData: async (_page: string, user: Row) => { loaded.push(user.id); return { kind: 'props', props: { userId: user.id } }; },
  });
  stub(path.relative(ROOT, nodeRequire.resolve('next/headers')), {
    __esModule: true,
    cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
    headers: async () => new Headers(),
  });
  // The dashboard's two client components, as named placeholders: the page's choice between them is what is checked.
  stub('app/[locale]/(app)/dashboard/TelegramDashboardRedirect.tsx', {
    __esModule: true,
    default: function TelegramDashboardRedirect() { return null; },
  });
  stub('app/[locale]/(app)/PageGate.tsx', {
    __esModule: true,
    default: function PageGate() { return null; },
    NoCredentialCard: () => null,
    PageLoader: () => null,
    startMiniApp: () => undefined,
  });
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`network blocked in smoke: ${String(input)}`);
  }) as typeof fetch;
}

// ---- Fixtures and helpers ----

function baseUser(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: '', culture: 'default',
    messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null, calendarSource: 'NATIVE',
    pairingId: null, suspendedAt: null, suspendedBy: null, suspendedReason: null, unreachableSince: null,
    whatsappPhone: null, whatsappBsuid: null, telegramId: null, isAdmin: false, globalRules: [], defaultReminderMinutes: null,
    sessionsValidAfter: null, googleAccountKey: null, googleCalendarSignIn: true,
    createdAt: new Date(Date.now() - 30 * DAY), updatedAt: new Date(Date.now() - DAY),
    ...o,
  };
}

/** 42 = WhatsApp-only (Hebrew, phone). 9 = Telegram 111111111 (Russian). 5 = Telegram 5550005 (English). */
function seed() {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  userWrites.length = 0;
  captured.length = 0;
  jar.clear();
  loaded.length = 0;
  DB.user = [
    baseUser({ id: 42, name: 'Noa', language: 'he', messagingPlatform: 'whatsapp', whatsappPhone: PHONE }),
    baseUser({ id: 9, name: 'Tal', language: 'ru', telegramId: BigInt(111111111) }),
    baseUser({ id: 5, name: 'Dana', language: 'en', telegramId: BigInt(5550005) }),
  ];
  DB.blockedIdentifier = [];
}

const userRow = (id: number) => DB.user.find(u => u.id === id) as Row;
const nowS = () => Math.floor(Date.now() / 1000);
const hkdf = (purpose: string) => Buffer.from(crypto.hkdfSync('sha256', process.env.SESSION_SECRET as string, '', `famcal/${purpose}/v1`, 32));

/** A cookie in session-auth's format, signed with the session-cookie key: any payload, any age. */
function signed(payload: Row | string): string {
  const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', hkdf('session-cookie')).update(body).digest('base64url')}`;
}

/** A cookie of the 6b shape issued `ageMs` ago, lasting `ttlS` from then. */
function aged(userId: number, m: string, at: number, ageMs: number, ttlS: number): string {
  const iat = Math.floor((Date.now() - ageMs) / 1000);
  return signed({ userId, m, at, iat, exp: iat + ttlS });
}

/** Valid Telegram initData for a Telegram user id, signed with the bot token. */
function initDataFor(tgId: number): string {
  const params: Record<string, string> = {
    auth_date: String(nowS()),
    query_id: 'AAH-smoke',
    user: JSON.stringify({ id: tgId, first_name: 'Test' }),
  };
  const checkString = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN ?? '').digest();
  const hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  return [...Object.entries(params), ['hash', hash]].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/** The response's Set-Cookie for the session cookie: its value and its attributes (names lower-cased), or null. */
function sessionSetCookie(res: Response): { value: string; attrs: Record<string, string | true> } | null {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const lines = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') ?? ''];
  const line = lines.find(l => l.startsWith(`${NAME}=`));
  if (!line) return null;
  const [first, ...rest] = line.split(';').map(s => s.trim());
  const attrs: Record<string, string | true> = {};
  for (const part of rest.filter(Boolean)) {
    const i = part.indexOf('=');
    if (i < 0) attrs[part.toLowerCase()] = true;
    else attrs[part.slice(0, i).toLowerCase()] = part.slice(i + 1);
  }
  return { value: decodeURIComponent(first.slice(NAME.length + 1)), attrs };
}

/** A Set-Cookie that removes the __Host- cookie: empty, Max-Age=0, with the Secure and Path=/ a __Host- cookie needs. */
const isCleared = (c: ReturnType<typeof sessionSetCookie>) =>
  !!c && c.value === '' && c.attrs['max-age'] === '0' && c.attrs.secure === true && c.attrs.path === '/';

const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function sourceFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); } else if (/\.tsx?$/.test(e.name)) out.push(rel);
    }
  };
  dirs.forEach(walk);
  return out;
}

async function fullBody(res: Response): Promise<string> {
  try { return JSON.stringify(await res.clone().json()); } catch { return '(non-json)'; }
}

/** Every console line written while fn runs (the lines are kept from the real console). */
async function recordingConsole<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const record = (...args: unknown[]) => {
    lines.push(args.map(a => (a instanceof Error ? `${a.message} ${a.stack ?? ''}` : typeof a === 'string' ? a : show(a))).join(' '));
  };
  console.log = record;
  console.warn = record;
  console.error = record;
  try {
    return { value: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

async function main() {
  installStubs();

  const { NextRequest, NextResponse } = nodeRequire('next/server');
  const S = await load('src/lib/session-auth.ts');
  const { finishSignIn, signInPageUrl, signInRefusal, appPageUrl } = await load('src/lib/web-session.ts');
  const { signInHref } = await load('src/site/signin.ts');
  const { verifyUserAuth } = await load('src/lib/api-auth.ts');
  const { getUserById } = await load('src/services/user-service.ts');
  const moderation = await load('src/lib/user-moderation.ts');
  const { generateMagicLink } = await load('src/services/magic-link.ts');
  const magicRoute = await load('app/api/auth/magic/route.ts');
  const pageDataRoute = await load('app/api/page-data/route.ts');
  const subscriptionRoute = await load('app/api/subscription/route.ts');
  const limiter = { name: 'general' };

  /** POST /api/page-data for the dashboard, with a session cookie or Telegram initData. */
  const pageData = (userId: number | string, o: { cookie?: string; initData?: string } = {}): Promise<Response> =>
    pageDataRoute.POST(new NextRequest(`${BASE}/api/page-data`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(o.cookie ? { cookie: `${NAME}=${o.cookie}` } : {}) },
      body: JSON.stringify({ page: 'dashboard', user_id: userId, locale: 'he', ...(o.initData ? { initData: o.initData } : {}) }),
    }));

  /** The dashboard page with no user_id, as Next calls it. A redirect comes back as `thrown` (its digest). */
  const dashboard = async (locale: string): Promise<{ type?: string; thrown?: string }> => {
    const page = (await load('app/[locale]/(app)/dashboard/page.tsx')).default;
    try {
      const el = await page({ params: Promise.resolve({ locale }), searchParams: Promise.resolve({}) });
      return { type: el?.type?.name };
    } catch (err) {
      return { thrown: String((err as Row)?.digest ?? (err instanceof Error ? err.message : err)) };
    }
  };

  // ---- The cookie ----

  await check('#1 the cookie lasts by how the person signed in: 30 days for Telegram, Google and email, 24 hours for a WhatsApp link; __Host-famcal_session, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain', () => {
    assert(S.SESSION_COOKIE_NAME === NAME, `name ${S.SESSION_COOKIE_NAME}`);
    assert(S.SESSION_TTL_SEC?.web === WEB_TTL && S.SESSION_TTL_SEC?.wa === WA_TTL, `ttls ${show(S.SESSION_TTL_SEC)}`);
    const at = Date.now() - 5000;
    for (const [method, ttl] of [['tg', WEB_TTL], ['google', WEB_TTL], ['email', WEB_TTL], ['wa', WA_TTL]] as const) {
      const token = S.createSessionToken(42, method, at);
      const s = S.validateSessionToken(token);
      assert(s && s.userId === 42 && s.method === method && s.signedInAt === at && s.exp - s.iat === ttl, `${method}: ${show(s)}`);
      const res = NextResponse.json({});
      S.setSessionCookie(res, token);
      const c = sessionSetCookie(res);
      assert(c && c.value === token, `${method}: no cookie set`);
      const a = c.attrs;
      assert(a['max-age'] === String(ttl) && a.secure === true && a.httponly === true && String(a.samesite).toLowerCase() === 'lax'
        && a.path === '/' && !('domain' in a), `${method} attributes ${show(a)}`);
    }
  });

  await check('#2 a cookie made before 6b (no method, no sign-in time) reads as a WhatsApp link\'s, signed in at its iat; an unknown method, a string user id, a third part or an expired cookie is refused', () => {
    const iat = nowS() - 60;
    const old = S.validateSessionToken(signed({ userId: 42, iat, exp: iat + WA_TTL }));
    assert(old && old.method === 'wa' && old.signedInAt === iat * 1000 && old.userId === 42, `old: ${show(old)}`);
    assert(S.validateSessionToken(signed({ userId: 42, m: 'admin', at: Date.now(), iat, exp: iat + WEB_TTL })) === null, 'an unknown method is accepted');
    assert(S.validateSessionToken(signed({ userId: '42', m: 'tg', at: Date.now(), iat, exp: iat + WEB_TTL })) === null, 'a string user id is accepted');
    assert(S.validateSessionToken(`${signed({ userId: 42, m: 'tg', at: Date.now(), iat, exp: iat + WEB_TTL })}.x`) === null, 'a third part is accepted');
    assert(S.validateSessionToken(signed({ userId: 42, m: 'tg', at: Date.now(), iat: iat - 2 * WEB_TTL, exp: iat - WEB_TTL })) === null, 'an expired cookie is accepted');
  });

  await check('#3 needsRenewal: a famcal.bot sign-in\'s cookie over a day old, never a WhatsApp link\'s', () => {
    const now = Date.now();
    const s = (method: string, ageMs: number) => {
      const iat = Math.floor((now - ageMs) / 1000);
      return { userId: 42, method, signedInAt: now - ageMs, iat, exp: iat + WEB_TTL };
    };
    const got = {
      tg2d: S.needsRenewal(s('tg', 2 * DAY), now),
      google1h: S.needsRenewal(s('google', 3600_000), now),
      email25h: S.needsRenewal(s('email', 25 * 3600_000), now),
      wa23h: S.needsRenewal(s('wa', 23 * 3600_000), now),
      wa2d: S.needsRenewal(s('wa', 2 * DAY), now),
    };
    assert(show(got) === show({ tg2d: true, google1h: false, email25h: true, wa23h: false, wa2d: false }), show(got));
  });

  // ---- Renewal ----

  await check('#4 page-data renews a 2-day-old Telegram sign-in\'s cookie for 30 more days with its first sign-in time and method; a fresh one, an hour-old Google one and a WhatsApp link\'s are left alone', async () => {
    seed();
    const AT = Date.now() - 2 * DAY - 123;
    const res = await pageData(5, { cookie: aged(5, 'tg', AT, 2 * DAY, WEB_TTL) });
    assert(res.status === 200, `status ${res.status} ${await fullBody(res)}`);
    const c = sessionSetCookie(res);
    const s = c ? S.validateSessionToken(c.value) : null;
    assert(s && s.method === 'tg' && s.signedInAt === AT && s.iat >= nowS() - 2 && s.exp - s.iat === WEB_TTL && c?.attrs['max-age'] === String(WEB_TTL),
      `renewed: ${show(s)} ${show(c?.attrs)}`);
    const cases: [string, string][] = [
      ['fresh tg', S.createSessionToken(5, 'tg', Date.now())],
      ['google an hour old', aged(5, 'google', Date.now() - 3600_000, 3600_000, WEB_TTL)],
      ['wa 23 hours old', aged(5, 'wa', Date.now() - 23 * 3600_000, 23 * 3600_000, WA_TTL)],
    ];
    for (const [label, cookie] of cases) {
      const r = await pageData(5, { cookie });
      assert(r.status === 200 && sessionSetCookie(r) === null, `${label}: status ${r.status}, set-cookie ${show(sessionSetCookie(r))}`);
    }
  });

  await check('#5 page-data is the only caller of needsRenewal: no other route renews a session', () => {
    const def = path.join('src', 'lib', 'session-auth.ts');
    const callers = sourceFiles(['app', 'src']).filter(f => f !== def && /\bneedsRenewal\(/.test(read(f)));
    assert(show(callers) === show([path.join('app', 'api', 'page-data', 'route.ts')]), `callers ${show(callers)}`);
  });

  await check('#5b a session route other than page-data does not renew: a 2-day-old Telegram sign-in\'s cookie is accepted (200) and no Set-Cookie comes back', async () => {
    seed();
    const cookie = aged(5, 'tg', Date.now() - 2 * DAY, 2 * DAY, WEB_TTL);
    assert(S.needsRenewal(S.validateSessionToken(cookie), Date.now()), 'the cookie is not one that page-data would renew');
    const res = await subscriptionRoute.GET(new NextRequest(`${BASE}/api/subscription?user_id=5`, { headers: { cookie: `${NAME}=${cookie}` } }));
    assert(res.status === 200, `status ${res.status} ${await fullBody(res)}`);
    assert(sessionSetCookie(res) === null, `set-cookie ${show(sessionSetCookie(res))}`);
  });

  // ---- Ending sessions ----

  await check('#6 a session signed in before sessionsValidAfter is refused to the millisecond: 1 ms before is 401 with the cookie cleared, the same ms or later is let in; a pre-6b cookie counts its iat', async () => {
    seed();
    const T = Math.floor(Date.now() / 1000) * 1000 - 60_000 + 437;
    userRow(42).sessionsValidAfter = new Date(T);
    const before = await pageData(42, { cookie: S.createSessionToken(42, 'email', T - 1) });
    assert(before.status === 401 && (await fullBody(before)).includes('Session ended'), `1 ms before: ${before.status} ${await fullBody(before)}`);
    assert(isCleared(sessionSetCookie(before)), `1 ms before: set-cookie ${show(sessionSetCookie(before))}`);
    for (const at of [T, T + 1]) {
      const r = await pageData(42, { cookie: S.createSessionToken(42, 'email', at) });
      assert(r.status === 200 && sessionSetCookie(r) === null, `at +${at - T} ms: ${r.status} ${await fullBody(r)}`);
    }
    const iat = Math.floor(T / 1000);
    const old = await pageData(42, { cookie: signed({ userId: 42, iat, exp: iat + WA_TTL }) });
    assert(old.status === 401 && isCleared(sessionSetCookie(old)), `a pre-6b cookie issued in the same second: ${old.status}`);
    assert(show(loaded) === show([42, 42]), `the loader ran for ${show(loaded)}`);
  });

  await check('#7 a refused cookie is cleared with the answer (its account gone: 404; suspended: 403); a cookie for another user_id is 401 and kept; a suspended Telegram user is 403 with no cookie touched', async () => {
    seed();
    const gone = await pageData(77, { cookie: S.createSessionToken(77, 'tg', Date.now()) });
    assert(gone.status === 404 && isCleared(sessionSetCookie(gone)), `no row: ${gone.status} ${show(sessionSetCookie(gone))}`);
    userRow(5).suspendedAt = new Date(Date.now() - DAY);
    const susp = await pageData(5, { cookie: S.createSessionToken(5, 'google', Date.now()) });
    assert(susp.status === 403 && isCleared(sessionSetCookie(susp)), `suspended: ${susp.status} ${show(sessionSetCookie(susp))}`);
    const other = await pageData(9, { cookie: S.createSessionToken(42, 'wa', Date.now()) });
    assert(other.status === 401 && sessionSetCookie(other) === null, `another user_id: ${other.status} ${show(sessionSetCookie(other))}`);
    userRow(9).suspendedAt = new Date(Date.now() - DAY);
    const tg = await pageData(111111111, { initData: initDataFor(111111111) });
    assert(tg.status === 403 && sessionSetCookie(tg) === null, `suspended on Telegram: ${tg.status} ${show(sessionSetCookie(tg))}`);
    assert(loaded.length === 0, `the loader ran for ${show(loaded)}`);
  });

  await check('#8 /dashboard with no user_id opens the signed-in browser\'s own calendar; a revoked cookie does it once, page-data clears it, and the next visit gets the card, not another round', async () => {
    seed();
    const empty = await dashboard('he');
    assert(empty.type === 'TelegramDashboardRedirect', `no cookie: ${show(empty)}`);
    const token = S.createSessionToken(42, 'google', Date.now() - 1000);
    // An expired cookie and a cookie under the pre-6b name (famcal_session) are never followed.
    jar.set(NAME, aged(42, 'google', Date.now() - 31 * DAY, 31 * DAY, WEB_TTL));
    const expired = await dashboard('he');
    assert(expired.type === 'TelegramDashboardRedirect', `expired cookie: ${show(expired)}`);
    jar.delete(NAME);
    jar.set('famcal_session', token);
    const oldName = await dashboard('he');
    assert(oldName.type === 'TelegramDashboardRedirect', `the pre-6b cookie name: ${show(oldName)}`);
    jar.delete('famcal_session');
    jar.set(NAME, `${token.split('.')[0]}.forged`);
    const forged = await dashboard('he');
    assert(forged.type === 'TelegramDashboardRedirect', `forged cookie: ${show(forged)}`);
    jar.set(NAME, token);
    const valid = await dashboard('he');
    assert(valid.thrown?.includes(';/he/dashboard?user_id=42;'), `signed-in browser: ${show(valid)}`);
    // Signed out on every device since: the page reads no row and still redirects; page-data refuses and clears.
    userRow(42).sessionsValidAfter = new Date();
    const refused = await pageData(42, { cookie: token });
    assert(refused.status === 401 && isCleared(sessionSetCookie(refused)), `revoked: ${refused.status} ${show(sessionSetCookie(refused))}`);
    jar.delete(NAME); // the browser applies the clearing Set-Cookie
    const after = await dashboard('he');
    assert(after.type === 'TelegramDashboardRedirect', `after the clear: ${show(after)}`);
  });

  await check('#9 a ban ends the web sessions of the accounts it names (by WhatsApp number or Telegram id) and refuses their next sign-in; an id nobody holds signs nobody out', async () => {
    seed();
    const cookie = S.createSessionToken(42, 'wa', Date.now() - 1000);
    await moderation.banIdentifier({ whatsappPhone: PHONE }, 5, null);
    const ended = userRow(42).sessionsValidAfter;
    assert(ended instanceof Date && Date.now() - ended.getTime() < 5000, `42's sessionsValidAfter ${show(ended)}`);
    assert(userRow(9).sessionsValidAfter == null && userRow(5).sessionsValidAfter == null, 'another account was signed out');
    const r = await pageData(42, { cookie });
    assert(r.status === 401 && isCleared(sessionSetCookie(r)), `the banned session: ${r.status}`);
    const again = await finishSignIn(await getUserById(42), 'wa');
    assert(again.headers.get('location') === `${BASE}/he/signin?status=blocked` && sessionSetCookie(again) === null,
      `sign-in after the ban: ${again.headers.get('location')} ${show(sessionSetCookie(again))}`);
    await moderation.banIdentifier({ telegramId: 111111111 }, 5, null);
    assert(userRow(9).sessionsValidAfter instanceof Date, 'the Telegram ban did not sign out row 9');
    const from = userWrites.length;
    await moderation.banIdentifier({ whatsappPhone: '972599999999' }, 5, null);
    assert(userWrites.slice(from).every(w => w.hit.length === 0), `a number nobody holds hit ${show(userWrites.slice(from))}`);
  });

  await check('#10 a suspension ends the web sessions, unsuspending does not bring them back, and the next sign-in works; while suspended a sign-in gets its page', async () => {
    seed();
    const old = S.createSessionToken(9, 'tg', Date.now() - 1000);
    await moderation.suspendUser(9, 5, 'smoke');
    const row = userRow(9);
    assert(row.suspendedAt instanceof Date && row.sessionsValidAfter instanceof Date && row.sessionsValidAfter.getTime() === row.suspendedAt.getTime(),
      `row 9 ${show({ suspendedAt: row.suspendedAt, sessionsValidAfter: row.sessionsValidAfter })}`);
    const during = await finishSignIn(await getUserById(9), 'tg');
    assert(during.headers.get('location') === `${BASE}/ru/signin?status=suspended` && sessionSetCookie(during) === null,
      `while suspended: ${during.headers.get('location')}`);
    await moderation.unsuspendUser(9, 5);
    assert(userRow(9).sessionsValidAfter instanceof Date, 'unsuspending cleared sessionsValidAfter');
    const r = await pageData(9, { cookie: old });
    assert(r.status === 401 && isCleared(sessionSetCookie(r)), `the old session after unsuspending: ${r.status}`);
    const fresh = await finishSignIn(await getUserById(9), 'tg');
    const c = sessionSetCookie(fresh);
    assert(fresh.headers.get('location') === `${BASE}/ru/dashboard?user_id=9` && c, `the new sign-in: ${fresh.headers.get('location')}`);
    const ok = await pageData(9, { cookie: c.value });
    assert(ok.status === 200, `the new session: ${ok.status} ${await fullBody(ok)}`);
  });

  // ---- The finishing step ----

  await check('#11 the WhatsApp link still signs in through the finishing step: Select calendars or the dashboard in the person\'s language with a 24-hour WhatsApp-link cookie; a suspended account gets its page and no cookie; an account that is gone gets the fresh-link card', async () => {
    seed();
    const tap = async (link: string) => {
      const res: Response = await magicRoute.GET(new NextRequest(link));
      return { status: res.status, to: res.headers.get('location') ?? '', cookie: sessionSetCookie(res) };
    };
    const calendars = await tap(await generateMagicLink(42, 'he', 'select-calendars'));
    const s = calendars.cookie ? S.validateSessionToken(calendars.cookie.value) : null;
    assert(calendars.to === `${BASE}/he/select-calendars?user_id=42` && s?.method === 'wa' && calendars.cookie?.attrs['max-age'] === String(WA_TTL),
      `select-calendars: ${show({ ...calendars, s })}`);
    const home = await tap(await generateMagicLink(42, 'ru'));
    assert(home.to === `${BASE}/he/dashboard?user_id=42` && home.cookie, `dashboard (a link minted in ru, the person's Hebrew): ${show(home)}`);
    userRow(42).suspendedAt = new Date();
    const susp = await tap(await generateMagicLink(42, 'he'));
    assert(susp.to === `${BASE}/he/signin?status=suspended` && susp.cookie === null, `suspended: ${show(susp)}`);
    const gone = await tap(await generateMagicLink(4242, 'ru'));
    assert(gone.to === `${BASE}/ru/dashboard` && gone.cookie === null, `no account: ${show(gone)}`);
  });

  await check('#12 finishSignIn as JSON (the email code): ok with the redirect and a 30-day email cookie; suspended and banned refused with their status and no cookie; a step that throws answers failed, logged and captured', async () => {
    seed();
    const ok = await finishSignIn(await getUserById(9), 'email', { respond: 'json' });
    const body = await ok.clone().json();
    assert(ok.status === 200 && show(body) === show({ ok: true, redirect: `${BASE}/ru/dashboard?user_id=9` }), `ok: ${ok.status} ${show(body)}`);
    const c = sessionSetCookie(ok);
    assert(c && S.validateSessionToken(c.value)?.method === 'email' && c.attrs['max-age'] === String(WEB_TTL), `cookie ${show(c)}`);
    userRow(5).suspendedAt = new Date();
    const susp = await finishSignIn(await getUserById(5), 'email', { respond: 'json' });
    assert(susp.status === 403 && show(await susp.json()) === show({ ok: false, status: 'suspended' }) && sessionSetCookie(susp) === null, `suspended ${susp.status}`);
    DB.blockedIdentifier.push({ id: 1, telegramId: BigInt(111111111), whatsappPhone: null, bannedBy: 5, bannedReason: null, createdAt: new Date() });
    const banned = await finishSignIn(await getUserById(9), 'google', { respond: 'json' });
    assert(banned.status === 403 && show(await banned.json()) === show({ ok: false, status: 'blocked' }) && sessionSetCookie(banned) === null, `banned ${banned.status}`);
    captured.length = 0;
    const secret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = '';
    try {
      const failed = await finishSignIn(await getUserById(42), 'tg');
      assert(failed.headers.get('location') === `${BASE}/he/signin?status=failed` && sessionSetCookie(failed) === null, `failed: ${failed.headers.get('location')}`);
      assert(captured.some(x => x.startsWith('signin-finish:')), `captured ${show(captured)}`);
    } finally {
      process.env.SESSION_SECRET = secret;
    }
  });

  await check('#13 verifyUserAuth\'s success says how the request was proved: a session carries its cookie (method and sign-in time), Telegram carries none', async () => {
    seed();
    const AT = Date.now() - 5000;
    const req = (cookie?: string) => new NextRequest(`${BASE}/api/x?user_id=42`, { headers: cookie ? { cookie: `${NAME}=${cookie}` } : {} });
    const viaSession = await verifyUserAuth(req(S.createSessionToken(42, 'google', AT)), '42', null, limiter, 'smoke');
    assert(viaSession.success && viaSession.via === 'session' && viaSession.session?.method === 'google' && viaSession.session.signedInAt === AT && viaSession.user.id === 42,
      `session: ${show({ via: viaSession.via, session: viaSession.session, user: viaSession.user?.id })}`);
    const viaTelegram = await verifyUserAuth(req(), '111111111', initDataFor(111111111), limiter, 'smoke');
    assert(viaTelegram.success && viaTelegram.via === 'telegram' && !('session' in viaTelegram) && viaTelegram.user.id === 9,
      `telegram: ${show({ via: viaTelegram.via, user: viaTelegram.user?.id })}`);
  });

  await check('#14 no console line holds a session cookie: a sign-in, a renewal and a refusal log the user, the method and the status only', async () => {
    seed();
    const tokens: string[] = [];
    const { lines } = await recordingConsole(async () => {
      const a = await finishSignIn(await getUserById(9), 'tg');
      tokens.push(sessionSetCookie(a)?.value ?? '');
      const old = aged(9, 'tg', Date.now() - 2 * DAY, 2 * DAY, WEB_TTL);
      tokens.push(old);
      const r = await pageData(9, { cookie: old });
      tokens.push(sessionSetCookie(r)?.value ?? '');
      userRow(9).sessionsValidAfter = new Date();
      const late = S.createSessionToken(9, 'tg', Date.now() - 1000);
      tokens.push(late);
      await pageData(9, { cookie: late });
    });
    assert(tokens.every(Boolean), `a token is missing: ${show(tokens.map(Boolean))}`);
    const leaks = lines.filter(l => tokens.some(t => l.includes(t) || l.includes(t.split('.')[0]) || l.includes(t.split('.')[1])));
    assert(leaks.length === 0, `leaks: ${show(leaks)}`);
  });

  await check('#15 signInPageUrl: /signin on the site in the person\'s language (English unprefixed), with the status, absolute', () => {
    const got = [signInPageUrl('en'), signInPageUrl('he', 'no-account'), signInPageUrl('ru', 'restart'), signInPageUrl('xx', 'failed')];
    const want = [`${BASE}/signin`, `${BASE}/he/signin?status=no-account`, `${BASE}/ru/signin?status=restart`, `${BASE}/signin?status=failed`];
    assert(show(got) === show(want), show(got));
  });

  await check('#16 a session\'s end can be kept: createSessionToken with exp keeps that end (never later than the method\'s own life) and setSessionCookie with maxAgeSec sets that Max-Age, so a WhatsApp link\'s fresh cookie after Remove keeps its old end; a bad exp, a bad Max-Age and a token that is not ours are refused', () => {
    const at = Date.now() - 3000;
    const keepExp = nowS() + 3600;
    const kept = S.createSessionToken(42, 'wa', at, { exp: keepExp });
    const s = S.validateSessionToken(kept);
    assert(s && s.method === 'wa' && s.exp === keepExp && s.signedInAt === at, `kept: ${show(s)}`);
    const res = NextResponse.json({});
    S.setSessionCookie(res, kept, { maxAgeSec: 3600 });
    const c = sessionSetCookie(res);
    assert(c && c.value === kept && c.attrs['max-age'] === '3600' && c.attrs.secure === true && c.attrs.httponly === true && c.attrs.path === '/',
      `cookie ${show(c)}`);
    const plain = NextResponse.json({});
    S.setSessionCookie(plain, S.createSessionToken(42, 'wa', at));
    assert(sessionSetCookie(plain)?.attrs['max-age'] === String(WA_TTL), `the default life of a WhatsApp link: ${show(sessionSetCookie(plain)?.attrs)}`);
    const longer = S.validateSessionToken(S.createSessionToken(42, 'wa', at, { exp: nowS() + 10 * WA_TTL }));
    assert(longer && longer.exp - longer.iat === WA_TTL, `an exp past the method's life was kept: ${show(longer)}`);
    const refusals: [string, () => unknown][] = [
      ['an exp in the past', () => S.createSessionToken(42, 'wa', at, { exp: nowS() - 5 })],
      ['a zero Max-Age', () => S.setSessionCookie(NextResponse.json({}), kept, { maxAgeSec: 0 })],
      ['a fractional Max-Age', () => S.setSessionCookie(NextResponse.json({}), kept, { maxAgeSec: 1.5 })],
      ['a token that is not ours', () => S.setSessionCookie(NextResponse.json({}), 'x.y')],
    ];
    for (const [label, fn] of refusals) {
      let thrown = false;
      try { fn(); } catch { thrown = true; }
      assert(thrown, `${label} was accepted`);
    }
  });

  await check('#17 signInRefusal is the one refusal rule: null for an account in good standing, \'suspended\' first, then \'blocked\' for a banned Telegram id or WhatsApp number; finishSignIn acts on the same answer with no cookie, which is what Add Google and the calendar match do before they attach a way', async () => {
    seed();
    const acct = (id: number, over: Row = {}) => ({ id, language: 'en', suspendedAt: null, telegramId: null, whatsappPhone: null, ...over });
    assert((await signInRefusal(acct(5, { telegramId: BigInt(5550005) }))) === null, 'an account in good standing was refused');
    assert((await signInRefusal(acct(5, { suspendedAt: new Date() }))) === 'suspended', 'suspended');
    DB.blockedIdentifier.push({ id: 1, telegramId: BigInt(111111111), whatsappPhone: null, bannedBy: 5, bannedReason: null, createdAt: new Date() });
    DB.blockedIdentifier.push({ id: 2, telegramId: null, whatsappPhone: PHONE, bannedBy: 5, bannedReason: null, createdAt: new Date() });
    const banned = acct(9, { telegramId: BigInt(111111111) });
    const bannedPhone = acct(42, { whatsappPhone: PHONE });
    assert((await signInRefusal(banned)) === 'blocked', 'a banned Telegram id');
    assert((await signInRefusal(bannedPhone)) === 'blocked', 'a banned WhatsApp number');
    assert((await signInRefusal({ ...banned, suspendedAt: new Date() })) === 'suspended', 'suspended and banned: suspended first');
    for (const [account, status] of [[banned, 'blocked'], [{ ...banned, suspendedAt: new Date() }, 'suspended']] as const) {
      const res = await finishSignIn(account, 'google', { respond: 'json' });
      assert(res.status === 403 && show(await res.json()) === show({ ok: false, status }) && sessionSetCookie(res) === null, `finishSignIn for ${status}: ${res.status}`);
    }
  });

  await check('#18 signInHref is the one /signin path builder (English and an unknown language unprefixed, he and ru under their prefix, the status as ?status=); signInPageUrl is that path on the site\'s address; src/site/signin.ts imports nothing server-side (the sign-in page and Settings are client components)', () => {
    const got = [signInHref('en'), signInHref('he'), signInHref('ru'), signInHref('xx'), signInHref('he', 'taken'), signInHref('ru', 'has-one'), signInHref('en', 'no-account'), signInHref('xx', 'failed')];
    const want = ['/signin', '/he/signin', '/ru/signin', '/signin', '/he/signin?status=taken', '/ru/signin?status=has-one', '/signin?status=no-account', '/signin?status=failed'];
    assert(show(got) === show(want), show(got));
    for (const locale of ['en', 'he', 'ru', 'xx']) {
      for (const status of [undefined, 'suspended', 'taken', 'has-one']) {
        assert(signInPageUrl(locale, status) === new URL(signInHref(locale, status), BASE).toString(), `signInPageUrl(${locale}, ${status}) is not signInHref on the site`);
      }
    }
    const webSession = read('src/lib/web-session.ts');
    assert(!/['"`]\/signin/.test(webSession.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'web-session.ts writes a /signin path of its own');
    const src = read('src/site/signin.ts');
    const imports = [...src.matchAll(/^import (type )?[^;]*? from '([^']+)';/gm)].map(m => ({ type: !!m[1], from: m[2] }));
    const serverSide = /prisma|redis|server-only|^next\/(headers|server)|session-auth|api-auth|\/services\/|error-capture|user-moderation|app-keys/;
    const bad = imports.filter(i => serverSide.test(i.from) || (i.from.endsWith('/web-session') && !i.type));
    assert(imports.length > 0 && bad.length === 0, `src/site/signin.ts imports ${show(bad)}`);
  });

  await check('#19 every landing is in the person\'s language with English unprefixed and an unknown language as English (localePrefix as-needed): the dashboard and Select calendars after a sign-in, the JSON redirect, a refusal\'s /signin?status=, the WhatsApp link (a fresh one and a stale one), and /dashboard with no user_id; /en/ is never written', async () => {
    seed();
    const acct = (language: string, suspendedAt: Date | null = null) => ({ id: 5, language, suspendedAt, telegramId: null, whatsappPhone: null });
    const places: [string, string][] = [['he', '/he'], ['en', ''], ['ru', '/ru'], ['xx', ''], ['', '']];
    const seen: string[] = [];
    for (const [language, prefix] of places) {
      const dash = await finishSignIn(acct(language), 'tg');
      const cal = await finishSignIn(acct(language), 'wa', { page: 'select-calendars' });
      const json = await finishSignIn(acct(language), 'email', { respond: 'json' });
      const refused = await finishSignIn(acct(language, new Date()), 'tg');
      const got = {
        dashboard: dash.headers.get('location'),
        calendars: cal.headers.get('location'),
        json: ((await json.json()) as Row).redirect,
        refused: refused.headers.get('location'),
        built: appPageUrl(language, 'dashboard', 5),
      };
      const want = {
        dashboard: `${BASE}${prefix}/dashboard?user_id=5`,
        calendars: `${BASE}${prefix}/select-calendars?user_id=5`,
        json: `${BASE}${prefix}/dashboard?user_id=5`,
        refused: `${BASE}${prefix}/signin?status=suspended`,
        built: `${BASE}${prefix}/dashboard?user_id=5`,
      };
      assert(show(got) === show(want), `language ${show(language)}: ${show(got)} (want ${show(want)})`);
      seen.push(...Object.values(got).map(String));
    }
    assert(seen.every(u => !u.includes('/en/')), `an /en/ path was written: ${show(seen.filter(u => u.includes('/en/')))}`);
    // The WhatsApp link: the person's own language (user 5 is English), a stale link's card in the link's language.
    const tap = async (link: string) => (await magicRoute.GET(new NextRequest(link))).headers.get('location');
    assert((await tap(await generateMagicLink(5, 'ru'))) === `${BASE}/dashboard?user_id=5`, 'the link of an English-speaking person');
    assert((await tap(await generateMagicLink(5, 'en', 'select-calendars'))) === `${BASE}/select-calendars?user_id=5`, 'Select calendars in English');
    assert((await tap(`${BASE}/api/auth/magic?token=stale&locale=en`)) === `${BASE}/dashboard`, 'the card of a stale English link');
    assert((await tap(`${BASE}/api/auth/magic?token=stale&locale=he`)) === `${BASE}/he/dashboard`, 'the card of a stale Hebrew link');
    // /dashboard with no user_id and a valid cookie.
    jar.set(NAME, S.createSessionToken(42, 'google', Date.now() - 1000));
    for (const [locale, prefix] of [['he', '/he'], ['en', ''], ['ru', '/ru']] as const) {
      const r = await dashboard(locale);
      assert(r.thrown?.includes(`;${prefix}/dashboard?user_id=42;`) && !r.thrown.includes('/en/'), `/dashboard in ${locale}: ${show(r)}`);
    }
    jar.delete(NAME);
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

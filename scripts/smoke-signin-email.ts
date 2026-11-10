// Smoke test for email sign-in codes (6b plan, Task 5; spec docs/superpowers/specs/2026-11-02-web-sign-in-design.md
// §2.5, §3 "Email", §5): POST /api/auth/email/request, POST /api/auth/email/verify, src/services/web-signin/email-code.ts
// and email-send.ts.
//
// What it pins:
//   - one answer for everyone: a known and an unknown address get the same status, body and flow cookie, and do the
//     same work before the answer (the limits and the flow; no query, no email: the lookup, the code and the send run
//     in after()); a text that is no address, and a Kelvin-sign (U+212A) look-alike of a real one, get it too and mail
//     nothing;
//   - the limits: asked before the lookup, for unknown addresses too; a held-back request gets the same answer, looks
//     nothing up and mails nothing, and a code already sent keeps working; a check while wrong codes are paused is
//     refused before the code is touched; a wrong or expired code is counted as wrong, for unknown addresses too;
//   - the code: 6 digits, to the address stored on the account (never the typed text), in the person's language
//     (Hebrew right to left), from FamCal <signin@famcal.bot> with replies to privacy@famcal.bot and an Idempotency-Key
//     a retry repeats; kept only as a keyed hash for 10 minutes; a new one replaces the old; the try is counted before
//     the compare; 5 tries void it; a right one signs in once and is used up;
//   - two code requests in one browser (two tabs): a code sent under the other tab's flow cookie is the generic "wrong"
//     and never signs in the other flow's account; the other tab's own code still works;
//   - the finish: the session cookie for method 'email', the flow cookie cleared, the last-used date; a suspended or
//     banned account, a removed email way and a missing flow each get their answer and no session;
//   - the send: a refusal, a 5xx and no answer are logged with the user id and the status, never the address or the
//     code; a spent day's budget stores and mails nothing and leaves the last code working; a failed send puts the
//     earlier code back (with its tries), a delivered new code starts its tries again but not the day's wrong codes;
//     a finish that fails answers 'failed' with HTTP 500;
//   - no console line or error report holds an address, a code or the Resend key.
//
// Real: both routes, email-code, email-send, the account lookups (identities.ts), fetch-retry, the flow cookie
// (flow.ts), the address checks (email-address.ts), the Origin guard, the client address, the session cookie and
// finishSignIn. Faked at the
// boundaries: Prisma (in memory), Redis (in memory), the limits module (src/services/web-signin/limits.ts: scripted
// answers, every call recorded; its counting is Task 3's smoke), Telegram, the admin notifier, error capture, Next's
// after() (queued, then run) and fetch (Resend scripted, anything else blocked). No network, no DB.
//
// Run with the fake env from scripts/ci-smokes.sh:
//   npx tsx scripts/smoke-signin-email.ts

import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

// Test values only; the fake env leaves these empty.
process.env.SESSION_SECRET ||= 'smoke-session-secret';
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.bot';
const RESEND_KEY = 're_smoke_not_a_real_key';
process.env.RESEND_API_KEY = RESEND_KEY;
// Email sign-up is off here (no Turnstile): 6b's behaviour, an address on no account is mailed nothing
delete process.env.TURNSTILE_SITE_KEY;
delete process.env.TURNSTILE_SECRET;

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

// ---- What the code says: console lines, error reports, admin messages ----

const logs: string[] = [];
const captured: string[] = [];
const adminMessages: string[] = [];
const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
const lineOf = (args: unknown[]) =>
  args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : show(a))).join(' ');
function hushConsole() {
  const keep = (...args: unknown[]) => { logs.push(lineOf(args)); };
  console.log = keep;
  console.info = keep;
  console.warn = keep;
  console.error = keep;
}

/** The boundary work in order: redis.<op>:<key prefix>, prisma.<model>.<op>, limits.<fn>, fetch.resend. */
const trace: string[] = [];

// ---- Fake Prisma: in-memory tables, a relation `user` joined by userId ----

const DB: Record<string, Row[]> = {};
const isPlain = (v: unknown): v is Row => v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);
function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') return a != null && b != null && String(a) === String(b);
  return a === b;
}
const num = (x: unknown) => (x instanceof Date ? x.getTime() : Number(x));
const OPERATORS = ['equals', 'in', 'not', 'lt', 'lte', 'gt', 'gte'];

function matches(row: Row, where?: Row): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    if (k === 'OR') return (cond as Row[]).some(c => matches(row, c));
    if (k === 'AND') return ([] as Row[]).concat(cond).every(c => matches(row, c));
    if (k === 'NOT') return !([] as Row[]).concat(cond).some(c => matches(row, c));
    const v = row[k];
    if (isPlain(cond)) {
      // A compound unique (kind_subject: { kind, subject }) holds the row's own fields.
      if (!Object.keys(cond).some(o => OPERATORS.includes(o))) return matches(row, cond);
      if ('equals' in cond && !same(v ?? null, cond.equals)) return false;
      if ('in' in cond && !(cond.in as unknown[]).some(x => same(v, x))) return false;
      if ('not' in cond && same(v ?? null, cond.not)) return false;
      if ('lt' in cond && !(v != null && num(v) < num(cond.lt))) return false;
      if ('lte' in cond && !(v != null && num(v) <= num(cond.lte))) return false;
      if ('gt' in cond && !(v != null && num(v) > num(cond.gt))) return false;
      if ('gte' in cond && !(v != null && num(v) >= num(cond.gte))) return false;
      return true;
    }
    return same(v ?? null, cond);
  });
}

function project(row: Row | undefined, args: Row = {}): Row | null {
  if (!row) return null;
  const spec: Row = args.select ?? args.include ?? {};
  const out: Row = args.select ? {} : { ...row };
  for (const [k, v] of Object.entries(spec)) {
    if (!v) continue;
    if (k === 'user' && 'userId' in row) {
      const user = (DB.user ?? []).find(u => u.id === row.userId);
      out.user = isPlain(v) ? project(user, v) : user ? { ...user } : null;
    } else if (args.select) {
      out[k] = row[k];
    }
  }
  return out;
}

function applyData(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (isPlain(v) && 'increment' in v) row[k] = (row[k] ?? 0) + v.increment;
    else if (isPlain(v) && 'set' in v) row[k] = v.set;
    else row[k] = v;
  }
}

let nextId = 1000;
function model(name: string): Row {
  const t = () => (DB[name] ??= []);
  const missing = () => Object.assign(new Error(`No ${name} record was found.`), { code: 'P2025' });
  const impl: Row = {
    findUnique: async (a: Row = {}) => project(t().find(r => matches(r, a.where)), a),
    findFirst: async (a: Row = {}) => project(t().find(r => matches(r, a.where)), a),
    findMany: async (a: Row = {}) => t().filter(r => matches(r, a.where)).map(r => project(r, a)),
    count: async (a: Row = {}) => t().filter(r => matches(r, a.where)).length,
    create: async (a: Row) => {
      const row: Row = { id: ++nextId, createdAt: new Date() };
      applyData(row, a.data);
      t().push(row);
      return project(row, a);
    },
    update: async (a: Row) => {
      const row = t().find(r => matches(r, a.where));
      if (!row) throw missing();
      applyData(row, a.data);
      return project(row, a);
    },
    updateMany: async (a: Row) => {
      const rows = t().filter(r => matches(r, a.where));
      rows.forEach(r => applyData(r, a.data));
      return { count: rows.length };
    },
    delete: async (a: Row) => {
      const i = t().findIndex(r => matches(r, a.where));
      if (i < 0) throw missing();
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
    Object.entries(impl).map(([k, fn]) => [k, (...args: unknown[]) => { trace.push(`prisma.${name}.${k}`); return fn(...args); }]),
  );
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

// ---- Fake Redis (Upstash parses JSON on read); every call is traced by its key's first two parts ----

const redisStore = new Map<string, string>();
const redisTtl = new Map<string, number>();
const decode = (raw: string | undefined) => {
  if (raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return raw; }
};
const encode = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
const keyPrefix = (k: string) => k.split(':').slice(0, 2).join(':');
const redisImpl: Row = {
  get: async (k: string) => decode(redisStore.get(k)),
  set: async (k: string, v: unknown, o?: Row) => {
    if (o?.nx && redisStore.has(k)) return null;
    redisStore.set(k, encode(v));
    if (o?.ex) redisTtl.set(k, Number(o.ex));
    else redisTtl.delete(k);
    return 'OK';
  },
  // Reads and deletes in one tick, as GETDEL does.
  getdel: async (k: string) => {
    const raw = redisStore.get(k);
    redisStore.delete(k);
    redisTtl.delete(k);
    return decode(raw);
  },
  del: async (...ks: unknown[]) =>
    ks.flat().reduce((n: number, k) => {
      redisTtl.delete(String(k));
      return n + (redisStore.delete(String(k)) ? 1 : 0);
    }, 0),
  incr: async (k: string) => {
    const n = Number(redisStore.get(k) ?? 0) + 1;
    redisStore.set(k, String(n));
    return n;
  },
  expire: async (k: string, seconds: number) => {
    if (!redisStore.has(k)) return 0;
    redisTtl.set(k, seconds);
    return 1;
  },
  exists: async (...ks: string[]) => ks.filter(k => redisStore.has(k)).length,
  ttl: async (k: string) => (redisStore.has(k) ? redisTtl.get(k) ?? -1 : -2),
};
const fakeRedis = new Proxy(redisImpl, {
  get(t, p) {
    if (typeof p !== 'string' || p === 'then') return undefined;
    const fn = t[p];
    if (!fn) return () => { throw new Error(`the smoke's Redis has no ${p}()`); };
    return (...args: unknown[]) => {
      trace.push(`redis.${p}:${keyPrefix(String(args[0]))}`);
      return fn(...args);
    };
  },
});

// ---- The limits (Task 3's module), scripted ----

type Verdict = { ok: true } | { ok: false; reason: string };
let requestVerdict: Verdict = { ok: true };
let wrongCodesPaused = false;
let dailySendLeft = true;
const limitCalls: { fn: string; args: Row }[] = [];
const limitsStub = {
  allowCodeRequest: async (args: Row) => {
    trace.push('limits.allowCodeRequest');
    limitCalls.push({ fn: 'allowCodeRequest', args });
    return requestVerdict;
  },
  codeChecksBlocked: async (args: Row) => {
    trace.push('limits.codeChecksBlocked');
    limitCalls.push({ fn: 'codeChecksBlocked', args });
    return wrongCodesPaused;
  },
  recordWrongCode: async (args: Row) => {
    trace.push('limits.recordWrongCode');
    limitCalls.push({ fn: 'recordWrongCode', args });
  },
  takeDailySend: async () => {
    trace.push('limits.takeDailySend');
    limitCalls.push({ fn: 'takeDailySend', args: {} });
    return dailySendLeft;
  },
  // The sign-up code's share (6c-1 Task 4): never asked here, since email sign-up is off without Turnstile
  takeSignUpSend: async (ip: unknown) => {
    trace.push('limits.takeSignUpSend');
    limitCalls.push({ fn: 'takeSignUpSend', args: { ip } });
    return { ok: false, reason: 'signup-day' };
  },
  // What the real one does in one Lua call: INCR, and EXPIRE when the key has none. Not traced as a Redis call, so
  // an INCR or EXPIRE of email-code's own would show in the trace.
  countWithin: async (key: string, windowSec: number) => {
    trace.push('limits.countWithin');
    limitCalls.push({ fn: 'countWithin', args: { key, windowSec } });
    const n = await redisImpl.incr(key);
    if (!redisTtl.has(key)) await redisImpl.expire(key, windowSec);
    return n;
  },
};

// ---- fetch: Resend scripted, everything else blocked ----

type ResendCall = { headers: Headers; body: Row };
const resendCalls: ResendCall[] = [];
/** Each entry answers one Resend call (return a Response, or throw for no answer); when empty, 200 with an id. */
let resendScript: (() => Response)[] = [];
const seenCodes = new Set<string>();

async function fakeFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== 'https://api.resend.com/emails') throw new Error(`network blocked in smoke: ${url}`);
  trace.push('fetch.resend');
  const body = JSON.parse(String(init?.body)) as Row;
  resendCalls.push({ headers: new Headers(init?.headers), body });
  const code = /\b(\d{6})\b/.exec(String(body.text))?.[1];
  if (code) seenCodes.add(code);
  const next = resendScript.shift();
  if (next) return next();
  return new Response(JSON.stringify({ id: `email-${resendCalls.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- Next's after(): queued, run by drainAfter() ----

const afterQueue: (() => unknown)[] = [];
async function drainAfter() {
  while (afterQueue.length) await afterQueue.shift()!();
}

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
  const capture = (e: unknown, ctx: string, extra?: unknown) => {
    captured.push(`${ctx}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)} ${show(extra ?? {})}`);
  };
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
  stub('src/utils/error-notifier.ts', {
    getAdminUserIds: async () => [],
    notifyAdminError: async (ctx: string, e: unknown) => { adminMessages.push(`${ctx}: ${String(e)}`); },
    notifyAdminWarning: async (ctx: string, message: string) => { adminMessages.push(`${ctx}: ${message}`); },
    notifyAdminFeedback: async () => undefined,
  });
  const recorder = (): Row =>
    new Proxy({} as Row, {
      get: (_t, p) => (typeof p !== 'string' || p === 'then' ? undefined : async () => ({ message_id: 1 })),
    });
  const telegram = { getBot: () => recorder(), getMessagingService: () => recorder() };
  stub('src/services/telegram/index.ts', telegram);
  stub('src/services/telegram/bot.ts', telegram);
  stub('src/services/web-signin/limits.ts', limitsStub);

  const nextServer = nodeRequire('next/server');
  nextServer.after = (task: unknown) => {
    afterQueue.push(typeof task === 'function' ? (task as () => unknown) : () => task);
  };
  globalThis.fetch = fakeFetch as typeof fetch;
}

// ---- Fixtures ----

const DAY = 86_400_000;
/** The addresses as each account stores them (the address to show; the subject is its normalised form). */
const ADDR = {
  dana: 'Dana.Levi@Example.com',
  sus: 'sus@example.com',
  ban: 'ban@example.com',
  kim: 'kim@example.com',
  olga: 'olga@example.com',
};
const UNKNOWN = 'nobody@example.com';

function baseUser(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', culture: 'default',
    messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null, calendarSource: 'NATIVE',
    pairingId: null, remindersEnabled: false, suspendedAt: null, unreachableSince: null, whatsappPhone: null,
    whatsappBsuid: null, telegramId: null, isAdmin: false, globalRules: [], voiceInputEnabled: true,
    textSummaryEnabled: true, voiceSummaryEnabled: false, weatherEnabled: true, defaultReminderMinutes: null,
    sessionsValidAfter: null, googleAccountKey: null, googleCalendarSignIn: true,
    createdAt: new Date(Date.now() - 30 * DAY), updatedAt: new Date(Date.now() - DAY),
    ...o,
  };
}

const identity = (id: number, userId: number, address: string): Row => ({
  id, userId, kind: 'email', subject: address.toLowerCase(), address, createdAt: new Date(Date.now() - 9 * DAY), lastUsedAt: null,
});

/** 1 Dana (he), 2 suspended (en), 3 banned by Telegram id (en), 4 Kim (en), 5 Olga, WhatsApp only (ru). */
function seed() {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  redisTtl.clear();
  trace.length = 0;
  limitCalls.length = 0;
  resendCalls.length = 0;
  resendScript = [];
  afterQueue.length = 0;
  requestVerdict = { ok: true };
  wrongCodesPaused = false;
  dailySendLeft = true;
  DB.user = [
    baseUser({ id: 1, name: 'Dana', telegramId: BigInt(5550001), language: 'he' }),
    baseUser({ id: 2, name: 'Sam', telegramId: BigInt(5550002), suspendedAt: new Date(Date.now() - DAY) }),
    baseUser({ id: 3, name: 'Bo', telegramId: BigInt(7770003) }),
    baseUser({ id: 4, name: 'Kim', telegramId: BigInt(5550004) }),
    baseUser({ id: 5, name: 'Olga', messagingPlatform: 'whatsapp', whatsappPhone: '972500000005', language: 'ru' }),
  ];
  DB.signInIdentity = [
    identity(11, 1, ADDR.dana),
    identity(12, 2, ADDR.sus),
    identity(13, 3, ADDR.ban),
    identity(14, 4, ADDR.kim),
    identity(15, 5, ADDR.olga),
  ];
  DB.blockedIdentifier = [{ id: 1, telegramId: BigInt(7770003), whatsappPhone: null, createdAt: new Date() }];
}

const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));
const wrongOf = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
const jsonOf = async (res: Response): Promise<Row | null> => res.clone().json().catch(() => null);

async function main() {
  installStubs();
  hushConsole();

  const { NextRequest } = nodeRequire('next/server');
  const retry = await load('src/utils/fetch-retry.ts');
  retry.__useRetryForTests({ sleep: async () => undefined, random: () => 0 });
  const requestRoute = await load('app/api/auth/email/request/route.ts');
  const verifyRoute = await load('app/api/auth/email/verify/route.ts');
  const { SIGNIN_COOKIE_NAME } = await load('src/services/web-signin/flow.ts');
  const { emailKey } = await load('src/services/web-signin/email-address.ts');
  const { SESSION_COOKIE_NAME, validateSessionToken } = await load('src/lib/session-auth.ts');
  const { REDIS_KEYS } = await load('src/config/redis-keys.ts');
  const MESSAGES: Row = {
    en: nodeRequire(path.join(ROOT, 'messages/en.json')),
    he: nodeRequire(path.join(ROOT, 'messages/he.json')),
    ru: nodeRequire(path.join(ROOT, 'messages/ru.json')),
  };

  const ORIGIN = 'https://famcal.bot';
  const IP = '203.0.113.7';
  const post = (route: string, body: unknown, o: { cookie?: string; origin?: string } = {}) =>
    new NextRequest(`${ORIGIN}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: o.origin ?? ORIGIN, 'x-real-ip': IP, ...(o.cookie ? { cookie: o.cookie } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const ask = async (email: unknown, o: { origin?: string } = {}) => {
    const res = await requestRoute.POST(post('/api/auth/email/request', { email, locale: 'en' }, o));
    const value = res.cookies.get(SIGNIN_COOKIE_NAME)?.value;
    return { res, status: res.status as number, body: await jsonOf(res), cookie: value ? `${SIGNIN_COOKIE_NAME}=${value}` : undefined };
  };
  const verify = async (cookie: string | undefined, code: unknown, o: { origin?: string } = {}) => {
    const res = await verifyRoute.POST(post('/api/auth/email/verify', { code }, { cookie, origin: o.origin }));
    return { res, status: res.status as number, body: await jsonOf(res) };
  };
  /** Asks for a code, runs the after() work, and returns the email it sent (null when none) and the code in it. */
  const codeFor = async (email: string) => {
    const before = resendCalls.length;
    const asked = await ask(email);
    await drainAfter();
    const call = resendCalls.length > before ? resendCalls[resendCalls.length - 1] : null;
    const code = call ? /\b(\d{6})\b/.exec(String(call.body.text))?.[1] ?? null : null;
    return { ...asked, call, code };
  };
  const sessionOf = (res: Row) => {
    const value = res.cookies.get(SESSION_COOKIE_NAME)?.value;
    return value ? validateSessionToken(value) : null;
  };
  const calls = (fn: string) => limitCalls.filter(c => c.fn === fn);

  // ---- One answer for everyone ----

  await check('#1 a known and an unknown address get the same status, body and flow cookie, and the same work before the answer (the limits and the flow, no query, no email); only the known one is mailed, after the answer', async () => {
    seed();
    const known = await ask('dana.levi@example.com');
    const knownWork = [...trace];
    const knownQueued = afterQueue.length;
    trace.length = 0;
    const unknown = await ask(UNKNOWN);
    const unknownWork = [...trace];
    const unknownQueued = afterQueue.length - knownQueued;
    assert(known.status === 200 && unknown.status === 200, `status ${known.status} / ${unknown.status}`);
    assert(show(known.body) === show({ ok: true }) && show(unknown.body) === show(known.body), `bodies ${show(known.body)} / ${show(unknown.body)}`);
    assert(known.cookie && unknown.cookie, 'a flow cookie for both');
    assert(show(knownWork) === show(unknownWork), `the work before the answer differs: ${show(knownWork)} / ${show(unknownWork)}`);
    assert(knownWork.includes('limits.allowCodeRequest'), `the limits were not asked: ${show(knownWork)}`);
    assert(!knownWork.some(w => w.startsWith('prisma.') || w === 'fetch.resend'), `looked up or mailed before the answer: ${show(knownWork)}`);
    assert(knownQueued === 1 && unknownQueued === 1, `after() tasks ${knownQueued} / ${unknownQueued}`);
    const mark = logs.length;
    await drainAfter();
    assert(resendCalls.length === 1, `emails sent: ${resendCalls.length}`);
    assert(show(resendCalls[0].body.to) === show([ADDR.dana]), `to ${show(resendCalls[0].body.to)}`);
    assert(logs.slice(mark).some(l => l.includes('no account signs in with this address')), `no line for the unknown address: ${show(logs.slice(mark))}`);
    const asked = calls('allowCodeRequest');
    assert(asked.length === 2 && asked.every(c => c.args.ip === IP && c.args.addForUserId === undefined), `limit asks: ${show(asked)}`);
    assert(asked[0].args.emailKey === emailKey('dana.levi@example.com') && asked[1].args.emailKey === emailKey(UNKNOWN), 'each ask carries its own address key');
    assert(calls('takeSignUpSend').length === 0, 'the sign-up share was asked with email sign-up off');
  });

  await check('#2 a text that is no usable address, and a Kelvin-sign (U+212A) look-alike of kim@example.com, get the same answer, are counted against the IP, and mail nothing', async () => {
    seed();
    for (const text of ['not-an-email', 'Kim@example.com', 'kim@example.com​', 42, null]) {
      const before = resendCalls.length;
      const asksBefore = calls('allowCodeRequest').length;
      const r = await ask(text);
      assert(r.status === 200 && show(r.body) === show({ ok: true }) && r.cookie, `${show(text)}: ${r.status} ${show(r.body)}`);
      assert(calls('allowCodeRequest').length === asksBefore + 1, `${show(text)}: the IP limit was not asked`);
      await drainAfter();
      assert(resendCalls.length === before, `${show(text)} was mailed: ${show(resendCalls.slice(before).map(c => c.body.to))}`);
    }
  });

  // ---- The email ----

  await check('#3 the code goes to the address stored on the account, not the typed text, in Hebrew right to left, from FamCal <signin@famcal.bot> with replies to privacy@famcal.bot, with the key and an Idempotency-Key', async () => {
    seed();
    const { call, code } = await codeFor('  DANA.Levi@EXAMPLE.com ');
    assert(call && code, `no email: ${show(logs.slice(-5))}`);
    assert(show(call.body.to) === show([ADDR.dana]), `to ${show(call.body.to)}`);
    const he = MESSAGES.he.signinEmail;
    assert(call.body.subject === he.signin.subject.replace('{code}', code), `subject ${call.body.subject}`);
    assert(call.body.from === 'FamCal <signin@famcal.bot>' && call.body.reply_to === 'privacy@famcal.bot', `from ${call.body.from}, reply_to ${call.body.reply_to}`);
    const text = String(call.body.text);
    assert(text.includes(code) && text.includes(he.signin.body) && text.includes(he.expiry), 'the text part');
    const html = String(call.body.html);
    assert(html.includes('lang="he"') && html.includes('dir="rtl"') && html.includes('direction:rtl'), 'the HTML is not right to left');
    assert(html.includes(he.signin.heading) && html.includes(code) && html.includes(he.warning), 'the HTML misses its words');
    assert(call.headers.get('authorization') === `Bearer ${RESEND_KEY}`, 'no Resend key');
    const idem = call.headers.get('idempotency-key') ?? '';
    assert(idem.length > 0 && idem.length <= 256 && !idem.includes(code), `Idempotency-Key of ${idem.length} characters`);
  });

  await check('#4 the email is in the account\'s own language: Russian for a Russian account, English for an English one', async () => {
    seed();
    const ru = await codeFor('olga@example.com');
    assert(ru.call && ru.code && ru.call.body.subject === MESSAGES.ru.signinEmail.signin.subject.replace('{code}', ru.code), `ru subject ${ru.call?.body.subject}`);
    assert(String(ru.call.body.html).includes('lang="ru"') && String(ru.call.body.html).includes('dir="ltr"'), 'ru HTML');
    const en = await codeFor('kim@example.com');
    assert(en.call && en.code && en.call.body.subject === MESSAGES.en.signinEmail.signin.subject.replace('{code}', en.code), `en subject ${en.call?.body.subject}`);
  });

  await check('#5 the code is stored only as a keyed hash, for 10 minutes, under a key with no address in it', async () => {
    seed();
    const { code } = await codeFor('kim@example.com');
    assert(code, 'no code');
    const key = REDIS_KEYS.signinCode('signin', emailKey('kim@example.com'));
    const record = decode(redisStore.get(key));
    assert(isPlain(record) && /^[0-9a-f]{64}$/.test(String(record.hash)) && record.userId === 4, `record ${show(record)}`);
    assert(redisTtl.get(key) === 600, `ttl ${redisTtl.get(key)}`);
    const codeRe = new RegExp(`\\b${code}\\b`);
    for (const [k, v] of redisStore) {
      assert(!codeRe.test(k) && !codeRe.test(v), `the code is in Redis under ${k}`);
      assert(!k.toLowerCase().includes('kim'), `an address in a Redis key: ${k}`);
    }
  });

  // ---- The check ----

  await check('#6 a new code replaces the old one; the right code signs in once: the session cookie (email), the flow cookie cleared, the last-used date; the same code again is wrong', async () => {
    seed();
    const first = await codeFor('dana.levi@example.com');
    const second = await codeFor('dana.levi@example.com');
    assert(first.code && second.code, 'no codes');
    if (first.code !== second.code) {
      const old = await verify(second.cookie, first.code);
      assert(old.body?.ok === false && old.body.error === 'wrong', `the old code: ${show(old.body)}`);
    }
    const ok = await verify(second.cookie, second.code);
    assert(ok.status === 200 && ok.body?.ok === true && String(ok.body.redirect).includes('user_id=1'), `status ${ok.status} ${show(ok.body)}; ${show(captured.slice(-3))}`);
    const session = sessionOf(ok.res);
    assert(session?.userId === 1 && session.method === 'email', `session ${show(session)}`);
    const flowCookie = ok.res.cookies.get(SIGNIN_COOKIE_NAME);
    assert(flowCookie && flowCookie.value === '', `the flow cookie was not cleared: ${show(flowCookie)}`);
    assert(DB.signInIdentity.find(r => r.id === 11)?.lastUsedAt instanceof Date, 'lastUsedAt not set');
    assert(calls('recordWrongCode').length === (first.code !== second.code ? 1 : 0), `wrong codes recorded: ${calls('recordWrongCode').length}`);
    const again = await verify(second.cookie, second.code);
    assert(again.body?.ok === false && again.body.error === 'wrong' && !again.res.cookies.get(SESSION_COOKIE_NAME), `a used code again: ${show(again.body)}`);
  });

  await check('#7 the try is counted before the compare, by limits.countWithin with the code\'s own 10 minutes (no INCR and EXPIRE of email-code\'s own); the fifth wrong try voids the code, so the right one after it is refused; the right one on the fifth try works', async () => {
    seed();
    const a = await codeFor('kim@example.com');
    assert(a.code, 'no code');
    trace.length = 0;
    await verify(a.cookie, wrongOf(a.code));
    const triesKey = REDIS_KEYS.signinCodeTries('signin', emailKey('kim@example.com'));
    const counted = trace.indexOf('limits.countWithin');
    const read = trace.indexOf('redis.get:signin:code');
    assert(counted >= 0 && read > counted, `the try was not counted before the compare: ${show(trace)}`);
    const counts = calls('countWithin');
    assert(counts.length === 1 && counts[0].args.key === triesKey && counts[0].args.windowSec === 600, `the try was not counted by limits.countWithin over the code's 10 minutes: ${show(counts)}`);
    assert(redisTtl.get(triesKey) === 600, `the tries' expiry ${redisTtl.get(triesKey)}`);
    assert(!trace.some(w => w.startsWith('redis.incr') || w.startsWith('redis.expire')), `email-code counted the try itself: ${show(trace)}`);
    for (let i = 0; i < 4; i++) await verify(a.cookie, wrongOf(a.code));
    assert(!redisStore.has(REDIS_KEYS.signinCode('signin', emailKey('kim@example.com'))), 'the fifth wrong try did not void the code at once');
    const late = await verify(a.cookie, a.code);
    assert(late.body?.ok === false && late.body.error === 'wrong' && !late.res.cookies.get(SESSION_COOKIE_NAME), `after 5 wrong tries: ${show(late.body)}`);
    assert(!redisStore.has(REDIS_KEYS.signinCode('signin', emailKey('kim@example.com'))), 'the code outlived its fifth wrong try');
    assert(calls('recordWrongCode').length === 6, `wrong codes recorded: ${calls('recordWrongCode').length}`);
    const b = await codeFor('kim@example.com');
    assert(b.code, 'no second code');
    for (let i = 0; i < 4; i++) await verify(b.cookie, wrongOf(b.code));
    const fifth = await verify(b.cookie, b.code);
    assert(fifth.body?.ok === true && sessionOf(fifth.res)?.userId === 4, `the right code on the fifth try: ${show(fifth.body)}`);
  });

  await check('#8 a code for an unknown address gets the same "wrong" answer as a wrong code for a known one, and both are counted as wrong codes for their address and IP; a right code is not', async () => {
    seed();
    const u = await ask(UNKNOWN);
    await drainAfter();
    const r = await verify(u.cookie, '123456');
    assert(r.body?.ok === false && r.body.error === 'wrong', `unknown: ${show(r.body)}`);
    const blockedAsk = calls('codeChecksBlocked');
    assert(blockedAsk.length === 1 && blockedAsk[0].args.emailKey === emailKey(UNKNOWN) && blockedAsk[0].args.ip === IP, `codeChecksBlocked: ${show(blockedAsk)}`);
    const recorded = calls('recordWrongCode');
    assert(recorded.length === 1 && recorded[0].args.emailKey === emailKey(UNKNOWN) && recorded[0].args.ip === IP, `recordWrongCode: ${show(recorded)}`);
    const k = await codeFor('kim@example.com');
    assert(k.code, 'no code');
    const kw = await verify(k.cookie, wrongOf(k.code));
    assert(kw.status === r.status && show(kw.body) === show(r.body), `known wrong ${kw.status} ${show(kw.body)} vs unknown ${r.status} ${show(r.body)}`);
    assert(calls('recordWrongCode').length === 2 && calls('recordWrongCode')[1].args.emailKey === emailKey('kim@example.com'), 'the known wrong code was not recorded');
    const kr = await verify(k.cookie, k.code);
    assert(kr.body?.ok === true, `the right code: ${show(kr.body)}`);
    assert(calls('recordWrongCode').length === 2, 'a right code was recorded as wrong');
    const malformed = await verify(k.cookie, '12ab56');
    assert(malformed.body?.error === 'wrong' && calls('recordWrongCode').length === 2, 'a code that is not 6 digits was counted or accepted');
  });

  await check('#9 while wrong codes are paused for the address or IP, a check is refused as "limited" before the code is touched, and the code works once the pause ends', async () => {
    seed();
    const k = await codeFor('kim@example.com');
    assert(k.code, 'no code');
    wrongCodesPaused = true;
    trace.length = 0;
    const r = await verify(k.cookie, k.code);
    assert(r.body?.ok === false && r.body.error === 'limited' && !r.res.cookies.get(SESSION_COOKIE_NAME), `paused: ${show(r.body)}`);
    assert(!trace.some(w => w === 'limits.countWithin' || w.startsWith('redis.incr') || w.startsWith('redis.getdel') || w.startsWith('prisma.')), `the code was touched: ${show(trace)}`);
    assert(calls('recordWrongCode').length === 0, 'a paused check was recorded as wrong');
    const u = await ask(UNKNOWN);
    const ur = await verify(u.cookie, '123456');
    assert(show(ur.body) === show(r.body), `unknown while paused: ${show(ur.body)}`);
    wrongCodesPaused = false;
    const ok = await verify(k.cookie, k.code);
    assert(ok.body?.ok === true, `after the pause: ${show(ok.body)}`);
  });

  await check('#10 each request limit (a minute, a day per address; an hour per IP): a held-back request gets the same answer and cookie, looks nothing up, mails nothing and logs the reason, for known and unknown addresses; the code already sent still works', async () => {
    for (const reason of ['email-minute', 'email-day', 'ip-hour']) {
      seed();
      const sent = await codeFor('dana.levi@example.com');
      assert(sent.code, `${reason}: no first code`);
      requestVerdict = { ok: false, reason };
      let danaCookie: string | undefined;
      for (const email of ['dana.levi@example.com', UNKNOWN]) {
        trace.length = 0;
        const mark = logs.length;
        const held = await ask(email);
        assert(held.status === 200 && show(held.body) === show({ ok: true }) && held.cookie, `${reason} ${email}: ${held.status} ${show(held.body)}`);
        assert(afterQueue.length === 0, `${reason} ${email}: a held-back request queued a lookup`);
        assert(!trace.some(w => w.startsWith('prisma.') || w === 'fetch.resend'), `${reason} ${email}: ${show(trace)}`);
        assert(logs.slice(mark).some(l => l.includes(reason)), `${reason} ${email}: the reason is not logged`);
        if (email !== UNKNOWN) danaCookie = held.cookie;
      }
      assert(resendCalls.length === 1, `${reason}: emails ${resendCalls.length}`);
      requestVerdict = { ok: true };
      const ok = await verify(danaCookie, sent.code);
      assert(ok.body?.ok === true, `${reason}: the code sent before stopped working: ${show(ok.body)}`);
    }
  });

  // ---- The finish ----

  await check('#11 no flow cookie, a flow gone from Redis, another way\'s flow (left alone), and an email way removed after the code was sent each answer "restart" with no session', async () => {
    seed();
    const k = await codeFor('kim@example.com');
    assert(k.code, 'no code');
    const none = await verify(undefined, k.code);
    assert(none.body?.ok === false && none.body.error === 'restart', `no cookie: ${show(none.body)}`);
    for (const key of [...redisStore.keys()]) if (key.startsWith('signin:flow:')) redisStore.delete(key);
    const gone = await verify(k.cookie, k.code);
    assert(gone.body?.ok === false && gone.body.error === 'restart', `flow gone: ${show(gone.body)}`);
    // Two tabs, two ways (review focus RF1): a code typed in tab 1 after tab 2 started a Telegram sign-in finds no email
    // flow under the cookie; it answers restart and leaves that cookie and its Telegram flow alone
    const { startFlow } = await load('src/services/web-signin/flow.ts');
    const tgStart = nodeRequire('next/server').NextResponse.json({});
    await startFlow(tgStart, { kind: 'telegram', state: 's', nonce: 'n', codeVerifier: 'v', locale: 'en' });
    const tgCookie = `${SIGNIN_COOKIE_NAME}=${tgStart.cookies.get(SIGNIN_COOKIE_NAME)?.value}`;
    const flowKeys = () => [...redisStore.keys()].filter(key => key.startsWith('signin:flow:')).length;
    const flowsBefore = flowKeys();
    const other = await verify(tgCookie, k.code);
    assert(other.body?.ok === false && other.body.error === 'restart' && !other.res.cookies.get(SIGNIN_COOKIE_NAME), `another way's flow: ${show(other.body)} ${show(other.res.cookies.get(SIGNIN_COOKIE_NAME))}`);
    assert(flowsBefore === 1 && flowKeys() === 1, `the Telegram flow was used up: ${flowsBefore} then ${flowKeys()}`);
    const d = await codeFor('dana.levi@example.com');
    assert(d.code, 'no code for Dana');
    DB.signInIdentity = DB.signInIdentity.filter(r => r.id !== 11);
    const removed = await verify(d.cookie, d.code);
    assert(removed.body?.ok === false && removed.body.error === 'restart' && !removed.res.cookies.get(SESSION_COOKIE_NAME), `way removed: ${show(removed.body)}`);
  });

  await check('#12 a suspended account answers "suspended" and a banned one "blocked", with no session cookie', async () => {
    seed();
    const s = await codeFor('sus@example.com');
    assert(s.code, 'no code for the suspended account');
    const sr = await verify(s.cookie, s.code);
    assert(sr.body?.ok === false && sr.body.error === 'suspended' && !sr.res.cookies.get(SESSION_COOKIE_NAME), `suspended: ${show(sr.body)}`);
    const b = await codeFor('ban@example.com');
    assert(b.code, 'no code for the banned account');
    const br = await verify(b.cookie, b.code);
    assert(br.body?.ok === false && br.body.error === 'blocked' && !br.res.cookies.get(SESSION_COOKIE_NAME), `banned: ${show(br.body)}`);
  });

  // ---- The send ----

  await check('#13 Resend\'s refusal is not retried and is logged with the user id and status; a 5xx is retried with the same Idempotency-Key and logs Resend\'s id; no answer gives up after 3 retries; each failure is reported', async () => {
    seed();
    resendScript = [() => new Response('{"name":"validation_error"}', { status: 422 })];
    let mark = logs.length;
    let reports = captured.length;
    await codeFor('dana.levi@example.com');
    assert(resendCalls.length === 1, `a 422 was sent ${resendCalls.length} times`);
    assert(logs.slice(mark).some(l => l.includes('user 1') && l.includes('422')), `no give-up line: ${show(logs.slice(mark))}`);
    assert(captured.length > reports, 'the failed send was not reported');
    resendScript = [() => new Response('{}', { status: 503 })];
    mark = logs.length;
    await codeFor('dana.levi@example.com');
    const [c1, c2] = resendCalls.slice(-2);
    assert((resendCalls.length as number) === 3 && c1.headers.get('idempotency-key') === c2.headers.get('idempotency-key'), 'the retry did not repeat the Idempotency-Key');
    assert(logs.slice(mark).some(l => l.includes('user 1') && l.includes('Resend id email-3')), `no success line: ${show(logs.slice(mark))}`);
    const noAnswer = () => { throw new TypeError('fetch failed'); };
    resendScript = [noAnswer, noAnswer, noAnswer, noAnswer];
    mark = logs.length;
    reports = captured.length;
    await codeFor('kim@example.com');
    assert((resendCalls.length as number) === 7, `no answer: ${resendCalls.length - 3} calls`);
    assert(logs.slice(mark).some(l => l.includes('user 4') && l.includes('no answer')), `no give-up line: ${show(logs.slice(mark))}`);
    assert(captured.length > reports, 'the failed send was not reported');
  });

  await check('#14 a spent day\'s budget: no code is stored or mailed, the line names the user, and the code sent before still works', async () => {
    seed();
    const a = await codeFor('kim@example.com');
    assert(a.code, 'no first code');
    dailySendLeft = false;
    const mark = logs.length;
    const b = await codeFor('kim@example.com');
    assert(b.call === null, 'mailed past the budget');
    assert(calls('takeDailySend').length === 2, `takeDailySend asked ${calls('takeDailySend').length} times`);
    assert(logs.slice(mark).some(l => l.includes('budget') && l.includes('user 4')), `no budget line: ${show(logs.slice(mark))}`);
    const ok = await verify(b.cookie, a.code);
    assert(ok.body?.ok === true, `the code sent before the budget ran out: ${show(ok.body)}`);
  });

  // ---- The guards ----

  await check('#15 another Origin is refused (403) before any work; without RESEND_API_KEY the request is 503 "unavailable" with nothing counted; a body that is not JSON is 400 and its text is not logged', async () => {
    seed();
    const cross = await ask('dana.levi@example.com', { origin: 'https://evil.example' });
    assert(cross.status === 403 && !cross.cookie, `cross-site request: ${cross.status}`);
    const crossVerify = await verify(undefined, '123456', { origin: 'https://evil.example' });
    assert(crossVerify.status === 403, `cross-site verify: ${crossVerify.status}`);
    assert(trace.length === 0 && limitCalls.length === 0, `work before the Origin check: ${show(trace)}`);
    delete process.env.RESEND_API_KEY;
    const off = await ask('dana.levi@example.com');
    process.env.RESEND_API_KEY = RESEND_KEY;
    assert(off.status === 503 && off.body?.error === 'unavailable' && !off.cookie && limitCalls.length === 0, `unconfigured: ${off.status} ${show(off.body)}`);
    const bad = await requestRoute.POST(post('/api/auth/email/request', 'dana.levi@example.com'));
    assert(bad.status === 400, `not JSON: ${bad.status}`);
  });

  await check('#16 two code requests in one browser (two tabs): tab 1 asked for Kim\'s code and tab 2 for Dana\'s, so the browser holds tab 2\'s flow cookie; Kim\'s code sent under it is the generic "wrong" (counted against Dana\'s address, no session, the cookie left alone), Dana\'s own code still signs Dana in; asking twice for one address leaves only the newer code working', async () => {
    seed();
    const tab1 = await codeFor('kim@example.com');
    const tab2 = await codeFor('dana.levi@example.com');
    assert(tab1.code && tab2.code, 'no codes');
    // One chance in a million that the two codes are the same number; then the stale one is made wrong on purpose.
    const stale = tab1.code === tab2.code ? wrongOf(tab1.code) : tab1.code;
    // The browser sends the cookie the last request set: tab 2's.
    const first = await verify(tab2.cookie, stale);
    assert(first.body?.ok === false && first.body.error === 'wrong' && !first.res.cookies.get(SESSION_COOKIE_NAME), `tab 1's code under tab 2's flow: ${show(first.body)}`);
    assert(!first.res.cookies.get(SIGNIN_COOKIE_NAME), `a wrong code touched the flow cookie: ${show(first.res.cookies.get(SIGNIN_COOKIE_NAME))}`);
    const recorded = calls('recordWrongCode');
    assert(recorded.length === 1 && recorded[0].args.emailKey === emailKey('dana.levi@example.com'), `recordWrongCode: ${show(recorded)}`);
    const second = await verify(tab2.cookie, tab2.code);
    assert(second.body?.ok === true && String(second.body.redirect).includes('user_id=1') && sessionOf(second.res)?.userId === 1, `tab 2's own code: ${show(second.body)}`);
    const a = await codeFor('kim@example.com');
    const b = await codeFor('kim@example.com');
    assert(a.code && b.code, 'no codes for the same address twice');
    if (a.code !== b.code) {
      const older = await verify(b.cookie, a.code);
      assert(older.body?.ok === false && older.body.error === 'wrong' && !older.res.cookies.get(SESSION_COOKIE_NAME), `the older code of the same address: ${show(older.body)}`);
    }
    const newer = await verify(b.cookie, b.code);
    assert(newer.body?.ok === true && sessionOf(newer.res)?.userId === 4, `the newer code: ${show(newer.body)}`);
  });

  await check('#18 a failed send puts the earlier code back (with its tries) and leaves none when there was none; a delivered new code starts its tries again while the wrong codes of the day keep counting', async () => {
    seed();
    const kim = emailKey('kim@example.com');
    const codeKey = REDIS_KEYS.signinCode('signin', kim);
    const triesKey = REDIS_KEYS.signinCodeTries('signin', kim);
    const a = await codeFor('kim@example.com');
    assert(a.code && a.cookie, 'no first code');
    for (let i = 0; i < 3; i++) await verify(a.cookie, wrongOf(a.code));
    assert(redisStore.get(triesKey) === '3', `tries before: ${redisStore.get(triesKey)}`);
    redisTtl.set(codeKey, 421);
    resendScript = [() => new Response('{"name":"validation_error"}', { status: 422 })];
    const reports = captured.length;
    const failed = await codeFor('kim@example.com');
    assert(failed.code && failed.code !== a.code, 'the failed send was not attempted with a new code');
    assert(captured.length > reports, 'the failed send was not reported');
    assert(redisTtl.get(codeKey) === 421, `the earlier code's time was not kept: ${redisTtl.get(codeKey)}`);
    assert(redisStore.get(triesKey) === '3', `the earlier code's tries were reset: ${redisStore.get(triesKey)}`);
    const undelivered = await verify(a.cookie, failed.code);
    assert(undelivered.body?.ok === false, 'the code that was never mailed signs in');
    const back = await verify(a.cookie, a.code);
    assert(back.body?.ok === true, `the earlier code does not work after a failed send: ${show(back.body)}`);
    // Nothing before it: a failed send leaves no code behind.
    seed();
    resendScript = [() => new Response('{}', { status: 422 })];
    await codeFor('kim@example.com');
    assert(!redisStore.has(codeKey), 'a code stored by a failed send was left');
    // A delivered new code starts its tries again; the day's wrong codes (limits) are not reset by it.
    seed();
    const c = await codeFor('kim@example.com');
    assert(c.code && c.cookie, 'no code');
    for (let i = 0; i < 3; i++) await verify(c.cookie, wrongOf(c.code));
    const d = await codeFor('kim@example.com');
    assert(d.code, 'no new code');
    assert(!redisStore.has(triesKey), 'a delivered new code kept the old tries');
    assert(calls('recordWrongCode').length === 3, `wrong codes recorded: ${calls('recordWrongCode').length}`);
    const ok = await verify(d.cookie, d.code);
    assert(ok.body?.ok === true, `the new code: ${show(ok.body)}`);
  });

  await check('#19 a sign-in the finish step could not complete answers error "failed" with HTTP 500, as the route\'s own failure does, and clears the flow', async () => {
    seed();
    const k = await codeFor('kim@example.com');
    assert(k.code && k.cookie, 'no code');
    const blocklist = (fakePrisma as Row).blockedIdentifier;
    const real = blocklist.findFirst;
    blocklist.findFirst = async () => { throw new Error('the blocklist read failed'); };
    let r;
    try {
      r = await verify(k.cookie, k.code);
    } finally {
      blocklist.findFirst = real;
    }
    assert(r.status === 500 && r.body?.ok === false && r.body.error === 'failed', `status ${r.status} ${show(r.body)}`);
    assert(!r.res.cookies.get(SESSION_COOKIE_NAME)?.value, 'a session cookie was set');
    assert(r.res.cookies.get(SIGNIN_COOKIE_NAME)?.value === '', 'the flow cookie was not cleared');
  });

  await check('#17 no console line, error report or admin message holds an address, a code or the Resend key', () => {
    const everything = [...logs, ...captured, ...adminMessages];
    const addresses = [...Object.values(ADDR), UNKNOWN, 'dana.levi@example.com'].map(a => a.toLowerCase());
    for (const line of everything) {
      const lower = line.toLowerCase();
      const address = addresses.find(a => lower.includes(a));
      assert(!address, `a line holds ${address}: ${line.slice(0, 200)}`);
      const code = [...seenCodes].find(c => new RegExp(`\\b${c}\\b`).test(line));
      assert(!code, `a line holds a code: ${line.slice(0, 200)}`);
      assert(!line.includes(RESEND_KEY), 'a line holds the Resend key');
    }
    assert(seenCodes.size >= 10, `only ${seenCodes.size} codes were mailed, so this proves little`);
  });

  Object.assign(console, realConsole);
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  if (failed) console.log(`\nlast lines:\n${logs.slice(-30).join('\n')}\n\nreports:\n${captured.slice(-10).join('\n')}`);
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  Object.assign(console, realConsole);
  console.error(err);
  process.exit(1);
});

// Smoke test for web sign-in's guards (plan 6b, Task 3; spec docs/superpowers/specs/2026-11-02-web-sign-in-design.md
// §3 and §5): the same-origin check on sign-in and Settings POSTs, the client address the limits count by, the
// famcal_signin flow (one use, bound to the browser, 10 minutes), the email address's one normal form (the Kelvin sign
// and other non-ASCII refused, an IDN as punycode), every email limit, and Sign out / Sign out on all devices.
// (Tries per code, counted before the compare, are the code's own: smoke-signin-email.ts.)
//
// same-origin, client-address, flow, email-address, limits, the two sign-out routes, session-auth, api-auth,
// user-service and app-keys run for real. Faked at the boundaries: Prisma (in memory), Redis (in memory, with expiry
// on a clock this smoke moves, and the limits' two Lua scripts done as Redis would), the admin notifier (records),
// the rate limiter (allows), Telegram and messaging (record), error capture (records), and fetch (blocked).
// No network, no DB.
//
// Checks named [guard] pass before Task 3 and must keep passing. The others fail until it lands.
//
// Run with the fake env (scripts/ci-smokes.sh):
//   npx tsx scripts/smoke-signin-guards.ts

import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

// Test values, used only when the fake env left them unset. The app's origin is famcal.bot's.
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.CRON_SECRET ||= 'test-cron';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.bot';

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

const show = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Set ? [...v] : v));

// ---- The clock: Date.now() moves forward when a check says so (new Date() is left alone) ----

const realNow = Date.now.bind(Date);
let offsetMs = 0;
Date.now = () => realNow() + offsetMs;
const advance = (seconds: number) => { offsetMs += seconds * 1000; };
/** Sets the clock to an instant (epoch ms). */
const setClock = (ms: number) => { offsetMs = ms - realNow(); };

// ---- Fake Prisma: the user table, any other model empty ----

const DB: Record<string, Row[]> = {};
const prismaCalls: string[] = [];
function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') return a != null && b != null && String(a) === String(b);
  return a === b;
}
const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => v === undefined || same(row[k] ?? null, v));
function model(name: string): Row {
  const t = () => (DB[name] ??= []);
  const impl: Row = {
    findUnique: async (a: Row = {}) => t().find((r) => matches(r, a.where)) ?? null,
    findFirst: async (a: Row = {}) => t().find((r) => matches(r, a.where)) ?? null,
    findMany: async (a: Row = {}) => t().filter((r) => matches(r, a.where)),
    count: async (a: Row = {}) => t().filter((r) => matches(r, a.where)).length,
    update: async (a: Row) => {
      const row = t().find((r) => matches(r, a.where));
      if (!row) throw Object.assign(new Error(`No ${name} record was found for an update.`), { code: 'P2025' });
      Object.assign(row, a.data);
      return row;
    },
    updateMany: async (a: Row) => {
      const rows = t().filter((r) => matches(r, a.where));
      rows.forEach((r) => Object.assign(r, a.data));
      return { count: rows.length };
    },
  };
  return new Proxy(impl, {
    get: (target, prop) => {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (...args: unknown[]) => {
        prismaCalls.push(`${name}.${prop}`);
        return (target[prop] ?? (async () => null))(...args);
      };
    },
  });
}
const models: Record<string, Row> = {};
const fakePrisma: Row = new Proxy({} as Row, {
  get(_t, prop) {
    if (typeof prop !== 'string' || prop === 'then') return undefined;
    if (prop === '$transaction') return async (arg: unknown) => (typeof arg === 'function' ? arg(fakePrisma) : Promise.all(arg as Promise<unknown>[]));
    if (prop.startsWith('$')) return async () => undefined;
    return (models[prop] ??= model(prop));
  },
});

// ---- Fake Redis: values and sets with an expiry on the clock above; the limits' Lua scripts done as Redis does ----

type Entry = { value: string | Set<string>; expiresAt: number | null };
const store = new Map<string, Entry>();
let redisDown = false;
let failKeyPrefix: string | null = null; // a write of a key with this prefix fails (the rest of Redis is up)
const live = (k: string): Entry | undefined => {
  const e = store.get(k);
  if (e && e.expiresAt !== null && e.expiresAt <= Date.now()) {
    store.delete(k);
    return undefined;
  }
  return e;
};
const decode = (e: Entry | undefined) => {
  if (!e || typeof e.value !== 'string') return null;
  try { return JSON.parse(e.value); } catch { return e.value; }
};
const encode = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
const ttlOf = (k: string) => {
  const e = live(k);
  if (!e) return -2;
  return e.expiresAt === null ? -1 : Math.ceil((e.expiresAt - Date.now()) / 1000);
};
const expire = (k: string, sec: number) => { const e = live(k); if (e) e.expiresAt = Date.now() + sec * 1000; };
const incr = (k: string) => {
  const n = Number((live(k)?.value as string) ?? 0) + 1;
  store.set(k, { value: String(n), expiresAt: live(k)?.expiresAt ?? null });
  return n;
};
const redisImpl: Row = {
  get: async (k: string) => decode(live(k)),
  mget: async (...ks: unknown[]) => ks.flat().map((k) => decode(live(String(k)))),
  set: async (k: string, v: unknown, o?: Row) => {
    if (failKeyPrefix && k.startsWith(failKeyPrefix)) throw new Error('smoke: this write fails');
    if (o?.nx && live(k)) return null;
    store.set(k, { value: encode(v), expiresAt: o?.ex ? Date.now() + o.ex * 1000 : null });
    return 'OK';
  },
  getdel: async (k: string) => { const e = live(k); store.delete(k); return decode(e); },
  del: async (...ks: unknown[]) => ks.flat().reduce((n: number, k) => n + (store.delete(String(k)) ? 1 : 0), 0),
  ttl: async (k: string) => ttlOf(k),
  eval: async (script: string, keys: string[], args: string[]) => {
    const [key] = keys;
    // Only the two exported scripts are run, matched by their whole text: a changed script is "unknown" here, and
    // check #25b pins what each one says (this fake is TypeScript, not a Lua engine).
    const { COUNT_SCRIPT, ADD_MEMBER_SCRIPT } = await load('src/services/web-signin/limits.ts');
    if (script === ADD_MEMBER_SCRIPT) {
      const e = live(key);
      const set = e && e.value instanceof Set ? e.value : new Set<string>();
      const added = !set.has(args[0]);
      set.add(args[0]);
      store.set(key, { value: set, expiresAt: e?.expiresAt ?? null });
      if (ttlOf(key) < 0) expire(key, Number(args[1]));
      if (added && set.size > Number(args[2])) { set.delete(args[0]); return 0; }
      return 1;
    }
    if (script === COUNT_SCRIPT) {
      const n = incr(key);
      if (ttlOf(key) < 0) expire(key, Number(args[0]));
      return n;
    }
    throw new Error(`unknown script in smoke: ${script}`);
  },
};
const fakeRedis = new Proxy(redisImpl, {
  get: (t, p) => {
    if (typeof p !== 'string' || p === 'then') return undefined;
    const fn = t[p] ?? (async () => null);
    return (...args: unknown[]) => {
      if (redisDown) return Promise.reject(new Error('smoke: Redis is down'));
      return fn(...args);
    };
  },
});

// ---- Records ----

const captured: string[] = [];
const adminWarnings: { context: string; message: string }[] = [];
const sent: Row[] = [];
const logLines: string[] = [];
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  const write = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logLines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    if (process.env.SMOKE_VERBOSE) write(...args);
  };
}

const recorder = (platform: string): Row =>
  new Proxy({} as Row, {
    get: (_t, p) => (typeof p !== 'string' || p === 'then' ? undefined : async (chatId: unknown, text?: unknown) => {
      sent.push({ platform, via: p, chatId, text });
      return { message_id: 1 };
    }),
  });

function installStubs(messagingTypes: Row) {
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
    checkRateLimit: async () => ({ success: true, limit: 99, remaining: 99, reset: 0 }),
    getRateLimitHeaders: () => ({}),
  });
  const capture = (e: unknown, ctx: string) => { captured.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`); };
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
  stub('src/utils/error-notifier.ts', {
    notifyAdminWarning: async (context: string, message: string) => { adminWarnings.push({ context, message }); },
    notifyAdminError: async (context: string, error: unknown) => { adminWarnings.push({ context, message: String(error) }); },
    notifyAdminFeedback: async () => undefined,
    getAdminUserIds: async () => [],
  });
  const telegram = { getBot: () => recorder('telegram'), initBot: () => recorder('telegram'), getMessagingService: () => recorder('telegram'), setUserMenuButton: async () => undefined };
  stub('src/services/telegram/index.ts', telegram);
  stub('src/services/telegram/bot.ts', telegram);
  const messaging = {
    ...messagingTypes,
    getMessagingService: (platform: unknown) => recorder(String(platform)),
    getTelegramService: () => recorder('telegram'),
    getWhatsAppService: () => recorder('whatsapp'),
    detectPlatform: () => 'telegram',
  };
  stub('src/services/messaging/index.ts', messaging);
  stub('src/services/messaging/factory.ts', messaging);
  globalThis.fetch = (async (input: unknown) => { throw new Error(`network blocked in smoke: ${String(input)}`); }) as typeof fetch;
}

// ---- Fixtures ----

const DAY = 86_400_000;
function baseUser(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', culture: 'default',
    messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null, calendarSource: 'NATIVE',
    pairingId: null, remindersEnabled: false, suspendedAt: null, unreachableSince: null, whatsappPhone: null,
    whatsappBsuid: null, telegramId: null, isAdmin: false, globalRules: [], voiceInputEnabled: true,
    textSummaryEnabled: true, voiceSummaryEnabled: false, weatherEnabled: true, sessionsValidAfter: null,
    createdAt: new Date(Date.now() - 30 * DAY), updatedAt: new Date(Date.now() - DAY),
    ...o,
  };
}

function reset() {
  for (const k of Object.keys(DB)) delete DB[k];
  store.clear();
  redisDown = false;
  offsetMs = 0;
  prismaCalls.length = 0;
  captured.length = 0;
  adminWarnings.length = 0;
  sent.length = 0;
  logLines.length = 0;
  DB.user = [
    baseUser({ id: 9, name: 'Tal', telegramId: BigInt(111111111) }),
    baseUser({ id: 42, name: 'Dana', messagingPlatform: 'whatsapp', whatsappPhone: '972500000042' }),
  ];
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


const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel)).catch((err) => {
  throw new Error(`cannot load ${rel}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
});

async function main() {
  installStubs(await load('src/services/messaging/types.ts'));
  const { NextRequest, NextResponse } = nodeRequire('next/server');

  const req = (url: string, o: { method?: string; origin?: string | null; type?: string | null; body?: string; cookie?: string; headers?: Row } = {}) => {
    const headers: Row = { ...(o.headers ?? {}) };
    if (o.origin !== null) headers.origin = o.origin ?? 'https://famcal.bot';
    if (o.type !== null) headers['content-type'] = o.type ?? 'application/json';
    if (o.cookie) headers.cookie = o.cookie;
    return new NextRequest(`https://famcal.bot${url}`, { method: o.method ?? 'POST', headers, body: o.body ?? (o.method === 'GET' ? undefined : '{}') });
  };

  // ---- Same origin, JSON ----

  await check('#1 refuseCrossSite lets a POST from https://famcal.bot with a JSON body through (with or without a charset)', async () => {
    reset();
    const { refuseCrossSite } = await load('src/lib/same-origin.ts');
    assert(refuseCrossSite(req('/api/auth/signout')) === null, 'plain application/json refused');
    assert(refuseCrossSite(req('/api/auth/signout', { type: 'Application/JSON; charset=utf-8' })) === null, 'JSON with a charset refused');
  });

  await check('#2 another Origin, none, "null", http:// or a famcal.bot subdomain is 403 { error: "cross_site" }, logged by path and reason only', async () => {
    reset();
    const { refuseCrossSite } = await load('src/lib/same-origin.ts');
    for (const origin of ['https://evil.example', null, 'null', 'http://famcal.bot', 'https://www.famcal.bot', 'https://famcal.bot.evil.example']) {
      const res = refuseCrossSite(req('/api/auth/signout', { origin }));
      assert(res && res.status === 403, `${origin}: ${res?.status}`);
      assert(show(await res.json()) === show({ error: 'cross_site' }), `${origin}: body`);
    }
    assert(logLines.some((l) => l.includes('[same-origin] refused POST /api/auth/signout')), `log: ${show(logLines)}`);
    assert(!logLines.some((l) => l.includes('evil.example')), `the log holds the Origin: ${show(logLines)}`);
  });

  await check('#3 a body that is not JSON (a form, text/plain, none) is 415 { error: "json_only" }; json: false lets a form through but still checks the Origin', async () => {
    reset();
    const { refuseCrossSite } = await load('src/lib/same-origin.ts');
    for (const type of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data; boundary=x', null]) {
      const res = refuseCrossSite(req('/api/auth/signout', { type }));
      assert(res && res.status === 415, `${type}: ${res?.status}`);
      assert(show(await res.json()) === show({ error: 'json_only' }), `${type}: body`);
    }
    assert(refuseCrossSite(req('/x', { type: 'application/x-www-form-urlencoded' }), { json: false }) === null, 'json: false refused a form');
    assert(refuseCrossSite(req('/x', { origin: 'https://evil.example', type: 'text/plain' }), { json: false })?.status === 403, 'json: false skipped the Origin');
  });

  await check('#4 the origin is the app\'s base URL, never the request\'s Host: Host evil.example with Origin evil.example is refused', async () => {
    reset();
    const { refuseCrossSite } = await load('src/lib/same-origin.ts');
    const request = new NextRequest('https://evil.example/api/auth/signout', { method: 'POST', headers: { origin: 'https://evil.example', host: 'evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert(refuseCrossSite(request)?.status === 403, 'refused not');
  });

  // ---- The client address ----

  await check('#5 the address is x-real-ip (trimmed); none, empty or not an address is null; X-Forwarded-For is never read', async () => {
    const { clientAddress } = await load('src/services/web-signin/client-address.ts');
    const at = (ip?: string) => clientAddress(new Request('https://famcal.bot/', { headers: { 'x-forwarded-for': '198.51.100.9', ...(ip === undefined ? {} : { 'x-real-ip': ip }) } }));
    assert(at('203.0.113.5') === '203.0.113.5', `v4: ${at('203.0.113.5')}`);
    assert(at(' 203.0.113.5 ') === '203.0.113.5', 'not trimmed');
    for (const v of [undefined, '', 'nonsense', '203.0.113.5, 198.51.100.9', '999.1.1.1']) assert(at(v) === null, `${v}: ${at(v)}`);
  });

  await check('#6 an IPv6 address counts by its /64 (any compression, upper case, a %zone, an embedded IPv4); an IPv4-mapped one by its IPv4', async () => {
    const { clientAddress } = await load('src/services/web-signin/client-address.ts');
    const at = (ip: string) => clientAddress(new Request('https://famcal.bot/', { headers: { 'x-real-ip': ip } }));
    const table: [string, string][] = [
      ['2001:db8:1:2:aaaa::1', '2001:db8:1:2::/64'],
      ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
      ['2001:DB8:1:2::9', '2001:db8:1:2::/64'],
      ['2001:db8:1:3::1', '2001:db8:1:3::/64'],
      ['2001:db8::1', '2001:db8:0:0::/64'],
      ['1:2:3:4:5:6:1.2.3.4', '1:2:3:4::/64'],
      ['fe80::1%eth0', 'fe80:0:0:0::/64'],
      ['::ffff:192.0.2.7', '192.0.2.7'],
      ['::ffff:c000:207', '192.0.2.7'],
    ];
    const wrong = table.filter(([ip, want]) => at(ip) !== want).map(([ip, want]) => `${ip}: ${at(ip)}, want ${want}`);
    assert(wrong.length === 0, wrong.join('; '));
  });

  // ---- The email address ----

  await check('#7 normalizeEmail: trimmed, ASCII lower case, an IDN domain as punycode, the rest as typed', async () => {
    const { normalizeEmail } = await load('src/services/web-signin/email-address.ts');
    const table: [string, string][] = [
      [' Dana@Gmail.COM ', 'dana@gmail.com'],
      ['a.b+tag@sub.example.co.il', 'a.b+tag@sub.example.co.il'],
      ["o'brien_x-1@Example.ORG", "o'brien_x-1@example.org"],
      ['user@münchen.de', 'user@xn--mnchen-3ya.de'],
      ['user@xn--mnchen-3ya.de', 'user@xn--mnchen-3ya.de'],
      ['user@пример.рф', 'user@xn--e1afmkfd.xn--p1ai'],
      ['user@MÜNCHEN.de', 'user@xn--mnchen-3ya.de'],
      ['Dana@ПРИМЕР.РФ', 'dana@xn--e1afmkfd.xn--p1ai'],
    ];
    const wrong = table.filter(([input, want]) => normalizeEmail(input) !== want).map(([input, want]) => `${show(input)}: ${normalizeEmail(input)}, want ${want}`);
    assert(wrong.length === 0, wrong.join('; '));
  });

  await check('#8 normalizeEmail refuses the Kelvin sign (in the name or the domain), other non-ASCII, a full-width dot, and every malformed address', async () => {
    const { normalizeEmail } = await load('src/services/web-signin/email-address.ts');
    const K = 'K';
    const refused: unknown[] = [
      `dan${K}@gmail.com`, `DAN${K}@gmail.com`, `dana@${K}-mail.com`, `dana@gmai${K}.com`, `dana@${K}.com`, 'dana@İ.com', 'dana@ＧＭＡＩＬ.com', 'dana@gmail．com', 'dаna@gmail.com', 'da​na@gmail.com',
      'dana@gmail', 'dana@@gmail.com', 'da@na@gmail.com', 'da na@gmail.com', '.dana@gmail.com', 'dana.@gmail.com', 'dana..x@gmail.com',
      '"dana"@gmail.com', 'dana@-gmail.com', 'dana@gmail-.com', 'dana@gmail..com', 'dana@gma_il.com', 'dana@1.23', 'dana@gmail.c',
      `${'a'.repeat(65)}@gmail.com`, `a@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.${'e'.repeat(60)}.com`,
      '', '   ', '@gmail.com', 'dana@', 42, null, undefined, {}, ['dana@gmail.com'],
    ];
    const passed = refused.filter((input) => normalizeEmail(input) !== null).map((input) => `${show(input)} → ${normalizeEmail(input)}`);
    assert(passed.length === 0, `accepted: ${passed.join('; ')}`);
  });

  await check('#9 emailKey is a keyed hash (32 hex, one per address, changes with SESSION_SECRET, never the address or its plain sha256); maskEmail shows d•••@gmail.com', async () => {
    const { emailKey, maskEmail } = await load('src/services/web-signin/email-address.ts');
    const a = emailKey('dana@gmail.com');
    assert(/^[0-9a-f]{32}$/.test(a), `form: ${a}`);
    assert(emailKey('dana@gmail.com') === a && emailKey('tal@gmail.com') !== a, 'not one per address');
    assert(!crypto.createHash('sha256').update('dana@gmail.com').digest('hex').startsWith(a), 'a plain sha256');
    const secret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'another-secret';
    const b = emailKey('dana@gmail.com');
    process.env.SESSION_SECRET = secret;
    assert(b !== a, 'the same under another SESSION_SECRET');
    assert(maskEmail('dana@gmail.com') === 'd•••@gmail.com' && maskEmail('a@x.co') === 'a•••@x.co', `mask: ${maskEmail('dana@gmail.com')}`);
  });

  // ---- The flow ----

  const flowCookieOf = (res: Response) => (res.headers.getSetCookie?.() ?? []).find((c: string) => c.startsWith('famcal_signin='));
  const oidc = (kind = 'telegram') => ({ kind, state: 'state-1', nonce: 'nonce-1', codeVerifier: 'verifier-1', locale: 'he' });
  /** A stored flow without its start time (startFlow adds `startedAt`: epoch ms), which is checked on its own. */
  const bare = (v: unknown) => { const { startedAt, ...rest } = (v ?? {}) as Row; assert(startedAt === undefined || typeof startedAt === 'number', `startedAt ${show(startedAt)}`); return rest; };
  const startOne = async (flow: Row) => {
    const { startFlow } = await load('src/services/web-signin/flow.ts');
    const res = NextResponse.json({ ok: true });
    await startFlow(res, flow);
    const header = flowCookieOf(res) ?? '';
    return { res, header, cookie: header.split(';')[0] };
  };

  await check('#10 startFlow sets famcal_signin (httpOnly, Secure, SameSite=Lax, Path=/api/auth, 10 minutes) and keeps the flow 600 s under the cookie\'s sha256, never the cookie', async () => {
    reset();
    const { header, cookie } = await startOne(oidc());
    assert(/^famcal_signin=[A-Za-z0-9_-]{43};/.test(header), `cookie: ${header}`);
    for (const flag of ['Path=/api/auth', 'Max-Age=600', 'Secure', 'HttpOnly', 'SameSite=lax']) assert(header.toLowerCase().includes(flag.toLowerCase()), `${flag} missing: ${header}`);
    const id = cookie.split('=')[1];
    const keys = [...store.keys()];
    const want = `signin:flow:${crypto.createHash('sha256').update(id).digest('hex')}`;
    assert(keys.length === 1 && keys[0] === want, `keys ${show(keys)}, want ${want}`);
    assert(!keys[0].includes(id), 'the key holds the cookie');
    assert(ttlOf(want) === 600, `ttl ${ttlOf(want)}`);
    assert(show(bare(decode(live(want)))) === show(oidc()) && typeof decode(live(want)).startedAt === 'number', `record ${show(decode(live(want)))}`);
    assert(!logLines.some((l) => l.includes(id) || l.includes('state-1') || l.includes('nonce-1') || l.includes('verifier-1')), `a secret in the log: ${show(logLines)}`);
  });

  await check('#11 takeFlow is one use and bound to the browser: its own cookie gets it once; no cookie, a foreign or unknown id gets null', async () => {
    reset();
    const { takeFlow } = await load('src/services/web-signin/flow.ts');
    const mine = await startOne(oidc());
    const theirs = await startOne({ ...oidc(), state: 'their-state' });
    const at = (cookie?: string) => req('/api/auth/telegram/callback', { method: 'GET', cookie });
    assert((await takeFlow(at(), ['telegram'])) === null, 'no cookie got a flow');
    assert((await takeFlow(at(`famcal_signin=${'A'.repeat(43)}`), ['telegram'])) === null, 'an unknown id got a flow');
    assert((await takeFlow(at('famcal_signin=not-a-flow-id'), ['telegram'])) === null, 'a malformed id got a flow');
    const first = await takeFlow(at(mine.cookie), ['telegram']);
    assert(show(bare(first)) === show(oidc()), `first take ${show(first)}`);
    assert((await takeFlow(at(mine.cookie), ['telegram'])) === null, 'a second take got the flow again');
    const other = await takeFlow(at(theirs.cookie), ['telegram']);
    assert(other?.state === 'their-state', `the other browser's flow ${show(other)}`);
  });

  await check('#12 a flow brought to the wrong step is refused and left for its own step (another tab\'s sign-in of another kind still finishes: review focus RF1); an add-google flow keeps its user id', async () => {
    reset();
    const { takeFlow } = await load('src/services/web-signin/flow.ts');
    const tg = await startOne(oidc('telegram'));
    const at = (cookie: string) => req('/api/auth/google/callback', { method: 'GET', cookie });
    assert((await takeFlow(at(tg.cookie), ['google', 'add-google'])) === null, 'a telegram flow passed the google callback');
    const own = await takeFlow(at(tg.cookie), ['telegram']);
    assert(own?.kind === 'telegram', `the refused flow was used up, so its own callback finds nothing: ${show(own)}`);
    const add = await startOne({ ...oidc('add-google'), userId: 42 });
    const got = await takeFlow(at(add.cookie), ['google', 'add-google']);
    assert(got?.kind === 'add-google' && got.userId === 42, `add-google ${show(got)}`);
  });

  await check('#13 a flow is gone after 10 minutes', async () => {
    reset();
    const { takeFlow } = await load('src/services/web-signin/flow.ts');
    const { cookie } = await startOne(oidc());
    advance(601);
    assert((await takeFlow(req('/api/auth/telegram/callback', { method: 'GET', cookie }), ['telegram'])) === null, 'an 11-minute-old flow was taken');
  });

  await check('#14 peekFlow reads the email flow without using it up, and only an email flow; takeFlow then uses it up', async () => {
    reset();
    const { peekFlow, takeFlow } = await load('src/services/web-signin/flow.ts');
    const email = { kind: 'email', emailKey: 'k'.repeat(32), locale: 'ru' };
    const { cookie } = await startOne(email);
    const at = () => req('/api/auth/email/verify', { cookie });
    assert(show(bare(await peekFlow(at(), 'email'))) === show(email), 'first peek');
    assert(show(bare(await peekFlow(at(), 'email'))) === show(email), 'second peek');
    assert(show(bare(await takeFlow(at(), ['email']))) === show(email), 'take');
    assert((await peekFlow(at(), 'email')) === null, 'a peek after the take');
    const tg = await startOne(oidc());
    assert((await peekFlow(req('/api/auth/email/verify', { cookie: tg.cookie }), 'email')) === null, 'peek returned an OIDC flow');
  });

  await check('#15 clearFlowCookie clears famcal_signin on its own path (empty, Max-Age=0, Path=/api/auth)', async () => {
    const { clearFlowCookie } = await load('src/services/web-signin/flow.ts');
    const res = NextResponse.json({ ok: true });
    clearFlowCookie(res);
    const header = flowCookieOf(res) ?? '';
    assert(/^famcal_signin=;/.test(header) && header.includes('Max-Age=0') && header.includes('Path=/api/auth'), `cookie: ${header}`);
  });

  // ---- The limits ----

  const keyFor = async (address: string) => (await load('src/services/web-signin/email-address.ts')).emailKey(address);
  const limits = () => load('src/services/web-signin/limits.ts');

  await check('#16 one code a minute per email: the second within the minute is refused (email-minute), the next minute passes', async () => {
    reset();
    const { allowCodeRequest } = await limits();
    const emailKey = await keyFor('dana@gmail.com');
    assert((await allowCodeRequest({ emailKey, ip: '203.0.113.5' })).ok === true, 'first');
    const second = await allowCodeRequest({ emailKey, ip: '203.0.113.6' });
    assert(!second.ok && second.reason === 'email-minute', `second ${show(second)}`);
    advance(61);
    assert((await allowCodeRequest({ emailKey, ip: '203.0.113.5' })).ok === true, 'a minute later');
  });

  await check('#17 five codes a day per email (email-day), from any address; free again a day after the first', async () => {
    reset();
    const { allowCodeRequest } = await limits();
    const emailKey = await keyFor('dana@gmail.com');
    for (let i = 1; i <= 5; i++) {
      const r = await allowCodeRequest({ emailKey, ip: `203.0.113.${i}` });
      assert(r.ok, `request ${i}: ${show(r)}`);
      advance(61);
    }
    const sixth = await allowCodeRequest({ emailKey, ip: '203.0.113.99' });
    assert(!sixth.ok && sixth.reason === 'email-day', `sixth ${show(sixth)}`);
    advance(24 * 3600);
    assert((await allowCodeRequest({ emailKey, ip: '203.0.113.5' })).ok, 'the next day');
  });

  await check('#18 twenty code requests an hour per address (ip-hour), one IPv6 /64 counting as one address; another address passes; free an hour later', async () => {
    reset();
    const { allowCodeRequest } = await limits();
    const { clientAddress } = await load('src/services/web-signin/client-address.ts');
    const ip = (raw: string) => clientAddress(new Request('https://famcal.bot/', { headers: { 'x-real-ip': raw } }));
    for (let i = 1; i <= 20; i++) {
      const r = await allowCodeRequest({ emailKey: await keyFor(`person${i}@example.com`), ip: ip(`2001:db8:1:2::${i.toString(16)}`) });
      assert(r.ok, `request ${i}: ${show(r)}`);
    }
    const next = await allowCodeRequest({ emailKey: await keyFor('person21@example.com'), ip: ip('2001:db8:1:2:ffff::1') });
    assert(!next.ok && next.reason === 'ip-hour', `21st from the same /64 ${show(next)}`);
    assert((await allowCodeRequest({ emailKey: await keyFor('person22@example.com'), ip: ip('2001:db8:1:3::1') })).ok, 'another /64 refused');
    advance(3601);
    assert((await allowCodeRequest({ emailKey: await keyFor('person23@example.com'), ip: ip('2001:db8:1:2::1') })).ok, 'an hour later');
  });

  await check('#19 Add email: three addresses a day per account (account-day); the same address again passes; another account passes', async () => {
    reset();
    const { allowCodeRequest } = await limits();
    for (const address of ['a@example.com', 'b@example.com', 'c@example.com']) {
      const r = await allowCodeRequest({ emailKey: await keyFor(address), ip: '203.0.113.5', addForUserId: 42 });
      assert(r.ok, `${address}: ${show(r)}`);
    }
    advance(61);
    assert((await allowCodeRequest({ emailKey: await keyFor('a@example.com'), ip: '203.0.113.5', addForUserId: 42 })).ok, 'the same address again');
    const fourth = await allowCodeRequest({ emailKey: await keyFor('d@example.com'), ip: '203.0.113.5', addForUserId: 42 });
    assert(!fourth.ok && fourth.reason === 'account-day', `fourth ${show(fourth)}`);
    assert((await allowCodeRequest({ emailKey: await keyFor('e@example.com'), ip: '203.0.113.5', addForUserId: 9 })).ok, 'another account');
  });

  await check('#20 ten wrong codes for an email pause its checks and its code requests for a whole day after the tenth', async () => {
    reset();
    const { recordWrongCode, codeChecksBlocked, allowCodeRequest } = await limits();
    const emailKey = await keyFor('dana@gmail.com');
    for (let i = 1; i <= 9; i++) {
      await recordWrongCode({ emailKey, ip: `203.0.113.${i}` });
      advance(2 * 3600);
    }
    assert((await codeChecksBlocked({ emailKey, ip: '203.0.113.50' })) === false, 'blocked after nine');
    await recordWrongCode({ emailKey, ip: '203.0.113.10' });
    assert((await codeChecksBlocked({ emailKey, ip: '203.0.113.50' })) === true, 'not blocked after ten');
    const request = await allowCodeRequest({ emailKey, ip: '203.0.113.50' });
    assert(!request.ok && request.reason === 'wrong-email-day', `a code request while paused ${show(request)}`);
    advance(23 * 3600);
    assert((await codeChecksBlocked({ emailKey, ip: '203.0.113.50' })) === true, 'free 23 h after the tenth (41 h after the first)');
    advance(3601);
    assert((await codeChecksBlocked({ emailKey, ip: '203.0.113.50' })) === false, 'still paused a day after the tenth');
  });

  await check('#20b [finding 11] no wrong-code record lives past a day of being made: the count is not renewed at the tenth (it ends a day after the first), and the pause is its own marker that ends a day after the tenth', async () => {
    reset();
    const { recordWrongCode } = await limits();
    const emailKey = await keyFor('dana@gmail.com');
    const countKey = `signin:lim:wrong-email-day:${emailKey}`;
    const pauseKey = `signin:lim:wrong-email-pause:${emailKey}`;
    for (let i = 1; i <= 9; i++) {
      await recordWrongCode({ emailKey, ip: `203.0.113.${i}` });
      advance(2 * 3600);
    }
    assert(!store.has(pauseKey), 'a pause marker before the tenth');
    await recordWrongCode({ emailKey, ip: '203.0.113.10' });
    const left = ttlOf(countKey);
    assert(left > 0 && left <= 24 * 3600 - 18 * 3600, `the count was renewed at the tenth: ${left} s left, 18 h after the first`);
    const pause = ttlOf(pauseKey);
    assert(pause > 23 * 3600 && pause <= 24 * 3600, `the pause marker should last a day from the tenth: ${pause} s`);
  });

  await check('#20c [Task 11 review] the pause marker\'s write failing does not lose the per-address wrong-code count (nor the email\'s): the failure is captured, the email stays blocked', async () => {
    reset();
    const { recordWrongCode, codeChecksBlocked } = await limits();
    const emailKey = await keyFor('dana@gmail.com');
    for (let i = 1; i <= 9; i++) await recordWrongCode({ emailKey, ip: '203.0.113.9' });
    failKeyPrefix = 'signin:lim:wrong-email-pause:';
    try {
      await recordWrongCode({ emailKey, ip: '203.0.113.9' });
    } finally {
      failKeyPrefix = null;
    }
    const ipKeys = [...store.keys()].filter((k) => k.startsWith('signin:lim:wrong-ip-hour:'));
    assert(ipKeys.length === 1 && Number(store.get(ipKeys[0])?.value) === 10, `the address count: ${show(ipKeys.map((k) => store.get(k)?.value))}`);
    assert(Number(store.get(`signin:lim:wrong-email-day:${emailKey}`)?.value) === 10, 'the email count after the tenth');
    assert(!store.has(`signin:lim:wrong-email-pause:${emailKey}`), 'the marker was written although its write failed');
    assert(captured.filter((c) => c.startsWith('signin-limits')).length === 1, `captured ${show(captured)}`);
    assert((await codeChecksBlocked({ emailKey, ip: '203.0.113.50' })) === true, 'the email is not blocked at ten wrong codes without the marker');
  });

  await check('#21 twenty wrong codes from one address in an hour block its checks, for any email; free an hour later', async () => {
    reset();
    const { recordWrongCode, codeChecksBlocked } = await limits();
    for (let i = 1; i <= 20; i++) await recordWrongCode({ emailKey: await keyFor(`p${i}@example.com`), ip: '203.0.113.5' });
    assert((await codeChecksBlocked({ emailKey: await keyFor('fresh@example.com'), ip: '203.0.113.5' })) === true, 'not blocked after twenty');
    assert((await codeChecksBlocked({ emailKey: await keyFor('fresh@example.com'), ip: '203.0.113.6' })) === false, 'another address blocked');
    advance(3601);
    assert((await codeChecksBlocked({ emailKey: await keyFor('fresh@example.com'), ip: '203.0.113.5' })) === false, 'still blocked an hour later');
  });

  await check('#22 ninety codes a UTC day: the 91st send is refused, the admin is told once (at the 90th, no address), code requests answer daily-budget; 00:00 UTC starts over', async () => {
    reset();
    setClock(Date.UTC(2026, 10, 2, 21, 30));
    const { takeDailySend, allowCodeRequest } = await limits();
    for (let i = 1; i <= 90; i++) assert((await takeDailySend()) === true, `send ${i} refused`);
    assert(adminWarnings.length === 1, `admin messages after 90: ${show(adminWarnings)}`);
    assert((await takeDailySend()) === false && (await takeDailySend()) === false, 'a send past 90');
    assert(adminWarnings.length === 1, `admin messages after 92: ${show(adminWarnings)}`);
    assert(!/@/.test(adminWarnings[0].message) && adminWarnings[0].message.includes('90'), `admin message: ${adminWarnings[0].message}`);
    const request = await allowCodeRequest({ emailKey: await keyFor('dana@gmail.com'), ip: '203.0.113.5' });
    assert(!request.ok && request.reason === 'daily-budget', `code request ${show(request)}`);
    const budgetKey = [...store.keys()].find((k) => k.startsWith('signin:lim:daily-send:'));
    assert(budgetKey === 'signin:lim:daily-send:2026-11-02' && ttlOf(budgetKey) === 2.5 * 3600, `budget key ${budgetKey} ttl ${budgetKey && ttlOf(budgetKey)}`);
    setClock(Date.UTC(2026, 10, 3, 0, 0, 1));
    assert((await takeDailySend()) === true, 'refused after 00:00 UTC');
    assert((await allowCodeRequest({ emailKey: await keyFor('dana@gmail.com'), ip: '203.0.113.5' })).ok, 'code request refused after 00:00 UTC');
  });

  await check('#23 every limit key is signin:lim:<what>:<hash> with no address, IP or user id in it, and expires within a day; no database query', async () => {
    reset();
    const { allowCodeRequest, recordWrongCode, codeChecksBlocked, takeDailySend } = await limits();
    const emailKey = await keyFor('dana@gmail.com');
    await allowCodeRequest({ emailKey, ip: '203.0.113.77', addForUserId: 4242 });
    await recordWrongCode({ emailKey, ip: '203.0.113.77' });
    await codeChecksBlocked({ emailKey, ip: '203.0.113.77' });
    await allowCodeRequest({ emailKey: await keyFor('tal@gmail.com'), ip: null });
    await takeDailySend();
    const keys = [...store.keys()];
    assert(keys.length >= 7, `keys ${show(keys)}`);
    // A hash or the budget's UTC date, nothing else: no address, IP, user id or 'none' fits
    const bad = keys.filter((k) => !/^signin:lim:[a-z-]+:([0-9a-f]{32}|\d{4}-\d{2}-\d{2})$/.test(k));
    assert(bad.length === 0, `keys: ${show(bad)}`);
    const ttls = keys.map((k) => [k, ttlOf(k)] as const).filter(([, ttl]) => ttl < 1 || ttl > 86400);
    assert(ttls.length === 0, `ttls ${show(ttls)}`);
    assert(prismaCalls.length === 0, `database: ${show(prismaCalls)}`);
    assert(logLines.some((l) => l.includes('no x-real-ip')), 'the missing address was not logged');
    assert(!logLines.some((l) => /dana|tal@|203\.0\.113/.test(l)), `an address in the log: ${show(logLines)}`);
  });

  await check('#24 Redis failing fails closed and logged: no code request, every check blocked, no send', async () => {
    reset();
    const { allowCodeRequest, codeChecksBlocked, recordWrongCode, takeDailySend } = await limits();
    const emailKey = await keyFor('dana@gmail.com');
    redisDown = true;
    const r = await allowCodeRequest({ emailKey, ip: '203.0.113.5' });
    assert(!r.ok && r.reason === 'store-down', `request ${show(r)}`);
    assert((await codeChecksBlocked({ emailKey, ip: '203.0.113.5' })) === true, 'check not blocked');
    await recordWrongCode({ emailKey, ip: '203.0.113.5' });
    assert((await takeDailySend()) === false, 'a send with Redis down');
    assert(captured.filter((c) => c.startsWith('signin-limits')).length === 4, `captured ${show(captured)}`);
  });

  await check('#25 countWithin counts a key of the caller\'s own in one Lua call: 1, 2, 3; the window starts at the first count and the next ones don\'t renew it; the key is free after the window; a Redis failure is thrown, not swallowed', async () => {
    reset();
    const { countWithin } = await limits();
    const key = 'signin:code-tries:probe';
    const counts = [await countWithin(key, 600), await countWithin(key, 600), await countWithin(key, 600)];
    assert(show(counts) === show([1, 2, 3]), `counts ${show(counts)}`);
    assert(ttlOf(key) === 600, `ttl after the first counts ${ttlOf(key)}`);
    advance(300);
    assert((await countWithin(key, 600)) === 4, 'the fourth count');
    assert(ttlOf(key) === 300, `the window was renewed by a later count: ttl ${ttlOf(key)}`);
    advance(301);
    assert((await countWithin(key, 600)) === 1, 'the count did not start over after the window');
    redisDown = true;
    let thrown = false;
    try { await countWithin(key, 600); } catch { thrown = true; }
    assert(thrown, 'a Redis failure was swallowed');
    assert(captured.length === 0, `countWithin captured an error itself: ${show(captured)}`);
  });

  await check('#25b the two Lua scripts say what the fake Redis does (the fake is not a Lua engine, so their load-bearing clauses are pinned): COUNT = INCR, expiry when the key has none (TTL < 0) and never again; ADD_MEMBER = SADD, expiry when none, a new member past the cap taken out again and refused', async () => {
    const { COUNT_SCRIPT, ADD_MEMBER_SCRIPT } = await limits();
    const wantCount = "local n = redis.call('INCR', KEYS[1]) if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return n";
    const wantAdd = "local added = redis.call('SADD', KEYS[1], ARGV[1]) if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end if added == 1 and redis.call('SCARD', KEYS[1]) > tonumber(ARGV[3]) then redis.call('SREM', KEYS[1], ARGV[1]) return 0 end return 1";
    assert(COUNT_SCRIPT === wantCount, `COUNT_SCRIPT changed: ${COUNT_SCRIPT}`);
    assert(ADD_MEMBER_SCRIPT === wantAdd, `ADD_MEMBER_SCRIPT changed: ${ADD_MEMBER_SCRIPT}`);
    const clauses: [string, string, string][] = [
      ['COUNT', COUNT_SCRIPT, "local n = redis.call('INCR', KEYS[1]) "],
      ['COUNT', COUNT_SCRIPT, "if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end"],
      ['COUNT', COUNT_SCRIPT, ' return n'],
      ['ADD_MEMBER', ADD_MEMBER_SCRIPT, "local added = redis.call('SADD', KEYS[1], ARGV[1]) "],
      ['ADD_MEMBER', ADD_MEMBER_SCRIPT, "if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end"],
      ['ADD_MEMBER', ADD_MEMBER_SCRIPT, "if added == 1 and redis.call('SCARD', KEYS[1]) > tonumber(ARGV[3]) then redis.call('SREM', KEYS[1], ARGV[1]) return 0 end return 1"],
    ];
    const missing = clauses.filter(([, text, clause]) => !text.includes(clause)).map(([name, , clause]) => `${name} lacks ${clause}`);
    assert(missing.length === 0, missing.join('; '));
    // a script the fake does not know is refused, not guessed at
    let refusedUnknown = false;
    try { await fakeRedis.eval(`${COUNT_SCRIPT} --`, ['signin:lim:probe'], ['60']); } catch { refusedUnknown = true; }
    assert(refusedUnknown, 'the fake ran a script that is not one of the two');
  });

  // ---- Sign out ----

  const sessionHeader = (res: Response, name: string) => (res.headers.getSetCookie?.() ?? []).find((c: string) => c.startsWith(`${name}=`)) ?? '';
  const cleared = (header: string) => /=;/.test(header) && /Path=\//.test(header) && /(Max-Age=0|Expires=Thu, 01 Jan 1970)/i.test(header);

  await check('#26 POST /api/auth/signout clears this browser\'s session cookie (200 { ok: true }) and reads no account', async () => {
    reset();
    const { SESSION_COOKIE_NAME, createSessionToken } = await load('src/lib/session-auth.ts');
    const { POST } = await load('app/api/auth/signout/route.ts');
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken(42, 'email', Date.now())}`;
    const res: Response = await POST(req('/api/auth/signout', { cookie }));
    assert(res.status === 200 && show(await res.json()) === show({ ok: true }), `status ${res.status}`);
    assert(cleared(sessionHeader(res, SESSION_COOKIE_NAME)), `set-cookie ${show(res.headers.getSetCookie())}`);
    assert(prismaCalls.length === 0, `database: ${show(prismaCalls)}`);
    assert(logLines.some((l) => l.includes('[signout] user 42 (email)')), `log ${show(logLines)}`);
  });

  await check('#27 sign out from another Origin is 403 and clears nothing', async () => {
    reset();
    const { SESSION_COOKIE_NAME, createSessionToken } = await load('src/lib/session-auth.ts');
    const { POST } = await load('app/api/auth/signout/route.ts');
    const res: Response = await POST(req('/api/auth/signout', { origin: 'https://evil.example', cookie: `${SESSION_COOKIE_NAME}=${createSessionToken(42, 'email', Date.now())}` }));
    assert(res.status === 403 && sessionHeader(res, SESSION_COOKIE_NAME) === '', `status ${res.status} ${show(res.headers.getSetCookie())}`);
  });

  await check('#28 sign out on all devices (the web cookie): sessionsValidAfter is now, this cookie is cleared, and a cookie signed in earlier is refused afterwards', async () => {
    reset();
    const { SESSION_COOKIE_NAME, createSessionToken } = await load('src/lib/session-auth.ts');
    const { POST } = await load('app/api/auth/signout-all/route.ts');
    const { verifyUserAuth } = await load('src/lib/api-auth.ts');
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken(42, 'google', Date.now() - 1000)}`;
    const before = Date.now();
    const res: Response = await POST(req('/api/auth/signout-all?user_id=42', { cookie }));
    assert(res.status === 200 && show(await res.json()) === show({ ok: true }), `status ${res.status}`);
    const row = DB.user.find((u) => u.id === 42)!;
    assert(row.sessionsValidAfter instanceof Date && row.sessionsValidAfter.getTime() >= before - 5, `sessionsValidAfter ${show(row.sessionsValidAfter)}`);
    assert(DB.user.find((u) => u.id === 9)!.sessionsValidAfter === null, 'another account was signed out');
    assert(cleared(sessionHeader(res, SESSION_COOKIE_NAME)), `set-cookie ${show(res.headers.getSetCookie())}`);
    const again = await verifyUserAuth(req('/api/page-data?user_id=42', { method: 'GET', cookie }), '42', null, { name: 'general' }, 'smoke');
    assert(again.success === false, 'the old cookie still works');
  });

  await check('#29 sign out on all devices from the Mini App (initData, user_id in the body) works too', async () => {
    reset();
    const { POST } = await load('app/api/auth/signout-all/route.ts');
    const res: Response = await POST(req('/api/auth/signout-all', { body: JSON.stringify({ user_id: 111111111, initData: initDataFor(111111111) }) }));
    assert(res.status === 200, `status ${res.status}`);
    assert(DB.user.find((u) => u.id === 9)!.sessionsValidAfter instanceof Date, 'row 9 not signed out');
  });

  await check('#30 sign out on all devices refuses another Origin (403), a form body (415), no credential (401) and another account\'s cookie (401), writing nothing', async () => {
    reset();
    const { SESSION_COOKIE_NAME, createSessionToken } = await load('src/lib/session-auth.ts');
    const { POST } = await load('app/api/auth/signout-all/route.ts');
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken(42, 'email', Date.now())}`;
    const cases: [string, Row, number][] = [
      ['another Origin', { origin: 'https://evil.example', cookie }, 403],
      ['a form body', { type: 'application/x-www-form-urlencoded', body: 'user_id=42', cookie }, 415],
      ['no credential', {}, 401],
      ['42\'s cookie for user 9', { cookie, url: '/api/auth/signout-all?user_id=9' }, 401],
    ];
    for (const [label, o, status] of cases) {
      const res: Response = await POST(req(o.url ?? '/api/auth/signout-all?user_id=42', o));
      assert(res.status === status, `${label}: ${res.status}, want ${status}`);
    }
    assert(DB.user.every((u) => u.sessionsValidAfter === null), `written: ${show(DB.user.map((u) => [u.id, u.sessionsValidAfter]))}`);
  });

  await check('#31 a body that is not JSON is 400, and its text is never logged', async () => {
    reset();
    const { POST } = await load('app/api/auth/signout-all/route.ts');
    const res: Response = await POST(req('/api/auth/signout-all?user_id=42', { body: 'email=dana@gmail.com&code=123456' }));
    assert(res.status === 400, `status ${res.status}`);
    assert(!logLines.some((l) => l.includes('dana') || l.includes('123456')), `the body in the log: ${show(logLines)}`);
  });

  // ---- 6c-1 Task 4: the sign-up code's share, the notices' budget and their per-account share, the new-accounts cap ----

  await check('#32 sign-up codes: 3 a day per client address (the 4th is signup-ip-day and counts nothing for the day; another address passes; free a day later); 30 a UTC day in all (the 31st is signup-day, the admin told once, at the 31st, with no address; the 32nd refused too; 00:00 UTC starts over); none of it takes from the 90', async () => {
    reset();
    setClock(Date.UTC(2026, 10, 4, 21, 0));
    const { takeSignUpSend } = await limits();
    for (let i = 1; i <= 3; i++) assert((await takeSignUpSend('203.0.113.5')).ok, `send ${i} from one address`);
    const fourth = await takeSignUpSend('203.0.113.5');
    assert(!fourth.ok && fourth.reason === 'signup-ip-day', `the 4th from one address: ${show(fourth)}`);
    assert((await takeSignUpSend('2001:db8:1:2::/64')).ok, 'another address');
    // 4 counted for the day so far (the refused 4th is not); 26 more from fresh addresses make 30
    for (let i = 0; i < 26; i++) assert((await takeSignUpSend(`198.51.100.${Math.floor(i / 3) + 1}`)).ok, `send ${i + 5} of the day`);
    assert(adminWarnings.length === 0, `the admin was told early: ${show(adminWarnings)}`);
    const over = await takeSignUpSend('192.0.2.1');
    assert(!over.ok && over.reason === 'signup-day', `the 31st ${show(over)}`);
    assert((await takeSignUpSend('192.0.2.2')).ok === false, 'the 32nd');
    assert((adminWarnings.length as number) === 1 && adminWarnings[0].context === 'signin-signup-budget', `admin messages ${show(adminWarnings)}`);
    assert(adminWarnings[0].message.includes('30') && !/@|203\.0\.113|192\.0\.2/.test(adminWarnings[0].message), `the admin message: ${adminWarnings[0].message}`);
    const dayKey = [...store.keys()].find((k) => k.startsWith('signin:lim:signup-send:'));
    assert(dayKey === 'signin:lim:signup-send:2026-11-04' && ttlOf(dayKey) === 3 * 3600, `day key ${dayKey} ttl ${dayKey && ttlOf(dayKey)}`);
    assert(![...store.keys()].some((k) => k.startsWith('signin:lim:daily-send:')), 'the sign-up share took from the 90 (issueCode does that, once per code)');
    setClock(Date.UTC(2026, 10, 5, 0, 0, 1));
    assert((await takeSignUpSend('192.0.2.3')).ok, 'refused after 00:00 UTC');
    advance(24 * 3600);
    assert((await takeSignUpSend('203.0.113.5')).ok, 'the first address still refused a day later');
    assert(!logLines.some((l) => /203\.0\.113|198\.51\.100|192\.0\.2|2001:db8/.test(l)), `an address in the log: ${show(logLines)}`);
  });

  await check('#33 security notices by email: their own 10 a UTC day, apart from the 90 (they go out with the 90 spent, and take nothing from it); the 11th refused (notice-budget) and logged; 00:00 UTC starts over; Redis failing refuses (store-down) and reports', async () => {
    reset();
    setClock(Date.UTC(2026, 10, 4, 12, 0));
    const { takeNoticeSend, takeDailySend } = await limits();
    for (let i = 1; i <= 91; i++) await takeDailySend();
    const spentKey = [...store.keys()].find((k) => k.startsWith('signin:lim:daily-send:')) as string;
    const spent = store.get(spentKey)?.value;
    // Ten accounts, one notice each, so the account's own share never refuses here (#37 pins it)
    for (let i = 1; i <= 10; i++) assert((await takeNoticeSend(100 + i)).ok === true, `notice ${i} refused`);
    const eleventh = await takeNoticeSend(111);
    assert(!eleventh.ok && eleventh.reason === 'notice-budget', `the 11th notice: ${show(eleventh)}`);
    assert(store.get(spentKey)?.value === spent, 'the notices took from the 90');
    const noticeKey = [...store.keys()].find((k) => k.startsWith('signin:lim:notice-send:'));
    assert(noticeKey === 'signin:lim:notice-send:2026-11-04' && ttlOf(noticeKey) === 12 * 3600, `notice key ${noticeKey} ttl ${noticeKey && ttlOf(noticeKey)}`);
    assert(logLines.some((l) => l.includes('security notices')), 'the 11th is not logged');
    setClock(Date.UTC(2026, 10, 5, 0, 0, 1));
    assert((await takeNoticeSend(111)).ok === true, 'refused after 00:00 UTC');
    redisDown = true;
    const down = await takeNoticeSend(112);
    assert(!down.ok && down.reason === 'store-down', `a notice with Redis down: ${show(down)}`);
    assert(captured.some((c) => c.startsWith('signin-limits')), `not reported: ${show(captured)}`);
  });

  await check('#34 new accounts: 5 a day per IPv4 address (the 6th is accounts-ip-day; another address passes; free a day later); IPv6 by its /48, so the /64s of one /48 share a count and another /48 passes; no address counts nothing and says so; no line holds an address; Redis failing refuses (store-down) and reports', async () => {
    reset();
    const { allowNewAccount } = await limits();
    for (let i = 1; i <= 5; i++) assert((await allowNewAccount('203.0.113.5')).ok, `account ${i}`);
    const sixth = await allowNewAccount('203.0.113.5');
    assert(!sixth.ok && sixth.reason === 'accounts-ip-day', `the 6th ${show(sixth)}`);
    assert((await allowNewAccount('203.0.113.6')).ok, 'another IPv4 address');
    for (let i = 1; i <= 5; i++) assert((await allowNewAccount(`2001:db8:1:${i}::/64`)).ok, `IPv6 account ${i}`);
    const v6 = await allowNewAccount('2001:db8:1:ff::/64');
    assert(!v6.ok && v6.reason === 'accounts-ip-day', `a 6th /64 of one /48: ${show(v6)}`);
    assert((await allowNewAccount('2001:db8:2:1::/64')).ok, 'another /48');
    const keysBefore = store.size;
    const mark = logLines.length;
    assert((await allowNewAccount(null)).ok, 'no address refused');
    assert(store.size === keysBefore, 'a request with no address was counted');
    assert(logLines.slice(mark).includes('[signup] no client address; the account cap is not counted'), `no line: ${show(logLines.slice(mark))}`);
    advance(24 * 3600 + 1);
    assert((await allowNewAccount('203.0.113.5')).ok, 'still refused a day later');
    assert(!logLines.some((l) => /203\.0\.113|2001:db8/.test(l)), `an address in the log: ${show(logLines)}`);
    redisDown = true;
    const down = await allowNewAccount('203.0.113.7');
    assert(!down.ok && down.reason === 'store-down', `Redis down: ${show(down)}`);
    assert(captured.some((c) => c.startsWith('signin-limits')), `not reported: ${show(captured)}`);
  });

  await check('#35 accountAddressKey: an IPv4 address as it is; clientAddress\'s IPv6 /64 as its /48; an IPv4-mapped IPv6 address as its IPv4', async () => {
    const { accountAddressKey, clientAddress } = await load('src/services/web-signin/client-address.ts');
    const at = (ip: string) => accountAddressKey(clientAddress(new Request('https://famcal.bot/', { headers: { 'x-real-ip': ip } })));
    const table: [string, string][] = [
      ['203.0.113.5', '203.0.113.5'],
      ['2001:db8:1:2:aaaa::1', '2001:db8:1::/48'],
      ['2001:db8:1:ffff::9', '2001:db8:1::/48'],
      ['2001:DB8:abcd:12::1', '2001:db8:abcd::/48'],
      ['2001:db8::1', '2001:db8:0::/48'],
      ['::ffff:192.0.2.7', '192.0.2.7'],
    ];
    const wrong = table.filter(([ip, want]) => at(ip) !== want).map(([ip, want]) => `${ip}: ${at(ip)}, want ${want}`);
    assert(wrong.length === 0, wrong.join('; '));
  });

  await check('#36 the sign-up share with Redis failing: refused (store-down) and reported once', async () => {
    reset();
    const { takeSignUpSend } = await limits();
    redisDown = true;
    const r = await takeSignUpSend('203.0.113.5');
    assert(!r.ok && r.reason === 'store-down', `Redis down: ${show(r)}`);
    assert(captured.filter((c) => c.startsWith('signin-limits')).length === 1, `reports ${show(captured)}`);
  });

  await check('#37 security notices per account: 3 a UTC day each (the 4th is notice-account-day, logged with the user id, and takes nothing from the day\'s 10); another account\'s notice still goes out; the day\'s 10 still hold across accounts; 00:00 UTC starts the account over', async () => {
    reset();
    setClock(Date.UTC(2026, 10, 4, 12, 0));
    const { takeNoticeSend } = await limits();
    for (let i = 1; i <= 3; i++) assert((await takeNoticeSend(7)).ok === true, `account 7's notice ${i} refused`);
    const mark = logLines.length;
    const fourth = await takeNoticeSend(7);
    assert(!fourth.ok && fourth.reason === 'notice-account-day', `account 7's 4th: ${show(fourth)}`);
    assert(logLines.slice(mark).some((l) => l.includes('notice-account-day') && l.includes('user 7')), `no line: ${show(logLines.slice(mark))}`);
    assert((await takeNoticeSend(8)).ok === true, 'account 8\'s notice refused once account 7\'s share was spent');
    const noticeKey = 'signin:lim:notice-send:2026-11-04';
    assert(store.get(noticeKey)?.value === '4', `the day's count is ${store.get(noticeKey)?.value}, want 3 + 1 (the refused 4th takes nothing)`);
    const accountKeys = [...store.keys()].filter((k) => k.startsWith('signin:lim:notice-account-day:'));
    assert(accountKeys.length === 2 && accountKeys.every((k) => ttlOf(k) === 12 * 3600) && !accountKeys.some((k) => /:(7|8)$/.test(k)), `account keys ${show(accountKeys.map((k) => [k, ttlOf(k)]))}`);
    // Accounts 9 and 10 take 3 each: 10 in all, so a fresh account's first notice is the day's 11th
    for (const id of [9, 9, 9, 10, 10, 10]) assert((await takeNoticeSend(id)).ok === true, `account ${id} refused before the day's 10`);
    const over = await takeNoticeSend(11);
    assert(!over.ok && over.reason === 'notice-budget', `the day's 11th, from a fresh account: ${show(over)}`);
    setClock(Date.UTC(2026, 10, 5, 0, 0, 1));
    assert((await takeNoticeSend(7)).ok === true, 'account 7 still refused after 00:00 UTC');
  });

  let failed = 0;
  for (const r of results) {
    process.stdout.write(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}\n`);
    if (!r.ok) failed++;
  }
  process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

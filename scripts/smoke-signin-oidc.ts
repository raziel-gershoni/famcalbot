// Smoke test for signing in on famcal.bot with Telegram and Google (spec
// docs/superpowers/specs/2026-11-02-web-sign-in-design.md §3 and §8 "Flows"): the start routes' redirect, the
// one-time checks kept for the browser (state, nonce, PKCE S256, famcal_signin), the callbacks' refusals (wrong,
// reused or late state, no cookie, wrong nonce, wrong audience, a foreign signature, ES256, an expired token,
// email_verified false; two sign-ins started in one browser: the older one's callback restarts and signs nobody in,
// the newer one still signs in; a provider's ?error=), Telegram found by its `id` claim and never by `sub`, Google found by `sub` and never by
// email, the no-account page, the retry layers (googleFetch for Google, fetchWithRetry for Telegram, no timeout
// signal), one discovery per provider, and no secret or email in a log line or a Sentry report.
//
// Real: the four routes, oidc-route, oidc (openid-client 6.8.8 and its checks), google-signin, identities, flow,
// web-session (finishSignIn), session-auth, user-service, user-moderation, fetch-retry and google-retry. Faked at
// the boundaries: Prisma (in memory), Redis (in memory, with expiry on a clock the smoke moves), error capture
// (recorded), Telegram and messaging (inert), and fetch, which plays both providers: their discovery documents,
// their keys (an RSA key made here; tokens are signed with node's crypto) and their token endpoints, which check the
// client secret, the redirect URI, the one-use code and the PKCE verifier against the challenge. No network, no DB.
//
// Run with the fake env from scripts/ci-smokes.sh (no dotenv):
//   npx tsx scripts/smoke-signin-oidc.ts

import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

// Test values. The base URL and the sign-in clients are set outright: the checks depend on them.
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.bot';
process.env.GOOGLE_CLIENT_ID = 'calendar-client.apps.googleusercontent.com';
const SIGNIN_ENV = {
  TELEGRAM_LOGIN_CLIENT_ID: '7000001',
  TELEGRAM_LOGIN_CLIENT_SECRET: 'tg-login-secret-5e3f',
  GOOGLE_SIGNIN_CLIENT_ID: 'signin-client.apps.googleusercontent.com',
  GOOGLE_SIGNIN_CLIENT_SECRET: 'g-signin-secret-9a1c',
};
Object.assign(process.env, SIGNIN_ENV);

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

// ---- Fake Prisma: in-memory tables, compound unique keys, `include` of a `<name>Id` relation ----

const DB: Record<string, Row[]> = {};
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
    // A compound unique key (kind_subject: { kind, subject }) names no column of its own.
    if (isPlain(cond) && !(k in row) && k.includes('_')) return matches(row, cond);
    const v = row[k];
    if (isPlain(cond)) {
      if ('equals' in cond && !same(v ?? null, cond.equals)) return false;
      if ('in' in cond && !(cond.in as unknown[]).some(x => same(v, x))) return false;
      if ('not' in cond && same(v ?? null, cond.not)) return false;
      if ('lt' in cond && !(v != null && num(v) < num(cond.lt))) return false;
      if ('gt' in cond && !(v != null && num(v) > num(cond.gt))) return false;
      return true;
    }
    return same(v ?? null, cond);
  });
}

function shape(name: string, row: Row | undefined, a: Row = {}): Row | null {
  if (!row) return null;
  const out: Row = a.select ? Object.fromEntries(Object.keys(a.select).filter(k => a.select[k]).map(k => [k, row[k]])) : { ...row };
  for (const [rel, on] of Object.entries(a.include ?? {})) {
    if (on) out[rel] = { ...(DB[rel] ?? []).find(r => same(r.id, row[`${rel}Id`])) };
  }
  return out;
}

const prismaCalls: string[] = [];
function model(name: string): Row {
  const t = () => (DB[name] ??= []);
  const impl: Row = {
    findUnique: async (a: Row = {}) => shape(name, t().find(r => matches(r, a.where)), a),
    findFirst: async (a: Row = {}) => shape(name, t().find(r => matches(r, a.where)), a),
    findMany: async (a: Row = {}) => t().filter(r => matches(r, a.where)).map(r => shape(name, r, a)),
    count: async (a: Row = {}) => t().filter(r => matches(r, a.where)).length,
    update: async (a: Row) => {
      const row = t().find(r => matches(r, a.where));
      if (!row) throw Object.assign(new Error(`No ${name} record was found for an update.`), { code: 'P2025' });
      Object.assign(row, a.data);
      return shape(name, row, a);
    },
    updateMany: async (a: Row) => {
      const rows = t().filter(r => matches(r, a.where));
      rows.forEach(r => Object.assign(r, a.data));
      return { count: rows.length };
    },
  };
  return Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, (...args: unknown[]) => { prismaCalls.push(`${name}.${k}`); return fn(...args); }]),
  );
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

// ---- Fake Redis (Upstash parses JSON on read), with expiry on a clock the smoke can move ----

let redisSkewMs = 0;
const redisNow = () => Date.now() + redisSkewMs;
const redisStore = new Map<string, { raw: string; expiresAt: number | null }>();
const live = (k: string) => {
  const e = redisStore.get(k);
  if (e && e.expiresAt !== null && e.expiresAt <= redisNow()) redisStore.delete(k);
  return redisStore.get(k);
};
const decode = (raw: string | undefined) => {
  if (raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return raw; }
};
const encode = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
const expiry = (o?: Row) => (o?.ex ? redisNow() + o.ex * 1000 : o?.px ? redisNow() + o.px : null);
const redisImpl: Row = {
  get: async (k: string) => decode(live(k)?.raw),
  set: async (k: string, v: unknown, o?: Row) => {
    if (o?.nx && live(k)) return null;
    redisStore.set(k, { raw: encode(v), expiresAt: expiry(o) });
    return 'OK';
  },
  setex: async (k: string, sec: number, v: unknown) => { redisStore.set(k, { raw: encode(v), expiresAt: redisNow() + sec * 1000 }); return 'OK'; },
  // Reads and deletes in one tick, as GETDEL does.
  getdel: async (k: string) => { const e = live(k); redisStore.delete(k); return decode(e?.raw); },
  del: async (...ks: unknown[]) => ks.flat().reduce((n: number, k) => n + (redisStore.delete(String(k)) ? 1 : 0), 0),
  incr: async (k: string) => { const n = Number(live(k)?.raw ?? 0) + 1; redisStore.set(k, { raw: String(n), expiresAt: live(k)?.expiresAt ?? null }); return n; },
  expire: async (k: string, sec: number) => { const e = live(k); if (!e) return 0; e.expiresAt = redisNow() + sec * 1000; return 1; },
  exists: async (...ks: string[]) => ks.filter(k => live(k)).length,
};
const fakeRedis = new Proxy(redisImpl, {
  get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? (async () => null)),
});

// ---- What reached the logs and Sentry ----

const logged: string[] = [];
const captured: { context: string; message: string; extra: string; severity?: string }[] = [];
const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
function recordConsole() {
  const record = (...args: unknown[]) => {
    logged.push(args.map(a => (a instanceof Error ? `${a.name}: ${a.message} ${show((a as { cause?: unknown }).cause ?? '')}` : typeof a === 'string' ? a : show(a))).join(' '));
  };
  Object.assign(console, { log: record, info: record, warn: record, error: record });
}

function installStubs(messagingTypes: Row) {
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
  const capture = (severity?: string) => (e: unknown, context: string, extra?: unknown) => {
    captured.push({ context, message: e instanceof Error ? e.message : String(e), extra: show(extra ?? null), severity });
  };
  stub('src/lib/error-capture.ts', { captureError: (e: unknown, c: string, x?: unknown, s?: string) => capture(s ?? 'error')(e, c, x), captureWarning: capture('warning'), captureInfo: () => undefined });
  const inert: Row = new Proxy({} as Row, {
    get: (_t, p) => (typeof p !== 'string' || p === 'then' ? undefined : async () => { throw new Error(`no ${p} in this smoke`); }),
  });
  const telegram = { getBot: () => inert, initBot: () => inert, getMessagingService: () => inert, setUserMenuButton: async () => undefined };
  stub('src/services/telegram/index.ts', telegram);
  stub('src/services/telegram/bot.ts', telegram);
  const messaging = { ...messagingTypes, getMessagingService: () => inert, getTelegramService: () => inert, getWhatsAppService: () => inert, detectPlatform: () => 'telegram' };
  stub('src/services/messaging/index.ts', messaging);
  stub('src/services/messaging/factory.ts', messaging);
}

// ---- The two providers, played by fetch ----

type P = 'telegram' | 'google';
const RSA = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const FOREIGN_RSA = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const EC = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const SERVERS = {
  telegram: {
    issuer: 'https://oauth.telegram.org',
    discovery: 'https://oauth.telegram.org/.well-known/openid-configuration',
    auth: 'https://oauth.telegram.org/auth',
    token: 'https://oauth.telegram.org/token',
    jwks: 'https://oauth.telegram.org/.well-known/jwks.json',
    kid: 'oidc-1',
    algs: ['RS256', 'ES256', 'EdDSA', 'ES256K'],
    clientId: () => SIGNIN_ENV.TELEGRAM_LOGIN_CLIENT_ID,
    secret: () => SIGNIN_ENV.TELEGRAM_LOGIN_CLIENT_SECRET,
  },
  google: {
    issuer: 'https://accounts.google.com',
    discovery: 'https://accounts.google.com/.well-known/openid-configuration',
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    kid: 'g-1',
    algs: ['RS256'],
    clientId: () => SIGNIN_ENV.GOOGLE_SIGNIN_CLIENT_ID,
    secret: () => SIGNIN_ENV.GOOGLE_SIGNIN_CLIENT_SECRET,
  },
};

const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function signJwt(claims: Row, kid: string, o: { alg?: 'RS256' | 'ES256'; key?: crypto.KeyObject } = {}): string {
  const alg = o.alg ?? 'RS256';
  const input = `${b64({ alg, kid, typ: 'JWT' })}.${b64(claims)}`;
  const sig = alg === 'RS256'
    ? crypto.sign('sha256', Buffer.from(input), o.key ?? RSA.privateKey)
    : crypto.sign('sha256', Buffer.from(input), { key: o.key ?? EC.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

/** Every value a log line must never hold: codes, states, nonces, verifiers, tokens, secrets, the email. */
const secrets = new Set<string>([SIGNIN_ENV.TELEGRAM_LOGIN_CLIENT_SECRET, SIGNIN_ENV.GOOGLE_SIGNIN_CLIENT_SECRET, 'dana@gmail.com']);
const codes = new Map<string, { p: P; challenge: string; redirectUri: string; idToken: string; used: boolean }>();
const fetches: { url: string; method: string; signal: boolean }[] = [];
const tokenCalls: { p: P; status: number }[] = [];
// A call, so TypeScript does not narrow `tokenCalls.length` to the 0 an earlier assert proved (it is not 0 after a sign-in).
const tokenCount = () => tokenCalls.length;
const failOnce = new Set<string>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function providerFetch(url: string, init: RequestInit): Response {
  const method = (init.method ?? 'GET').toUpperCase();
  for (const p of ['telegram', 'google'] as P[]) {
    const s = SERVERS[p];
    if (url === s.discovery) {
      return json({
        issuer: s.issuer, authorization_endpoint: s.auth, token_endpoint: s.token, jwks_uri: s.jwks,
        response_types_supported: ['code'], subject_types_supported: ['public'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        id_token_signing_alg_values_supported: s.algs, code_challenge_methods_supported: ['plain', 'S256'],
      });
    }
    if (url === s.jwks) {
      return json({ keys: [
        { ...RSA.publicKey.export({ format: 'jwk' }), kid: s.kid, alg: 'RS256', use: 'sig' },
        { ...EC.publicKey.export({ format: 'jwk' }), kid: `${s.kid}-es`, alg: 'ES256', use: 'sig' },
      ] });
    }
    if (url === s.token && method === 'POST') {
      const form = new URLSearchParams(String(init.body));
      const entry = codes.get(form.get('code') ?? '');
      const challenge = crypto.createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      const refuse = (status: number, error: string) => { tokenCalls.push({ p, status }); return json({ error }, status); };
      if (form.get('client_id') !== s.clientId() || form.get('client_secret') !== s.secret()) return refuse(401, 'invalid_client');
      if (!entry || entry.used || entry.p !== p || form.get('grant_type') !== 'authorization_code') return refuse(400, 'invalid_grant');
      if (form.get('redirect_uri') !== entry.redirectUri || challenge !== entry.challenge) return refuse(400, 'invalid_grant');
      entry.used = true;
      const accessToken = `at-${crypto.randomUUID()}`;
      secrets.add(accessToken);
      tokenCalls.push({ p, status: 200 });
      return json({ access_token: accessToken, token_type: 'Bearer', expires_in: 30, id_token: entry.idToken });
    }
  }
  throw new Error(`network blocked in smoke: ${method} ${url}`);
}

interface Approval { alg?: 'RS256' | 'ES256'; key?: crypto.KeyObject; nonce?: string | null; aud?: unknown; expIn?: number; iss?: string }

/** The provider's side of an approval: an id_token for this authorization request, and the URL the browser comes back to. */
function approve(p: P, authUrl: URL, claims: Row, o: Approval = {}): URL {
  const q = authUrl.searchParams;
  const now = Math.floor(Date.now() / 1000);
  const nonce = o.nonce === undefined ? q.get('nonce') : o.nonce;
  const body: Row = { iss: o.iss ?? SERVERS[p].issuer, aud: o.aud ?? q.get('client_id'), iat: now, exp: now + (o.expIn ?? 30), ...(nonce === null ? {} : { nonce }), ...claims };
  const code = crypto.randomBytes(16).toString('hex');
  const idToken = signJwt(body, o.alg === 'ES256' ? `${SERVERS[p].kid}-es` : SERVERS[p].kid, o);
  codes.set(code, { p, challenge: q.get('code_challenge') ?? '', redirectUri: q.get('redirect_uri') ?? '', idToken, used: false });
  for (const v of [code, idToken, q.get('state'), q.get('nonce')]) if (v) secrets.add(v);
  const back = new URL(q.get('redirect_uri') ?? '');
  back.searchParams.set('code', code);
  back.searchParams.set('state', q.get('state') ?? '');
  return back;
}

// ---- Fixtures ----

const DAY = 86_400_000;
function baseUser(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', culture: 'default',
    messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null, calendarSource: 'NATIVE',
    pairingId: null, remindersEnabled: false, suspendedAt: null, unreachableSince: null, whatsappPhone: null,
    whatsappBsuid: null, telegramId: null, isAdmin: false, globalRules: [], defaultReminderMinutes: null,
    sessionsValidAfter: null, googleAccountKey: null, googleCalendarSignIn: true,
    createdAt: new Date(Date.now() - 30 * DAY), updatedAt: new Date(Date.now() - DAY),
    ...o,
  };
}

/**
 * 9 = Telegram user 111111111 (en). 1 = Telegram user 5550001 (he) with a Google sign-in way (sub g-sub-1).
 * 7 = Telegram user 777, whose id is the `sub` the Telegram tokens below carry. 3 = WhatsApp-only, with an email
 * sign-in way for dana@gmail.com, the address the Google tokens carry.
 */
function seed() {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  redisSkewMs = 0;
  codes.clear();
  tokenCalls.length = 0;
  captured.length = 0;
  failOnce.clear();
  DB.user = [
    baseUser({ id: 9, name: 'Tal', telegramId: BigInt(111111111) }),
    baseUser({ id: 1, name: 'Dana', telegramId: BigInt(5550001), language: 'he' }),
    baseUser({ id: 7, name: 'Sub-Twin', telegramId: BigInt(777) }),
    baseUser({ id: 3, name: 'WA', messagingPlatform: 'whatsapp', whatsappPhone: '972500000003' }),
  ];
  DB.signInIdentity = [
    { id: 1, userId: 1, kind: 'google', subject: 'g-sub-1', address: 'dana@gmail.com', createdAt: new Date(Date.now() - DAY), lastUsedAt: null },
    { id: 2, userId: 3, kind: 'email', subject: 'dana@gmail.com', address: 'dana@gmail.com', createdAt: new Date(Date.now() - DAY), lastUsedAt: null },
  ];
}

const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

async function main() {
  installStubs(await load('src/services/messaging/types.ts'));
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    fetches.push({ url, method: (init.method ?? 'GET').toUpperCase(), signal: init.signal != null });
    if (failOnce.delete(url)) return json({ error: 'backend_error' }, 503);
    return providerFetch(url, init);
  }) as typeof fetch;

  const { NextRequest } = nodeRequire('next/server');
  const { __useRetryForTests } = await load('src/utils/fetch-retry.ts');
  const { __useGoogleRetryForTests } = await load('src/services/google-retry.ts');
  __useRetryForTests({ sleep: async () => undefined });
  __useGoogleRetryForTests({ sleep: async () => undefined });
  const { SESSION_COOKIE_NAME, validateSessionToken } = await load('src/lib/session-auth.ts');
  const { signInPageUrl } = await load('src/lib/web-session.ts');
  const { SIGNIN_COOKIE_NAME } = await load('src/services/web-signin/flow.ts');
  const { __resetOidcForTests } = await load('src/services/web-signin/oidc.ts');
  const routes = {
    telegram: { start: await load('app/api/auth/telegram/start/route.ts'), callback: await load('app/api/auth/telegram/callback/route.ts') },
    google: { start: await load('app/api/auth/google/start/route.ts'), callback: await load('app/api/auth/google/callback/route.ts') },
  };
  recordConsole();

  const req = (url: string, cookie?: string) =>
    new NextRequest(url, { headers: { 'accept-language': 'en', ...(cookie ? { cookie } : {}) } });
  const setCookies = (res: Response): string[] => res.headers.getSetCookie();
  const cookieOf = (res: Response, name: string) => setCookies(res).find(c => c.startsWith(`${name}=`));
  const valueOf = (res: Response, name: string) => cookieOf(res, name)?.split(';')[0].slice(name.length + 1) ?? '';
  const location = (res: Response) => res.headers.get('location') ?? '';
  const sessionOf = (res: Response) => {
    const value = valueOf(res, SESSION_COOKIE_NAME);
    return value ? validateSessionToken(decodeURIComponent(value)) : null;
  };

  /** /api/auth/<p>/start: the provider's URL and this browser's famcal_signin cookie. */
  async function start(p: P, locale = 'en') {
    const res: Response = await routes[p].start.GET(req(`https://famcal.bot/api/auth/${p}/start?locale=${locale}`));
    const flowCookie = `${SIGNIN_COOKIE_NAME}=${valueOf(res, SIGNIN_COOKIE_NAME)}`;
    return { res, url: new URL(location(res)), flowCookie };
  }
  /** The browser back on /api/auth/<p>/callback with what the provider gave it. */
  const callback = (p: P, back: URL, cookie?: string): Promise<Response> => routes[p].callback.GET(req(back.href, cookie));
  /** A whole sign-in: start, the provider's approval with these claims, the callback. */
  async function signIn(p: P, claims: Row, o: Approval = {}, locale = 'en') {
    const s = await start(p, locale);
    const back = approve(p, s.url, claims, o);
    return { ...s, back, res: await callback(p, back, s.flowCookie) };
  }
  const isSignInPage = (res: Response, locale: string, status: string) => location(res) === signInPageUrl(locale, status);
  const flowCleared = (res: Response) => {
    const c = cookieOf(res, SIGNIN_COOKIE_NAME) ?? '';
    return /^famcal_signin=;/.test(c) && /Path=\/api\/auth/i.test(c) && /(Max-Age=0|Expires=Thu, 01 Jan 1970)/i.test(c);
  };
  const lastCapture = () => captured[captured.length - 1];

  // ---- Not set up ----

  await check('#1 a way whose client id or secret is unset stays off: its start goes to /signin?status=unavailable, with no flow and no request', async () => {
    seed();
    const before = fetches.length;
    delete process.env.TELEGRAM_LOGIN_CLIENT_SECRET;
    process.env.GOOGLE_SIGNIN_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
    try {
      const tg = await routes.telegram.start.GET(req('https://famcal.bot/api/auth/telegram/start?locale=ru'));
      assert(isSignInPage(tg, 'ru', 'unavailable'), `telegram: ${tg.status} ${location(tg)}`);
      const g = await routes.google.start.GET(req('https://famcal.bot/api/auth/google/start?locale=en'));
      assert(isSignInPage(g, 'en', 'unavailable'), `google on the calendar client: ${g.status} ${location(g)}`);
      assert(!cookieOf(tg, SIGNIN_COOKIE_NAME) && !cookieOf(g, SIGNIN_COOKIE_NAME), `a flow cookie was set: ${show([setCookies(tg), setCookies(g)])}`);
      assert(redisStore.size === 0, `flows kept: ${show([...redisStore.keys()])}`);
      assert(fetches.length === before, `requests: ${show(fetches.slice(before))}`);
    } finally {
      Object.assign(process.env, SIGNIN_ENV);
      __resetOidcForTests();
    }
  });

  // ---- The start ----

  await check('#2 Telegram start: Telegram\'s /auth with our client, redirect URI from the base URL, openid profile, S256, state, nonce and origin; famcal_signin is HttpOnly, Secure, Lax, Path=/api/auth', async () => {
    seed();
    const { res, url } = await start('telegram');
    const q = url.searchParams;
    assert(res.status >= 300 && res.status < 400, `status ${res.status}`);
    assert(`${url.origin}${url.pathname}` === SERVERS.telegram.auth, `to ${url.origin}${url.pathname}`);
    assert(q.get('client_id') === SIGNIN_ENV.TELEGRAM_LOGIN_CLIENT_ID && q.get('response_type') === 'code', `client ${show([...q])}`);
    assert(q.get('redirect_uri') === 'https://famcal.bot/api/auth/telegram/callback', `redirect_uri ${q.get('redirect_uri')}`);
    assert(q.get('scope') === 'openid profile', `scope ${q.get('scope')}`);
    assert(q.get('code_challenge_method') === 'S256' && (q.get('code_challenge') ?? '').length === 43, `pkce ${q.get('code_challenge_method')} ${q.get('code_challenge')}`);
    assert((q.get('state') ?? '').length >= 22 && (q.get('nonce') ?? '').length >= 22 && q.get('state') !== q.get('nonce'), 'state and nonce');
    assert(q.get('origin') === 'https://famcal.bot', `origin ${q.get('origin')}`);
    assert(!url.href.includes(SIGNIN_ENV.TELEGRAM_LOGIN_CLIENT_SECRET), 'the client secret is in the URL');
    const c = cookieOf(res, SIGNIN_COOKIE_NAME) ?? '';
    assert(/HttpOnly/i.test(c) && /Secure/i.test(c) && /SameSite=Lax/i.test(c) && /Path=\/api\/auth/i.test(c), `flow cookie ${c}`);
  });

  await check('#3 Google start: Google\'s endpoint, openid email only, S256, state and nonce, the account chooser; never include_granted_scopes, access_type or origin', async () => {
    seed();
    const { url } = await start('google');
    const q = url.searchParams;
    assert(`${url.origin}${url.pathname}` === SERVERS.google.auth, `to ${url.origin}${url.pathname}`);
    assert(q.get('client_id') === SIGNIN_ENV.GOOGLE_SIGNIN_CLIENT_ID, `client_id ${q.get('client_id')}`);
    assert(q.get('redirect_uri') === 'https://famcal.bot/api/auth/google/callback', `redirect_uri ${q.get('redirect_uri')}`);
    assert(q.get('scope') === 'openid email', `scope ${q.get('scope')}`);
    assert(q.get('code_challenge_method') === 'S256' && q.get('state') && q.get('nonce'), `checks ${show([...q.keys()])}`);
    assert(q.get('prompt') === 'select_account', `prompt ${q.get('prompt')}`);
    for (const k of ['include_granted_scopes', 'access_type', 'origin']) assert(!q.has(k), `${k}=${q.get(k)}`);
  });

  // ---- Telegram: who it is ----

  await check('#4 Telegram, `id` as a number: user 9 is signed in (method tg) and lands on /dashboard?user_id=9 (English has no prefix); the code went with the secret and the PKCE verifier; famcal_signin is cleared', async () => {
    seed();
    const { res } = await signIn('telegram', { sub: '777', id: 111111111 });
    const to = new URL(location(res));
    assert(to.pathname === '/dashboard' && to.searchParams.get('user_id') === '9', `to ${location(res)}; ${show(captured)}`);
    const session = sessionOf(res);
    assert(session?.userId === 9 && session.method === 'tg', `session ${show(session)}`);
    assert(show(tokenCalls) === show([{ p: 'telegram', status: 200 }]), `token calls ${show(tokenCalls)}`);
    assert(flowCleared(res), `flow cookie ${show(setCookies(res))}`);
  });

  await check('#5 Telegram, `id` as a string of digits: user 1 is signed in, in their own language (/he/dashboard)', async () => {
    seed();
    const { res } = await signIn('telegram', { sub: '777', id: '5550001' });
    const to = new URL(location(res));
    assert(to.pathname === '/he/dashboard' && to.searchParams.get('user_id') === '1', `to ${location(res)}`);
    assert(sessionOf(res)?.userId === 1, `session ${show(sessionOf(res))}`);
  });

  await check('#6 Telegram never by `sub`: a token whose sub is user 7\'s Telegram id and whose id is user 9\'s signs in 9; one with that sub and no id signs in nobody (status=failed)', async () => {
    seed();
    const both = await signIn('telegram', { sub: '777', id: 111111111 });
    assert(sessionOf(both.res)?.userId === 9, `with id: ${show(sessionOf(both.res))}`);
    const subOnly = await signIn('telegram', { sub: '777' });
    assert(isSignInPage(subOnly.res, 'en', 'failed'), `sub only: ${location(subOnly.res)}`);
    assert(!sessionOf(subOnly.res), `sub only signed in ${show(sessionOf(subOnly.res))}`);
    assert(/no Telegram user id/.test(lastCapture()?.message ?? ''), `capture ${show(lastCapture())}`);
  });

  await check('#7 an unknown Telegram id gets the no-account page in the language the sign-in began in, with no session', async () => {
    seed();
    const { res } = await signIn('telegram', { sub: '1', id: 222222222 }, {}, 'ru');
    assert(isSignInPage(res, 'ru', 'no-account'), `to ${location(res)}`);
    assert(!sessionOf(res) && flowCleared(res), `cookies ${show(setCookies(res))}`);
  });

  await check('#8 a suspended account goes to finishSignIn\'s suspended page, with no session', async () => {
    seed();
    DB.user.find(u => u.id === 9)!.suspendedAt = new Date(Date.now() - DAY);
    const { res } = await signIn('telegram', { sub: '1', id: 111111111 });
    assert(isSignInPage(res, 'en', 'suspended') && !sessionOf(res), `to ${location(res)} ${show(setCookies(res))}`);
  });

  // ---- The one-time checks ----

  await check('#9 a reused state: the same callback a second time is status=restart and makes no second exchange', async () => {
    seed();
    const first = await signIn('telegram', { sub: '1', id: 111111111 });
    assert(sessionOf(first.res)?.userId === 9, `first ${location(first.res)}`);
    const again = await callback('telegram', first.back, first.flowCookie);
    assert(isSignInPage(again, 'en', 'restart') && !sessionOf(again), `again ${location(again)}`);
    assert(tokenCalls.length === 1, `token calls ${show(tokenCalls)}`);
  });

  await check('#10 a wrong state is status=restart with no exchange: the cookie it came with is used up (the right state under it is refused too), and this browser\'s flow is kept under a new id, which still signs in', async () => {
    seed();
    const s = await start('telegram');
    const back = approve('telegram', s.url, { sub: '1', id: 111111111 });
    const forged = new URL(back.href);
    forged.searchParams.set('state', 'not-the-state');
    const wrong = await callback('telegram', forged, s.flowCookie);
    assert(isSignInPage(wrong, 'en', 'restart') && !sessionOf(wrong), `wrong ${location(wrong)}`);
    const kept = valueOf(wrong, SIGNIN_COOKIE_NAME);
    assert(kept !== '' && kept !== s.flowCookie.slice(SIGNIN_COOKIE_NAME.length + 1) && !flowCleared(wrong), `the flow was not kept under a new id: ${show(setCookies(wrong))}`);
    const old = await callback('telegram', back, s.flowCookie);
    assert(isSignInPage(old, 'en', 'restart') && !sessionOf(old), `right state under the used-up cookie ${location(old)}`);
    assert(tokenCalls.length === 0, `token calls ${show(tokenCalls)}`);
    const right = await callback('telegram', back, `${SIGNIN_COOKIE_NAME}=${kept}`);
    assert(sessionOf(right)?.userId === 9, `right state under the kept flow ${location(right)}`);
  });

  await check('#10b the flow kept after a wrong state keeps the time it had left: 5 minutes into the sign-in, the kept record and its cookie live for the other 5, not a new 10', async () => {
    seed();
    const s = await start('telegram');
    const back = approve('telegram', s.url, { sub: '1', id: 111111111 });
    const forged = new URL(back.href);
    forged.searchParams.set('state', 'not-the-state');
    const realNow = Date.now;
    Date.now = () => realNow() + 300_000;
    try {
      const wrong = await callback('telegram', forged, s.flowCookie);
      const maxAge = Number(/Max-Age=(\d+)/i.exec(cookieOf(wrong, SIGNIN_COOKIE_NAME) ?? '')?.[1]);
      assert(maxAge >= 295 && maxAge <= 300, `the kept cookie lives ${maxAge} s`);
      const left = [...redisStore.values()].map(e => ((e.expiresAt ?? 0) - Date.now()) / 1000);
      assert(left.length === 1 && left[0] > 295 && left[0] <= 300, `the kept record lives ${show(left)} s`);
      // past the 10th minute a wrong state leaves no time, and nothing is kept
      Date.now = () => realNow() + 601_000;
      const late = await callback('telegram', forged, `${SIGNIN_COOKIE_NAME}=${valueOf(wrong, SIGNIN_COOKIE_NAME)}`);
      assert(isSignInPage(late, 'en', 'restart') && valueOf(late, SIGNIN_COOKIE_NAME) === '', `a flow with no time left was kept: ${show(setCookies(late))}`);
    } finally {
      Date.now = realNow;
    }
  });

  await check('#11 a late callback (over 10 minutes after the start) is status=restart with no exchange', async () => {
    seed();
    const s = await start('telegram');
    const back = approve('telegram', s.url, { sub: '1', id: 111111111 });
    redisSkewMs = 601_000;
    const res = await callback('telegram', back, s.flowCookie);
    assert(isSignInPage(res, 'en', 'restart') && !sessionOf(res), `to ${location(res)}`);
    assert(tokenCalls.length === 0, `token calls ${show(tokenCalls)}`);
  });

  await check('#12 a callback without this browser\'s famcal_signin is status=restart with no exchange', async () => {
    seed();
    const s = await start('telegram');
    const res = await callback('telegram', approve('telegram', s.url, { sub: '1', id: 111111111 }));
    assert(isSignInPage(res, 'en', 'restart') && !sessionOf(res), `to ${location(res)}`);
    assert(tokenCalls.length === 0, `token calls ${show(tokenCalls)}`);
  });

  await check('#13 a Google flow\'s cookie on the Telegram callback is status=restart with no exchange, and that Google sign-in (another tab\'s) still finishes', async () => {
    seed();
    const g = await start('google');
    const t = await start('telegram');
    const res = await callback('telegram', approve('telegram', t.url, { sub: '1', id: 111111111 }), g.flowCookie);
    assert(isSignInPage(res, 'en', 'restart') && !sessionOf(res), `to ${location(res)}`);
    assert(tokenCalls.length === 0, `token calls ${show(tokenCalls)}`);
    // Two tabs, two ways (review focus RF1): the Telegram answer neither used up nor cleared the Google sign-in this
    // browser started last, which still finishes
    assert(!flowCleared(res) && valueOf(res, SIGNIN_COOKIE_NAME) === '', `the Google sign-in's cookie was touched: ${show(setCookies(res))}`);
    const google = await callback('google', approve('google', g.url, { sub: 'g-sub-1', email: 'dana@gmail.com', email_verified: true }), g.flowCookie);
    assert(sessionOf(google)?.userId === 1, `the Google sign-in no longer finishes: ${location(google)}`);
  });

  // ---- The id_token's checks (status=failed, a Sentry warning that names the check) ----

  const refusedWith = async (name: string, p: P, claims: Row, o: Approval, expect: RegExp) => {
    seed();
    const { res } = await signIn(p, claims, o);
    assert(isSignInPage(res, 'en', 'failed'), `${name}: to ${location(res)}`);
    assert(!sessionOf(res) && flowCleared(res), `${name}: cookies ${show(setCookies(res))}`);
    const c = lastCapture();
    assert(c && c.context === 'signin-oidc' && c.severity === 'warning' && expect.test(c.message), `${name}: capture ${show(c)}`);
  };
  const tgClaims = { sub: '1', id: 111111111 };
  const gClaims = { sub: 'g-sub-1', email: 'dana@gmail.com', email_verified: true };

  await check('#14 a wrong nonce is refused', () => refusedWith('wrong nonce', 'telegram', tgClaims, { nonce: 'someone-elses-nonce' }, /claim nonce/));
  await check('#15 an id_token with no nonce is refused (the log names it, for the first live sign-in)', () => refusedWith('no nonce', 'telegram', tgClaims, { nonce: null }, /"nonce" \(nonce\) claim missing/));
  await check('#16 a Telegram token for another audience is refused', () => refusedWith('audience', 'telegram', tgClaims, { aud: 'another-bot' }, /claim aud/));
  await check('#17 a token signed by a key Telegram didn\'t publish is refused', () => refusedWith('foreign key', 'telegram', tgClaims, { key: FOREIGN_RSA.privateKey }, /signature verification failed/));
  await check('#18 an ES256 token is refused (RS256 only), though its key is published', () => refusedWith('ES256', 'telegram', tgClaims, { alg: 'ES256' }, /"alg"/));
  await check('#19 a token expired 2 minutes ago is refused', () => refusedWith('expired', 'telegram', tgClaims, { expIn: -120 }, /claim exp/));

  await check('#19b a token from another issuer is refused', () => refusedWith('issuer', 'telegram', tgClaims, { iss: 'https://oauth.example.invalid' }, /claim iss/));

  await check('#19c a malformed Telegram `id` signs in nobody (status=failed, "no Telegram user id"): zero, negative, a fraction, text, a number past 2^53, a string past int64, a string of 20 digits', async () => {
    const bad: unknown[] = [0, -5, 1.5, 'abc', '0123', '12.5', '', 2 ** 60, '9223372036854775808', '12345678901234567890'];
    for (const id of bad) {
      seed();
      const { res } = await signIn('telegram', { sub: '1', id });
      assert(isSignInPage(res, 'en', 'failed') && !sessionOf(res), `id ${show(id)}: to ${location(res)}`);
      assert(/no Telegram user id/.test(lastCapture()?.message ?? ''), `id ${show(id)}: capture ${show(lastCapture())}`);
    }
    seed();
    const top = await signIn('telegram', { sub: '1', id: '9223372036854775807' });
    assert(isSignInPage(top.res, 'en', 'no-account'), `the largest int64 is a valid id with no account: ${location(top.res)}`);
  });

  await check('#20 a token that expired 10 s ago is within the clock tolerance and signs in', async () => {
    seed();
    const { res } = await signIn('telegram', tgClaims, { expIn: -10 });
    assert(sessionOf(res)?.userId === 9, `to ${location(res)}; ${show(lastCapture())}`);
  });

  // ---- Google ----

  await check('#21 Google: the sign-in way with this sub signs in user 1 (method google, /he/dashboard) and its last use is set', async () => {
    seed();
    const { res } = await signIn('google', gClaims);
    const to = new URL(location(res));
    assert(to.pathname === '/he/dashboard' && to.searchParams.get('user_id') === '1', `to ${location(res)}; ${show(captured)}`);
    const session = sessionOf(res);
    assert(session?.userId === 1 && session.method === 'google', `session ${show(session)}`);
    assert(DB.signInIdentity[0].lastUsedAt instanceof Date, `lastUsedAt ${show(DB.signInIdentity[0])}`);
    assert(flowCleared(res), `flow cookie ${show(setCookies(res))}`);
  });

  await check('#22 Google: email_verified as the string "true" counts as verified', async () => {
    seed();
    const { res } = await signIn('google', { ...gClaims, email_verified: 'true' });
    assert(sessionOf(res)?.userId === 1, `to ${location(res)}`);
  });

  await check('#23 Google: email_verified false, "false" or missing, or no email, signs in nobody (status=failed)', async () => {
    for (const claims of [{ ...gClaims, email_verified: false }, { ...gClaims, email_verified: 'false' }, { sub: 'g-sub-1', email: 'dana@gmail.com' }, { sub: 'g-sub-1', email_verified: true }]) {
      seed();
      const { res } = await signIn('google', claims);
      assert(isSignInPage(res, 'en', 'failed') && !sessionOf(res), `${show(claims)}: to ${location(res)}`);
      assert(DB.signInIdentity[0].lastUsedAt === null, `${show(claims)}: the way was looked up`);
    }
  });

  await check('#24 Google: a token for the calendar client, or for both clients with no azp, is refused', async () => {
    await refusedWith('calendar audience', 'google', gClaims, { aud: process.env.GOOGLE_CLIENT_ID }, /claim aud/);
    await refusedWith('two audiences', 'google', gClaims, { aud: [SIGNIN_ENV.GOOGLE_SIGNIN_CLIENT_ID, process.env.GOOGLE_CLIENT_ID] }, /untrusted audiences/);
  });

  await check('#25 Google never by email: an unknown sub whose verified email is user 3\'s email way gets the no-account page', async () => {
    seed();
    const { res } = await signIn('google', { ...gClaims, sub: 'g-sub-unknown' });
    assert(isSignInPage(res, 'en', 'no-account') && !sessionOf(res), `to ${location(res)}`);
    assert(DB.signInIdentity[1].lastUsedAt === null, 'the email way was touched');
  });

  // ---- Two sign-ins in one browser, and a provider that comes back without a code ----

  await check('#26 two sign-ins started in one browser (two tabs): the first one\'s callback, whose state no longer matches the cookie the second start set, is status=restart and signs nobody in; the second one still signs in; neither can be played again', async () => {
    for (const [p, claims, userId, method] of [['telegram', tgClaims, 9, 'tg'], ['google', gClaims, 1, 'google']] as [P, Row, number, string][]) {
      seed();
      const tab1 = await start(p);
      const tab2 = await start(p);
      assert(tab1.flowCookie !== tab2.flowCookie, `${p}: both starts set the same cookie`);
      const back1 = approve(p, tab1.url, claims);
      const back2 = approve(p, tab2.url, claims);
      // The browser holds the cookie the last start set (tab 2's).
      const first = await callback(p, back1, tab2.flowCookie);
      assert(isSignInPage(first, 'en', 'restart') && !sessionOf(first), `${p}: tab 1 ${location(first)}`);
      assert(tokenCalls.length === 0, `${p}: tab 1 reached the token endpoint ${show(tokenCalls)}`);
      const kept = valueOf(first, SIGNIN_COOKIE_NAME);
      assert(kept !== '' && !flowCleared(first), `${p}: tab 2's flow was not kept: ${show(setCookies(first))}`);
      const second = await callback(p, back2, `${SIGNIN_COOKIE_NAME}=${kept}`);
      const session = sessionOf(second);
      assert(session?.userId === userId && session.method === method, `${p}: tab 2 ${location(second)} ${show(session)}`);
      assert(show(tokenCalls) === show([{ p, status: 200 }]), `${p}: token calls ${show(tokenCalls)}`);
      for (const [name, back, cookie] of [['tab 2 again', back2, `${SIGNIN_COOKIE_NAME}=${kept}`], ['tab 1 again', back1, tab2.flowCookie]] as [string, URL, string][]) {
        const replay = await callback(p, back, cookie);
        assert(isSignInPage(replay, 'en', 'restart') && !sessionOf(replay), `${p}: ${name} ${location(replay)}`);
      }
      assert(tokenCount() === 1, `${p}: token calls after the replays ${show(tokenCalls)}`);
    }
  });

  await check('#27 a provider\'s ?error= (the person cancelled): with this browser\'s state it goes back to the plain /signin page with no exchange, no Sentry report, the flow cookie cleared and the error word logged; a word that is not a lowercase OAuth word is logged as unrecognised; with a wrong state it is status=restart', async () => {
    for (const p of ['telegram', 'google'] as P[]) {
      seed();
      const answer = async (error: string, state?: string) => {
        const s = await start(p);
        const back = new URL(s.url.searchParams.get('redirect_uri') ?? '');
        back.searchParams.set('error', error);
        back.searchParams.set('state', state ?? s.url.searchParams.get('state') ?? '');
        const mark = logged.length;
        const res = await callback(p, back, s.flowCookie);
        return { res, lines: logged.slice(mark) };
      };
      const denied = await answer('access_denied');
      assert(location(denied.res) === signInPageUrl('en'), `${p}: to ${location(denied.res)}`);
      assert(!sessionOf(denied.res) && flowCleared(denied.res), `${p}: cookies ${show(setCookies(denied.res))}`);
      assert(tokenCalls.length === 0 && captured.length === 0, `${p}: token calls ${show(tokenCalls)}, reports ${show(captured)}`);
      assert(denied.lines.includes(`[signin] ${p} came back without a code (access_denied)`), `${p}: log ${show(denied.lines)}`);
      const odd = await answer('Bad value; drop table');
      assert(location(odd.res) === signInPageUrl('en'), `${p}: odd word to ${location(odd.res)}`);
      assert(odd.lines.includes(`[signin] ${p} came back without a code (unrecognised)`) && !odd.lines.some(l => l.includes('drop table')), `${p}: odd log ${show(odd.lines)}`);
      const forged = await answer('access_denied', 'not-the-state');
      assert(isSignInPage(forged.res, 'en', 'restart'), `${p}: wrong state to ${location(forged.res)}`);
    }
  });

  // ---- The retry layers, the cache, the logs ----

  await check('#28 a 503 from either token endpoint is retried by that provider\'s layer, and no request carries a timeout signal', async () => {
    seed();
    failOnce.add(SERVERS.telegram.token);
    const tg = await signIn('telegram', tgClaims);
    assert(sessionOf(tg.res)?.userId === 9, `telegram after a 503: ${location(tg.res)}; ${show(lastCapture())}`);
    failOnce.add(SERVERS.google.token);
    const g = await signIn('google', gClaims);
    assert(sessionOf(g.res)?.userId === 1, `google after a 503: ${location(g.res)}; ${show(lastCapture())}`);
    assert(logged.some(l => l.startsWith('[signin-telegram] HTTP 503; retry 1 of 3')), `no fetchWithRetry line: ${show(logged.slice(-5))}`);
    assert(logged.some(l => l.startsWith('[google-retry] POST oauth2.googleapis.com/token answered 503; retry 1 of 3')), `no googleFetch line: ${show(logged.slice(-5))}`);
    const signalled = fetches.filter(f => f.signal);
    assert(signalled.length === 0, `requests with a signal: ${show(signalled)}`);
  });

  await check('#29 discovery and the keys are fetched once per provider for the whole run', () => {
    for (const p of ['telegram', 'google'] as P[]) {
      const discoveries = fetches.filter(f => f.url === SERVERS[p].discovery).length;
      const keys = fetches.filter(f => f.url === SERVERS[p].jwks).length;
      assert(discoveries === 1 && keys === 1, `${p}: ${discoveries} discoveries, ${keys} key fetches`);
    }
  });

  await check('#30 a failed discovery is not kept: that start goes to status=failed, and the next one discovers again and works', async () => {
    seed();
    __resetOidcForTests();
    const discovery = (u: string) => u === SERVERS.telegram.discovery;
    const before = fetches.filter(f => discovery(f.url)).length;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => (discovery(String(input)) ? json({ error: 'gone' }, 404) : realFetch(input as string, init))) as typeof fetch;
    let first: Response;
    try {
      first = await routes.telegram.start.GET(req('https://famcal.bot/api/auth/telegram/start?locale=en'));
    } finally {
      globalThis.fetch = realFetch;
    }
    assert(isSignInPage(first, 'en', 'failed') && !cookieOf(first, SIGNIN_COOKIE_NAME), `first ${location(first)}`);
    assert(/could not start: .*HTTP 404/.test(lastCapture()?.message ?? ''), `capture ${show(lastCapture())}`);
    const { res } = await signIn('telegram', tgClaims);
    assert(sessionOf(res)?.userId === 9, `after ${location(res)}`);
    assert(fetches.filter(f => discovery(f.url)).length === before + 1, 'the second start did not discover again');
  });

  await check('#31 no log line or Sentry report holds the email, a code, a state, a nonce, an id_token, an access token or a client secret', () => {
    const texts = [...logged, ...captured.map(c => `${c.message} ${c.extra}`)];
    const leaks = texts.filter(t => [...secrets].some(s => t.includes(s)));
    assert(secrets.size > 20, `only ${secrets.size} values were tracked`);
    assert(leaks.length === 0, `leaked: ${show(leaks.slice(0, 3))}`);
  });

  Object.assign(console, realConsole);
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  Object.assign(console, realConsole);
  console.error(err);
  process.exit(1);
});

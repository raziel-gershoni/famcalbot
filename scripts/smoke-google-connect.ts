// Smoke test for binding a Google consent to the FamCal account that started it (R3), and
// for signing WhatsApp webhooks. Anyone could mint a consent URL with their own state and
// send it to a victim; the callback then saved the victim's Google token on the sender's
// account. Now the callback only parks the token in Redis under a fresh pendingId, sends
// the browser to /oauth-complete with that id in the URL fragment, and the token is saved
// only when the state's owner sends gc_<pendingId> from their own Telegram or WhatsApp.
// The Mini App learns of the commit from a short-lived flag, not from updatedAt. Also:
// WhatsApp-shaped webhook POSTs must carry Meta's X-Hub-Signature-256 when
// WHATSAPP_APP_SECRET is set, and entries with no phone_number_id are dropped once
// WHATSAPP_PHONE_NUMBER_ID is set.
//
// Review fixes (#20-#23): the poll counts only a commit after the attempt began (since),
// so a flag from an earlier connect can't skip the consent; the poll has a rate limit of
// its own, apart from the general one page-data shares; a reply that fails after the
// commit doesn't fail the webhook (a redelivered /start would say "expired"); and the
// "failed" reply doesn't claim nothing was saved, since the commit can fail half-way.
//
// Follow-ups (#24-#30): an unset TELEGRAM_BOT_USERNAME or WHATSAPP_PHONE_NUMBER falls back
// to gate-links' public bot and number, so it can't hide the only finish button; the
// finish page tells a WhatsApp owner to send the prefilled message; a second tap says the
// link was already used; the poll's since is the tap on Connect on the server's clock
// (oauth/start's serverTime gives the offset), so a phone whose clock runs ahead still sees
// the commit, and one that runs behind or a connect since the page opened doesn't skip the
// consent; the signature is
// checked over Meta's raw bytes, not re-serialized JSON; /start connect from an account
// already linked to WhatsApp gets the usual dashboard reply; and the admin notice escapes
// the user's name.
//
// The callback page, the finish page's helpers, google-connect, the webhook route, the
// Telegram and WhatsApp webhook handlers, /start (webhook and polling), magic-link,
// oauth/start, check-token-refresh and user-service run for real, and so does
// RefreshTokenClient (#27: its hooks on a small dispatcher, no DOM). Faked at the
// boundaries: Prisma (in memory), Redis (in memory), the rate limiter (always allows), the
// Telegram bot and messaging (record every send), the admin notifier (records), error
// capture, fetch (Google's token endpoint answers with a test token; anything else is
// blocked), and in #27 the phone (webview, localStorage, a clock off the server's, the
// poll's interval). No network, no DB.
//
// google-sync S2 (#31-#43, spec §3 and §6 "OAuth"): every consent sends
// include_granted_scopes; a 'sync' consent adds calendar.app.created and carries its FamCal
// calendar in the state (an own live one only); the callback parks the granted scopes, and
// for a sync the calendar and the account (calendars.get primary, with the exchange's access
// token); the commit saves googleScopes, puts the user's links stopped on the token or the
// permission back to work, and a sync commit re-checks the calendar and creates or
// re-enables its link. Connecting without the new scope works as before.
//
// Checks named [guard] already pass before the fix and must keep passing. The others
// fail until the fix lands.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-google-connect.ts

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
process.env.TELEGRAM_BOT_USERNAME = 'famcal_test_bot';
process.env.WHATSAPP_PHONE_NUMBER = '15550001111';
process.env.TELEGRAM_WEBHOOK_SECRET = 'test-tg-secret';
// Empty, not deleted: @prisma/client loads a .env file into every variable that is unset
process.env.WHATSAPP_APP_SECRET = '';
process.env.WHATSAPP_PHONE_NUMBER_ID = '';

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
/** Runs before every Prisma call: a test's look at what a worker tick would see at that moment. */
let beforePrismaCall: (() => void) | null = null;
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
      if ('not' in cond && (isPlain(cond.not) ? matches(row, { [k]: cond.not }) : same(v ?? null, cond.not))) return false;
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

function applyData(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (isPlain(v) && 'increment' in v) row[k] = (row[k] ?? 0) + v.increment;
    else if (isPlain(v) && 'set' in v) row[k] = v.set;
    else if (isPlain(v) && ('connect' in v || 'create' in v || 'disconnect' in v)) continue;
    else row[k] = v;
  }
}

let seq = 0;

function model(name: string): Row {
  const t = () => (DB[name] ??= []);
  const recordUser = (method: string, where: Row, data: Row, hit: Row[]) => {
    if (name === 'user') userWrites.push({ method, where, data, hit: hit.map(r => r.id) });
  };
  const create = (data: Row): Row => {
    const now = new Date();
    const id = name === 'user' ? Math.max(0, ...t().map(r => Number(r.id))) + 1 : `${name}-${++seq}`;
    const row: Row = { id, createdAt: now, updatedAt: now };
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
    findFirst: async (a: Row = {}) => pick(t().find(r => matches(r, a.where)), a.select),
    findMany: async (a: Row = {}) => t().filter(r => matches(r, a.where)).map(r => pick(r, a.select)),
    count: async (a: Row = {}) => t().filter(r => matches(r, a.where)).length,
    create: async (a: Row) => pick(create(a.data), a.select),
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
    // Checks and deletes in one tick, as a single DELETE ... WHERE does.
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
    Object.entries(impl).map(([k, fn]) => [k, (...args: unknown[]) => { beforePrismaCall?.(); prismaCalls.push(`${name}.${k}`); return fn(...args); }]),
  );
}

const models: Record<string, Row> = {};
const fakePrisma: Row = new Proxy({} as Row, {
  get(_t, prop) {
    if (typeof prop !== 'string' || prop === 'then') return undefined;
    if (prop === '$transaction') {
      return async (arg: unknown) => {
        beforePrismaCall?.();
        prismaCalls.push('$transaction');
        return typeof arg === 'function' ? arg(fakePrisma) : Promise.all(arg as Promise<unknown>[]);
      };
    }
    if (prop.startsWith('$')) return async () => undefined;
    return (models[prop] ??= model(prop));
  },
});

// ---- Fake Redis (Upstash parses JSON on read); TTLs are recorded ----

const redisStore = new Map<string, string>();
const redisTtl = new Map<string, number>();
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
    if (o?.ex) redisTtl.set(k, o.ex);
    return 'OK';
  },
  del: async (...ks: unknown[]) => ks.flat().reduce((n: number, k) => n + (redisStore.delete(String(k)) ? 1 : 0), 0),
  // Reads and deletes in one tick, as GETDEL does.
  getdel: async (k: string) => { const raw = redisStore.get(k); redisStore.delete(k); return decode(raw); },
  exists: async (...ks: string[]) => ks.filter(k => redisStore.has(k)).length,
  incr: async (k: string) => { const n = Number(redisStore.get(k) ?? 0) + 1; redisStore.set(k, String(n)); return n; },
  mget: async (...ks: unknown[]) => ks.flat().map(k => decode(redisStore.get(String(k)))),
  scan: async () => [0, []],
  expire: async () => 1,
  ttl: async () => -1,
};
const fakeRedis = new Proxy(redisImpl, {
  get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? (async () => null)),
});

// ---- Telegram / messaging: every send is recorded ----

type Sent = { via: string; platform: string; chatId: unknown; text?: string; options?: Row };
const sent: Sent[] = [];
const captured: string[] = [];
const adminNotes: string[] = [];
/** Send methods that throw while listed, as a Telegram or Meta outage does. */
const failingSends = new Set<string>();
/** Which limiter each rate-limit check used. */
const limiterUses: string[] = [];
/** S4: users whose plan lacks google_sync (src/services/google-sync/access.ts), and every check it made. */
const syncDenied = new Set<number>();
const syncChecks: number[] = [];

const recorder = (platform: string, prefix: string): Row =>
  new Proxy({} as Row, {
    get: (_t, p) =>
      typeof p !== 'string' || p === 'then'
        ? undefined
        : async (chatId: unknown, ...rest: unknown[]) => {
            if (failingSends.has(p)) throw new Error(`${prefix}.${p} failed (smoke)`);
            sent.push({
              via: `${prefix}.${p}`, platform, chatId,
              text: typeof rest[0] === 'string' ? rest[0] : undefined,
              options: (rest[1] ?? undefined) as Row | undefined,
            });
            return { message_id: 1 };
          },
  });

// ---- Boundaries: stubs in require's cache, served to import() by a load hook ----

const googleCalls: string[] = [];
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BOTH_SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events';
/** What Google's token endpoint answers next; tests override it. */
let googleAnswer: Row = { refresh_token: 'google-rt-new', scope: BOTH_SCOPES, access_token: 'test' };
/** A refusal instead: the HTTP status and the raw body (JSON or not). seed() clears it. */
let googleRefusal: { status: number; body: string } | null = null;
const SYNC_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
/** The account's identity: calendars.get('primary')'s id, asked with the exchange's access token (google-sync S2). */
const GOOGLE_PRIMARY_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary?fields=id';
/** What calendars.get('primary') answers next: an id, or an HTTP status it fails with. */
let primaryAnswer: { id: string } | { status: number } = { id: 'tal@gmail.com' };
/** The Authorization header each calendars.get('primary') carried. */
const primaryAuth: string[] = [];
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

// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-partner-labels.ts);
// the webhook handlers reach it through the real Telegram command modules.
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};

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
    settingsRateLimiter: { name: 'settings' }, commandRateLimiter: { name: 'command' }, generalRateLimiter: { name: 'general' },
    tokenPollRateLimiter: { name: 'token-poll' },
    checkRateLimit: async (limiter: Row) => {
      limiterUses.push(String(limiter?.name));
      return { success: true, limit: 99, remaining: 99, reset: 0 };
    },
    getRateLimitHeaders: () => ({}),
  });
  const capture = (e: unknown, ctx: string) => { captured.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`); };
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
  stub('src/utils/error-notifier.ts', {
    notifyAdminWarning: async (title: string, message: string) => { adminNotes.push(`${title}: ${message}`); },
    notifyAdminError: async () => undefined,
    notifyAdminFeedback: async () => undefined,
    getAdminUserIds: async () => [],
  });
  const bot = recorder('telegram', 'bot');
  stub('src/services/telegram/bot.ts', {
    getBot: () => bot,
    initBot: () => bot,
    getMessagingService: () => recorder('telegram', 'tg'),
    setUserMenuButton: async (chatId: unknown) => { sent.push({ via: 'setUserMenuButton', platform: 'telegram', chatId }); },
  });
  const types = nodeRequire(path.join(ROOT, 'src/services/messaging/types.ts'));
  const messaging = {
    ...types,
    // As the real factory: Telegram needs the bot instance (telegram/bot.ts passes it)
    getMessagingService: (platform: unknown, bot?: unknown) => {
      if (platform === types.MessagingPlatform.TELEGRAM && !bot) throw new Error('Telegram bot instance required for Telegram adapter');
      return recorder(String(platform), String(platform));
    },
    getTelegramService: () => recorder('telegram', 'telegram'),
    getWhatsAppService: () => recorder('whatsapp', 'whatsapp'),
    // The factory's rule: a WhatsApp Business body is WhatsApp, everything else Telegram
    detectPlatform: (req: { body: Row }) =>
      !(req.body?.message || req.body?.callback_query || req.body?.update_id !== undefined)
        && req.body?.object === 'whatsapp_business_account' && req.body?.entry?.[0]?.changes
        ? types.MessagingPlatform.WHATSAPP
        : types.MessagingPlatform.TELEGRAM,
  };
  // The plan gate for a copy (S4): the plan check itself runs in smoke-google-sync.ts.
  stub('src/services/google-sync/access.ts', {
    syncAllowed: async (userId: number) => { syncChecks.push(userId); return !syncDenied.has(userId); },
  });
  stub('src/services/messaging/index.ts', messaging);
  stub('src/services/messaging/factory.ts', messaging);
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    googleCalls.push(url);
    if (url === GOOGLE_TOKEN_URL) {
      if (googleRefusal) return new Response(googleRefusal.body, { status: googleRefusal.status, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(googleAnswer), { headers: { 'content-type': 'application/json' } });
    }
    if (url === GOOGLE_PRIMARY_URL) {
      primaryAuth.push(String(new Headers(init?.headers).get('authorization')));
      const a = primaryAnswer;
      return 'id' in a
        ? new Response(JSON.stringify(a), { headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ error: { code: a.status, message: 'smoke' } }), { status: a.status, headers: { 'content-type': 'application/json' } });
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
    googleScopes: [], googleSyncNotifiedAt: null,
    pairingId: null, remindersEnabled: false, suspendedAt: null, unreachableSince: null, whatsappPhone: null,
    whatsappBsuid: null, telegramId: null, isAdmin: false, globalRules: [], voiceInputEnabled: true,
    textSummaryEnabled: true, voiceSummaryEnabled: false, weatherEnabled: true, locationForced: false,
    createdAt: new Date(Date.now() - 30 * DAY), updatedAt: new Date(Date.now() - DAY),
    ...o,
  };
}

const TAL_TG = 111111111;
const VICTIM_TG = 42;
const STRANGER_TG = 999999999;
const WA_BSUID = 'IL.123';
const VICTIM_WA_PHONE = '+972500000007';

/**
 * 9 = Tal, Telegram 111111111, NATIVE with reminders on (the attacker in the attack, the
 * owner in the happy path). 42 = WhatsApp-only, BSUID IL.123. 7 = Victim, Telegram 42
 * and WhatsApp +972500000007, already on Google with their own token.
 */
function seed() {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  redisTtl.clear();
  prismaCalls.length = 0;
  userWrites.length = 0;
  googleCalls.length = 0;
  sent.length = 0;
  captured.length = 0;
  adminNotes.length = 0;
  failingSends.clear();
  limiterUses.length = 0;
  syncDenied.clear();
  syncChecks.length = 0;
  googleAnswer = { refresh_token: 'google-rt-new', scope: BOTH_SCOPES, access_token: 'test' };
  googleRefusal = null;
  primaryAnswer = { id: 'tal@gmail.com' };
  primaryAuth.length = 0;
  DB.googleSyncLink = [];
  DB.googleSyncItem = [];
  DB.user = [
    baseUser({ id: 9, name: 'Tal Cohen', telegramId: BigInt(TAL_TG), remindersEnabled: true }),
    baseUser({ id: 42, name: 'Noa', messagingPlatform: 'whatsapp', whatsappBsuid: WA_BSUID, language: 'he' }),
    baseUser({ id: 7, name: 'Victim', telegramId: BigInt(VICTIM_TG), whatsappPhone: VICTIM_WA_PHONE, calendarSource: 'GOOGLE', googleRefreshToken: 'victim-own-token' }),
  ];
  DB.oAuthState = [];
  DB.nativeCalendar = [
    { id: 'cal-9', ownerUserId: 9, name: 'Tal calendar', isDeleted: false },
    { id: 'cal-42', ownerUserId: 42, name: 'Noa calendar', isDeleted: false },
  ];
}

const userRow = (id: number) => DB.user.find(u => u.id === id) as Row;
const writesHitting = (id: number) => userWrites.filter(w => w.hit.includes(id));
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const pendingKeys = () => [...redisStore.keys()].filter(k => k.startsWith('oauth:pending:'));

function addState(userId: number): string {
  const token = `u1_${crypto.randomBytes(32).toString('hex')}`;
  DB.oAuthState.push({ id: `st-${++seq}`, userId: BigInt(userId), token, createdAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60_000) });
  return token;
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

/** Runs `fn` with the services' logs silenced; returns what console.error got. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ value: T; errors: string[] }> {
  const { log, warn, error } = console;
  const errors: string[] = [];
  console.log = () => undefined;
  console.warn = () => undefined;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
  try {
    return { value: await fn(), errors };
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

type CallbackEnd = { redirect?: string; element?: Row; threw?: string };

/** Run the OAuth callback page as Next does; its success path ends in a redirect, which throws. */
async function runCallback(state: string): Promise<CallbackEnd> {
  const page = (await load('app/oauth-callback/page.tsx')).default;
  try {
    const element = await page({ searchParams: Promise.resolve({ code: 'test-code', state }) });
    return { element: element as Row };
  } catch (err) {
    const digest = String((err as Row)?.digest ?? '');
    if (digest.startsWith('NEXT_REDIRECT')) return { redirect: digest.split(';')[2] };
    return { threw: err instanceof Error ? err.message : String(err) };
  }
}

/** Every element of a server-rendered tree, sync components expanded. */
function elementsOf(node: unknown, out: Row[] = []): Row[] {
  if (Array.isArray(node)) { node.forEach(n => elementsOf(n, out)); return out; }
  if (!node || typeof node !== 'object') return out;
  const el = node as Row;
  if (typeof el.type === 'function') {
    const rendered = el.type(el.props);
    if (rendered && typeof rendered.then !== 'function') elementsOf(rendered, out);
    return out;
  }
  out.push(el);
  elementsOf(el.props?.children, out);
  return out;
}
const textOf = (els: Row[]) => els.flatMap(e => ([] as unknown[]).concat(e.props?.children ?? []))
  .filter(c => typeof c === 'string' || typeof c === 'number').join(' ');

/**
 * Runs a client component's own code with no DOM: React's hook dispatcher is swapped for a
 * small one (useState, useRef, useCallback, useEffect), so its render, effects and handlers
 * run as they do on the phone. A state update renders again and runs the effects whose deps
 * changed. tree() is the latest render.
 */
function runClient(component: (props: Row) => unknown, props: Row): { tree: () => unknown } {
  const internals = nodeRequire('react').__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE as Row;
  const slots: Row[] = [];
  let cursor = 0;
  let output: unknown;
  let effects: Array<() => void> = [];
  let dirty = false;
  let busy = false;
  const changed = (a?: unknown[], b?: unknown[]) => !a || !b || a.length !== b.length || a.some((v, k) => !Object.is(v, b[k]));
  const dispatcher = {
    useState(init: unknown) {
      const slot = (slots[cursor++] ??= { value: typeof init === 'function' ? (init as () => unknown)() : init });
      slot.set ??= (next: unknown) => {
        const value = typeof next === 'function' ? (next as (v: unknown) => unknown)(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        update();
      };
      return [slot.value, slot.set];
    },
    useRef: (init: unknown) => (slots[cursor++] ??= { current: init }),
    useCallback(fn: unknown, deps: unknown[]) {
      const k = cursor++;
      if (!slots[k] || changed(slots[k].deps, deps)) slots[k] = { fn, deps };
      return slots[k].fn;
    },
    useEffect(fn: () => unknown, deps?: unknown[]) {
      const k = cursor++;
      const prev = slots[k];
      if (prev && !changed(prev.deps, deps)) return;
      const slot: Row = { deps, cleanup: prev?.cleanup };
      slots[k] = slot;
      effects.push(() => {
        slot.cleanup?.();
        const cleanup = fn();
        slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
      });
    },
  };
  function update() {
    dirty = true;
    if (busy) return;
    busy = true;
    try {
      while (dirty) {
        dirty = false;
        cursor = 0;
        const saved = internals.H;
        internals.H = dispatcher;
        try {
          output = component(props);
        } finally {
          internals.H = saved;
        }
        const run = effects;
        effects = [];
        run.forEach(effect => effect());
      }
    } finally {
      busy = false;
    }
  }
  update();
  return { tree: () => output };
}

/** The finish page's fragment, parsed: p, n, b. */
function fragmentOf(redirect: string): URLSearchParams {
  return new URLSearchParams(redirect.split('#')[1] ?? '');
}

/** A Telegram text message, as Telegram posts it to the webhook. */
let updateId = 1;
function tgText(fromId: number, text: string, first = 'Test') {
  return {
    update_id: updateId++,
    message: { message_id: updateId, date: 0, text, from: { id: fromId, first_name: first, language_code: 'en' }, chat: { id: fromId, type: 'private' } },
  };
}

/** A WhatsApp text message, as Meta posts it to the webhook. */
let waMsg = 1;
function waText(from: string, text: string, o: { bsuid?: string; metadata?: boolean } = {}) {
  const isPhone = /^\+?\d+$/.test(from);
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba-1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          ...(o.metadata === false ? {} : { metadata: { phone_number_id: 'pnid-test', display_phone_number: '15550001111' } }),
          contacts: [{ profile: { name: 'Sender' }, ...(isPhone ? { wa_id: from.replace('+', '') } : {}), ...(o.bsuid ? { user_id: o.bsuid } : {}) }],
          messages: [{ from: from.replace('+', ''), id: `wamid.${waMsg++}`, timestamp: '0', type: 'text', text: { body: text } }],
        },
      }],
    }],
  };
}

const noopRes = () => ({ status: () => ({ json: () => undefined }) });

async function tgWebhook(update: Row): Promise<void> {
  const { handleTelegramWebhook } = await load('src/services/webhook-handlers.ts');
  await quietly(() => handleTelegramWebhook({ body: update }, noopRes()));
}

async function waWebhook(body: Row): Promise<void> {
  const { handleWhatsAppWebhook } = await load('src/services/webhook-handlers.ts');
  await quietly(() => handleWhatsAppWebhook({ body }, noopRes()));
}

/** A pending token for `ownerId`, as the callback leaves it: returns the pendingId. */
async function pendingFor(ownerId: number): Promise<string> {
  const { createPendingGoogleToken } = await load('src/services/google-connect.ts');
  return createPendingGoogleToken(ownerId, 'google-rt-new');
}

async function savedToken(id: number): Promise<string> {
  const { safeDecrypt } = await load('src/utils/encryption.ts');
  return safeDecrypt(userRow(id).googleRefreshToken);
}

const sentTo = (chatId: unknown) => sent.filter(s => String(s.chatId) === String(chatId) && s.via !== 'setUserMenuButton');

async function main() {
  installStubs();
  const { NextRequest } = nodeRequire('next/server');
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8'));

  // ---- B1: the callback parks the token ----

  let callbackRedirect = '';
  await check('#1 the callback stores an encrypted pending entry for the owner (15 min) and writes nothing on the user', async () => {
    seed();
    const state = addState(9);
    const { value: end } = await quietly(() => runCallback(state));
    assert(end.redirect, `callback ended with ${show(end.threw ?? end.element?.type ?? end)}; ${captured.join(' | ')}`);
    callbackRedirect = end.redirect;
    assert(userWrites.length === 0, `user writes: ${show(userWrites.map(w => ({ m: w.method, hit: w.hit, data: Object.keys(w.data) })))}`);
    assert(DB.nativeCalendar.every(c => !c.isDeleted), `native calendars changed: ${show(DB.nativeCalendar)}`);
    const keys = pendingKeys();
    assert(keys.length === 1, `pending keys: ${show([...redisStore.keys()])}`);
    const raw = redisStore.get(keys[0]) ?? '';
    assert(!raw.includes('google-rt-new'), 'the refresh token is stored in plaintext');
    const entry = JSON.parse(raw);
    assert(entry.ownerUserId === 9, `entry ${raw}`);
    const { decrypt } = await load('src/utils/encryption.ts');
    assert(decrypt(entry.refreshToken) === 'google-rt-new', 'the stored token does not decrypt to Google\'s token');
    assert(redisTtl.get(keys[0]) === 15 * 60, `TTL ${redisTtl.get(keys[0])}`);
    assert(!redisStore.has('googleConnected:9'), 'the commit flag is set before any claim');
  });

  await check('#2 the redirect goes to /oauth-complete?locale=… with the pendingId, name and buttons only in the fragment', async () => {
    assert(callbackRedirect, 'no redirect from #1');
    const [beforeHash] = callbackRedirect.split('#');
    const url = new URL(beforeHash, 'http://localhost');
    assert(url.pathname === '/oauth-complete', `path ${url.pathname}`);
    assert([...url.searchParams.keys()].join(',') === 'locale' && url.searchParams.get('locale') === 'en', `query ${url.search}`);
    const frag = fragmentOf(callbackRedirect);
    const p = frag.get('p') ?? '';
    assert(/^[A-Za-z0-9_-]{32}$/.test(p), `pendingId ${p}`);
    assert(!beforeHash.includes(p), 'the pendingId is in the query');
    assert(pendingKeys()[0] === `oauth:pending:${sha256(p)}`, `key ${pendingKeys()[0]} is not sha256(pendingId)`);
    assert(frag.get('n') === 'Tal', `name ${frag.get('n')}`);
    assert(frag.get('b') === 'tg', `buttons ${frag.get('b')}`);
  });

  await check('#3 a reused state gets the clean "invalid or expired" page; two racing callbacks park one token', async () => {
    seed();
    const state = addState(9);
    const { value: [a, b] } = await quietly(() => Promise.all([runCallback(state), runCallback(state)]));
    const redirects = [a, b].filter(e => e.redirect);
    const pages = [a, b].filter(e => e.element);
    assert(redirects.length === 1 && pages.length === 1, `ends: ${show([a, b].map(e => e.redirect ?? e.threw ?? 'page'))}`);
    assert(pendingKeys().length === 1, `pending keys ${pendingKeys().length}`);
    const { value: again } = await quietly(() => runCallback(state));
    assert(again.element && !again.threw, `the third callback ended with ${show(again.threw ?? again.redirect)}`);
    const text = textOf(elementsOf(again.element));
    assert(/invalid or expired/i.test(text), `page text: ${text}`);
  });

  await check('#4 error-page "Try again": t.me/<bot>?start=dashboard for a Telegram owner, /refresh-token for a WhatsApp-only one', async () => {
    seed();
    googleAnswer = { scope: BOTH_SCOPES, access_token: 'test' }; // no refresh_token: the NoRefreshToken page
    const hrefs: string[] = [];
    for (const owner of [9, 42]) {
      const { value: end } = await quietly(() => runCallback(addState(owner)));
      assert(end.element, `owner ${owner}: ${show(end.redirect ?? end.threw)}`);
      const btn = elementsOf(end.element).find(e => e.type === 'a' && e.props?.className === 'btn');
      hrefs.push(String(btn?.props?.href));
    }
    assert(hrefs[0] === 'https://t.me/famcal_test_bot?start=dashboard', `Telegram owner: ${hrefs[0]}`);
    assert(hrefs[1] === '/refresh-token?user_id=42', `WhatsApp owner: ${hrefs[1]}`);
    assert(pendingKeys().length === 0 && userWrites.length === 0, 'an error page parked or saved a token');
  });

  // ---- B2: the finish page ----

  await check('#5 the finish page: Telegram and WhatsApp links carry gc_<pendingId>; no fragment = incomplete', async () => {
    const mod = await load('app/oauth-complete/OAuthCompleteClient.tsx');
    assert(typeof mod.parseFinishFragment === 'function' && typeof mod.finishLinks === 'function', 'OAuthCompleteClient exports no parseFinishFragment/finishLinks');
    const id = 'A'.repeat(16) + '_-'.repeat(8);
    const parsed = mod.parseFinishFragment(`#p=${id}&n=${encodeURIComponent('נועה')}&b=tg%2Cwa`);
    assert(parsed && parsed.pendingId === id && parsed.ownerName === 'נועה' && parsed.telegram && parsed.whatsapp, `parsed ${show(parsed)}`);
    const links = mod.finishLinks(parsed, 'famcal_test_bot', '15550001111', en.oauthComplete.whatsappText);
    assert(links.telegram === `https://t.me/famcal_test_bot?start=gc_${id}`, `telegram ${links.telegram}`);
    const wa = new URL(links.whatsapp);
    assert(wa.origin === 'https://wa.me' && wa.pathname === '/15550001111', `whatsapp ${links.whatsapp}`);
    assert((wa.searchParams.get('text') ?? '').includes(`gc_${id}`), `prefilled ${wa.searchParams.get('text')}`);
    const tgOnly = mod.finishLinks(mod.parseFinishFragment(`#p=${id}&n=Tal&b=tg`), 'famcal_test_bot', '15550001111', en.oauthComplete.whatsappText);
    assert(tgOnly.telegram && !tgOnly.whatsapp, `tg only: ${show(tgOnly)}`);
    for (const bad of ['', '#', `#n=Tal&b=tg`, `#p=short&b=tg`, `#p=${id}&b=`]) {
      const p = mod.parseFinishFragment(bad);
      const l = p ? mod.finishLinks(p, 'famcal_test_bot', '15550001111', en.oauthComplete.whatsappText) : {};
      assert(!l.telegram && !l.whatsapp, `fragment ${show(bad)} gave links ${show(l)}`);
    }
    const page = (await load('app/oauth-complete/page.tsx')).default;
    const el = (await page({ searchParams: Promise.resolve({ locale: 'he' }) })) as Row;
    assert(el.props.botUsername === 'famcal_test_bot' && el.props.waNumber === '15550001111' && el.props.locale === 'he', `props ${show(el.props)}`);
  });

  // ---- B3: claims ----

  await check('#6 owner claims over Telegram: /start gc_… commits (token, cache, admin note; the user stays NATIVE with FamCal, Google is a connection), sets the flag, replies with "Choose calendars"', async () => {
    seed();
    const id = await pendingFor(9);
    await tgWebhook(tgText(TAL_TG, `/start gc_${id}`));
    assert(await savedToken(9) === 'google-rt-new', `row 9 token: ${userRow(9).googleRefreshToken}; ${captured.join(' | ')}`);
    assert(userRow(9).calendarSource === 'NATIVE', `calendarSource ${userRow(9).calendarSource}`);
    assert(DB.nativeCalendar.find(c => c.id === 'cal-9')?.isDeleted === false, 'the native calendar was soft-deleted');
    const cached = decode(redisStore.get('reminders:users')) as Row[] | null;
    assert(cached?.some(u => u.id === 9 && u.googleRefreshToken === 'google-rt-new' && u.calendarSource === 'NATIVE'), `reminder cache ${show(cached)}`);
    assert(adminNotes.some(n => n.includes(String(TAL_TG))), `admin notes ${show(adminNotes)}`);
    assert(redisStore.has('googleConnected:9') && redisTtl.get('googleConnected:9') === 15 * 60, `flag ${redisStore.get('googleConnected:9')} ttl ${redisTtl.get('googleConnected:9')}`);
    assert(pendingKeys().length === 0, 'the pending entry is still there');
    const reply = sentTo(TAL_TG).at(-1);
    const button = reply?.options?.replyMarkup?.inline_keyboard?.[0]?.[0];
    assert(button?.web_app?.url?.endsWith(`/en/select-calendars?user_id=${TAL_TG}`), `reply ${show(reply)}`);
    assert(writesHitting(7).length === 0 && writesHitting(42).length === 0, 'another row was written');
  });

  await check('#6b a FamCal user with leftover Google choices and no token who connects again starts from an empty list (chooses calendars again); a legacy Google user keeps their choices', async () => {
    seed();
    Object.assign(userRow(9), { calendarAssignments: [{ calendarId: 'old@gmail.com', labels: ['primary', 'yours'], name: 'Old', color: '#4285F4' }] });
    const id = await pendingFor(9);
    await tgWebhook(tgText(TAL_TG, `/start gc_${id}`));
    assert(await savedToken(9) === 'google-rt-new', `row 9 token: ${userRow(9).googleRefreshToken}`);
    const after = userRow(9).calendarAssignments;
    assert(after === null || after === undefined || (typeof after === 'object' && !Array.isArray(after)), `stale choices kept: ${show(after)}`);
    seed();
    Object.assign(userRow(9), { calendarSource: 'GOOGLE', calendarAssignments: [{ calendarId: 'tal@gmail.com', labels: ['primary', 'yours'], name: 'Tal', color: '#4285F4' }] });
    const id2 = await pendingFor(9);
    await tgWebhook(tgText(TAL_TG, `/start gc_${id2}`));
    assert(Array.isArray(userRow(9).calendarAssignments) && userRow(9).calendarAssignments.length === 1, `legacy choices lost: ${show(userRow(9).calendarAssignments)}`);
  });

  await check('#7 owner claims over WhatsApp: the gc_ token in a sentence commits on 42, sets the flag, replies with a select-calendars magic link', async () => {
    seed();
    const id = await pendingFor(42);
    await waWebhook(waText(WA_BSUID, `לסיים את החיבור ליומן Google: gc_${id}`, { bsuid: WA_BSUID }));
    assert(await savedToken(42) === 'google-rt-new', `row 42 token: ${userRow(42).googleRefreshToken}; ${captured.join(' | ')}`);
    assert(userRow(42).calendarSource === 'NATIVE', `calendarSource ${userRow(42).calendarSource}`);
    assert(redisStore.has('googleConnected:42'), 'no flag for 42');
    const reply = sentTo(WA_BSUID).at(-1);
    const url = reply?.options?.whatsappUrlButton?.url ?? '';
    const token = new URL(url || 'http://x').searchParams.get('token') ?? '';
    const magic = decode(redisStore.get(`magic:${token}`)) as Row | null;
    assert(magic?.userId === 42 && magic?.page === 'select-calendars', `reply ${show(reply)}; magic ${show(magic)}`);
    assert(reply?.text && /t\.me\/famcal_test_bot/.test(reply.text), `no Telegram promotion in ${show(reply?.text)}`);
    assert(writesHitting(9).length === 0 && writesHitting(7).length === 0, 'another row was written');
  });

  await check('#8 the magic link for select-calendars lands there with the session; a plain one still lands on the dashboard', async () => {
    seed();
    const { generateMagicLink } = await load('src/services/magic-link.ts');
    const { GET } = await load('app/api/auth/magic/route.ts');
    const go = async (link: string) => {
      const res: Response = await GET(new NextRequest(link));
      return { location: res.headers.get('location') ?? '', cookie: res.headers.get('set-cookie') ?? '' };
    };
    const toCalendars = await go(await generateMagicLink(42, 'he', 'select-calendars'));
    assert(new URL(toCalendars.location).pathname === '/he/select-calendars' && toCalendars.cookie.includes('famcal_session='), `select-calendars: ${show(toCalendars)}`);
    const toDashboard = await go(await generateMagicLink(42, 'he'));
    assert(new URL(toDashboard.location).pathname === '/he/dashboard', `dashboard: ${show(toDashboard)}`);
  });

  await check('#9 a non-owner Telegram claim (the victim) commits nothing, says so, and the entry is gone', async () => {
    seed();
    const id = await pendingFor(9);
    await tgWebhook(tgText(VICTIM_TG, `/start gc_${id}`));
    assert(userWrites.length === 0, `user writes: ${show(userWrites.map(w => ({ m: w.method, hit: w.hit })))}`);
    assert(await savedToken(7) === 'victim-own-token', 'the victim\'s own token changed');
    assert(!redisStore.has('googleConnected:9') && !redisStore.has('googleConnected:7'), 'a flag was set');
    assert(pendingKeys().length === 0, 'the pending entry survived a wrong claim');
    assert(!googleCalls.some(u => u.includes('revoke')), `revoked at Google: ${show(googleCalls)}`);
    const reply = sentTo(VICTIM_TG).at(-1);
    assert(reply?.text && /different/i.test(reply.text) && !reply.options?.replyMarkup, `reply ${show(reply)}`);
    // The owner's own claim afterwards finds nothing
    await tgWebhook(tgText(TAL_TG, `/start gc_${id}`));
    assert(userWrites.length === 0 && /expired/i.test(sentTo(TAL_TG).at(-1)?.text ?? ''), `owner after the wrong claim: ${show(sentTo(TAL_TG).at(-1))}`);
  });

  await check('#10 a non-owner WhatsApp claim commits nothing, says so, and the entry is gone', async () => {
    seed();
    const id = await pendingFor(9);
    await waWebhook(waText(VICTIM_WA_PHONE, `Finish connecting my Google Calendar: gc_${id}`));
    assert(userWrites.length === 0, `user writes: ${show(userWrites.map(w => ({ m: w.method, hit: w.hit })))}`);
    assert(pendingKeys().length === 0, 'the pending entry survived a wrong claim');
    const reply = sentTo(VICTIM_WA_PHONE.replace('+', '')).concat(sentTo(VICTIM_WA_PHONE)).at(-1);
    assert(reply?.text && /different/i.test(reply.text), `reply ${show(reply)}`);
  });

  await check('#11 an unknown WhatsApp sender with a gc_ token gets no user row and no welcome', async () => {
    seed();
    const id = await pendingFor(9);
    const before = DB.user.length;
    await waWebhook(waText('+972599999999', `gc_${id}`));
    assert(DB.user.length === before && !userWrites.some(w => w.method === 'create'), `users ${DB.user.length} (was ${before})`);
    assert(pendingKeys().length === 0, 'the pending entry survived');
    const replies = sentTo('972599999999').concat(sentTo('+972599999999'));
    assert(replies.length === 1 && /different/i.test(replies[0].text ?? ''), `replies ${show(replies)}`);
  });

  await check('#12 expired and reused pendingIds: "expired", nothing committed twice', async () => {
    seed();
    await tgWebhook(tgText(TAL_TG, `/start gc_${crypto.randomBytes(24).toString('base64url')}`));
    assert(userWrites.length === 0 && /expired/i.test(sentTo(TAL_TG).at(-1)?.text ?? ''), `unknown id: ${show(sentTo(TAL_TG).at(-1))}`);
    const id = await pendingFor(9);
    await tgWebhook(tgText(TAL_TG, `/start gc_${id}`));
    const writes = userWrites.length;
    assert(writes > 0, 'the first claim committed nothing');
    adminNotes.length = 0;
    await tgWebhook(tgText(TAL_TG, `/start gc_${id}`));
    assert(userWrites.length === writes && adminNotes.length === 0, 'the reused id committed again');
    assert(/expired/i.test(sentTo(TAL_TG).at(-1)?.text ?? ''), `reused id: ${show(sentTo(TAL_TG).at(-1))}`);
    // A WhatsApp claim of an expired id says the same
    await waWebhook(waText(WA_BSUID, `gc_${id}`, { bsuid: WA_BSUID }));
    assert(/פג|expired/i.test(sentTo(WA_BSUID).at(-1)?.text ?? ''), `WhatsApp expired: ${show(sentTo(WA_BSUID).at(-1))}`);
  });

  await check('#13 /start gc_… from an unknown Telegram sender creates no user, sets no menu button (webhook and polling)', async () => {
    seed();
    const before = DB.user.length;
    const id = await pendingFor(9);
    await tgWebhook(tgText(STRANGER_TG, `/start gc_${id}`, 'Stranger'));
    assert(DB.user.length === before && !userWrites.some(w => w.method === 'create'), `webhook: users ${DB.user.length}`);
    assert(!sent.some(s => s.via === 'setUserMenuButton'), 'webhook: a menu button was set');
    assert(/different/i.test(sentTo(STRANGER_TG).at(-1)?.text ?? ''), `webhook reply ${show(sentTo(STRANGER_TG))}`);
    // Polling mode: the bot's /start handler
    const handlers: { re: RegExp; fn: (msg: Row, match: RegExpExecArray | null) => Promise<void> }[] = [];
    const { setupHandlers } = await load('src/services/telegram/commands.ts');
    setupHandlers({ onText: (re: RegExp, fn: (msg: Row, match: RegExpExecArray | null) => Promise<void>) => handlers.push({ re, fn }) });
    const id2 = await pendingFor(9);
    const text = `/start gc_${id2}`;
    const start = handlers.find(h => h.re.test(text));
    assert(start, 'no /start handler');
    await quietly(() => start.fn({ chat: { id: STRANGER_TG }, from: { id: STRANGER_TG, first_name: 'Stranger' }, text }, start.re.exec(text)));
    assert(DB.user.length === before && !userWrites.some(w => w.method === 'create'), `polling: users ${DB.user.length}`);
    assert(pendingKeys().length === 0, 'polling: the pending entry survived');
  });

  // ---- B4: the Mini App waits for the commit ----

  await check('#14 check-token-refresh: refreshed only after a commit, not on a fresh updatedAt', async () => {
    seed();
    const { GET } = await load('app/api/check-token-refresh/route.ts');
    const ask = async () => {
      const res: Response = await GET(new NextRequest(`http://localhost/api/check-token-refresh?user_id=${TAL_TG}&since=${Date.now() - 60_000}`, {
        headers: { 'x-telegram-init-data': initDataFor(TAL_TG) },
      }));
      return { status: res.status, body: await res.json() };
    };
    // The old signal: a token on the row and a fresh updatedAt
    userRow(9).googleRefreshToken = 'old-token';
    userRow(9).updatedAt = new Date();
    const before = await ask();
    assert(before.status === 200 && before.body.refreshed === false, `before the commit: ${show(before)}`);
    const id = await pendingFor(9);
    await tgWebhook(tgText(TAL_TG, `/start gc_${id}`));
    const after = await ask();
    assert(after.status === 200 && after.body.refreshed === true, `after the commit: ${show(after)}`);
    const noAuth: Response = await GET(new NextRequest(`http://localhost/api/check-token-refresh?user_id=${TAL_TG}&since=0&initData=${encodeURIComponent(initDataFor(TAL_TG))}`));
    assert(noAuth.status === 401, `initData in the query: ${noAuth.status}`);
  });

  await check('#15 RefreshTokenClient polls on an interval for 3 minutes, calls ready(), sends initData in the header', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/refresh-token/RefreshTokenClient.tsx'), 'utf8');
    assert(/setInterval\(/.test(src) && /POLL_INTERVAL_MS\s*=\s*2000/.test(src) && /POLL_WINDOW_MS\s*=\s*3\s*\*\s*60_?000/.test(src), 'no 2 s / 3 min poll');
    assert(/WebApp\??\.ready\(\)/.test(src) && /WebApp\??\.expand\(\)/.test(src), 'no ready() next to expand()');
    assert(src.includes("'X-Telegram-Init-Data'"), 'initData header gone');
    const page = (await load('app/refresh-token/page.tsx')).default;
    seed();
    const el = (await page({ searchParams: Promise.resolve({ user_id: String(TAL_TG) }) })) as Row;
    assert(el.props.translations.waitingTelegram && el.props.translations.waitingWhatsApp, 'no waiting copy passed to the client');
  });

  await check("#15b /refresh-token's copy follows the Google state: a first connect (state 'none', stale choices too) is told to connect, never that access expired; a legacy Google user's cleared token with stored calendars keeps the reconnect copy", async () => {
    const page = (await load('app/refresh-token/page.tsx')).default;
    const messages: Record<string, Row> = {
      en: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8')).refreshToken,
      he: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/he.json'), 'utf8')).refreshToken,
    };
    const copyOf = async (userId: number) => {
      const el = (await page({ searchParams: Promise.resolve({ user_id: String(userId) }) })) as Row;
      const t = el.props.translations;
      return [t.title, t.subtitle, t.step3];
    };
    seed();
    const talNone = await copyOf(TAL_TG);
    userRow(9).language = 'he';
    const talHeNone = await copyOf(TAL_TG);
    userRow(9).language = 'en';
    // A FamCal user's stale choices with no token are none (liveGoogleChoices): still a first connect
    Object.assign(userRow(9), { calendarAssignments: [{ calendarId: 'tal@gmail.com', labels: ['primary', 'yours'], name: 'Tal', color: '#4285F4' }] });
    const talStale = await copyOf(TAL_TG);
    // A legacy Google user (the marker) whose token was cleared with calendars stored: reconnect
    userRow(9).calendarSource = 'GOOGLE';
    const talReconnect = await copyOf(TAL_TG);
    for (const lang of ['en', 'he']) {
      for (const key of ['connectTitle', 'connectSubtitle', 'connectStep3']) assert(typeof messages[lang][key] === 'string' && messages[lang][key], `${lang} ${key} missing`);
    }
    assert(show(talNone) === show([messages.en.connectTitle, messages.en.connectSubtitle, messages.en.connectStep3]), `Tal, never connected: ${show(talNone)}`);
    assert(show(talHeNone) === show([messages.he.connectTitle, messages.he.connectSubtitle, messages.he.connectStep3]), `Tal in Hebrew, never connected: ${show(talHeNone)}`);
    assert(show(talStale) === show([messages.en.connectTitle, messages.en.connectSubtitle, messages.en.connectStep3]), `Tal, stale choices: ${show(talStale)}`);
    assert(show(talReconnect) === show([messages.en.title, messages.en.subtitle, messages.en.step3]), `Tal, legacy Google, token cleared: ${show(talReconnect)}`);
  });

  // ---- B5: the webhook route ----

  const APP_SECRET = 'test-app-secret';
  const signWa = (raw: string, secret = APP_SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  const postWebhook = async (raw: string, headers: Record<string, string> = {}) => {
    const { POST } = await load('app/api/webhook/route.ts');
    const { value: res, errors } = await quietly(() => POST(new NextRequest('http://localhost/api/webhook', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw,
    })) as Promise<Response>);
    return { status: res.status, errors };
  };

  await check('#16 WhatsApp signature with WHATSAPP_APP_SECRET set: valid → handled; bad or missing → 401 and nothing processed', async () => {
    seed();
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    try {
      const id = await pendingFor(42);
      const raw = JSON.stringify(waText(WA_BSUID, `gc_${id}`, { bsuid: WA_BSUID }));
      const missing = await postWebhook(raw);
      const bad = await postWebhook(raw, { 'x-hub-signature-256': signWa(raw, 'wrong-secret') });
      const short = await postWebhook(raw, { 'x-hub-signature-256': 'sha256=00' });
      assert(missing.status === 401 && bad.status === 401 && short.status === 401, `missing ${missing.status}, bad ${bad.status}, short ${short.status}`);
      assert(pendingKeys().length === 1 && userWrites.length === 0 && sent.length === 0, 'an unsigned body was processed');
      const good = await postWebhook(raw, { 'x-hub-signature-256': signWa(raw) });
      assert(good.status === 200, `valid: ${good.status}`);
      assert(await savedToken(42) === 'google-rt-new', `valid signature not handled; ${captured.join(' | ')}`);
    } finally {
      process.env.WHATSAPP_APP_SECRET = '';
    }
  });

  await check('#17 WhatsApp with WHATSAPP_APP_SECRET unset: accepted, with one error log per process', async () => {
    seed();
    const WARNING = '[WhatsApp] WHATSAPP_APP_SECRET is not set; webhook signatures are NOT verified';
    const id = await pendingFor(42);
    const first = await postWebhook(JSON.stringify(waText(WA_BSUID, `gc_${id}`, { bsuid: WA_BSUID })));
    const second = await postWebhook(JSON.stringify(waText(WA_BSUID, 'hello', { bsuid: WA_BSUID })));
    assert(first.status === 200 && second.status === 200, `statuses ${first.status} ${second.status}`);
    assert(await savedToken(42) === 'google-rt-new', 'the unsigned claim was not handled');
    const warnings = [...first.errors, ...second.errors].filter(e => e.includes(WARNING));
    assert(warnings.length === 1, `warnings: ${show(warnings)}`);
    const { ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS } = await load('src/lib/whatsapp-signature.ts');
    assert(ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS === true, 'the unset-secret policy is not one named constant');
  });

  await check('#18 [guard] the Telegram webhook path: right secret → handled, wrong or missing → 401', async () => {
    seed();
    const id = await pendingFor(9);
    const raw = JSON.stringify(tgText(TAL_TG, `/start gc_${id}`));
    const wrong = await postWebhook(raw, { 'x-telegram-bot-api-secret-token': 'nope' });
    const missing = await postWebhook(raw);
    assert(wrong.status === 401 && missing.status === 401, `wrong ${wrong.status}, missing ${missing.status}`);
    assert(userWrites.length === 0 && sent.length === 0, 'an unauthenticated Telegram update was processed');
    const right = await postWebhook(raw, { 'x-telegram-bot-api-secret-token': 'test-tg-secret' });
    assert(right.status === 200, `right secret: ${right.status}`);
    // Handled: today any /start reply; with the fix, the commit
    assert(sentTo(TAL_TG).length > 0, 'the update was not handled');
  });

  await check('#19 with WHATSAPP_PHONE_NUMBER_ID set, an entry with no metadata is dropped; ours is handled', async () => {
    seed();
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'pnid-test';
    try {
      const id = await pendingFor(42);
      await waWebhook(waText(WA_BSUID, `gc_${id}`, { bsuid: WA_BSUID, metadata: false }));
      assert(pendingKeys().length === 1 && userWrites.length === 0 && sent.length === 0, 'an entry with no phone_number_id was processed');
      await waWebhook(waText(WA_BSUID, `gc_${id}`, { bsuid: WA_BSUID }));
      assert(await savedToken(42) === 'google-rt-new', 'our own entry was not handled');
    } finally {
      process.env.WHATSAPP_PHONE_NUMBER_ID = '';
    }
  });

  // ---- Review fixes ----

  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const askRefreshed = async (since?: number) => {
    const { GET } = await load('app/api/check-token-refresh/route.ts');
    const query = `user_id=${TAL_TG}${since === undefined ? '' : `&since=${since}`}`;
    const res: Response = await GET(new NextRequest(`http://localhost/api/check-token-refresh?${query}`, {
      headers: { 'x-telegram-init-data': initDataFor(TAL_TG) },
    }));
    return { status: res.status, body: await res.json() };
  };

  /**
   * The phone around a client component: a Telegram webview (initData, MainButton,
   * openLink), localStorage, and a clock `skew` ms off the server's. fetch to our API is
   * answered by the real route, on the server's clock; asServer runs anything else there
   * (a commit, a direct ask). setInterval only records: tick() runs the poll once, then
   * waits for what it fetched.
   */
  const onPhone = async <T,>(skew: number, initData: string, fn: (phone: Row) => Promise<T>): Promise<T> => {
    const realNow = Date.now;
    const { fetch: serverFetch, setInterval: realSetInterval, clearInterval: realClearInterval } = globalThis;
    const saved = ['window', 'document', 'localStorage'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
    const routes: Record<string, string> = {
      '/api/oauth/start': 'app/api/oauth/start/route.ts',
      '/api/check-token-refresh': 'app/api/check-token-refresh/route.ts',
    };
    // The phone's clock is `phoneShift` off the real one, the server's `serverShift`. While
    // any server call runs (depth > 0) the shared clock is the server's: a count, not a saved
    // value, so overlapping calls (the page's next oauth/start beside a commit) can't leave
    // it on the wrong side.
    let phoneShift = skew;
    let serverShift = 0;
    let depth = 0;
    const storage = new Map<string, string>();
    const intervals = new Map<number, () => void>();
    const inflight: Promise<unknown>[] = [];
    const phone: Row = { storage, opened: [] as string[], mainButton: 'hidden', refuse: new Set<string>(), location: { href: 'http://localhost/en/refresh-token', hash: '' } };
    phone.serverNow = () => realNow() + serverShift;
    /** The phone's clock moves on by `ms` (the page left open); the server's with it. */
    phone.advance = (ms: number) => { phoneShift += ms; serverShift += ms; };
    phone.asServer = async <R,>(run: () => Promise<R>): Promise<R> => {
      depth += 1;
      try {
        return await run();
      } finally {
        depth -= 1;
      }
    };
    phone.settle = async () => {
      for (let idle = 0; idle < 3;) {
        const count = inflight.length;
        await Promise.allSettled(inflight);
        await new Promise(resolve => setImmediate(resolve));
        idle = inflight.length === count ? idle + 1 : 0;
      }
    };
    phone.tick = async () => {
      // What the page fetched lands first (its clock is the phone's again), then the poll runs
      await phone.settle();
      [...intervals.values()].forEach(run => run());
      await phone.settle();
    };
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    const noop = () => undefined;
    Date.now = () => realNow() + (depth > 0 ? serverShift : phoneShift);
    define('window', {
      Telegram: { WebApp: { initData, ready: noop, expand: noop, openLink: (u: string) => phone.opened.push(u), MainButton: { setText: noop, onClick: noop, offClick: noop, show: () => { phone.mainButton = 'shown'; }, hide: () => { phone.mainButton = 'hidden'; } } } },
      location: phone.location,
      open: (u: string) => phone.opened.push(u),
      sessionStorage: { getItem: () => null },
    });
    define('document', { hidden: false, addEventListener: noop, removeEventListener: noop });
    define('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, String(v)),
      removeItem: (k: string) => storage.delete(k),
    });
    let nextTimer = 0;
    globalThis.setInterval = ((run: () => void) => { intervals.set(++nextTimer, run); return nextTimer; }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((id: number) => { intervals.delete(id); }) as typeof clearInterval;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const file = routes[url.split('?')[0]];
      if (!file) return serverFetch(input as string, init);
      // phone.refuse: the next call to this route fails as a rate limit would
      if (phone.refuse.delete(url.split('?')[0])) return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 });
      const call = phone.asServer(async () => {
        const mod = await load(file);
        return mod[(init?.method ?? 'GET').toUpperCase()](new NextRequest(`http://localhost${url}`, init));
      });
      inflight.push(call);
      return call;
    }) as typeof fetch;
    try {
      return await fn(phone);
    } finally {
      Date.now = realNow;
      Object.assign(globalThis, { fetch: serverFetch, setInterval: realSetInterval, clearInterval: realClearInterval });
      for (const [key, desc] of saved) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else delete (globalThis as Row)[key];
      }
    }
  };

  await check('#20 check-token-refresh: a flag from a connect before this attempt (since) is not success; a commit after it is', async () => {
    seed();
    // An earlier connect left its flag; then the user taps Connect again (since)
    await tgWebhook(tgText(TAL_TG, `/start gc_${await pendingFor(9)}`));
    assert(redisStore.has('googleConnected:9'), `the first commit set no flag; ${captured.join(' | ')}`);
    await pause(5);
    const since = Date.now();
    const stale = await askRefreshed(since);
    assert(stale.status === 200 && stale.body.refreshed === false, `while still at Google: ${show(stale)}`);
    await pause(5);
    await tgWebhook(tgText(TAL_TG, `/start gc_${await pendingFor(9)}`));
    const fresh = await askRefreshed(since);
    assert(fresh.status === 200 && fresh.body.refreshed === true, `after the new commit: ${show(fresh)}`);
    const noSince = await askRefreshed();
    assert(noSince.status === 400, `no since: ${show(noSince)}`);
    const src = fs.readFileSync(path.join(ROOT, 'app/refresh-token/RefreshTokenClient.tsx'), 'utf8');
    const poll = src.match(/fetch\(`\/api\/check-token-refresh[^`]*`/)?.[0] ?? '';
    assert(/&since=\$\{/.test(poll), `the client's poll URL sends no since: ${poll || '(not found)'}`);
  });

  await check('#21 check-token-refresh has a rate limit of its own, not the general one page-data shares', async () => {
    seed();
    const res = await askRefreshed(Date.now());
    assert(res.status === 200, `status ${show(res)}`);
    assert(limiterUses.length === 1 && limiterUses[0] === 'token-poll', `limiters used: ${show(limiterUses)}`);
    const src = fs.readFileSync(path.join(ROOT, 'src/lib/rate-limit.ts'), 'utf8');
    const def = src.match(/export const tokenPollRateLimiter = new Ratelimit\(\{[\s\S]*?slidingWindow\((\d+), '1 m'\)[\s\S]*?prefix: '([^']+)'/);
    assert(def, 'rate-limit.ts defines no tokenPollRateLimiter');
    // 30 a minute from the 2 s poll, plus visibilitychange checks
    assert(Number(def[1]) >= 60 && def[2] !== 'ratelimit:general', `limit ${def[1]}, prefix ${def[2]}`);
  });

  await check('#22 a reply that fails after the commit doesn\'t fail the webhook (Telegram and WhatsApp)', async () => {
    seed();
    const id = await pendingFor(9);
    const raw = JSON.stringify(tgText(TAL_TG, `/start gc_${id}`));
    failingSends.add('sendMessage');
    const tg = await postWebhook(raw, { 'x-telegram-bot-api-secret-token': 'test-tg-secret' });
    failingSends.clear();
    assert(await savedToken(9) === 'google-rt-new', `no commit; ${captured.join(' | ')}`);
    assert(tg.status === 200, `Telegram webhook ${tg.status}: a redelivered /start would find the entry gone and say "expired"`);
    assert(captured.some(c => c.includes('failed (smoke)')), `the failed reply was not captured: ${show(captured)}`);
    const waId = await pendingFor(42);
    failingSends.add('sendMessage');
    const wa = await postWebhook(JSON.stringify(waText(WA_BSUID, `gc_${waId}`, { bsuid: WA_BSUID })));
    failingSends.clear();
    assert(await savedToken(42) === 'google-rt-new', `no WhatsApp commit; ${captured.join(' | ')}`);
    assert(wa.status === 200, `WhatsApp webhook ${wa.status}`);
  });

  await check('#23 a commit whose follow-ups fail after the token is saved (the reminder cache and the flag, Redis down) still says it connected, never that nothing was', async () => {
    const set = redisImpl.set;
    const NOTHING_SAVED = { en: /nothing was connected/i, he: /לא חיברנו כלום/, ru: /ничего не подключено/i };
    for (const locale of ['en', 'he', 'ru'] as const) {
      seed();
      userRow(9).language = locale;
      const id = await pendingFor(9);
      redisImpl.set = async (k: string, ...rest: unknown[]) => {
        if (/^(reminders:users|googleConnected:)/.test(k)) throw new Error('redis down (smoke)');
        return set(k, ...rest);
      };
      try {
        await tgWebhook(tgText(TAL_TG, `/start gc_${id}`));
      } finally {
        redisImpl.set = set;
      }
      assert(await savedToken(9) === 'google-rt-new', `${locale}: the token was not saved`);
      const reply = sentTo(TAL_TG).at(-1)?.text ?? '';
      assert(reply && !NOTHING_SAVED[locale].test(reply), `${locale} reply: ${show(reply)}`);
    }
  });

  // ---- Follow-ups ----

  await check('#24 with TELEGRAM_BOT_USERNAME and WHATSAPP_PHONE_NUMBER unset, the finish page, "Try again" and the Telegram tip use gate-links\' defaults', async () => {
    const gate = await load('src/lib/gate-links.ts');
    assert(gate.DEFAULT_BOT_USERNAME === 'family_calendar_telegram_bot' && gate.DEFAULT_WA_NUMBER === '972548524687',
      `gate-links exports ${show([gate.DEFAULT_BOT_USERNAME, gate.DEFAULT_WA_NUMBER])}`);
    // Empty, not deleted: @prisma/client loads a .env file into every variable that is unset
    process.env.TELEGRAM_BOT_USERNAME = '';
    process.env.WHATSAPP_PHONE_NUMBER = '';
    try {
      const page = (await load('app/oauth-complete/page.tsx')).default;
      const el = (await page({ searchParams: Promise.resolve({ locale: 'en' }) })) as Row;
      assert(el.props.botUsername === 'family_calendar_telegram_bot' && el.props.waNumber === '972548524687', `props ${show(el.props)}`);
      // A WhatsApp-only owner still gets the only button that can finish
      const mod = await load('app/oauth-complete/OAuthCompleteClient.tsx');
      const links = mod.finishLinks(mod.parseFinishFragment(`#p=${'A'.repeat(32)}&b=wa`), el.props.botUsername, el.props.waNumber, en.oauthComplete.whatsappText);
      assert(String(links.whatsapp).startsWith('https://wa.me/972548524687?text='), `WhatsApp-only links ${show(links)}`);
      seed();
      googleAnswer = { scope: BOTH_SCOPES, access_token: 'test' }; // no refresh_token: the NoRefreshToken page
      const { value: end } = await quietly(() => runCallback(addState(9)));
      const btn = end.element ? elementsOf(end.element).find(e => e.type === 'a' && e.props?.className === 'btn') : undefined;
      assert(btn?.props?.href === 'https://t.me/family_calendar_telegram_bot?start=dashboard', `Try again: ${show(btn?.props?.href ?? end)}`);
      seed();
      await waWebhook(waText(WA_BSUID, `gc_${await pendingFor(42)}`, { bsuid: WA_BSUID }));
      const reply = sentTo(WA_BSUID).at(-1)?.text ?? '';
      assert(reply.includes('https://t.me/family_calendar_telegram_bot?start=connect'), `no Telegram tip in the WhatsApp reply: ${show(reply)}`);
    } finally {
      process.env.TELEGRAM_BOT_USERNAME = 'famcal_test_bot';
      process.env.WHATSAPP_PHONE_NUMBER = '15550001111';
    }
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    for (const name of ['TELEGRAM_BOT_USERNAME', 'WHATSAPP_PHONE_NUMBER']) {
      assert(new RegExp(`^\\|[^\\n]*\`${name}\``, 'm').test(readme), `README's table has no ${name} row`);
      // Commented out: a copied placeholder would override the fallback with a bot or
      // number that doesn't exist
      const line = example.split('\n').find(l => l.includes(`${name}=`));
      assert(line && /^# [A-Z_]+=your_[a-z_]+_here$/.test(line), `.env.example has no commented-out placeholder for ${name}: ${show(line)}`);
    }
  });

  await check('#25 the finish page tells a WhatsApp owner to send the prefilled message (en/he/ru); a Telegram-only one gets no hint', async () => {
    const mod = await load('app/oauth-complete/OAuthCompleteClient.tsx');
    assert(typeof mod.FinishButtons === 'function', 'OAuthCompleteClient exports no FinishButtons');
    const SEND = { en: /send it/i, he: /לשלוח/, ru: /отправьте/ };
    for (const locale of ['en', 'he', 'ru'] as const) {
      const t = JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${locale}.json`), 'utf8')).oauthComplete;
      assert(SEND[locale].test(t.whatsappHint ?? ''), `${locale} oauthComplete.whatsappHint: ${show(t.whatsappHint)}`);
      const both = elementsOf(mod.FinishButtons({ links: { telegram: 'https://t.me/x', whatsapp: 'https://wa.me/1?text=x' }, translations: t, arrow: null }));
      const waAt = both.findIndex(e => e.type === 'a' && e.props?.href === 'https://wa.me/1?text=x');
      const hintAt = both.findIndex(e => textOf([e]) === t.whatsappHint);
      assert(waAt >= 0 && hintAt > waAt, `${locale}: the hint is not under the WhatsApp button (${waAt}, ${hintAt})`);
      const tgOnly = elementsOf(mod.FinishButtons({ links: { telegram: 'https://t.me/x' }, translations: t, arrow: null }));
      assert(tgOnly.some(e => e.type === 'a') && !textOf(tgOnly).includes(t.whatsappHint), `${locale}: Telegram-only shows the WhatsApp hint`);
    }
    const src = fs.readFileSync(path.join(ROOT, 'app/oauth-complete/OAuthCompleteClient.tsx'), 'utf8');
    assert(/<FinishButtons\b/.test(src), 'the page does not render FinishButtons');
  });

  await check('#26 a second tap after a successful connect says the link was already used (Telegram and WhatsApp, en/he/ru)', async () => {
    const USED = { en: /already used/i, he: /כבר נוצל/, ru: /уже использована/i };
    const DASHBOARD = { en: /dashboard/i, he: /לוח הבקרה/, ru: /панел/i };
    for (const locale of ['en', 'he', 'ru'] as const) {
      seed();
      userRow(9).language = locale;
      userRow(42).language = locale;
      const tgId = await pendingFor(9);
      await tgWebhook(tgText(TAL_TG, `/start gc_${tgId}`));
      assert(await savedToken(9) === 'google-rt-new', `${locale}: the first Telegram tap committed nothing; ${captured.join(' | ')}`);
      await tgWebhook(tgText(TAL_TG, `/start gc_${tgId}`));
      const tg = sentTo(TAL_TG).at(-1)?.text ?? '';
      assert(USED[locale].test(tg) && DASHBOARD[locale].test(tg), `${locale} Telegram second tap: ${show(tg)}`);
      const waId = await pendingFor(42);
      await waWebhook(waText(WA_BSUID, `gc_${waId}`, { bsuid: WA_BSUID }));
      assert(await savedToken(42) === 'google-rt-new', `${locale}: the first WhatsApp message committed nothing`);
      await waWebhook(waText(WA_BSUID, `gc_${waId}`, { bsuid: WA_BSUID }));
      const wa = sentTo(WA_BSUID).at(-1)?.text ?? '';
      assert(USED[locale].test(wa) && DASHBOARD[locale].test(wa), `${locale} WhatsApp second message: ${show(wa)}`);
    }
  });

  await check('#27 the poll\'s since is the tap on Connect on the server\'s clock: with the phone 5 min ahead or behind, a commit after the tap is reported, an earlier one or one since the page opened is not', async () => {
    const client = await load('app/refresh-token/RefreshTokenClient.tsx');
    const TRANSLATIONS = new Proxy({}, { get: (_t, key) => (key === 'gate' ? new Proxy({}, { get: (_g, k) => String(k) }) : String(key)) });
    for (const skew of [5 * 60_000, -5 * 60_000]) {
      const label = skew > 0 ? 'phone 5 min ahead' : 'phone 5 min behind';
      seed();
      // An earlier connect left its flag
      await tgWebhook(tgText(TAL_TG, `/start gc_${await pendingFor(9)}`));
      assert(redisStore.has('googleConnected:9'), `the earlier commit set no flag; ${captured.join(' | ')}`);
      await pause(5);
      await onPhone(skew, initDataFor(TAL_TG), async phone => {
        // The page, run as on the phone: oauth/start on mount, then the tap, then the poll
        const app = runClient(client.default, { userId: String(TAL_TG), locale: 'en', translations: TRANSLATIONS });
        await phone.settle();
        const connect = () => elementsOf(app.tree()).find(e => e.type === 'button' && e.props?.className === 'btn');
        assert(connect()?.props.disabled === false, `${label}: no Google URL from oauth/start: ${show(connect()?.props ?? null)}`);
        // Another connect lands while the page is open (another tab, an earlier consent's finish button)
        await phone.asServer(async () => {
          await pause(5);
          await tgWebhook(tgText(TAL_TG, `/start gc_${await pendingFor(9)}`));
          await pause(20);
        });
        const tappedAt = phone.serverNow();
        connect()!.props.onClick();
        const since = JSON.parse(phone.storage.get('famcalbot_oauth_pending') ?? 'null')?.startTime;
        assert(phone.opened.length === 1 && String(phone.opened[0]).startsWith('https://accounts.google.com/'), `${label}: opened ${show(phone.opened)}`);
        await phone.tick();
        assert(!phone.location.href.includes('select-calendars'), `${label}: a connect from before the tap counted (since ${since}, tapped at ${tappedAt})`);
        if (skew < 0) {
          // What the phone's clock alone would have asked: the earlier connects count
          assert((await phone.asServer(() => askRefreshed(tappedAt + skew))).body.refreshed === true, `${label}: the case has no skew to catch`);
        }
        await phone.asServer(async () => {
          await pause(5);
          await tgWebhook(tgText(TAL_TG, `/start gc_${await pendingFor(9)}`));
        });
        await phone.tick();
        assert(phone.location.href === `/en/select-calendars?user_id=${TAL_TG}`, `${label}: the commit after the tap was not reported (since ${since}, tapped at ${tappedAt}); at ${phone.location.href}`);
        if (skew > 0) {
          // What the phone's clock alone would have asked: no commit counts
          assert((await phone.asServer(() => askRefreshed(tappedAt + skew))).body.refreshed === false, `${label}: the case has no skew to catch`);
        }
      });
    }
    // oauth/start sends its clock; with none (or not a number) the phone's clock stands
    seed();
    const { POST } = await load('app/api/oauth/start/route.ts');
    const before = Date.now();
    const res: Response = await POST(new NextRequest('http://localhost/api/oauth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': initDataFor(TAL_TG) },
      body: JSON.stringify({ user_id: String(TAL_TG) }),
    }));
    const body = await res.json();
    assert(res.status === 200 && typeof body.serverTime === 'number' && body.serverTime >= before && body.serverTime <= Date.now(), `oauth/start ${res.status} ${show(body)}`);
    assert(typeof client.attemptFromStart === 'function' && typeof client.attemptSince === 'function', 'RefreshTokenClient exports no attemptFromStart / attemptSince');
    for (const serverTime of [undefined, 'soon', NaN]) {
      const start = client.attemptFromStart({ oauthUrl: 'https://accounts.google.com/x', serverTime }, 1000);
      assert(start?.oauthUrl === 'https://accounts.google.com/x' && client.attemptSince(start.clockOffset, 5000) === 5000, `serverTime ${show(serverTime)}: ${show(start)}`);
    }
    assert(client.attemptFromStart({ error: 'x' }, 1000) === null, 'an answer with no oauthUrl starts an attempt');
  });

  await check('#28 [guard] the signature covers Meta\'s raw bytes: \\u-escaped Hebrew, an escaped slash and a space after a colon still verify', async () => {
    seed();
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    try {
      const id = await pendingFor(42);
      const canonical = JSON.stringify(waText(WA_BSUID, `gc_${id} https://famcal.bot`, { bsuid: WA_BSUID }));
      // As Meta writes it: non-ASCII as \uXXXX, '/' as '\/', and a space after a colon
      const raw = canonical
        .replace('"name":"Sender"', '"name": "\\u05e0\\u05d5\\u05e2\\u05d4"')
        .replace('https://famcal.bot', 'https:\\/\\/famcal.bot');
      const parsed = JSON.parse(raw);
      assert(parsed.entry[0].changes[0].value.contacts[0].profile.name === 'נועה'
        && parsed.entry[0].changes[0].value.messages[0].text.body.endsWith(' https://famcal.bot'), `raw ${raw}`);
      assert(JSON.stringify(parsed) !== raw, 'the raw body is canonical JSON');
      // A route that verified the re-serialized body would refuse Meta's real signature
      const { isValidWhatsAppSignature } = await load('src/lib/whatsapp-signature.ts');
      assert(!isValidWhatsAppSignature(JSON.stringify(parsed), signWa(raw), APP_SECRET), 'the signature also fits the re-serialized body');
      const good = await postWebhook(raw, { 'x-hub-signature-256': signWa(raw) });
      assert(good.status === 200, `status ${good.status}`);
      assert(await savedToken(42) === 'google-rt-new', `not committed; ${captured.join(' | ')}`);
    } finally {
      process.env.WHATSAPP_APP_SECRET = '';
    }
  });

  await check('#29 /start connect from an account already linked to WhatsApp (phone or BSUID only) gets the usual dashboard reply and no link code (webhook and polling)', async () => {
    const handlers: { re: RegExp; fn: (msg: Row, match: RegExpExecArray | null) => Promise<void> }[] = [];
    const { setupHandlers } = await load('src/services/telegram/commands.ts');
    setupHandlers({ onText: (re: RegExp, fn: (msg: Row, match: RegExpExecArray | null) => Promise<void>) => handlers.push({ re, fn }) });
    const startConnect = async (via: 'webhook' | 'polling', tgId: number) => {
      const text = '/start connect';
      if (via === 'webhook') return tgWebhook(tgText(tgId, text));
      const start = handlers.find(h => h.re.test(text));
      assert(start, 'no polling /start handler');
      await quietly(() => start.fn({ chat: { id: tgId }, from: { id: tgId, first_name: 'Test', language_code: 'en' }, text }, start.re.exec(text)));
    };
    const BSUID_TG = 5050;
    for (const via of ['webhook', 'polling'] as const) {
      seed();
      DB.user.push(baseUser({ id: 50, name: 'Dana', telegramId: BigInt(BSUID_TG), whatsappBsuid: 'IL.555', messagingPlatform: 'all' }));
      for (const tgId of [VICTIM_TG, BSUID_TG]) {
        await startConnect(via, tgId);
        const replies = sentTo(tgId);
        const button = replies.at(-1)?.options?.replyMarkup?.inline_keyboard?.[0]?.[0];
        assert(String(button?.web_app?.url).endsWith(`/en/dashboard?user_id=${tgId}`), `${via} ${tgId}: ${show(replies)}`);
        assert(!replies.some(r => /already linked|link code/i.test(r.text ?? '')), `${via} ${tgId}: ${show(replies)}`);
      }
      assert(![...redisStore.keys()].some(k => k.startsWith('link:code:')), `${via}: a link code was made`);
      // An account with no WhatsApp still gets the button that links it
      await startConnect(via, TAL_TG);
      const tal = sentTo(TAL_TG).at(-1)?.options?.replyMarkup?.inline_keyboard?.[0]?.[0];
      assert(String(tal?.url).startsWith('https://wa.me/15550001111?text=link%20'), `${via} unlinked: ${show(sentTo(TAL_TG))}`);
    }
  });

  await check('#30 the admin "Token Refreshed" notice escapes the user\'s name for parse_mode HTML', async () => {
    seed();
    userRow(9).name = '<a href="https://evil.example">Open admin panel</a> & co';
    await tgWebhook(tgText(TAL_TG, `/start gc_${await pendingFor(9)}`));
    const note = adminNotes.find(n => n.startsWith('Token Refreshed')) ?? '';
    assert(note.includes('(&lt;a href="https://evil.example"&gt;Open admin panel&lt;/a&gt; &amp; co)') && !note.includes('<a'), `note ${show(note)}`);
  });


  // ---- google-sync S2: incremental scopes, the sync purpose, the scopes at commit ----

  /** POST /api/oauth/start as Tal's Mini App does, with extra body fields. */
  const startOAuth = async (extra: Row = {}) => {
    const { POST } = await load('app/api/oauth/start/route.ts');
    const res = await quietly<Response>(() => POST(new NextRequest('http://localhost/api/oauth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': initDataFor(TAL_TG) },
      body: JSON.stringify({ user_id: String(TAL_TG), ...extra }),
    }))).then(r => r.value);
    const body = await res.json();
    const url = body.oauthUrl ? new URL(body.oauthUrl) : null;
    return { status: res.status, body, params: url?.searchParams ?? new URLSearchParams() };
  };
  /** A state row as oauth/start makes it, with a purpose. */
  const addSyncState = (userId: number, nativeCalendarId: string) => {
    const token = addState(userId);
    Object.assign(DB.oAuthState.at(-1)!, { purpose: 'sync', nativeCalendarId });
    return token;
  };
  /** The callback's pending entry, read back from Redis (one only). */
  const pendingEntry = (): Row => {
    const keys = pendingKeys();
    assert(keys.length === 1, `pending keys: ${show(keys)}`);
    return JSON.parse(redisStore.get(keys[0]) ?? '{}');
  };
  /** Consent through the callback, then Tal's /start tap: the whole flow. */
  const consentAndClaim = async (state: string) => {
    const { value: end } = await quietly(() => runCallback(state));
    assert(end.redirect, `callback ended with ${show(end.threw ?? end.element?.type ?? end)}; ${captured.join(' | ')}`);
    const p = fragmentOf(end.redirect).get('p');
    await tgWebhook(tgText(TAL_TG, `/start gc_${p}`));
  };
  const linksOf = (userId: number) => DB.googleSyncLink.filter(l => l.userId === userId);
  const { __resetSyncGateForTests, shouldRunSync, setNextSync } = await load('src/services/google-sync/gate.ts');
  const closeGate = () => { __resetSyncGateForTests(); shouldRunSync(new Date()); setNextSync(null, new Date()); };
  const gateOpen = () => shouldRunSync(new Date());

  await check('#31 S2 oauth/start (connect): include_granted_scopes=true, only the two calendar scopes, offline with consent; the state has no purpose', async () => {
    seed();
    const { status, params, body } = await startOAuth();
    assert(status === 200, `oauth/start ${status} ${show(body)}`);
    assert(params.get('include_granted_scopes') === 'true', `include_granted_scopes ${params.get('include_granted_scopes')}`);
    assert(params.get('scope') === BOTH_SCOPES, `scope ${params.get('scope')}`);
    assert(params.get('access_type') === 'offline' && params.get('prompt') === 'consent', `params ${params.toString()}`);
    assert(DB.oAuthState.length === 1 && DB.oAuthState[0].token === params.get('state'), `states ${show(DB.oAuthState)}`);
    assert(DB.oAuthState[0].purpose == null && DB.oAuthState[0].nativeCalendarId == null, `state ${show(DB.oAuthState[0])}`);
  });

  await check('#32 S2 oauth/start (sync): the extra calendar.app.created scope beside the two, include_granted_scopes; the state carries purpose and nativeCalendarId', async () => {
    seed();
    const { status, params, body } = await startOAuth({ purpose: 'sync', nativeCalendarId: 'cal-9' });
    assert(status === 200, `oauth/start ${status} ${show(body)}`);
    assert(params.get('include_granted_scopes') === 'true', `include_granted_scopes ${params.get('include_granted_scopes')}`);
    assert(params.get('scope') === `${BOTH_SCOPES} ${SYNC_SCOPE}`, `scope ${params.get('scope')}`);
    const st = DB.oAuthState[0];
    assert(DB.oAuthState.length === 1 && st.purpose === 'sync' && st.nativeCalendarId === 'cal-9' && String(st.userId) === '9', `state ${show(DB.oAuthState)}`);
  });

  await check('#33 S2 oauth/start refuses a sync for a calendar the user does not own, a deleted one, none, or an unknown purpose (400), and makes no state', async () => {
    seed();
    DB.nativeCalendar.push({ id: 'cal-9-gone', ownerUserId: 9, name: 'Old', isDeleted: true });
    const bodies: Row[] = [
      { purpose: 'sync', nativeCalendarId: 'cal-42' },
      { purpose: 'sync', nativeCalendarId: 'cal-9-gone' },
      { purpose: 'sync', nativeCalendarId: 'cal-none' },
      { purpose: 'sync' },
      { purpose: 'sync', nativeCalendarId: 42 },
      { purpose: 'other', nativeCalendarId: 'cal-9' },
    ];
    for (const b of bodies) {
      const { status, body } = await startOAuth(b);
      assert(status === 400 && !body.oauthUrl, `${show(b)}: ${status} ${show(body)}`);
    }
    assert(DB.oAuthState.length === 0, `states ${show(DB.oAuthState)}`);
  });

  await check('#34 S2 callback (connect): the pending entry carries the granted scopes from the token response; no identity call', async () => {
    seed();
    googleAnswer = { refresh_token: 'google-rt-new', scope: `${BOTH_SCOPES} ${SYNC_SCOPE}`, access_token: 'at-1' };
    const { value: end } = await quietly(() => runCallback(addState(9)));
    assert(end.redirect, `callback ${show(end.threw ?? end)}`);
    const entry = pendingEntry();
    assert(show(entry.scopes) === show([...BOTH_SCOPES.split(' '), SYNC_SCOPE]), `scopes ${show(entry.scopes)}`);
    assert(entry.sync === undefined, `sync ${show(entry.sync)}`);
    assert(primaryAuth.length === 0 && googleCalls.every(u => u === GOOGLE_TOKEN_URL), `Google calls ${show(googleCalls)}`);
    assert(userWrites.length === 0, 'the callback wrote the user');
  });

  await check('#35 S2 callback (sync): asks calendars.get(primary) with the exchange\'s access token; the entry carries the calendar and the account; nothing is saved yet', async () => {
    seed();
    googleAnswer = { refresh_token: 'google-rt-new', scope: `${BOTH_SCOPES} ${SYNC_SCOPE}`, access_token: 'at-sync' };
    const { value: end } = await quietly(() => runCallback(addSyncState(9, 'cal-9')));
    assert(end.redirect, `callback ${show(end.threw ?? end)}; ${captured.join(' | ')}`);
    const entry = pendingEntry();
    assert(show(entry.sync) === show({ nativeCalendarId: 'cal-9', googleAccount: 'tal@gmail.com' }), `sync ${show(entry.sync)}`);
    assert(show(primaryAuth) === show(['Bearer at-sync']), `identity calls ${show(primaryAuth)}`);
    assert(userWrites.length === 0 && DB.googleSyncLink.length === 0, 'the callback saved something');
  });

  await check('#35b S2 callback (sync): an identity call that fails is logged and captured; the consent still parks, with no account', async () => {
    seed();
    googleAnswer = { refresh_token: 'google-rt-new', scope: `${BOTH_SCOPES} ${SYNC_SCOPE}`, access_token: 'at-sync' };
    primaryAnswer = { status: 503 };
    const { value: end } = await quietly(() => runCallback(addSyncState(9, 'cal-9')));
    assert(end.redirect, `callback ${show(end.threw ?? end)}`);
    const entry = pendingEntry();
    assert(show(entry.sync) === show({ nativeCalendarId: 'cal-9', googleAccount: null }), `sync ${show(entry.sync)}`);
    assert(captured.some(c => c.startsWith('google-sync-account')), `captured ${show(captured)}`);
  });

  await check('#36 S2 commit (connect): googleScopes saved from the entry; the user\'s links in token/scopes go back (ok, or creating with no calendar yet) with nextAttemptAt cleared; the outage notice resets; the gate opens; nobody else\'s links move', async () => {
    seed();
    googleAnswer = { refresh_token: 'google-rt-new', scope: `${BOTH_SCOPES} ${SYNC_SCOPE}`, access_token: 'at-1' };
    userRow(9).googleSyncNotifiedAt = new Date();
    DB.googleSyncLink = [
      { id: 'l-tok', userId: 9, nativeCalendarId: 'cal-9', googleCalendarId: 'g1', enabled: true, state: 'token', dirtySeq: 0, pushedSeq: 0 },
      { id: 'l-new', userId: 9, nativeCalendarId: 'cal-9b', googleCalendarId: null, enabled: true, state: 'scopes', dirtySeq: 1, pushedSeq: 0 },
      { id: 'l-gone', userId: 9, nativeCalendarId: 'cal-9c', googleCalendarId: 'g3', enabled: true, state: 'gone', dirtySeq: 0, pushedSeq: 0 },
      { id: 'l-noa', userId: 42, nativeCalendarId: 'cal-42', googleCalendarId: 'g4', enabled: true, state: 'token', dirtySeq: 0, pushedSeq: 0 },
    ];
    const later = new Date(Date.now() + 3_600_000);
    DB.googleSyncItem = [
      { id: 'i1', linkId: 'l-tok', nativeEventId: 'e1', nextAttemptAt: later },
      { id: 'i2', linkId: 'l-noa', nativeEventId: 'e2', nextAttemptAt: later },
    ];
    closeGate();
    await consentAndClaim(addState(9));
    assert(await savedToken(9) === 'google-rt-new', `token ${userRow(9).googleRefreshToken}; ${captured.join(' | ')}`);
    assert(show(userRow(9).googleScopes) === show([...BOTH_SCOPES.split(' '), SYNC_SCOPE]), `googleScopes ${show(userRow(9).googleScopes)}`);
    assert(userRow(9).googleSyncNotifiedAt === null, `googleSyncNotifiedAt ${show(userRow(9).googleSyncNotifiedAt)}`);
    const state = Object.fromEntries(DB.googleSyncLink.map(l => [l.id, l.state]));
    assert(show(state) === show({ 'l-tok': 'ok', 'l-new': 'creating', 'l-gone': 'gone', 'l-noa': 'token' }), `states ${show(state)}`);
    assert(DB.googleSyncItem.find(i => i.id === 'i1')?.nextAttemptAt === null, `i1 ${show(DB.googleSyncItem[0])}`);
    assert(DB.googleSyncItem.find(i => i.id === 'i2')?.nextAttemptAt instanceof Date, 'another user\'s item was reset');
    assert(gateOpen(), 'the gate stayed closed');
    assert(DB.googleSyncLink.length === 4, 'a connect made a link');
  });

  await check('#36b S2 commit (connect) without calendar.app.created: links in token go to scopes (the token is fine, the permission is missing); connecting still works with the two scopes', async () => {
    seed();
    DB.googleSyncLink = [{ id: 'l-tok', userId: 9, nativeCalendarId: 'cal-9', googleCalendarId: 'g1', enabled: true, state: 'token', dirtySeq: 0, pushedSeq: 0 }];
    await consentAndClaim(addState(9));
    assert(await savedToken(9) === 'google-rt-new', `token ${userRow(9).googleRefreshToken}; ${captured.join(' | ')}`);
    assert(show(userRow(9).googleScopes) === show(BOTH_SCOPES.split(' ')), `googleScopes ${show(userRow(9).googleScopes)}`);
    assert(DB.googleSyncLink[0].state === 'scopes', `state ${DB.googleSyncLink[0].state}`);
    const reply = sentTo(TAL_TG).at(-1);
    assert(reply?.options?.replyMarkup?.inline_keyboard?.[0]?.[0]?.web_app?.url?.endsWith(`/en/select-calendars?user_id=${TAL_TG}`), `reply ${show(reply)}`);
  });

  await check('#36c S2/S3 commit (connect) on turned-off copies: one with a Remove/Keep queued goes back to work to carry it out, also with no stored Google calendar id (a calendar the create made but never stored is looked up by its token, so it goes \'creating\'); one with no Google calendar and nothing queued is left alone', async () => {
    seed();
    googleAnswer = { refresh_token: 'google-rt-new', scope: `${BOTH_SCOPES} ${SYNC_SCOPE}`, access_token: 'at-1' };
    const later = new Date(Date.now() + 3_600_000);
    DB.googleSyncLink = [
      { id: 'l-offq', userId: 9, nativeCalendarId: 'cal-9', googleCalendarId: 'g1', enabled: false, unlinkChoice: 'remove', state: 'token', dirtySeq: 2, pushedSeq: 1 },
      { id: 'l-offn', userId: 9, nativeCalendarId: 'cal-9b', googleCalendarId: null, enabled: false, unlinkChoice: 'remove', state: 'scopes', dirtySeq: 2, pushedSeq: 0 },
      { id: 'l-offd', userId: 9, nativeCalendarId: 'cal-9c', googleCalendarId: null, enabled: false, unlinkChoice: 'remove', state: 'token', dirtySeq: 2, pushedSeq: 2 },
    ];
    DB.googleSyncItem = [
      { id: 'i1', linkId: 'l-offq', nativeEventId: 'e1', nextAttemptAt: later },
      { id: 'i2', linkId: 'l-offn', nativeEventId: 'e2', nextAttemptAt: later },
      { id: 'i3', linkId: 'l-offd', nativeEventId: 'e3', nextAttemptAt: later },
    ];
    await consentAndClaim(addState(9));
    assert(await savedToken(9) === 'google-rt-new', `token; ${captured.join(' | ')}`);
    const state = Object.fromEntries(DB.googleSyncLink.map(l => [l.id, l.state]));
    assert(show(state) === show({ 'l-offq': 'ok', 'l-offn': 'creating', 'l-offd': 'token' }), `states ${show(state)}`);
    assert(DB.googleSyncLink.every(l => l.enabled === false), `enabled ${show(DB.googleSyncLink)}`);
    assert(DB.googleSyncItem.find(i => i.id === 'i1')?.nextAttemptAt === null, 'the queued turn-off\'s item kept its retry');
    assert(DB.googleSyncItem.find(i => i.id === 'i2')?.nextAttemptAt === null, 'the queued turn-off with no stored id kept its retry');
    assert(DB.googleSyncItem.find(i => i.id === 'i3')?.nextAttemptAt instanceof Date, 'the turned-off copy with nothing queued had its retry cleared');
  });

  await check('#43 S2 the OAuthState columns come in their own migration: 20261020000001_google_sync has shipped and is unchanged (migrate deploy never re-runs an applied one)', async () => {
    const dir = path.join(ROOT, 'prisma/migrations');
    const shipped = fs.readFileSync(path.join(dir, '20261020000001_google_sync/migration.sql'));
    const sha = crypto.createHash('sha256').update(shipped).digest('hex');
    assert(sha === '760f0f95c5642b4b384bc48b58b65ad122784f6c47260a73ff7ec3aad08ff337', `20261020000001_google_sync was edited after it shipped (sha256 ${sha})`);
    const later = fs.readdirSync(dir).filter(d => d > '20261020000001_google_sync' && fs.existsSync(path.join(dir, d, 'migration.sql')))
      .map(d => fs.readFileSync(path.join(dir, d, 'migration.sql'), 'utf8')).join('\n');
    for (const col of ['purpose', 'nativeCalendarId']) {
      assert(new RegExp(`ALTER TABLE "OAuthState" ADD COLUMN IF NOT EXISTS "${col}" TEXT;`).test(later), `no later migration adds OAuthState.${col}`);
    }
  });

  await check('#37 S2 commit (sync): creates the link (enabled, creating, the account, dirty), saves the scopes and opens the gate; the stale-choices clear still runs', async () => {
    seed();
    Object.assign(userRow(9), { calendarAssignments: [{ calendarId: 'old@gmail.com', labels: ['primary', 'yours'], name: 'Old', color: '#4285F4' }] });
    googleAnswer = { refresh_token: 'google-rt-new', scope: `${BOTH_SCOPES} ${SYNC_SCOPE}`, access_token: 'at-sync' };
    closeGate();
    await consentAndClaim(addSyncState(9, 'cal-9'));
    assert(await savedToken(9) === 'google-rt-new', `token; ${captured.join(' | ')}`);
    assert(show(userRow(9).googleScopes) === show([...BOTH_SCOPES.split(' '), SYNC_SCOPE]), `googleScopes ${show(userRow(9).googleScopes)}`);
    const links = linksOf(9);
    assert(links.length === 1, `links ${show(DB.googleSyncLink)}`);
    const l = links[0];
    assert(l.nativeCalendarId === 'cal-9' && l.enabled === true && l.state === 'creating' && l.googleAccount === 'tal@gmail.com' && l.googleCalendarId == null && l.dirtySeq === 1,
      `link ${show(l)}`);
    assert(gateOpen(), 'the gate stayed closed');
    const after = userRow(9).calendarAssignments;
    assert(after === null || after === undefined || (typeof after === 'object' && !Array.isArray(after)), `stale choices kept: ${show(after)}`);
  });

  await check('#38 S2 commit (sync) re-checks the calendar: deleted or given to someone else since the consent, no link is made; the token is still saved', async () => {
    for (const change of ['deleted', 'transferred'] as const) {
      seed();
      googleAnswer = { refresh_token: 'google-rt-new', scope: `${BOTH_SCOPES} ${SYNC_SCOPE}`, access_token: 'at-sync' };
      const state = addSyncState(9, 'cal-9');
      const cal = DB.nativeCalendar.find(c => c.id === 'cal-9')!;
      if (change === 'deleted') cal.isDeleted = true;
      else cal.ownerUserId = 42;
      await consentAndClaim(state);
      assert(await savedToken(9) === 'google-rt-new', `${change}: token; ${captured.join(' | ')}`);
      assert(DB.googleSyncLink.length === 0, `${change}: links ${show(DB.googleSyncLink)}`);
    }
  });

  await check('#39 S2 commit (sync) where the user unticked calendar.app.created: the link is made in scopes, not creating', async () => {
    seed();
    googleAnswer = { refresh_token: 'google-rt-new', scope: BOTH_SCOPES, access_token: 'at-sync' };
    await consentAndClaim(addSyncState(9, 'cal-9'));
    const links = linksOf(9);
    assert(links.length === 1 && links[0].state === 'scopes' && links[0].enabled === true, `links ${show(DB.googleSyncLink)}`);
    assert(show(userRow(9).googleScopes) === show(BOTH_SCOPES.split(' ')), `googleScopes ${show(userRow(9).googleScopes)}`);
  });

  await check('#40 S2 commit (sync) on a copy turned off earlier: re-enabled on the same row and Google calendar, the queued choice and token dropped, every item dirty with its hashes cleared, backfill again; the stored account is kept', async () => {
    seed();
    googleAnswer = { refresh_token: 'google-rt-new', scope: `${BOTH_SCOPES} ${SYNC_SCOPE}`, access_token: 'at-sync' };
    primaryAnswer = { id: 'other@gmail.com' };
    DB.googleSyncLink = [{
      id: 'l-off', userId: 9, nativeCalendarId: 'cal-9', googleCalendarId: 'g1', googleAccount: 'tal@gmail.com', enabled: false, state: 'ok',
      unlinkChoice: 'remove', unlinkToken: 'enc-token', dirtySeq: 3, pushedSeq: 2, backfilledAt: new Date(), lastError: 'x',
    }];
    DB.googleSyncItem = [
      { id: 'i1', linkId: 'l-off', nativeEventId: 'e1', masterHash: 'h1', slotHashes: { a: 'b' }, dirtySeq: 2, pushedSeq: 2, nextAttemptAt: new Date(), attempts: 4 },
    ];
    await consentAndClaim(addSyncState(9, 'cal-9'));
    assert(DB.googleSyncLink.length === 1, `links ${show(DB.googleSyncLink)}`);
    const l = DB.googleSyncLink[0];
    assert(l.id === 'l-off' && l.enabled === true && l.state === 'ok' && l.unlinkChoice === null && l.unlinkToken === null && l.backfilledAt === null && l.dirtySeq === 4 && l.lastError === null,
      `link ${show(l)}`);
    assert(l.googleCalendarId === 'g1' && l.googleAccount === 'tal@gmail.com', `calendar/account ${show(l)}`);
    const i = DB.googleSyncItem[0];
    assert(i.masterHash === null && show(i.slotHashes) === '{}' && i.dirtySeq === 3 && i.nextAttemptAt === null && i.attempts === 0, `item ${show(i)}`);
  });

  await check('#40b S2 commit (sync) on a copy that is already on changes nothing on it but a token/scopes state', async () => {
    seed();
    googleAnswer = { refresh_token: 'google-rt-new', scope: `${BOTH_SCOPES} ${SYNC_SCOPE}`, access_token: 'at-sync' };
    DB.googleSyncLink = [{ id: 'l-on', userId: 9, nativeCalendarId: 'cal-9', googleCalendarId: 'g1', googleAccount: 'tal@gmail.com', enabled: true, state: 'ok', dirtySeq: 5, pushedSeq: 5, backfilledAt: new Date(0) }];
    await consentAndClaim(addSyncState(9, 'cal-9'));
    const l = DB.googleSyncLink[0];
    assert(DB.googleSyncLink.length === 1 && l.dirtySeq === 5 && l.state === 'ok' && l.backfilledAt instanceof Date, `link ${show(l)}`);
  });

  await check('#40c S2 commit (sync) on a copy turned off with a Remove queued while the token was dead: the gate never opens while the link still shows turned off in \'ok\' with the Remove queued, so a worker tick in between can\'t carry out the Remove the user just took back', async () => {
    seed();
    googleAnswer = { refresh_token: 'google-rt-new', scope: `${BOTH_SCOPES} ${SYNC_SCOPE}`, access_token: 'at-sync' };
    DB.googleSyncLink = [{
      id: 'l-off', userId: 9, nativeCalendarId: 'cal-9', googleCalendarId: 'g1', googleAccount: 'tal@gmail.com', enabled: false, state: 'token',
      unlinkChoice: 'remove', unlinkToken: 'enc-token', dirtySeq: 3, pushedSeq: 2,
    }];
    closeGate();
    const seen: string[] = [];
    const gateState = (globalThis as { __googleSyncGate?: { nextRunAt: number } }).__googleSyncGate!;
    beforePrismaCall = () => {
      if (gateState.nextRunAt > Date.now()) return;
      const l = DB.googleSyncLink.find(x => x.id === 'l-off');
      if (l && !l.enabled && l.unlinkChoice && l.state === 'ok') seen.push(show({ enabled: l.enabled, state: l.state, unlinkChoice: l.unlinkChoice }));
    };
    try {
      await consentAndClaim(addSyncState(9, 'cal-9'));
    } finally {
      beforePrismaCall = null;
    }
    assert(seen.length === 0, `a worker tick could carry out the Remove: gate open on ${seen[0]}`);
    const l = DB.googleSyncLink[0];
    assert(l.enabled === true && l.state === 'ok' && l.unlinkChoice === null && l.unlinkToken === null && l.googleCalendarId === 'g1', `link ${show(l)}`);
    assert(gateOpen(), 'the gate stayed closed');
  });

  await check('#41 S2 a pending entry parked before this deploy (no scopes) commits as before and leaves googleScopes as they were', async () => {
    seed();
    userRow(9).googleScopes = ['https://www.googleapis.com/auth/calendar.readonly'];
    const id = await pendingFor(9);
    const key = pendingKeys()[0];
    const raw = JSON.parse(redisStore.get(key) ?? '{}');
    redisStore.set(key, JSON.stringify({ ownerUserId: raw.ownerUserId, refreshToken: raw.refreshToken }));
    await tgWebhook(tgText(TAL_TG, `/start gc_${id}`));
    assert(await savedToken(9) === 'google-rt-new', `token; ${captured.join(' | ')}`);
    assert(show(userRow(9).googleScopes) === show(['https://www.googleapis.com/auth/calendar.readonly']), `googleScopes ${show(userRow(9).googleScopes)}`);
  });

  await check('#42 S2 the privacy page names the Google copy in every language: calendar.app.created, the "FamCal ·" calendar, never read back, Remove or Keep; dated October 2026', async () => {
    const page = (await load('app/[locale]/privacy/page.tsx')).default;
    const want: Record<string, RegExp[]> = {
      en: [/calendar\.app\.created/, /FamCal · /, /never read back/, /delete that Google calendar or keep it/, /October 2026/],
      he: [/calendar\.app\.created/, /FamCal · /, /לא נקראים בחזרה/, /למחוק את יומן ה-Google הזה או להשאיר אותו/, /אוקטובר 2026/],
      ru: [/calendar\.app\.created/, /FamCal · /, /никогда не читаются обратно/, /удалить этот календарь Google или оставить его/, /октябрь 2026/],
    };
    for (const [locale, patterns] of Object.entries(want)) {
      const text = textOf(elementsOf(await page({ params: Promise.resolve({ locale }) })));
      for (const re of patterns) assert(re.test(text), `${locale}: no ${re} in the privacy page`);
    }
    // Hebrew stays gender-neutral in the new text: no masculine-only "you ask" forms
    const he = textOf(elementsOf(await page({ params: Promise.resolve({ locale: 'he' }) })));
    const googleSection = he.slice(he.indexOf('אנו ניגשים ליומן Google באמצעות'), he.indexOf('אחסון נתונים'));
    assert(!/(^|\s)(אתה|תאשר|תבקש|שלך)(?=[\s,.]|$)/.test(googleSection), `he: a masculine form in the Google section: ${googleSection}`);
  });

  // ---- google-sync S4: the plan gate on a sync consent, and the reply to a sync commit ----

  const enBot = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8')).bot.googleSync.consent;
  const heBot = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/he.json'), 'utf8')).bot.googleSync.consent;

  await check('#44 S4 oauth/start (sync) for a user whose plan lacks google_sync: 403 upgrade_required, no state, no Google URL; a connect never asks the plan', async () => {
    seed();
    syncDenied.add(9);
    const { status, body } = await startOAuth({ purpose: 'sync', nativeCalendarId: 'cal-9' });
    assert(status === 403 && body.error === 'upgrade_required' && !body.oauthUrl, `sync: ${status} ${show(body)}`);
    assert(DB.oAuthState.length === 0, `states ${show(DB.oAuthState)}`);
    assert(show(syncChecks) === show([9]), `plan checks ${show(syncChecks)}`);
    syncChecks.length = 0;
    const connect = await startOAuth({});
    assert(connect.status === 200 && connect.body.oauthUrl, `connect: ${connect.status} ${show(connect.body)}`);
    assert(syncChecks.length === 0, `a connect asked the plan: ${show(syncChecks)}`);
  });

  await check('#45 S4 a sync commit on Telegram replies with the copy line and an "Open calendars" button to /<lang>/calendars, never the connect reply\'s "choose calendars"', async () => {
    seed();
    googleAnswer = { refresh_token: 'google-rt-new', scope: `${BOTH_SCOPES} ${SYNC_SCOPE}`, access_token: 'at-sync' };
    await consentAndClaim(addSyncState(9, 'cal-9'));
    assert(linksOf(9).length === 1, `links ${show(DB.googleSyncLink)}; ${captured.join(' | ')}`);
    const replies = sentTo(TAL_TG);
    assert(replies.length === 1, `replies ${show(replies)}`);
    const reply = replies[0];
    assert(reply.text === enBot.started, `text ${show(reply.text)}`);
    const button = reply.options?.replyMarkup?.inline_keyboard?.[0]?.[0];
    assert(button?.text === enBot.button && String(button?.web_app?.url).endsWith(`/en/calendars?user_id=${TAL_TG}`), `button ${show(button)}`);
    assert(!replies.some(r => /select-calendars/.test(show(r))), `a choose-calendars reply: ${show(replies)}`);
  });

  await check('#46 S4 a sync commit whose calendar is no longer the user\'s: the "nothing was copied" line, no button; a plain connect still replies with "choose calendars"', async () => {
    seed();
    const state = addSyncState(9, 'cal-9');
    DB.nativeCalendar.find(c => c.id === 'cal-9')!.isDeleted = true;
    await consentAndClaim(state);
    const reply = sentTo(TAL_TG).at(-1);
    assert(reply?.text === enBot.notOwner && !reply?.options?.replyMarkup, `reply ${show(reply)}`);
    seed();
    await consentAndClaim(addState(9));
    const plain = sentTo(TAL_TG).at(-1);
    assert(String(plain?.options?.replyMarkup?.inline_keyboard?.[0]?.[0]?.web_app?.url).endsWith(`/en/select-calendars?user_id=${TAL_TG}`), `connect reply ${show(plain)}`);
  });

  await check('#47 S4 a sync commit over WhatsApp: the copy line in the user\'s language with the Telegram tip, no select-calendars magic link', async () => {
    seed();
    googleAnswer = { refresh_token: 'google-rt-new', scope: `${BOTH_SCOPES} ${SYNC_SCOPE}`, access_token: 'at-sync' };
    const { value: end } = await quietly(() => runCallback(addSyncState(42, 'cal-42')));
    assert(end.redirect, `callback ${show(end.threw ?? end)}`);
    const p = fragmentOf(end.redirect).get('p');
    await waWebhook(waText(WA_BSUID, `gc_${p}`, { bsuid: WA_BSUID }));
    assert(linksOf(42).length === 1, `links ${show(DB.googleSyncLink)}; ${captured.join(' | ')}`);
    const reply = sentTo(WA_BSUID).at(-1);
    assert(reply?.text?.startsWith(heBot.started) && /t\.me\/famcal_test_bot/.test(reply.text), `reply ${show(reply)}`);
    assert(!reply?.options?.whatsappUrlButton, `a magic link button: ${show(reply?.options)}`);
  });

  await check('#48 S4 a sync commit whose grant lacks calendar.app.created (unticked in Google\'s consent): the "permission wasn\'t given" line with the Open calendars button on Telegram, and over WhatsApp; never "started"', async () => {
    seed();
    googleAnswer = { refresh_token: 'google-rt-new', scope: BOTH_SCOPES, access_token: 'at-sync' };
    await consentAndClaim(addSyncState(9, 'cal-9'));
    const links = linksOf(9);
    assert(links.length === 1 && links[0].state === 'scopes', `links ${show(DB.googleSyncLink)}; ${captured.join(' | ')}`);
    const reply = sentTo(TAL_TG).at(-1);
    assert(reply?.text === enBot.noPermission, `text ${show(reply?.text)}`);
    const button = reply?.options?.replyMarkup?.inline_keyboard?.[0]?.[0];
    assert(button?.text === enBot.button && String(button?.web_app?.url).endsWith(`/en/calendars?user_id=${TAL_TG}`), `button ${show(button)}`);
    seed();
    googleAnswer = { refresh_token: 'google-rt-new', scope: BOTH_SCOPES, access_token: 'at-sync' };
    const { value: end } = await quietly(() => runCallback(addSyncState(42, 'cal-42')));
    assert(end.redirect, `callback ${show(end.threw ?? end)}`);
    await waWebhook(waText(WA_BSUID, `gc_${fragmentOf(end.redirect).get('p')}`, { bsuid: WA_BSUID }));
    const wa = sentTo(WA_BSUID).at(-1);
    assert(wa?.text?.startsWith(heBot.noPermission) && !wa.text.startsWith(heBot.started), `reply ${show(wa)}`);
  });

  await check('#49 every Connect tap opens a Google URL of its own: after a consent used the first state, a second tap on the same page opens a new one, whose consent reaches the finish page instead of "Invalid or expired state token"; a URL left unused 9 minutes is replaced, not opened', async () => {
    const client = await load('app/refresh-token/RefreshTokenClient.tsx');
    const TRANSLATIONS = new Proxy({}, { get: (_t, key) => (key === 'gate' ? new Proxy({}, { get: (_g, k) => String(k) }) : String(key)) });
    const stateOf = (url: unknown) => new URL(String(url)).searchParams.get('state') ?? '';
    seed();
    await onPhone(0, initDataFor(TAL_TG), async phone => {
      const app = runClient(client.default, { userId: String(TAL_TG), locale: 'en', translations: TRANSLATIONS });
      await phone.settle();
      const connect = () => elementsOf(app.tree()).find(e => e.type === 'button' && e.props?.className === 'btn');
      assert(connect()?.props.disabled === false && phone.mainButton === 'shown', `not ready: ${show(connect()?.props ?? null)}, MainButton ${phone.mainButton}`);
      connect()!.props.onClick();
      // The URL just opened is spent: until the next one is ready, nothing can reopen it
      assert(connect()?.props.disabled === true && phone.mainButton === 'hidden', `right after the tap: ${show(connect()?.props ?? null)}, MainButton ${phone.mainButton}`);
      await phone.settle();
      assert(connect()?.props.disabled === false && phone.mainButton === 'shown', `no next URL: ${show(connect()?.props ?? null)}`);
      const first = stateOf(phone.opened[0]);
      const done = await phone.asServer(() => quietly(() => runCallback(first)));
      assert(done.value.redirect?.startsWith('/oauth-complete'), `first consent: ${show(done.value.threw ?? done.value.element?.props ?? done.value)}`);
      connect()!.props.onClick();
      await phone.settle();
      const second = stateOf(phone.opened[1]);
      assert(phone.opened.length === 2 && second.startsWith('u1_') && second !== first, `second tap opened ${show(phone.opened)}`);
      const again = await phone.asServer(() => quietly(() => runCallback(second)));
      assert(again.value.redirect?.startsWith('/oauth-complete'), `second consent: ${show(again.value.threw ?? again.value.element?.props ?? again.value)}`);
      // A URL prepared 9.5 minutes ago (its state ends at 10): the tap gets a new one instead
      const ready = stateOf(phone.opened[1]);
      phone.advance(9.5 * 60_000);
      connect()!.props.onClick();
      assert(phone.opened.length === 2, `a 9.5-minute-old URL was opened: ${show(phone.opened)}`);
      await phone.settle();
      connect()!.props.onClick();
      await phone.settle();
      const third = stateOf(phone.opened[2]);
      assert(phone.opened.length === 3 && third !== ready && DB.oAuthState.some((r: Row) => r.token === third), `after the stale tap: ${show(phone.opened)}`);
    });
  });

  await check('#51 a failed oauth/start after a tap (429) leaves Connect working: no final error beside the waiting text; the tap prepares a new URL (opening nothing), the next tap opens it', async () => {
    const client = await load('app/refresh-token/RefreshTokenClient.tsx');
    const TRANSLATIONS = new Proxy({}, { get: (_t, key) => (key === 'gate' ? new Proxy({}, { get: (_g, k) => String(k) }) : String(key)) });
    seed();
    await onPhone(0, initDataFor(TAL_TG), async phone => {
      const app = runClient(client.default, { userId: String(TAL_TG), locale: 'en', translations: TRANSLATIONS });
      await phone.settle();
      const connect = () => elementsOf(app.tree()).find(e => e.type === 'button' && e.props?.className === 'btn');
      const alerts = () => elementsOf(app.tree()).filter(e => e.props?.role === 'alert');
      phone.refuse.add('/api/oauth/start');
      connect()!.props.onClick();
      await phone.settle();
      assert(phone.opened.length === 1, `opened ${show(phone.opened)}`);
      assert(alerts().length === 0 && connect()?.props.disabled === false && phone.mainButton === 'shown', `after the failed prepare: alerts ${alerts().length}, button ${show(connect()?.props ?? null)}, MainButton ${phone.mainButton}`);
      connect()!.props.onClick();
      assert(phone.opened.length === 1, `the retry tap opened ${show(phone.opened)}`);
      await phone.settle();
      connect()!.props.onClick();
      await phone.settle();
      const opened = new URL(String(phone.opened[1] ?? 'https://x/')).searchParams.get('state') ?? '';
      assert(phone.opened.length === 2 && opened !== new URL(phone.opened[0]).searchParams.get('state') && DB.oAuthState.some((r: Row) => r.token === opened), `after the retry: ${show(phone.opened)}`);
    });
  });

  await check('#50 Google refusing the code exchange (400 invalid_grant with its description, or a 502 that isn\'t JSON) shows the "couldn\'t finish" page with a retry, logs and captures Google\'s reason, parks nothing; never the permissions page', async () => {
    for (const refusal of [
      { status: 400, body: JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request' }), says: 'HTTP 400 invalid_grant: Bad Request' },
      { status: 502, body: '<html>Bad Gateway</html>', says: 'HTTP 502' },
    ]) {
      seed();
      googleRefusal = refusal;
      const { value: end, errors } = await quietly(() => runCallback(addState(9)));
      const type = end.element?.type as Row | undefined;
      assert(type?.name === 'ExchangeFailedPage', `${refusal.status}: rendered ${show(type?.name ?? end.threw ?? end.redirect)}`);
      assert(end.element?.props.locale === 'en' && String(end.element?.props.retryHref).startsWith('https://t.me/'), `${refusal.status}: props ${show(end.element?.props)}`);
      assert(captured.some(c => c.startsWith('oauth-token-exchange:') && c.includes(refusal.says)), `${refusal.status}: captured ${show(captured)}`);
      assert(errors.some(e => e.includes(`user 9`) && e.includes(refusal.says)), `${refusal.status}: logged ${show(errors)}`);
      assert(pendingKeys().length === 0, `${refusal.status}: a token was parked`);
    }
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

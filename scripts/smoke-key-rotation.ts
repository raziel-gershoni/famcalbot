// Smoke test for reading stored Google tokens while ENCRYPTION_KEY is rotated (secret
// rotation spec §a, call sites). Before, every getUser* decrypted the token with
// safeDecrypt, so one row the key couldn't open made getAllUsers throw (the whole hourly
// summary batch failed) and every lookup of that user throw (connect and reconnect too).
// Now convertPrismaUserToConfig reads it with readStoredToken: '' (not connected) for a
// value neither key opens, reported once, and '' for an empty cipher (what select-calendars
// wrote for users with no token). The OAuth claim catches a pending entry it can't decrypt
// and answers "expired". select-calendars no longer writes the token at all.
//
// Keys: ENCRYPTION_KEY = B (new), ENCRYPTION_KEY_PREVIOUS = A (old); C is a key this server
// never had. Users with no token ('' or an empty cipher) must never be captured or written
// (review focus 1).
//
// getAllUsers, convertPrismaUserToConfig, google-connect (park, claim, commit), the OAuth
// callback page, verifyUserAuth and the select-calendars route run for real. Faked at the
// boundaries: Prisma (in memory), Redis (in memory), the rate limiter (always allows),
// error capture, the admin notifier, Telegram and WhatsApp (record), the sync plan check,
// and fetch (Google's token endpoint answers; anything else is blocked). Every user here
// has reminders off, so nothing reaches the reminder cache.
//
// Check #10 also runs the real summary batch (sendDailySummaryToAll in summary.ts, with the
// real getAllUsers, claude.ts prompt builder and delivery) over two users, one with a token no
// key opens. Faked there: the calendar reader (records what it is handed), the calendar
// provider, the AI, voice, analytics, subscription, timezone and Telegram. It runs without
// the hourly filter (filterByHour), which only chooses users after getAllUsers.
// No network, no DB.
//
// The native-reminder snooze and the Google sync worker are checked in their own smokes
// (smoke-reminder-actions.ts, smoke-google-sync-worker.ts), whose harnesses run them.
//
// Run with the fake env (no dotenv):
//   npx tsx scripts/smoke-key-rotation.ts

import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function stubAnalytics() {
  stub('src/services/analytics-service.ts', { trackActivityAsync: (userId: number, action: string, meta?: object) => { activityRows.push(`${userId}:${action} ${JSON.stringify(meta ?? {})}`); }, addBreadcrumb: () => undefined });
}
/** The activity rows the code under test writes: "<user id>:<action> <json>". */
const activityRows: string[] = [];

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
// Set before any module loads: encryption.ts used to read the key once, at load.
process.env.ENCRYPTION_KEY = B;
process.env.ENCRYPTION_KEY_PREVIOUS = A;
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.CRON_SECRET ||= 'test-cron';
process.env.TELEGRAM_BOT_USERNAME = 'famcal_test_bot';
process.env.WHATSAPP_PHONE_NUMBER = '15550001111';

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

/** AES-256-GCM in our iv:tag:data format, with Node's crypto directly (not the module under test). */
function encryptWith(keyHex: string, text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const data = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data}`;
}
function decryptWith(keyHex: string, value: string): string | null {
  const [iv, tag, data] = String(value).split(':');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(iv, 'hex'), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(tag, 'hex'));
    return d.update(data, 'hex', 'utf8') + d.final('utf8');
  } catch {
    return null; // the wrong key: what the checks assert
  }
}

// ---- Fake Prisma: in-memory tables, any model ----

const DB: Record<string, Row[]> = {};
/** Every write to the user table: the where it used, the data and the row ids it hit. */
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
  return {
    findUnique: async (a: Row = {}) => pick(t().find(r => matches(r, a.where)), a.select),
    findFirst: async (a: Row = {}) => pick(t().find(r => matches(r, a.where)), a.select),
    findMany: async (a: Row = {}) => t().filter(r => matches(r, a.where)).map(r => pick(r, a.select)),
    count: async (a: Row = {}) => t().filter(r => matches(r, a.where)).length,
    create: async (a: Row) => pick(create(a.data), a.select),
    update: async (a: Row) => pick(updateOne(a.where, a.data, 'update'), a.select),
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
  set: async (k: string, v: unknown, o?: Row) => {
    if (o?.nx && redisStore.has(k)) return null;
    redisStore.set(k, encode(v));
    return 'OK';
  },
  del: async (...ks: unknown[]) => ks.flat().reduce((n: number, k) => n + (redisStore.delete(String(k)) ? 1 : 0), 0),
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

// ---- Boundaries: stubs in require's cache, served to import() by a load hook ----

const captured: { ctx: string; extra?: Row; message: string }[] = [];
/** What each summary read was handed: the user's id, their Google token and how many Google choices they still have. */
const readCalls: { userId: unknown; token: unknown; googleChoices: number }[] = [];
const sent: { via: string; chatId: unknown; text: unknown }[] = [];
const recorder = (prefix: string): Row =>
  new Proxy({} as Row, {
    get: (_t, p) =>
      typeof p !== 'string' || p === 'then'
        ? undefined
        : async (chatId: unknown, text?: unknown) => { sent.push({ via: `${prefix}.${p}`, chatId, text }); return { message_id: 1 }; },
  });

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

// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-partner-labels.ts).
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

/** Every request the fake network refused: Google's token endpoint is the only one it answers. */
const blockedFetches: string[] = [];
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BOTH_SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events';

function installStubs() {
  stub('src/utils/prisma.ts', { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() });
  stub('src/utils/redis.ts', { redis: fakeRedis });
  stub('src/lib/rate-limit.ts', {
    settingsRateLimiter: { name: 'settings' }, commandRateLimiter: { name: 'command' }, generalRateLimiter: { name: 'general' },
    tokenPollRateLimiter: { name: 'token-poll' },
    checkRateLimit: async () => ({ success: true, limit: 99, remaining: 99, reset: 0 }),
    getRateLimitHeaders: () => ({}),
  });
  const capture = (e: unknown, ctx: string, extra?: Row) => {
    captured.push({ ctx, extra, message: e instanceof Error ? e.message : String(e) });
  };
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
  stub('src/utils/error-notifier.ts', {
    notifyAdminWarning: async () => undefined,
    notifyAdminError: async () => undefined,
    notifyAdminFeedback: async () => undefined,
    getAdminUserIds: async () => [],
  });
  const bot = recorder('bot');
  stub('src/services/telegram/bot.ts', {
    getBot: () => bot,
    initBot: () => bot,
    getMessagingService: () => recorder('tg'),
    setUserMenuButton: async () => undefined,
  });
  const types = nodeRequire(path.join(ROOT, 'src/services/messaging/types.ts'));
  const messaging = {
    ...types,
    getMessagingService: (platform: unknown) => recorder(String(platform)),
    getTelegramService: () => recorder('telegram'),
    getWhatsAppService: () => recorder('whatsapp'),
  };
  stub('src/services/messaging/index.ts', messaging);
  stub('src/services/messaging/factory.ts', messaging);
  stub('src/services/google-sync/access.ts', { syncAllowed: async () => true });

  globalThis.fetch = (async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === GOOGLE_TOKEN_URL) {
      return new Response(JSON.stringify({ refresh_token: 'google-rt-new', scope: BOTH_SCOPES, access_token: 'test' }), { headers: { 'content-type': 'application/json' } });
    }
    blockedFetches.push(url);
    throw new Error(`network blocked in smoke: ${url}`);
  }) as typeof fetch;
}

/** The summary batch's seams (check #10), installed just before summary.ts first loads so no earlier check sees them. */
function installBatchStubs() {
  // The reader and what is past it. Each read records the user it was handed, so the
  // check sees whether any Google token would have been used.
  const { liveGoogleChoices } = nodeRequire(path.join(ROOT, 'src/lib/google-state.ts'));
  stub('src/services/calendar-read/index.ts', {
    sourcesFor: () => ['famcal'],
    readRange: async (user: Row, fromKey: string, toKey: string) => {
      readCalls.push({ userId: user.id, token: user.googleRefreshToken, googleChoices: liveGoogleChoices(user).length });
      const window = { from: new Date(`${fromKey}T00:00:00Z`), to: new Date(`${toKey}T00:00:00Z`) };
      return { window, items: [], famcal: { status: 'ok', ctx: { viewerId: user.id, partner: null }, calendars: [], partner: null } };
    },
  });
  stub('src/services/calendar-provider/index.ts', {
    // FamCal's own calendar, then the Google choices the user still has.
    getCalendarAssignmentsForUser: async (u: Row) => [
      { calendarId: `native:cal-${u.id}`, labels: ['yours'], name: u.name, color: '#039BE5' },
      ...liveGoogleChoices(u),
    ],
  });
  stub('src/services/native-reminders/open-reminders.ts', { addDigestReminders: async (_u: Row, events: unknown[]) => ({ events, moreCount: 0 }) });
  stub('src/services/ai-provider.ts', {
    // Answers with the name of the one user the prompt is about.
    generateAICompletion: async (prompt: string) => {
      const name = ['Gita', 'Boaz'].find(n => prompt.includes(n)) ?? 'nobody';
      return { text: `Summary for ${name}`, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn', model: 'fake-model', durationMs: 0 };
    },
    streamAICompletion: async () => { throw new Error('a scheduled summary never streams'); },
  });
  stub('src/services/telegram/voice.ts', { sendVoiceMessage: async () => undefined, sendWeeklyVoiceMessage: async () => undefined });
  stub('src/services/telegram/commands.ts', { sendSetupNudgeIfNeeded: async () => false });
  stubAnalytics();
  stub('src/services/subscription-service.ts', { checkFeatureAccess: async () => ({ allowed: true }), incrementUsage: async () => undefined });
  stub('src/lib/timezone.ts', { resolveUserTimezone: async () => 'Asia/Jerusalem' });
}

// ---- Fixtures ----

const DAY = 86_400_000;
const TAL_TG = 111111111;

function baseUser(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', culture: 'default',
    messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null, calendarSource: 'NATIVE',
    googleScopes: [], googleSyncNotifiedAt: null,
    pairingId: null, remindersEnabled: false, suspendedAt: null, unreachableSince: null, whatsappPhone: null,
    whatsappBsuid: null, telegramId: null, isAdmin: false, globalRules: [], voiceInputEnabled: true,
    textSummaryEnabled: true, voiceSummaryEnabled: false, weatherEnabled: true,
    createdAt: new Date(Date.now() - 30 * DAY), updatedAt: new Date(Date.now() - DAY),
    ...o,
  };
}

/** A clean world, with every once-per-process report forgotten. */
function seed(users: Row[]) {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  userWrites.length = 0;
  captured.length = 0;
  sent.length = 0;
  blockedFetches.length = 0;
  readCalls.length = 0;
  delete (globalThis as Row).__famcalEncryptionReports;
  DB.user = users;
  DB.oAuthState = [];
  DB.googleSyncLink = [];
  DB.nativeCalendar = users.map(u => ({ id: `cal-${u.id}`, ownerUserId: u.id, name: `${u.name} calendar`, isDeleted: false, labels: ['yours', 'primary'] }));
}

const userRow = (id: number) => DB.user.find(u => u.id === id) as Row;
const tokenCaptures = () => captured.filter(c => c.ctx === 'token-undecryptable');

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

/** Runs `fn` with the services' logs silenced. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn, error } = console;
  console.log = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    return await fn();
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

/** A pending entry parked as the callback parks it, its token encrypted under `keyHex`. Returns the pendingId. */
function parkUnder(keyHex: string, ownerUserId: number, token: string): string {
  const pendingId = crypto.randomBytes(24).toString('base64url');
  const key = `oauth:pending:${crypto.createHash('sha256').update(pendingId).digest('hex')}`;
  redisStore.set(key, JSON.stringify({ ownerUserId, refreshToken: encryptWith(keyHex, token), scopes: BOTH_SCOPES.split(' ') }));
  return pendingId;
}

const pendingKeys = () => [...redisStore.keys()].filter(k => k.startsWith('oauth:pending:'));

async function saveChoices(tgId: number): Promise<{ status: number; body: Row }> {
  const { NextRequest } = nodeRequire('next/server');
  const route = await load('app/api/select-calendars/route.ts');
  const req = new NextRequest(`http://localhost/api/select-calendars?user_id=${tgId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      initData: initDataFor(tgId),
      calendarAssignments: [{ calendarId: 'me@gmail.com', labels: ['primary', 'yours'], name: 'Me', color: '#039BE5' }],
    }),
  });
  const res = await quietly(() => route.POST(req) as Promise<Response>);
  return { status: res.status, body: await res.json() };
}

async function main() {
  installStubs();
  const { getAllUsers } = await load('src/services/user-service.ts');
  stubAnalytics(); // before google-connect loads, so its activity rows land in activityRows
  const { claimPendingGoogleToken } = await load('src/services/google-connect.ts');

  const EMPTY_CIPHER = encryptWith(A, '');
  const CHOICES = [{ calendarId: 'me@gmail.com', labels: ['primary', 'yours'], name: 'Me', color: '#039BE5' }];

  // ---- getAllUsers: the summary batch's first step ----

  await check('#1 getAllUsers with one row neither key opens returns every user: B and A tokens decrypted, plaintext as it is, \'\' for the bad one, reported once (ids only), nothing written', async () => {
    seed([
      baseUser({ id: 1, name: 'Current', telegramId: BigInt(1001), googleRefreshToken: encryptWith(B, 'tok-current') }),
      baseUser({ id: 2, name: 'Previous', telegramId: BigInt(1002), googleRefreshToken: encryptWith(A, 'tok-previous') }),
      baseUser({ id: 3, name: 'Lost', telegramId: BigInt(1003), googleRefreshToken: encryptWith(C, 'tok-lost') }),
      baseUser({ id: 4, name: 'Legacy', telegramId: BigInt(1004), googleRefreshToken: '1//0gLegacyPlain' }),
    ]);
    const users = await quietly(() => getAllUsers()) as Row[];
    const tokens = Object.fromEntries(users.map(u => [u.id, u.googleRefreshToken]));
    assert(show(tokens) === show({ 1: 'tok-current', 2: 'tok-previous', 3: '', 4: '1//0gLegacyPlain' }), `tokens ${show(tokens)}`);
    // A second read of the bad row is not reported again.
    await quietly(() => getAllUsers());
    const caps = tokenCaptures();
    assert(caps.length === 1 && caps[0].extra?.user_id === 3 && caps[0].extra?.column === 'googleRefreshToken', `captures ${show(captured)}`);
    assert(!show(captured).includes('tok-lost'), 'the token was captured');
    assert(userWrites.length === 0, `writes ${show(userWrites)}`);
  });

  await check('#2 getAllUsers: users with no token (\'\' or an empty cipher) read as \'\' with no capture and no write (review focus 1)', async () => {
    seed([
      baseUser({ id: 5, name: 'Native', telegramId: BigInt(1005), googleRefreshToken: '' }),
      baseUser({ id: 6, name: 'EmptyCipher', telegramId: BigInt(1006), googleRefreshToken: EMPTY_CIPHER }),
    ]);
    const users = await quietly(() => getAllUsers()) as Row[];
    assert(users.length === 2 && users.every(u => u.googleRefreshToken === ''), `tokens ${show(users.map(u => [u.id, u.googleRefreshToken]))}`);
    assert(captured.length === 0, `captures ${show(captured)}`);
    assert(userWrites.length === 0, `writes ${show(userWrites)}`);
  });

  // ---- Connect and reconnect ----

  await check('#3 the OAuth callback and the claim work for a user whose stored token neither key opens: the new token is committed under ENCRYPTION_KEY (B)', async () => {
    seed([baseUser({ id: 9, name: 'Tal Cohen', telegramId: BigInt(TAL_TG), googleRefreshToken: encryptWith(C, 'tok-lost') })]);
    const end = await quietly(() => runCallback(addState(9)));
    assert(end.redirect, `callback ended with ${show(end.threw ?? end.element?.type ?? end)}; ${show(captured)}`);
    const pendingId = new URLSearchParams(end.redirect.split('#')[1] ?? '').get('p') ?? '';
    const claim = await quietly(() => claimPendingGoogleToken(pendingId, { telegramId: TAL_TG })) as Row;
    assert(claim.status === 'connected', `claim ${show(claim)}`);
    const stored = userRow(9).googleRefreshToken;
    assert(decryptWith(B, stored) === 'google-rt-new', 'the committed token does not open with B');
    assert(decryptWith(A, stored) === null && decryptWith(C, stored) === null, 'the committed token opens with an old key');
    assert(tokenCaptures().length === 1 && tokenCaptures()[0].extra?.user_id === 9, `captures ${show(captured)}`);
  });

  await check('#4 a claim parked under the old key (A) connects with KEY=B, PREVIOUS=A, and the token is saved under B', async () => {
    seed([baseUser({ id: 9, name: 'Tal Cohen', telegramId: BigInt(TAL_TG) })]);
    const pendingId = parkUnder(A, 9, 'google-rt-parked');
    activityRows.length = 0;
    const claim = await quietly(() => claimPendingGoogleToken(pendingId, { telegramId: TAL_TG })) as Row;
    assert(claim.status === 'connected', `claim ${show(claim)}`);
    assert(decryptWith(B, userRow(9).googleRefreshToken) === 'google-rt-parked', 'not saved under B');
    assert(activityRows.filter(r => r.startsWith('9:calendar_connected')).join() === '9:calendar_connected {"provider":"google"}', `activity ${show(activityRows)}`);
    assert(captured.every(c => !c.ctx.includes('undecryptable')), `captures ${show(captured)}`);
  });

  await check('#5 a claim parked under a key this server never had (C) answers expired: the entry is used up, captured (oauth-claim-undecryptable, the user id), nothing written', async () => {
    seed([baseUser({ id: 9, name: 'Tal Cohen', telegramId: BigInt(TAL_TG), googleRefreshToken: encryptWith(B, 'tok-kept') })]);
    const before = userRow(9).googleRefreshToken;
    const pendingId = parkUnder(C, 9, 'google-rt-unknown');
    const claim = await quietly(async () => {
      try {
        return await claimPendingGoogleToken(pendingId, { telegramId: TAL_TG });
      } catch (err) {
        return { threw: err instanceof Error ? err.message : String(err) };
      }
    }) as Row;
    assert(show(claim) === show({ status: 'expired' }), `claim ${show(claim)}`);
    assert(pendingKeys().length === 0, 'the entry is still parked');
    const caps = captured.filter(c => c.ctx === 'oauth-claim-undecryptable');
    assert(caps.length === 1 && caps[0].extra?.user_id === 9, `captures ${show(captured)}`);
    assert(userWrites.length === 0 && userRow(9).googleRefreshToken === before, `writes ${show(userWrites)}`);
  });

  // ---- select-calendars: saving choices never writes the token ----

  await check('#6 select-calendars: saving choices leaves a connected user\'s stored token byte for byte; the update carries no googleRefreshToken', async () => {
    seed([baseUser({ id: 9, name: 'Tal Cohen', telegramId: BigInt(TAL_TG), googleRefreshToken: encryptWith(B, 'tok-kept') })]);
    const before = userRow(9).googleRefreshToken;
    const res = await saveChoices(TAL_TG);
    assert(res.status === 200, `status ${res.status} ${show(res.body)} ${show(captured)}`);
    assert(userRow(9).googleRefreshToken === before, 'the stored token changed');
    const updates = userWrites.filter(w => w.hit.includes(9));
    assert(updates.length > 0 && updates.every(w => !('googleRefreshToken' in w.data)), `writes ${show(updates.map(w => Object.keys(w.data)))}`);
  });

  await check('#7 select-calendars: a user whose token neither key opens can still save, and the stored token is left byte for byte (PREVIOUS may open it later)', async () => {
    seed([baseUser({ id: 9, name: 'Tal Cohen', telegramId: BigInt(TAL_TG), googleRefreshToken: encryptWith(C, 'tok-lost') })]);
    const before = userRow(9).googleRefreshToken;
    const res = await saveChoices(TAL_TG);
    assert(res.status === 200, `status ${res.status} ${show(res.body)} ${show(captured)}`);
    assert(userRow(9).googleRefreshToken === before, 'the stored token was overwritten');
  });

  await check('#8 select-calendars: users with no token (\'\' or an empty cipher) save with no capture, and their column is not written (no iv:tag: for \'\') (review focus 1)', async () => {
    seed([
      baseUser({ id: 5, name: 'Native', telegramId: BigInt(1005), googleRefreshToken: '' }),
      baseUser({ id: 6, name: 'EmptyCipher', telegramId: BigInt(1006), googleRefreshToken: EMPTY_CIPHER }),
    ]);
    for (const [id, tg] of [[5, 1005], [6, 1006]]) {
      const before = userRow(id).googleRefreshToken;
      const res = await saveChoices(tg);
      assert(res.status === 200, `user ${id}: status ${res.status} ${show(res.body)}`);
      assert(userRow(id).googleRefreshToken === before, `user ${id}: the column was written`);
    }
    assert(captured.length === 0, `captures ${show(captured)}`);
    const cacheKeys = [...redisStore.keys()].filter(k => k.startsWith('reminders:users'));
    assert(cacheKeys.length === 0, `reminder cache written: ${show(cacheKeys)}`);
  });

  await check('#8b select-calendars: a reminders-on user with a readable token is cached under reminders:users:v2 with the token sealed (never the plaintext, never the legacy key), and the stored column is left byte for byte', async () => {
    const { isEncrypted, openSecret } = await load('src/utils/encryption.ts');
    seed([baseUser({ id: 9, name: 'Tal Cohen', telegramId: BigInt(TAL_TG), remindersEnabled: true, googleRefreshToken: encryptWith(B, 'tok-kept') })]);
    const before = userRow(9).googleRefreshToken;
    const res = await saveChoices(TAL_TG);
    assert(res.status === 200, `status ${res.status} ${show(res.body)} ${show(captured)}`);
    assert(userRow(9).googleRefreshToken === before, 'the stored token changed');
    const raw = redisStore.get('reminders:users:v2') ?? '';
    assert(raw !== '' && !raw.includes('tok-kept'), `v2 holds the plaintext token or is missing: ${raw ? 'present' : '(missing)'}`);
    const entry = (JSON.parse(raw) as Row[]).find(u => u.id === 9);
    assert(!!entry && isEncrypted(entry.googleToken) && openSecret(entry.googleToken) === 'tok-kept' && !('googleRefreshToken' in entry), `entry ${show(entry)}`);
    assert(!redisStore.has('reminders:users'), 'the legacy key was written');
  });

  // ---- The summary's Google choices (calendar-read/google.ts reads liveGoogleChoices) ----

  await check('#9 after getAllUsers, a FamCal (NATIVE) user whose token neither key opens, or who has an empty cipher, has no live Google choices, so the summary makes no Google call; only the unreadable ones are captured; a B token keeps its choices; a legacy GOOGLE-source user with an unreadable token reads as "reconnect" (accepted, Deviation 5) (review focus 1)', async () => {
    const choices = [{ calendarId: 'me@gmail.com', labels: ['primary', 'yours'], name: 'Me', color: '#039BE5' }];
    seed([
      baseUser({ id: 21, name: 'Lost', telegramId: BigInt(1021), googleRefreshToken: encryptWith(C, 'tok-lost'), calendarAssignments: choices }),
      baseUser({ id: 22, name: 'EmptyCipher', telegramId: BigInt(1022), googleRefreshToken: EMPTY_CIPHER, calendarAssignments: choices }),
      baseUser({ id: 23, name: 'Current', telegramId: BigInt(1023), googleRefreshToken: encryptWith(B, 'tok-current'), calendarAssignments: choices }),
      baseUser({ id: 24, name: 'LegacyGoogle', telegramId: BigInt(1024), googleRefreshToken: encryptWith(C, 'tok-lost-2'), calendarAssignments: choices, calendarSource: 'GOOGLE' }),
    ]);
    const { liveGoogleChoices, googleStateOf } = await load('src/lib/google-state.ts');
    const users = await quietly(() => getAllUsers()) as Row[];
    const counts = Object.fromEntries(users.map(u => [u.id, liveGoogleChoices(u).length]));
    assert(show(counts) === show({ 21: 0, 22: 0, 23: 1, 24: 1 }), `live choices ${show(counts)}`);
    const states = Object.fromEntries(users.map(u => [u.id, googleStateOf(u)]));
    assert(show(states) === show({ 21: 'none', 22: 'none', 23: 'connected', 24: 'reconnect' }), `states ${show(states)}`);
    const capturedIds = tokenCaptures().map(c => c.extra?.user_id).sort();
    assert(show(capturedIds) === show([21, 24]), `captures ${show(captured)}`);
    assert(!show(captured).includes('tok-lost'), 'a token was captured');
    assert(userWrites.length === 0, `writes ${show(userWrites)}`);
  });

  // ---- The hourly summary batch ----

  await check('#10 the summary batch (sendDailySummaryToAll over the real getAllUsers) delivers to the good users when one user\'s token neither key opens: that user is still summarized FamCal-only, and no Google token is used', async () => {
    installBatchStubs();
    seed([
      baseUser({ id: 31, name: 'Gita', location: '', weatherEnabled: false, telegramId: BigInt(1031), googleRefreshToken: encryptWith(B, 'tok-good'), calendarAssignments: CHOICES }),
      baseUser({ id: 32, name: 'Boaz', location: '', weatherEnabled: false, telegramId: BigInt(1032), googleRefreshToken: encryptWith(C, 'tok-lost'), calendarAssignments: CHOICES }),
    ]);
    const { sendDailySummaryToAll } = await load('src/services/telegram/summary.ts');
    const result = await quietly(() => sendDailySummaryToAll()) as Row;
    assert(result.processed === 2, `result ${show(result)}; captures ${show(captured)}`);
    // Telegram: each user got their own summary (the good user's came regardless of the bad row).
    const summaries = sent.filter(s => s.via === 'tg.sendMessage').map(s => [String(s.chatId), String(s.text).split('\n')[0]]);
    assert(show(summaries.sort()) === show([['1031', 'Summary for Gita'], ['1032', 'Summary for Boaz']]), `sent ${show(sent)}`);
    // The reads: the good user's Google token and choices reached the reader; the bad user's did not.
    const reads = Object.fromEntries(readCalls.map(r => [String(r.userId), [r.token, r.googleChoices]]));
    assert(show(reads) === show({ 31: ['tok-good', 1], 32: ['', 0] }), `reads ${show(readCalls)}`);
    assert(blockedFetches.length === 0, `network ${show(blockedFetches)}`);
    // Only the unreadable token is reported, once; no batch or user failure; nothing written.
    assert(show(tokenCaptures().map(c => c.extra?.user_id)) === show([32]), `captures ${show(captured)}`);
    assert(captured.every(c => !c.ctx.startsWith('summary-')), `captures ${show(captured)}`);
    assert(!show(captured).includes('tok-'), 'a token was captured');
    assert(userWrites.length === 0, `writes ${show(userWrites)}`);
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

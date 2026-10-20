// Smoke test for "Google becomes a connection" (spec docs/superpowers/specs/2026-10-19-
// google-connection-design.md §7, first bullet; plan Task G1, the server's model switch).
//
// Every user has FamCal, created lazily; Google is an optional connection (a token plus the
// chosen calendars). Nothing gates on User.calendarSource any more:
// - sourcesFor, the union of calendars (FamCal rows, then the Google choices), the FamCal
//   read, hasUsableCalendar and the lazy FamCal main (no primary once Google calendars
//   are chosen, so a Google user's default stays theirs);
// - defaultCalendarFor, and one primary across both lists, cleared only when a save adds it;
// - connecting Google never flips the source or hides FamCal; pairing with a Google user;
// - reminders for a Google user (the plan and Telegram gates kept);
// - one shared calendar limit: over-limit setups kept, blocked only above the limit when a
//   save raises the total;
// - the Google states and the 07:00 nudges (no OAuth track; choose calendars at any age;
//   reconnect for a cleared token with stored calendars), the bot's nudges, the admin;
// - the daily reminder-cache sync and the summary batch take a Google user without a token.
// Task G2, section I: providers by calendar id and the split fetch, where a create goes when
// nothing placed it (and a reminder), the parser's default, and the union in the kid-name
// follow-up and the voice show. The bot's own paths are in smoke-calendar-routing. The WA->TG
// merge carrying a token from a NATIVE W is in smoke-account-merge (its FK-faithful fake).
//
// Real code runs over fakes at the boundaries: Prisma (in memory), Redis (in memory), error
// capture, the admin notifier, the auth checks, Telegram and WhatsApp (record every send),
// and the editor's Google calendar list. No network, no DB.
//
// Run with the fake env runner: scripts/run-smoke.sh scripts/smoke-calendar-connection.ts <TZ>

import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

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
const show = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
const eq = (a: unknown, b: unknown, what: string) => assert(show(a) === show(b), `${what}: ${show(a)} (want ${show(b)})`);

globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network blocked in smoke: ${String(input)}`);
}) as typeof fetch;

// ---- Fake Prisma: in-memory tables ----

let DB: Record<string, Row[]> = {};
const table = (name: string) => (DB[name] ??= []);
const NULLS = new Set<unknown>();
const num = (x: unknown) => (x instanceof Date ? x.getTime() : Number(x));
function norm(v: unknown): unknown {
  return NULLS.has(v) || v === undefined ? null : v;
}
function same(a: unknown, b: unknown): boolean {
  a = norm(a); b = norm(b);
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') return a != null && b != null && String(a) === String(b);
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}
const isPlain = (v: unknown): v is Row =>
  v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && !NULLS.has(v);

function matches(row: Row, where?: Row): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    if (k === 'AND') return ([] as Row[]).concat(cond).every(c => matches(row, c));
    if (k === 'OR') return (cond as Row[]).some(c => matches(row, c));
    if (k === 'NOT') return !([] as Row[]).concat(cond).some(c => matches(row, c));
    const v = row[k];
    if (isPlain(cond)) {
      if ('equals' in cond && !same(v, cond.equals)) return false;
      if ('in' in cond && !(cond.in as unknown[]).some(x => same(v, x))) return false;
      if ('has' in cond && !(Array.isArray(v) && v.includes(cond.has))) return false;
      if ('not' in cond && (isPlain(cond.not) ? matches(row, { [k]: cond.not }) : same(v, cond.not))) return false;
      if ('gt' in cond && !(v != null && num(v) > num(cond.gt))) return false;
      if ('gte' in cond && !(v != null && num(v) >= num(cond.gte))) return false;
      if ('lt' in cond && !(v != null && num(v) < num(cond.lt))) return false;
      if ('lte' in cond && !(v != null && num(v) <= num(cond.lte))) return false;
      return true;
    }
    return same(v, cond);
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
    else row[k] = NULLS.has(v) ? null : v;
  }
}
function ordered(rows: Row[], orderBy?: Row | Row[]): Row[] {
  if (!orderBy) return rows;
  const keys = ([] as Row[]).concat(orderBy).flatMap(o => Object.entries(o));
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const d = num(a[k]) - num(b[k]);
      if (d !== 0) return dir === 'desc' ? -d : d;
    }
    return 0;
  });
}
let seq = 0;
function model(name: string): Row {
  const t = () => table(name);
  const create = (data: Row): Row => {
    const now = new Date(Date.now() + ++seq); // strictly increasing createdAt
    const id = name === 'user' ? Math.max(0, ...t().map(r => Number(r.id))) + 1 : `${name}-${seq}`;
    const row: Row = { id, createdAt: now, updatedAt: now };
    if (name === 'nativeCalendar') Object.assign(row, { color: '#039BE5', labels: [], rules: [], privacy: 'PRIVATE', isDeleted: false, personName: null });
    applyData(row, data);
    t().push(row);
    return row;
  };
  const updateOne = (where: Row, data: Row): Row => {
    const row = t().find(r => matches(r, where));
    if (!row) throw Object.assign(new Error(`No ${name} record was found for an update.`), { code: 'P2025' });
    applyData(row, data);
    row.updatedAt = new Date();
    return row;
  };
  return {
    findUnique: async (a: Row = {}) => pick(t().find(r => matches(r, a.where)), a.select),
    findUniqueOrThrow: async (a: Row = {}) => {
      const row = t().find(r => matches(r, a.where));
      if (!row) throw Object.assign(new Error(`No ${name} found`), { code: 'P2025' });
      return pick(row, a.select);
    },
    findFirst: async (a: Row = {}) => pick(ordered(t().filter(r => matches(r, a.where)), a.orderBy)[0], a.select),
    findMany: async (a: Row = {}) => ordered(t().filter(r => matches(r, a.where)), a.orderBy).map(r => pick(r, a.select)),
    count: async (a: Row = {}) => t().filter(r => matches(r, a.where)).length,
    create: async (a: Row) => pick(create(a.data), a.select),
    update: async (a: Row) => pick(updateOne(a.where, a.data), a.select),
    updateMany: async (a: Row) => {
      const rows = t().filter(r => matches(r, a.where));
      rows.forEach(r => applyData(r, a.data));
      return { count: rows.length };
    },
    upsert: async (a: Row) => {
      const row = t().find(r => matches(r, a.where));
      return row ? pick(updateOne(a.where, a.update), a.select) : pick(create({ ...a.where, ...a.create }), a.select);
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

// ---- Fake Redis ----

const redisStore = new Map<string, string>();
const decode = (raw: string | undefined) => {
  if (raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return raw; }
};
const redisImpl: Row = {
  get: async (k: string) => decode(redisStore.get(k)),
  set: async (k: string, v: unknown, o?: Row) => {
    if (o?.nx && redisStore.has(k)) return null;
    redisStore.set(k, typeof v === 'string' ? v : JSON.stringify(v));
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

// ---- Sends, captures ----

type Sent = { via: string; chatId: unknown; text?: string; options?: Row };
const sent: Sent[] = [];
/** What the bot object (getBot) was asked to send or edit: kid-name answers. */
const botSent: { method: string; args: unknown[] }[] = [];
const captured: string[] = [];
const recorder = (prefix: string): Row =>
  new Proxy({} as Row, {
    get: (_t, p) =>
      typeof p !== 'string' || p === 'then'
        ? undefined
        : async (chatId: unknown, ...rest: unknown[]) => {
            sent.push({ via: `${prefix}.${p}`, chatId, text: typeof rest[0] === 'string' ? rest[0] : undefined, options: rest[1] as Row | undefined });
            return { message_id: 1 };
          },
  });

const botRecorder: Row = new Proxy({} as Row, {
  get: (_t, p) =>
    typeof p !== 'string' || p === 'then'
      ? undefined
      : async (...args: unknown[]) => {
          botSent.push({ method: p, args });
          return { message_id: 1 };
        },
});

/** What the editor's Google calendar list answers next (google-item.ts is faked). */
let googleEditorAnswer: Row = { calendars: [] };
/** The select-calendars page's live Google list (calendar.ts listUserCalendars is faked). */
let googleListed: Row[] = [];
/** The summary's day reads (calendar-read/digest.ts readDigestDay is faked): who, and which calendar ids. */
const summaryReads: { userId: number; ids: string[] }[] = [];

// ---- Module stubs ----

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
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

function installStubs() {
  stub('src/utils/prisma.ts', { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() });
  stub('src/utils/redis.ts', { redis: fakeRedis });
  stub('src/lib/error-capture.ts', {
    captureError: (e: unknown, ctx: string) => { captured.push(`error:${ctx}:${e instanceof Error ? e.message : String(e)}`); },
    captureWarning: (m: string, ctx: string) => { captured.push(`warning:${ctx}:${m}`); },
    captureInfo: () => {},
  });
  stub('src/utils/error-notifier.ts', {
    notifyAdminWarning: async () => {}, notifyAdminError: async () => {}, getAdminUserIds: async () => [], notifyAdminFeedback: async () => {},
  });
  stub('src/lib/rate-limit.ts', {
    settingsRateLimiter: {}, commandRateLimiter: {}, generalRateLimiter: {}, tokenPollRateLimiter: {},
    checkRateLimit: async () => ({ success: true, limit: 99, remaining: 99, reset: 0 }),
    getRateLimitHeaders: () => ({}),
  });
  stub('src/lib/api-auth.ts', {
    verifyUserAuth: async (_req: unknown, userId: string | null) => {
      const { getUserById } = await load('src/services/user-service.ts');
      const user = await getUserById(Number(userId));
      return user ? { success: true, user } : { success: false, response: new Response('{}', { status: 404 }) };
    },
  });
  stub('src/lib/admin-auth.ts', { verifyAdminAccess: async () => ({ authorized: true, adminId: 1 }) });
  const telegram = {
    getMessagingService: () => recorder('tg'), setUserMenuButton: async () => {}, getBot: () => botRecorder, initBot: () => ({}),
    // The daily cron handler's batch; H6 checks only its reminder-cache sync beside it.
    sendDailySummaryToAll: async () => ({ processed: 0, skippedHour: 0, skippedDay: 0, skippedDedup: 0 }),
  };
  stub('src/services/telegram/index.ts', telegram);
  stub('src/services/telegram/bot.ts', telegram);
  stub('src/services/messaging/factory.ts', {
    getMessagingService: () => recorder('msg'), getTelegramService: () => recorder('tg'),
    getWhatsAppService: () => recorder('wa'), detectPlatform: () => 'telegram',
  });
  stub('src/services/calendar-write/google-item.ts', { googleEditorCalendars: async () => googleEditorAnswer });
  stub('src/services/calendar.ts', { ...nodeRequire(path.join(ROOT, 'src/services/calendar.ts')), listUserCalendars: async () => googleListed });
  // The summary's read stops at the read: the smoke checks who is read, with which ids.
  stub('src/services/calendar-read/digest.ts', {
    ...nodeRequire(path.join(ROOT, 'src/services/calendar-read/digest.ts')),
    readDigestDay: async (user: Row, _day: string, _tz: string, ids: string[]) => {
      summaryReads.push({ userId: user.id as number, ids });
      throw new Error('smoke: the read stops here');
    },
  });
}

// ---- Fixtures ----

const DAY = 86_400_000;
const days = (n: number) => new Date(Date.now() + n * DAY);
const TOKENS = { a: '', b: '' };

function baseUser(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', culture: 'default',
    locationForced: false, messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null,
    calendarSource: 'NATIVE', pairingId: null, remindersEnabled: false, suspendedAt: null, suspendedBy: null,
    suspendedReason: null, unreachableSince: null, whatsappPhone: null, whatsappBsuid: null, telegramId: null,
    isAdmin: false, globalRules: [], textSummaryEnabled: true, voiceSummaryEnabled: true, voiceInputEnabled: false,
    voicePreference: 'default', voiceStyle: 'natural', weatherEnabled: true, includeWeeklyInLookahead: false,
    includeLookaheadInTomorrow: false, lookaheadAlways7Days: false, preferredMorningHour: 7, preferredEveningHour: 19,
    dailySummaryDays: [0, 1, 2, 3, 4, 5, 6], tomorrowSummaryDays: [0, 1, 2, 3, 4, 5, 6], defaultReminderMinutes: null,
    pickupRemindersEnabled: true, reminderStartAt: null, createdAt: days(-400), updatedAt: days(-1),
    ...o,
  };
}
const cal = (id: string, ownerUserId: number, name: string, o: Row = {}): Row => ({
  id, ownerUserId, name, color: '#039BE5', labels: [], rules: [], privacy: 'PRIVATE', isDeleted: false, personName: null,
  personEnglishName: null, personGender: null, createdAt: days(-300 + Number(id.replace(/\D/g, '') || 0)), updatedAt: days(-20), ...o,
});
const gcal = (calendarId: string, labels: string[], name = calendarId) => ({ calendarId, labels, name, color: '#4285F4' });
const subscription = (userId: number, plan = 'FREE') => ({
  id: `sub-${userId}`, userId, plan, status: 'ACTIVE', trialStartedAt: days(-100), trialEndsAt: days(-86),
  currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, compedBy: null, compedAt: null, compReason: null,
  createdAt: days(-100), updatedAt: days(-100),
});

// Users: 1 Nava (FamCal, paired with 2), 2 Pele (partner), 3 Gil (legacy Google, FamCal hidden,
// Google primary), 4 Hila (legacy Google, no primary, token), 5 Omri (legacy Google, token cleared,
// calendars stored), 6 Tami (FamCal, connected Google, chose none yet).
function seed() {
  DB = {};
  redisStore.clear();
  sent.length = 0;
  botSent.length = 0;
  captured.length = 0;
  googleEditorAnswer = { calendars: [] };
  DB.user = [
    baseUser({ id: 1, name: 'Nava', telegramId: BigInt(5550001), pairingId: 'pair-12' }),
    baseUser({ id: 2, name: 'Pele', telegramId: BigInt(5550002), pairingId: 'pair-12' }),
    baseUser({ id: 3, name: 'Gil', telegramId: BigInt(5550003), calendarSource: 'GOOGLE', googleRefreshToken: TOKENS.a,
      calendarAssignments: [gcal('gil@gmail.com', ['primary', 'yours'], 'Gil'), gcal('kids@group.calendar.google.com', ['kids'], 'Kids')] }),
    baseUser({ id: 4, name: 'Hila', telegramId: BigInt(5550004), calendarSource: 'GOOGLE', googleRefreshToken: TOKENS.b,
      calendarAssignments: [gcal('kids4@group.calendar.google.com', ['kids'], 'Kids'), gcal('hila@gmail.com', ['yours'], 'Hila')] }),
    baseUser({ id: 5, name: 'Omri', telegramId: BigInt(5550005), calendarSource: 'GOOGLE', googleRefreshToken: '',
      calendarAssignments: [gcal('omri@gmail.com', ['primary', 'yours'], 'Omri')] }),
    baseUser({ id: 6, name: 'Tami', telegramId: BigInt(5550006), googleRefreshToken: TOKENS.a, calendarAssignments: null }),
  ];
  DB.pairing = [{ id: 'pair-12', status: 'ACTIVE', inviterUserId: 1, inviteeUserId: 2, acceptedAt: days(-50), createdAt: days(-50) }];
  DB.nativeCalendar = [
    cal('cal-1', 1, 'Nava', { labels: ['primary', 'yours'], privacy: 'SHARED_EDITOR' }),
    cal('cal-2', 2, 'Pele', { labels: ['primary', 'yours'], privacy: 'SHARED_EDITOR' }),
    cal('cal-3', 3, 'Gil old', { labels: ['primary', 'yours'], isDeleted: true }),
    cal('cal-6', 6, 'Tami', { labels: ['primary', 'yours'] }),
    cal('cal-7', 1, 'Nava kids', { labels: ['kids'], privacy: 'SHARED_EDITOR' }),
  ];
  DB.subscription = [1, 2, 3, 4, 5, 6].map(id => subscription(id));
  DB.usageCounter = [];
  DB.userFeatureOverride = [];
  DB.adminSettings = [{ id: 'global', earlyAdoptionMode: false, nativeRemindersEnabled: true, remindersEnabled: true }];
  redisStore.set('early_adoption:global_enabled', 'false');
  redisStore.set('nrem:enabled', 'true');
  for (const id of [1, 2, 3, 4, 5, 6]) redisStore.set(`feature:access:${id}:reminders`, JSON.stringify({ allowed: true }));
}
const userRow = (id: number) => table('user').find(u => u.id === id) as Row;
const calsOf = (ownerUserId: number) => table('nativeCalendar').filter(c => c.ownerUserId === ownerUserId);
const live = (ownerUserId: number) => calsOf(ownerUserId).filter(c => !c.isDeleted);
async function configOf(id: number): Promise<Row> {
  const { getUserById } = await load('src/services/user-service.ts');
  return getUserById(id);
}

async function route(rel: string, method: string, userId: number, body?: Row, params?: Row): Promise<{ status: number; body: Row }> {
  const mod = await load(rel);
  const { NextRequest } = await import('next/server');
  const req = new NextRequest(`https://famcal.test/api/x?user_id=${userId}`, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const res: Response = await mod[method](req, params ? { params: Promise.resolve(params) } : undefined);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  installStubs();
  const { Prisma } = await import('@prisma/client');
  for (const v of [Prisma.JsonNull, Prisma.DbNull, Prisma.AnyNull]) NULLS.add(v);
  const { encrypt } = await load('src/utils/encryption.ts');
  TOKENS.a = encrypt('google-rt-a');
  TOKENS.b = encrypt('google-rt-b');

  // ---- A. The pure rules ----

  await check('A1 sourcesFor: FamCal for everyone, plus Google with a token, whatever calendarSource says', async () => {
    const { sourcesFor } = await load('src/services/calendar-read/index.ts');
    const got = [
      sourcesFor({ calendarSource: 'NATIVE', googleRefreshToken: '' }),
      sourcesFor({ calendarSource: 'NATIVE', googleRefreshToken: 'rt' }),
      sourcesFor({ calendarSource: 'GOOGLE', googleRefreshToken: '' }),
      sourcesFor({ calendarSource: 'GOOGLE', googleRefreshToken: 'rt' }),
    ];
    eq(got, [['famcal'], ['famcal', 'google'], ['famcal'], ['famcal', 'google']], 'sourcesFor');
  });

  await check('A2 defaultCalendarFor: own primary (Google over FamCal), else the first Google "yours", else the first Google, else the FamCal main (null); partner rows never count', async () => {
    const { defaultCalendarFor } = await load('src/utils/calendar-helpers.ts');
    const famPrimary = { calendarId: 'native:a', labels: ['primary', 'yours'], name: 'A', color: '' };
    const famKids = { calendarId: 'native:k', labels: ['kids'], name: 'K', color: '' };
    const partner = { calendarId: 'native:p', labels: ['spouse'], name: 'P', color: '' };
    const gPrimary = { calendarId: 'g@x', labels: ['primary', 'yours'], name: 'G', color: '' };
    const gKids = { calendarId: 'kids@g', labels: ['kids'], name: 'GK', color: '' };
    const gYours = { calendarId: 'me@g', labels: ['yours'], name: 'GY', color: '' };
    eq(defaultCalendarFor([famPrimary, famKids, gKids, gPrimary]), 'g@x', 'both primary');
    eq(defaultCalendarFor([famPrimary, gKids, gYours]), 'native:a', 'FamCal primary only');
    eq(defaultCalendarFor([partner, gKids, gYours]), 'me@g', 'Google-only, no primary: first yours');
    eq(defaultCalendarFor([partner, gKids]), 'kids@g', 'Google-only, no yours: first Google');
    eq(defaultCalendarFor([partner, famKids]), null, 'no Google, no own primary: the FamCal main');
    eq(defaultCalendarFor([]), null, 'nothing: the FamCal main');
  });

  await check('A3 googleStateOf: never connected, choose calendars, reconnect (token cleared, calendars stored), connected', async () => {
    const { googleStateOf } = await load('src/lib/google-state.ts');
    eq([
      googleStateOf({ googleRefreshToken: '', calendarAssignments: null }),
      googleStateOf({ googleRefreshToken: '', calendarAssignments: [] }),
      googleStateOf({ googleRefreshToken: 'rt', calendarAssignments: null }),
      googleStateOf({ googleRefreshToken: 'rt', calendarAssignments: [] }),
      googleStateOf({ googleRefreshToken: '', calendarAssignments: [gcal('a', ['yours'])] }),
      googleStateOf({ googleRefreshToken: 'rt', calendarAssignments: [gcal('a', ['yours'])] }),
    ], ['none', 'none', 'choose', 'choose', 'reconnect', 'connected'], 'states');
  });

  await check('A4 calendarTotal: own FamCal plus Google, the FamCal main not counted once Google calendars are chosen', async () => {
    const { calendarTotal } = await load('src/services/subscription-service.ts');
    eq([calendarTotal(1, 0), calendarTotal(2, 0), calendarTotal(1, 2), calendarTotal(3, 2), calendarTotal(0, 2)], [1, 2, 2, 4, 2], 'totals');
  });

  // ---- B. The union, the FamCal read, the lazy main ----

  await check('B1 getCalendarAssignmentsForUser: FamCal rows (own and the partner\'s shared) first, then the Google choices, for a FamCal user who connected Google', async () => {
    seed();
    Object.assign(userRow(1), { googleRefreshToken: TOKENS.a, calendarAssignments: [gcal('nava@gmail.com', ['yours'], 'Nava G')] });
    const { getCalendarAssignmentsForUser } = await load('src/services/calendar-provider/user-calendars.ts');
    const got = await getCalendarAssignmentsForUser(await configOf(1));
    eq(got.map((a: Row) => a.calendarId), ['native:cal-1', 'native:cal-2', 'native:cal-7', 'nava@gmail.com'], 'order');
    eq(got[1].labels, ['spouse'], 'partner row labelled from the viewer side');
  });

  await check('B2 a legacy Google user: usable by Google alone; once the FamCal main is made (lazily, by reminders), the union is it, then the Google choices; hidden FamCal calendars stay hidden', async () => {
    seed();
    const { hasUsableCalendar, getCalendarAssignmentsForUser } = await load('src/services/calendar-provider/user-calendars.ts');
    const { getMainNativeCalendar } = await load('src/services/native-calendar/event-store.ts');
    assert(await hasUsableCalendar(await configOf(3)), 'not usable');
    await getMainNativeCalendar(3);
    const got = await getCalendarAssignmentsForUser(await configOf(3));
    const main = live(3);
    assert(main.length === 1 && main[0].id !== 'cal-3', `live FamCal ${show(calsOf(3))}`);
    eq(got.map((a: Row) => a.calendarId), [`native:${main[0].id}`, 'gil@gmail.com', 'kids@group.calendar.google.com'], 'order');
    assert(calsOf(3).find(c => c.id === 'cal-3')?.isDeleted === true, 'the hidden calendar came back');
  });

  await check('B3 the lazy FamCal main: labels ["yours"] when the user has Google choices (with or without a primary), ["primary","yours"] with none; once only', async () => {
    seed();
    table('user').push(baseUser({ id: 7, name: 'Yoni', telegramId: BigInt(5550007) }));
    const { ensurePrimaryNativeCalendar } = await load('src/services/native-calendar/onboarding.ts');
    await ensurePrimaryNativeCalendar(3); // Gil: Google primary
    await ensurePrimaryNativeCalendar(4); // Hila: Google choices, no primary
    await ensurePrimaryNativeCalendar(4);
    await ensurePrimaryNativeCalendar(7); // Yoni: no Google choices
    eq(live(3).map(c => c.labels), [['yours']], 'Gil');
    eq(live(4).map(c => c.labels), [['yours']], 'Hila');
    eq(live(7).map(c => c.labels), [['primary', 'yours']], 'Yoni');
  });

  await check('B6 a Google user with no primary keeps the first Google "yours" as the default once the FamCal main exists (the union, and the editor preselects it)', async () => {
    seed();
    const { getCalendarAssignmentsForUser } = await load('src/services/calendar-provider/user-calendars.ts');
    const { defaultCalendarFor } = await load('src/utils/calendar-helpers.ts');
    const { editorInfo } = await load('src/services/calendar-write/item-info.ts');
    eq(defaultCalendarFor(await getCalendarAssignmentsForUser(await configOf(4))), 'hila@gmail.com', 'before the FamCal main');
    googleEditorAnswer = { calendars: [
      { id: 'kids4@group.calendar.google.com', name: 'Kids', color: '#4285F4', main: false, mine: true },
      { id: 'hila@gmail.com', name: 'Hila', color: '#4285F4', main: false, mine: true },
    ] };
    const info = await editorInfo(await configOf(4), 'Asia/Jerusalem'); // makes the FamCal main
    assert(live(4).length === 1, `FamCal ${show(calsOf(4))}`);
    eq(defaultCalendarFor(await getCalendarAssignmentsForUser(await configOf(4))), 'hila@gmail.com', 'after the FamCal main');
    eq(info.calendars.filter((c: Row) => c.main).map((c: Row) => c.id), ['hila@gmail.com'], 'editor main');
  });

  await check('B4 hasUsableCalendar: a Google user with no token (and no FamCal yet) has FamCal', async () => {
    seed();
    Object.assign(userRow(5), { calendarAssignments: null });
    const { hasUsableCalendar } = await load('src/services/calendar-provider/user-calendars.ts');
    assert(await hasUsableCalendar(await configOf(5)), 'not usable');
    assert(live(5).length === 1, `FamCal ${show(calsOf(5))}`);
  });

  await check('B5 readFamcal reads a legacy Google user\'s FamCal (no "not a built-in calendar user" error)', async () => {
    seed();
    table('nativeCalendar').push(cal('cal-9', 3, 'Gil', { labels: ['yours'] }));
    const { readFamcal } = await load('src/services/calendar-read/famcal.ts');
    const got = await readFamcal(await configOf(3), { from: days(0), to: days(1) }, {});
    assert(got.read.status === 'ok', `status ${got.read.status}: ${got.read.cause}`);
    eq(got.read.calendars.map((c: Row) => c.id), ['native:cal-9'], 'legend');
  });

  // ---- C. Connect, pairing ----

  await check('C1 commitGoogleToken: the token is saved; the user stays NATIVE, keeps every FamCal calendar, and the reminder cache is not told GOOGLE', async () => {
    seed();
    Object.assign(userRow(1), { remindersEnabled: true });
    const { commitGoogleToken } = await load('src/services/google-connect.ts');
    await commitGoogleToken(1, 'google-rt-new');
    const u = userRow(1);
    assert(u.calendarSource === 'NATIVE', `calendarSource ${u.calendarSource}`);
    assert(u.googleRefreshToken && u.googleRefreshToken !== 'google-rt-new', 'token not saved encrypted');
    eq(live(1).map(c => c.id), ['cal-1', 'cal-7'], 'FamCal calendars');
    const cached = decode(redisStore.get('reminders:users')) as Row[] | null;
    const entry = cached?.find(c => c.id === 1);
    assert(entry && entry.googleRefreshToken === 'google-rt-new' && entry.calendarSource !== 'GOOGLE', `cache ${show(entry)}`);
  });

  await check('C2 pairing with a Google user: a legacy Google user invites, a FamCal user accepts; both are paired and their FamCal calendars shared', async () => {
    seed();
    Object.assign(userRow(1), { pairingId: null });
    Object.assign(userRow(2), { pairingId: null });
    table('pairing').length = 0;
    table('nativeCalendar').push(cal('cal-9', 3, 'Gil', { labels: ['yours'] }));
    const { createInvite, acceptInvite } = await load('src/services/pairing-service.ts');
    const invite = await createInvite(3);
    const result = await acceptInvite(invite.token, 1);
    assert(userRow(3).pairingId === result.pairing.id && userRow(1).pairingId === result.pairing.id, `pairing ${userRow(3).pairingId} ${userRow(1).pairingId}`);
    assert(calsOf(3).find(c => c.id === 'cal-9')?.privacy === 'SHARED_EDITOR', 'Gil\'s FamCal calendar not shared');
    assert(calsOf(3).find(c => c.id === 'cal-3')?.isDeleted === true, 'a hidden calendar came back');
  });

  await check('C3 the pair and calendars pages and the pair API serve a Google user (no notNative notice)', async () => {
    seed();
    const { loadPageData } = await load('src/lib/page-data.ts');
    const user = await configOf(3);
    const calendars = await loadPageData('calendars', user, 5550003, 'en');
    const pair = await loadPageData('pair', user, 5550003, 'en');
    assert(calendars.kind === 'props', `calendars ${show(calendars)}`);
    assert(pair.kind === 'props', `pair ${show(pair)}`);
    assert(calendars.props.initialCalendars.length === 1 && live(3).length === 1, `the FamCal main ${show(calendars.props.initialCalendars)}`);
    const api = await route('app/api/pair/route.ts', 'GET', 3);
    assert(api.status === 200 && api.body.native !== false, `pair API ${show(api)}`);
  });

  // ---- D. Reminders ----

  await check('D1 reminders for a Google user: supported on Telegram with the plan; no Telegram and a plan without reminders still say no', async () => {
    seed();
    const { getReminderSupport } = await load('src/services/native-reminders/support.ts');
    const ok = await getReminderSupport(await configOf(3));
    const noTg = await getReminderSupport({ ...(await configOf(3)), telegramId: null });
    redisStore.set('feature:access:4:reminders', JSON.stringify({ allowed: false }));
    const noPlan = await getReminderSupport(await configOf(4));
    eq([ok, noTg.reason, noPlan.reason], [{ supported: true }, 'no_telegram', 'no_access'], 'support');
  });

  await check('D2 a reminder for a Google partner: the partner can be reminded, and owns it', async () => {
    const { effectiveOwnerId } = await load('src/services/native-reminders/ownership.ts');
    const { partnerCanRemind } = await load('src/services/calendar-write/item-info.ts');
    const partner = { id: 3, name: 'Gil', englishName: '', gender: 'male', telegramId: BigInt(5550003), language: 'en', calendarSource: 'GOOGLE' };
    eq(effectiveOwnerId({ creatorUserId: 1, forUserId: 3 }, partner), 3, 'owner');
    eq(partnerCanRemind({ viewerId: 1, partner }), true, 'canRemind');
  });

  // ---- E. The calendar limit ----

  await check('E1 checkCalendarLimit: one shared total, blocked only above the limit and when the save raises it (FREE: 3)', async () => {
    seed();
    const { checkCalendarLimit } = await load('src/services/subscription-service.ts');
    // Nava: 2 own FamCal, no Google -> current 2
    const a = await checkCalendarLimit(1, 3); // a third: allowed (> not >=)
    const b = await checkCalendarLimit(1, 4);
    // Gil: no live FamCal, 2 Google -> current 2; then over the limit with 5 Google
    Object.assign(userRow(3), { calendarAssignments: ['a', 'b', 'c', 'd', 'e'].map(id => gcal(id, ['yours'])) });
    const c = await checkCalendarLimit(3, 5); // the same over-limit set: kept
    const d = await checkCalendarLimit(3, 4); // fewer: kept
    const e = await checkCalendarLimit(3, 6);
    eq([a.allowed, b.allowed, c.allowed, d.allowed, e.allowed], [true, false, true, true, false], 'allowed');
  });

  await check('E2 the save routes count the shared total: a FamCal POST over a Google set, a select-calendars re-save of an over-limit set', async () => {
    seed();
    // Tami: FamCal main + 3 Google = 3 (the main skipped); a 2nd FamCal calendar makes 4
    Object.assign(userRow(6), { calendarAssignments: ['a', 'b', 'c'].map(id => gcal(`${id}@g`, id === 'a' ? ['yours'] : ['kids'])) });
    const post = await route('app/api/native-calendars/route.ts', 'POST', 6, { name: 'Work' });
    // Hila: 4 Google, no FamCal yet (over the limit): re-saving 4 is fine, a 5th is not
    const four = ['a', 'b', 'c', 'd'].map((id, i) => gcal(`${id}@g`, i === 0 ? ['yours'] : ['kids']));
    Object.assign(userRow(4), { calendarAssignments: four });
    const resave = await route('app/api/select-calendars/route.ts', 'POST', 4, { calendarAssignments: four });
    const five = await route('app/api/select-calendars/route.ts', 'POST', 4, { calendarAssignments: [...four, gcal('e@g', ['kids'])] });
    eq([post.status, post.body.error, resave.status, five.status], [403, 'calendar_limit_reached', 200, 403], 'statuses');
  });

  await check('E3 select-calendars page: the Google allowance leaves room for the counted FamCal calendars, and names the FamCal primary for the note', async () => {
    seed();
    googleListed = [{ id: 'tami@gmail.com', name: 'Tami', primary: true, accessRole: 'owner' }];
    table('nativeCalendar').push(cal('cal-8', 6, 'Work', { labels: ['kids'] }));
    const { loadPageData } = await load('src/lib/page-data.ts');
    const page = await loadPageData('select-calendars', await configOf(6), 5550006, 'en');
    assert(page.kind === 'props', show(page));
    eq([page.props.calendarLimit, page.props.famcalPrimaryName], [2, 'Tami'], 'allowance and note');
  });

  // ---- F. One primary across both lists ----

  await check('F1 select-calendars: ticking primary on a Google calendar clears the FamCal primary (yours kept); the partner\'s calendar is untouched', async () => {
    seed();
    Object.assign(userRow(1), { googleRefreshToken: TOKENS.a, calendarAssignments: [gcal('nava@gmail.com', ['yours'], 'Nava G')] });
    const res = await route('app/api/select-calendars/route.ts', 'POST', 1, { calendarAssignments: [gcal('nava@gmail.com', ['primary', 'yours'], 'Nava G')] });
    assert(res.status === 200, show(res));
    eq(calsOf(1).find(c => c.id === 'cal-1')?.labels, ['yours'], 'FamCal main');
    eq(calsOf(2).find(c => c.id === 'cal-2')?.labels, ['primary', 'yours'], 'partner');
  });

  await check('F2 [guard] select-calendars: a save that keeps primary where it was never touches FamCal (a legacy double primary stays)', async () => {
    seed();
    table('nativeCalendar').push(cal('cal-9', 3, 'Gil', { labels: ['primary', 'yours'] }));
    const stored = userRow(3).calendarAssignments;
    const toggled = [stored[0], { ...stored[1], labels: ['birthdays'] }];
    const res = await route('app/api/select-calendars/route.ts', 'POST', 3, { calendarAssignments: toggled });
    assert(res.status === 200, show(res));
    eq(calsOf(3).find(c => c.id === 'cal-9')?.labels, ['primary', 'yours'], 'FamCal');
  });

  await check('F3 [guard] FamCal PATCH: renaming a primary calendar (labels resent as they were) leaves the Google primary', async () => {
    seed();
    table('nativeCalendar').push(cal('cal-9', 3, 'Gil', { labels: ['primary', 'yours'] }));
    const res = await route('app/api/native-calendars/[id]/route.ts', 'PATCH', 3, { name: 'Gil home', labels: ['primary', 'yours'] }, { id: 'cal-9' });
    assert(res.status === 200, show(res));
    eq(userRow(3).calendarAssignments[0].labels, ['primary', 'yours'], 'Google primary');
  });

  await check('F4 FamCal PATCH adding primary clears it from the Google choices and from the user\'s other FamCal calendars', async () => {
    seed();
    table('nativeCalendar').push(cal('cal-9', 3, 'Gil', { labels: ['primary', 'yours'] }), cal('cal-10', 3, 'Gil 2', { labels: ['yours'] }));
    const res = await route('app/api/native-calendars/[id]/route.ts', 'PATCH', 3, { labels: ['primary', 'yours'] }, { id: 'cal-10' });
    assert(res.status === 200, show(res));
    eq(userRow(3).calendarAssignments.map((a: Row) => a.labels), [['yours'], ['kids']], 'Google');
    eq(calsOf(3).filter(c => !c.isDeleted).map(c => [c.id, c.labels]), [['cal-9', ['yours']], ['cal-10', ['primary', 'yours']]], 'FamCal');
  });

  await check('F5 FamCal POST: a Google user may create a FamCal calendar; one created primary clears the other primaries', async () => {
    seed();
    const res = await route('app/api/native-calendars/route.ts', 'POST', 3, { name: 'Home', labels: ['primary', 'yours'] });
    assert(res.status === 200, show(res));
    eq(userRow(3).calendarAssignments[0].labels, ['yours'], 'Google primary');
  });

  // ---- G. The Google states, the nudges ----

  await check('G1 the 07:00 nudges: choose calendars for a token with none chosen (at any age), reconnect for a cleared token with stored calendars, no OAuth track', async () => {
    seed();
    for (const id of [1, 2, 3, 4, 6]) userRow(id).location = 'Tel Aviv';
    // Tami (token, none chosen) and Omri (token cleared, calendars stored) were first seen in that state days ago
    redisStore.set('setup:start:6:calendars', String(days(-4).getTime()));
    redisStore.set('setup:start:5:reconnect', String(days(-2).getTime()));
    table('user').push(baseUser({ id: 7, name: 'Yael', telegramId: BigInt(5550007), calendarSource: 'GOOGLE', createdAt: days(-2) }));
    const { handleSetupReminders } = await load('src/cron/handlers.ts');
    await handleSetupReminders();
    const to = (id: number) => sent.filter(s => String(s.chatId) === String(5550000 + id));
    const urlOf = (s: Sent) => s.options?.replyMarkup?.inline_keyboard?.[0]?.[0]?.web_app?.url ?? '';
    assert(to(6).length === 1 && urlOf(to(6)[0]).includes('/select-calendars'), `Tami ${show(to(6))}`);
    assert(to(5).length === 1 && urlOf(to(5)[0]).includes('/refresh-token'), `Omri ${show(to(5))}`);
    assert(to(7).length === 0 && to(1).length === 0, `Yael/Nava ${show([...to(7), ...to(1)])}`);
    assert(![...redisStore.keys()].some(k => k.includes(':oauth:')), 'an oauth attempt was recorded');
  });

  await check('G2 the Google tracks start when the cron first sees the state: no nudge that day, the start is kept', async () => {
    seed();
    for (const id of [1, 2, 3, 4, 6]) userRow(id).location = 'Tel Aviv';
    const { handleSetupReminders } = await load('src/cron/handlers.ts');
    await handleSetupReminders();
    assert(sent.length === 0, `sent ${show(sent)}`);
    assert(redisStore.has('setup:start:6:calendars') && redisStore.has('setup:start:5:reconnect'), `keys ${[...redisStore.keys()]}`);
  });

  await check('G3 a fresh connect restarts the Google tracks (commitGoogleToken clears their start and attempts)', async () => {
    seed();
    redisStore.set('setup:start:5:reconnect', String(days(-20).getTime()));
    redisStore.set('setup:reminder:5:reconnect:0', '1');
    redisStore.set('setup:start:5:calendars', String(days(-20).getTime()));
    const { commitGoogleToken } = await load('src/services/google-connect.ts');
    await commitGoogleToken(5, 'google-rt-again');
    assert(![...redisStore.keys()].some(k => /^setup:(start|reminder):5:(reconnect|calendars)/.test(k)), `keys ${[...redisStore.keys()]}`);
  });

  await check('G4 the location nudge goes to every user without one, a Google user without a token too', async () => {
    seed();
    for (const id of [1, 2, 3, 4, 5, 6]) Object.assign(userRow(id), { location: 'Tel Aviv', createdAt: days(-400) });
    Object.assign(userRow(5), { location: '', createdAt: days(-6), calendarAssignments: null });
    const { handleSetupReminders } = await load('src/cron/handlers.ts');
    await handleSetupReminders();
    const omri = sent.filter(s => String(s.chatId) === '5550005');
    assert(omri.length === 1 && String(omri[0].options?.replyMarkup?.inline_keyboard?.[0]?.[0]?.web_app?.url).includes('/settings'), show(omri));
  });

  await check('G5 the bot\'s command nudge never asks a Google user to connect or choose calendars; a missing location still nudges', async () => {
    seed();
    const { sendSetupNudgeIfNeeded } = await load('src/services/telegram/commands.ts');
    const { MessagingPlatform } = await load('src/services/messaging/types.ts');
    const svc = recorder('cmd');
    const omri = await configOf(5);
    const blocked = await sendSetupNudgeIfNeeded(omri, 5550005, svc, MessagingPlatform.TELEGRAM);
    const noLocation = await sendSetupNudgeIfNeeded({ ...omri, location: '' }, 5550005, svc, MessagingPlatform.TELEGRAM);
    eq([blocked, noLocation, sent.length], [false, true, 1], 'nudges');
  });

  // ---- H. Reminder cache, editor, admin ----

  await check('H1 the settings save caches a Google user without a token for event alerts (FamCal has them)', async () => {
    seed();
    const res = await route('app/api/settings/route.ts', 'POST', 5, { remindersEnabled: true });
    assert(res.status === 200, show(res));
    const cached = decode(redisStore.get('reminders:users')) as Row[] | null;
    assert(cached?.some(c => c.id === 5), `cache ${show(cached)}`);
  });

  await check('H2 the editor info is the union: FamCal kinds, partner and calendars plus the writable Google rows; main follows defaultCalendarFor', async () => {
    seed();
    Object.assign(userRow(1), { googleRefreshToken: TOKENS.a, calendarAssignments: [gcal('nava@gmail.com', ['primary', 'yours'], 'Nava G')] });
    googleEditorAnswer = { calendars: [{ id: 'nava@gmail.com', name: 'Nava G', color: '#4285F4', main: false, mine: true }] };
    const { editorInfo } = await load('src/services/calendar-write/item-info.ts');
    const info = await editorInfo(await configOf(1), 'Asia/Jerusalem');
    eq(info.calendars.map((c: Row) => [c.id, c.main]), [['native:cal-1', false], ['native:cal-7', false], ['native:cal-2', false], ['nava@gmail.com', true]], 'calendars');
    eq([info.kinds, info.partner?.name, info.partner?.canRemind], [{ event: true, reminder: true }, 'Pele', true], 'kinds/partner');
  });

  await check('H3 a failed Google calendar list drops only the Google rows; a legacy Google user gets the FamCal main row (made lazily, the default while the Google one is unlisted) and reminders', async () => {
    seed();
    googleEditorAnswer = { calendars: [], failure: 'token' };
    const { editorInfo } = await load('src/services/calendar-write/item-info.ts');
    const info = await editorInfo(await configOf(3), 'Asia/Jerusalem');
    eq(info.calendars.map((c: Row) => [c.id.startsWith('native:'), c.main]), [[true, true]], 'rows');
    eq(info.kinds, { event: true, reminder: true }, 'kinds');
  });

  await check('H4 admin: the user card counts both kinds and badges Google by token; the nudge offered follows the Google state', async () => {
    seed();
    const { NextRequest } = await import('next/server');
    const { GET } = await load('app/api/admin/user-overrides/route.ts');
    const card = async (id: number) => (await (await GET(new NextRequest(`https://famcal.test/api/admin/user-overrides?user_id=${id}&initData=x`))).json()).user;
    const nava = await card(1); // 2 FamCal, no Google
    const tami = await card(6); // FamCal main, token, none chosen
    const omri = await card(5); // cleared token, 1 stored
    eq([nava.calendarsCount, nava.registrationStatus.hasOAuth, nava.registrationStatus.applicableReminder], [2, false, null], 'Nava');
    eq([tami.registrationStatus.hasOAuth, tami.registrationStatus.applicableReminder], [true, 'calendars'], 'Tami');
    eq([omri.calendarsCount, omri.registrationStatus.applicableReminder], [1, 'reconnect'], 'Omri');
    assert(!('oauth' in nava.setupReminders) && !('calendarSource' in nava.registrationStatus), show(nava));
  });

  await check('H5 admin send-reminder: oauth is gone; calendars and reconnect go to anyone (by token state)', async () => {
    seed();
    const { POST } = await load('app/api/admin/send-reminder/route.ts');
    const { NextRequest } = await import('next/server');
    const send = async (user_id: number, reminder_type: string) =>
      (await POST(new NextRequest('https://famcal.test/api/admin/send-reminder', { method: 'POST', body: JSON.stringify({ initData: 'x', user_id, reminder_type }) }))).status;
    eq([await send(6, 'oauth'), await send(6, 'calendars'), await send(5, 'reconnect')], [400, 200, 200], 'statuses');
    const omri = sent.find(s => String(s.chatId) === '5550005');
    assert(String(omri?.options?.replyMarkup?.inline_keyboard?.[0]?.[0]?.web_app?.url).includes('/refresh-token'), show(omri));
  });

  await check('H6 the daily run\'s reminder-cache sync takes a Google user without a token (FamCal alerts), beside the Google and FamCal users', async () => {
    seed();
    for (const id of [1, 4, 5]) userRow(id).remindersEnabled = true;
    const { handleDailySummary } = await load('src/cron/handlers.ts');
    await handleDailySummary();
    const cached = decode(redisStore.get('reminders:users')) as Row[] | null;
    eq((cached ?? []).map(c => c.id).sort(), [1, 4, 5], 'cached users');
  });

  await check('H7 the summary batch serves a Google user without a token: the token-less skip is gone, the gate counts the union (FamCal only here), and the read asks for FamCal then the Google choices', async () => {
    seed();
    table('user').push(baseUser({ id: 7, name: 'Yoni', telegramId: BigInt(5550007), calendarSource: 'GOOGLE', location: '' }));
    DB.user = table('user').filter(u => [5, 7].includes(u.id as number));
    table('nativeCalendar').push(cal('cal-5', 5, 'Omri', { labels: ['yours'] }), cal('cal-77', 7, 'Yoni', { labels: ['primary', 'yours'] }));
    for (const id of [5, 7]) redisStore.set(`tz:user:${id}`, 'Asia/Jerusalem');
    summaryReads.length = 0;
    const { sendDailySummaryToAll } = await load('src/services/telegram/summary.ts');
    await sendDailySummaryToAll();
    eq(summaryReads, [
      { userId: 5, ids: ['native:cal-5', 'omri@gmail.com'] },
      { userId: 7, ids: ['native:cal-77'] },
    ], 'reads');
  });

  await check('G6 an unreachable user (blocked the bot) gets no 07:00 nudge: not reconnect, not choose calendars, not location', async () => {
    seed();
    for (const id of [1, 2, 3, 4]) userRow(id).location = 'Tel Aviv';
    Object.assign(userRow(5), { unreachableSince: days(-90) }); // reconnect, start 2 days ago
    Object.assign(userRow(6), { unreachableSince: days(-90), location: 'Tel Aviv' }); // choose, start 4 days ago
    redisStore.set('setup:start:6:calendars', String(days(-4).getTime()));
    redisStore.set('setup:start:5:reconnect', String(days(-2).getTime()));
    table('user').push(baseUser({ id: 8, name: 'Dov', telegramId: BigInt(5550008), location: '', createdAt: days(-6), unreachableSince: days(-1) }));
    const { handleSetupReminders } = await load('src/cron/handlers.ts');
    await handleSetupReminders();
    assert(sent.length === 0, `sent ${show(sent)}`);
  });

  await check('H8 admin switch-platform clears every setup track key (reconnect attempts and the Google starts too)', async () => {
    seed();
    const { setupTrackKeys } = await load('src/services/setup-tracks.ts');
    for (const k of setupTrackKeys(5) as string[]) redisStore.set(k, '1');
    const { POST } = await load('app/api/admin/switch-platform/route.ts');
    const { NextRequest } = await import('next/server');
    const res = await POST(new NextRequest('https://famcal.test/api/admin/switch-platform', {
      method: 'POST', body: JSON.stringify({ initData: 'x', user_id: 5, whatsapp_phone: '+15550000005' }),
    }));
    assert(res.status === 200, `status ${res.status}`);
    const left = [...redisStore.keys()].filter(k => /^setup:(start|reminder):5:/.test(k));
    eq(left, [], 'keys left');
  });

  // ---- I. Providers by calendar id (Task G2, spec §3 and §4 Providers) ----

  /** Runs `fn` with the two providers' fetches replaced, then puts the real ones back. */
  async function withFetches(native: (ids: string[]) => Promise<Row[]>, google: (ids: string[]) => Promise<Row[]>, fn: () => Promise<void>) {
    const { nativeProvider } = await load('src/services/calendar-provider/native-provider.ts');
    const { googleProvider } = await load('src/services/calendar-provider/google-provider.ts');
    const real = [nativeProvider.fetchEventsInRange, googleProvider.fetchEventsInRange];
    nativeProvider.fetchEventsInRange = (_u: Row, ids: string[]) => native(ids);
    googleProvider.fetchEventsInRange = (_u: Row, ids: string[]) => google(ids);
    try {
      await fn();
    } finally {
      [nativeProvider.fetchEventsInRange, googleProvider.fetchEventsInRange] = real;
    }
  }
  const MIXED = ['native:cal-1', 'native:cal-7', 'nava@gmail.com', 'kids@group.calendar.google.com'];

  await check('I1 providerForCalendar: a native: id goes to FamCal, every other id (the literal primary too) to Google', async () => {
    const { providerForCalendar } = await load('src/services/calendar-provider/index.ts');
    eq(['native:cal-1', 'nava@gmail.com', 'kids@group.calendar.google.com', 'primary'].map(id => providerForCalendar(id).name), ['native', 'google', 'google', 'google'], 'providers');
  });

  await check('I2 the split fetch: each provider is asked for its own ids only; FamCal events, then Google, and no failed half', async () => {
    seed();
    const { fetchEventsInRange } = await load('src/services/calendar-provider/index.ts');
    const asked: string[] = [];
    await withFetches(
      async ids => { asked.push(`native ${ids.join(',')}`); return [{ eventId: 'n1' }]; },
      async ids => { asked.push(`google ${ids.join(',')}`); return [{ eventId: 'g1' }]; },
      async () => {
        const got = await fetchEventsInRange(await configOf(1), MIXED, days(0), days(1));
        eq({ events: got.events.map((e: Row) => e.eventId), failed: got.failed }, { events: ['n1', 'g1'], failed: [] }, 'result');
      },
    );
    eq(asked.sort(), ['google nava@gmail.com,kids@group.calendar.google.com', 'native native:cal-1,native:cal-7'], 'asked');
  });

  await check('I3 the split fetch: a failed half is reported (Sentry) and named in failed, never thrown; the other half\'s events stay', async () => {
    seed();
    const { fetchEventsInRange } = await load('src/services/calendar-provider/index.ts');
    const user = await configOf(1);
    let googleDown: Row = {};
    await withFetches(async () => [{ eventId: 'n1' }], async () => { throw new Error('GOOGLE_TOKEN_EXPIRED'); }, async () => {
      googleDown = await fetchEventsInRange(user, MIXED, days(0), days(1));
    });
    let famcalDown: Row = {};
    await withFetches(async () => { throw new Error('db down'); }, async () => [{ eventId: 'g1' }], async () => {
      famcalDown = await fetchEventsInRange(user, MIXED, days(0), days(1));
    });
    eq([googleDown.events.map((e: Row) => e.eventId), googleDown.failed], [['n1'], ['google']], 'Google down');
    eq([famcalDown.events.map((e: Row) => e.eventId), famcalDown.failed], [['g1'], ['famcal']], 'FamCal down');
    assert(captured.some(c => c.startsWith('error:calendar-provider-fetch:GOOGLE_TOKEN_EXPIRED')) && captured.some(c => c.startsWith('error:calendar-provider-fetch:db down')), `captured ${show(captured)}`);
  });

  await check('I4 [guard-ish] the split fetch asks no provider for an empty half: FamCal ids only never reach Google', async () => {
    seed();
    const { fetchEventsInRange } = await load('src/services/calendar-provider/index.ts');
    const asked: string[] = [];
    await withFetches(async () => { asked.push('native'); return []; }, async () => { asked.push('google'); return []; }, async () => {
      await fetchEventsInRange(await configOf(1), ['native:cal-1'], days(0), days(1));
    });
    eq(asked, ['native'], 'asked');
  });

  await check('I5 createCalendarFor: a placed event keeps its calendar; an unplaced one takes the default (Google for Google users, FamCal primary otherwise); a reminder always the FamCal main', async () => {
    seed();
    const { createCalendarFor } = await load('src/services/calendar-provider/index.ts');
    const got = [
      await createCalendarFor(await configOf(4), { calendarId: 'kids4@group.calendar.google.com' }),
      await createCalendarFor(await configOf(1), {}),
      await createCalendarFor(await configOf(4), {}),
      await createCalendarFor(await configOf(3), { calendarId: '' }),
    ];
    eq(got, ['kids4@group.calendar.google.com', 'native:cal-1', 'hila@gmail.com', 'gil@gmail.com'], 'events');
    const reminder = await createCalendarFor(await configOf(3), { calendarId: 'gil@gmail.com', kind: 'reminder' });
    eq([reminder, live(3).length], [`native:${live(3)[0]?.id}`, 1], 'reminder: on the FamCal main, made lazily');
    eq(await createCalendarFor(await configOf(1), { calendarId: 'native:cal-1', kind: 'reminder' }), 'native:cal-1', 'a reminder already on FamCal');
  });

  await check('I6 the parser: an unmatched calendar is the default of the union (not calendars[0]); a match is kept', async () => {
    seed();
    const { getMainNativeCalendar } = await load('src/services/native-calendar/event-store.ts');
    await getMainNativeCalendar(4);
    const { getCalendarAssignmentsForUser } = await load('src/services/calendar-provider/user-calendars.ts');
    const { parseGeminiEventResponse } = await load('src/services/voice/gemini-voice.ts');
    const hila = await getCalendarAssignmentsForUser(await configOf(4));
    assert(hila[0].calendarId.startsWith('native:'), `fixture: Hila's union starts with ${hila[0].calendarId}`);
    const nava = await getCalendarAssignmentsForUser(await configOf(1));
    const parse = (calendarId: string, calendars: Row[]) => parseGeminiEventResponse({
      intent: 'create', confidence: 'high',
      event: { title: 'Dentist', startDate: '2026-10-21', startTime: '10:00', endDate: '2026-10-21', endTime: '11:00', calendarId, calendarName: '' },
    }, calendars, 'Asia/Jerusalem').event;
    eq([parse('nope', hila).calendarId, parse('nope', hila).calendarName], ['hila@gmail.com', 'Hila'], 'Hila (Google, no primary)');
    eq(parse('nope', nava).calendarId, 'native:cal-1', 'Nava (FamCal primary)');
    eq(parse('kids4@group.calendar.google.com', hila).calendarId, 'kids4@group.calendar.google.com', 'a match');
  });

  await check('I7 the parser: a reminder never takes a Google calendar; with reminders off it is an ordinary event in the default calendar', async () => {
    seed();
    const { getMainNativeCalendar } = await load('src/services/native-calendar/event-store.ts');
    await getMainNativeCalendar(3);
    const { getCalendarAssignmentsForUser } = await load('src/services/calendar-provider/user-calendars.ts');
    const { parseGeminiEventResponse } = await load('src/services/voice/gemini-voice.ts');
    const gil = await getCalendarAssignmentsForUser(await configOf(3));
    const json = { intent: 'create', confidence: 'high', event: { kind: 'reminder', title: 'Call mom', startDate: '2026-10-21', startTime: '20:00', endTime: '20:30' } };
    const on = parseGeminiEventResponse(json, gil, 'Asia/Jerusalem', true).event;
    assert(on.kind === 'reminder' && !(on.calendarId ?? '').includes('@'), `reminder on ${on.calendarId}`);
    const off = parseGeminiEventResponse(json, gil, 'Asia/Jerusalem', false).event;
    eq([off.kind, off.calendarId], [undefined, 'gil@gmail.com'], 'reminders off');
  });

  await check('I8 kid-name follow-up reads the union: a FamCal kids calendar\'s child and the partner are known, a new name is asked', async () => {
    seed();
    Object.assign(table('nativeCalendar').find(c => c.id === 'cal-7') as Row, { personName: 'Noa' });
    const { detectUnknownKidName } = await load('src/services/kid-name-detection.ts');
    const ev = (summary: string, calendarId: string) => ({ summary, start: '2026-10-21', end: '2026-10-22', calendarId, calendarName: 'x' });
    const got = await detectUnknownKidName([ev('Swim - Noa', 'native:cal-7'), ev('Lunch - Pele', 'native:cal-2'), ev('Ballet - Tom', 'native:cal-7')], await configOf(1));
    eq(got?.name, 'Tom', 'candidate');
  });

  await check('I9 kid-name "yes" on a FamCal calendar names its person (NativeCalendar.personName), with the FamCal copy and the calendars page; a partner\'s calendar is left alone', async () => {
    seed();
    const { handleKidNameCallback } = await load('src/services/kid-name-callbacks.ts');
    redisStore.set('kidname:pending:kn:1:1', JSON.stringify({ name: 'Tom', calendarId: 'native:cal-7', userId: 1 }));
    await handleKidNameCallback(5550001, 9, 'q', 'kidname_yes', 'kn:1:1');
    eq((table('nativeCalendar').find(c => c.id === 'cal-7') as Row).personName, 'Tom', 'personName');
    const edit = botSent.find(b => b.method === 'editMessageText');
    const { getBotMessages } = await load('src/lib/bot-messages.ts');
    const t = await getBotMessages('en');
    const want = String(t.kidNameDetection.confirmedFamcal).replace('{calendar}', 'Nava kids').replace('{name}', 'Tom');
    assert(edit && edit.args[0] === want, `edit ${show(edit?.args[0])} (want ${show(want)})`);
    assert(show(edit.args[1]).includes('/en/calendars?user_id=5550001'), `link ${show(edit.args[1])}`);
    redisStore.set('kidname:pending:kn:1:2', JSON.stringify({ name: 'Ido', calendarId: 'native:cal-2', userId: 1 }));
    await handleKidNameCallback(5550001, 9, 'q', 'kidname_yes', 'kn:1:2');
    eq((table('nativeCalendar').find(c => c.id === 'cal-2') as Row).personName, null, 'the partner\'s calendar');
  });

  await check('I11 kid-name "yes" on an own FamCal calendar not labelled kids (unlabelled, birthdays) writes the rule with the plain copy, never personName', async () => {
    seed();
    table('nativeCalendar').push(cal('cal-9', 1, 'Family'), cal('cal-10', 1, 'Birthdays', { labels: ['birthdays'] }));
    const { handleKidNameCallback } = await load('src/services/kid-name-callbacks.ts');
    const { getBotMessages } = await load('src/lib/bot-messages.ts');
    const t = await getBotMessages('en');
    for (const [id, name] of [['cal-9', 'Family'], ['cal-10', 'Birthdays']]) {
      botSent.length = 0;
      redisStore.set(`kidname:pending:kn:${id}`, JSON.stringify({ name: 'Noa', calendarId: `native:${id}`, userId: 1 }));
      await handleKidNameCallback(5550001, 9, 'q', 'kidname_yes', `kn:${id}`);
      const row = table('nativeCalendar').find(c => c.id === id) as Row;
      eq([row.personName, row.rules], [null, ['Noa is my child']], name);
      const edit = botSent.find(b => b.method === 'editMessageText');
      const want = String(t.kidNameDetection.confirmed).replace('{calendar}', name).replace('{name}', 'Noa');
      assert(edit && edit.args[0] === want, `${name}: edit ${show(edit?.args[0])} (want ${show(want)})`);
    }
  });

  await check('I10 the voice show reads the union for a Google user too (it named nobody before)', async () => {
    seed();
    const { resolveShowCalendars } = await load('src/services/voice-show/context.ts');
    const got = await resolveShowCalendars(await configOf(3));
    eq(got?.map((c: Row) => c.calendarId), ['gil@gmail.com', 'kids@group.calendar.google.com'], 'Gil (no FamCal yet)');
    const nava = await resolveShowCalendars(await configOf(1));
    eq(nava?.map((c: Row) => c.calendarId), ['native:cal-1', 'native:cal-2', 'native:cal-7'], 'Nava');
  });

  // ---- Report ----
  const failed = results.filter(r => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
  if (captured.length) console.log(`captured: ${captured.length}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

// Smoke test for what the [locale] pages hand out before anyone has proved who they
// are. The server never sees Telegram initData and the pages used to load private data
// for any ?user_id: the pair page even carried the live invite token, which grants
// editor access to the inviter's calendars. A page now renders no user data; the data
// comes from one authenticated POST to /api/page-data, which answers with the props, a
// locale redirect, a notice, or 401/403/404.
//
// The pages, the page-data route, user-service, pairing-service and subscription-service
// run for real. Faked at the boundaries: Prisma (in memory, every call counted), Redis
// (in memory), the rate limiter (always allows), Telegram and messaging (record every
// send), error capture, the Google Calendar list (counted) and fetch (blocked). No
// network, no DB.
//
// The Settings page's week start (#6d): Settings answers with where the person's week starts
// (the home's rule over the home's zone lookup), so the summary-day chips start there. The
// real timezone module runs, with its 2 s wait cut to 30 ms, over a place lookup and a Redis
// the smoke controls.
//
// Review fix (#9): the dead /oauth-success route looked a user up by the URL's Telegram
// id with no credential and showed their name.
//
// The dashboard branch (calendar-home spec §7.1, §7.3; Plan D, Task D7; #11-#14): the
// dashboard's props are the calendar home's own (the empty state's hints, lookahead7) and
// each load logs one webapp_opened activity. The two hint gates (getReminderSupport,
// checkFeatureAccess) and the activity log run for real over the fakes, the gates inside
// recorders.

// Every check here fails until the fix lands. Numbers follow the design's smoke list.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-page-auth.ts

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
  get: async (k: string) => {
    if (k === redisReadFails) throw new Error('redis read failed in smoke');
    return decode(redisStore.get(k));
  },
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
/** When set, the stubbed Google calendar list throws this message (#10). */
let googleListError: string | null = null;
/** What the stubbed place lookup answers (#6d): an IANA zone, or 'hang' until releaseGeocode is called. */
let geocodeZone = 'Europe/London';
let releaseGeocode: (() => void) | null = null;
/** When set, the fake Redis throws on a read of this key (#6d): a timezone lookup that fails. */
let redisReadFails: string | null = null;
/** The calendar home's hint gates as called: `<feature>(<user id>)`, and getReminderSupport's user ids (#11-#14). */
const featureChecks: string[] = [];
const supportChecks: number[] = [];
/** When set, checkFeatureAccess throws for this feature (#14). */
let featureError: string | null = null;
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
  // Google: the calendar list is the only Google call a page makes.
  stub('src/services/calendar.ts', {
    ...nodeRequire(path.join(ROOT, 'src/services/calendar.ts')),
    listUserCalendars: async (refreshToken: string) => {
      googleCalls.push(`listUserCalendars(${refreshToken})`);
      if (googleListError) throw new Error(googleListError);
      return [{ id: 'CAL-SECRET-google@group.calendar.google.com', name: 'CAL-SECRET-google', description: '', primary: false, accessRole: 'writer', backgroundColor: '#123456' }];
    },
  });
  // The place lookup behind a person's zone answers the zone the smoke sets, or hangs until it is released (#6d).
  stub('src/services/weather/geocoding.ts', {
    ...nodeRequire(path.join(ROOT, 'src/services/weather/geocoding.ts')),
    geocodeLocation: async () => {
      const hang = geocodeZone === 'hang';
      if (hang) await new Promise<void>((resolve) => { releaseGeocode = resolve; });
      return { latitude: 0, longitude: 0, timezone: hang ? 'Europe/London' : geocodeZone };
    },
  });
  // The real timezone module (its cache, its lookups, its race), with the pages' 2 s wait cut to 30 ms so a lookup that never answers does not hold the smoke.
  const realTimezone = nodeRequire(path.join(ROOT, 'src/lib/timezone.ts'));
  stub('src/lib/timezone.ts', { ...realTimezone, timezoneWithin: (user: Row) => realTimezone.timezoneWithin(user, 30) });
  // The calendar home's hint gates run for real inside recorders. The support module loads
  // after the wrapped subscription service, so its own 'reminders' check is recorded too.
  const subscriptionService = nodeRequire(path.join(ROOT, 'src/services/subscription-service.ts'));
  stub('src/services/subscription-service.ts', {
    ...subscriptionService,
    checkFeatureAccess: async (userId: number, feature: string) => {
      featureChecks.push(`${feature}(${userId})`);
      if (featureError === feature) throw new Error(`feature check failed in smoke: ${feature}`);
      return subscriptionService.checkFeatureAccess(userId, feature);
    },
    // The hint's quiet read: recorded the same way, answered by the real one.
    peekFeatureAccess: async (userId: number, feature: string) => {
      featureChecks.push(`${feature}(${userId})`);
      if (featureError === feature) throw new Error(`feature check failed in smoke: ${feature}`);
      return subscriptionService.peekFeatureAccess(userId, feature);
    },
  });
  const reminderSupport = nodeRequire(path.join(ROOT, 'src/services/native-reminders/support.ts'));
  stub('src/services/native-reminders/support.ts', {
    ...reminderSupport,
    getReminderSupport: async (user: Row, options?: Row) => {
      supportChecks.push(Number(user.id));
      return reminderSupport.getReminderSupport(user, options);
    },
  });
  globalThis.fetch = (async (input: unknown) => {
    googleCalls.push(`fetch ${String(input)}`);
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
    textSummaryEnabled: true, voiceSummaryEnabled: false, weatherEnabled: true,
    preferredMorningHour: 7, preferredEveningHour: 20, dailySummaryDays: [0, 1, 2, 3, 4, 5, 6], tomorrowSummaryDays: [0, 1, 2, 3, 4, 5, 6],
    createdAt: new Date(Date.now() - 30 * DAY), updatedAt: new Date(Date.now() - DAY),
    ...o,
  };
}

/**
 * 1 = Dana, Telegram 5550001, Hebrew, NATIVE, paired with 3 and holding an open invite
 * (both visible at once, so one render shows both leaks). 4 = Gina, Telegram 8880004,
 * GOOGLE. 9 = Tal, Telegram 111111111. 42 = WhatsApp-only, Russian. Everything private
 * carries "SECRET".
 */
function seed() {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  prismaCalls.length = 0;
  googleCalls.length = 0;
  googleListError = null;
  featureChecks.length = 0;
  supportChecks.length = 0;
  featureError = null;
  geocodeZone = 'Europe/London';
  redisReadFails = null;
  sent.length = 0;
  captured.length = 0;
  DB.user = [
    baseUser({ id: 1, name: 'Dana', telegramId: BigInt(5550001), language: 'he', location: 'LOC-SECRET-1', pairingId: 'pair-1' }),
    baseUser({ id: 3, name: 'PARTNER-SECRET-NAME', telegramId: BigInt(5550003), language: 'he', pairingId: 'pair-1' }),
    baseUser({
      id: 4, name: 'Gina', telegramId: BigInt(8880004), calendarSource: 'GOOGLE', location: 'LOC-SECRET-4',
      googleRefreshToken: 'google-rt-test',
      calendarAssignments: [{ calendarId: 'CAL-SECRET-mine@gmail.com', labels: ['primary', 'yours'], name: 'CAL-SECRET-mine', color: '#000000', rules: ['CAL-SECRET-rule'] }],
    }),
    baseUser({ id: 9, name: 'Tal', telegramId: BigInt(111111111) }),
    baseUser({ id: 42, name: 'WA-User', language: 'ru', location: 'LOC-SECRET-42', messagingPlatform: 'whatsapp', whatsappBsuid: 'IL.123' }),
  ];
  DB.pairing = [{
    id: 'pair-1', status: 'ACTIVE', inviterUserId: 1, inviteeUserId: 3, acceptedAt: new Date(Date.now() - 3 * DAY),
    unlinkedAt: null, unlinkedByUserId: null, createdAt: new Date(Date.now() - 4 * DAY),
  }];
  DB.pairingInvite = [{
    id: 'inv-1', token: INVITE_TOKEN, inviterUserId: 1, expiresAt: new Date(Date.now() + 6 * DAY),
    acceptedAt: null, acceptedByUserId: null, revokedAt: null, createdAt: new Date(Date.now() - DAY),
  }];
  const cal = (id: string, ownerUserId: number, name: string, o: Row = {}): Row => ({
    id, ownerUserId, name, color: '#336699', labels: ['kids'], privacy: 'PRIVATE', isDeleted: false,
    personName: null, personEnglishName: null, personGender: null, rules: [], createdAt: new Date(Date.now() - 9 * DAY), ...o,
  });
  DB.nativeCalendar = [
    cal('cal-1', 1, 'CAL-SECRET-dana', { personName: 'KID-SECRET', rules: ['KID-SECRET-rule'] }),
    cal('cal-3', 3, 'CAL-SECRET-partner', { privacy: 'SHARED_EDITOR' }),
    cal('cal-4', 4, 'CAL-SECRET-gina-native'),
    cal('cal-42', 42, 'CAL-SECRET-wa'),
  ];
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

async function fullBody(res: Response): Promise<string> {
  try { return JSON.stringify(await res.clone().json()); } catch { return '(non-json)'; }
}

/** The body, cut short for a failure message. */
async function bodyOf(res: Response): Promise<string> {
  const text = await fullBody(res);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/** Call a page server component as Next does. A redirect or notFound comes back as `thrown`. */
async function callPage(rel: string, locale: string, userId: string): Promise<{ el?: unknown; thrown?: string }> {
  const page = (await load(rel)).default;
  try {
    return { el: await page({ params: Promise.resolve({ locale }), searchParams: Promise.resolve({ user_id: userId }) }) };
  } catch (err) {
    return { thrown: String((err as Row)?.digest ?? (err instanceof Error ? err.message : err)) };
  }
}

/** The element tree as the RSC payload would carry it: client props included. */
function serialize(value: unknown): string {
  try {
    return JSON.stringify(value, (k, v) => {
      if (k.startsWith('_')) return undefined;
      if (typeof v === 'bigint') return `${v}n`;
      if (v instanceof Set) return [...v];
      if (v instanceof Map) return Object.fromEntries(v);
      if (typeof v === 'function') return `[fn ${v.name}]`;
      return v;
    }) ?? '';
  } catch (err) {
    return `(unserializable: ${err instanceof Error ? err.message : String(err)})`;
  }
}

/** Server-render the element inside the providers the app layout gives a client page. */
function renderHtml(el: unknown, locale: string): string {
  const React = nodeRequire('react');
  const { renderToString } = nodeRequire('react-dom/server');
  const { NextIntlClientProvider } = nodeRequire('next-intl');
  const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
  const noop = () => undefined;
  const router = { push: noop, replace: noop, refresh: noop, prefetch: noop, back: noop, forward: noop };
  const messages = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${locale}.json`), 'utf8'));
  try {
    return renderToString(
      React.createElement(AppRouterContext.Provider, { value: router },
        React.createElement(NextIntlClientProvider, { locale, messages, timeZone: 'Asia/Jerusalem' }, el)),
    );
  } catch (err) {
    return `(render failed: ${err instanceof Error ? err.message : String(err)})`;
  }
}

async function main() {
  installStubs();

  const { NextRequest } = nodeRequire('next/server');
  const { createSessionToken } = await load('src/lib/session-auth.ts');
  const waCookie = `famcal_session=${createSessionToken(42)}`;

  const req = (url: string, o: { body?: unknown; cookie?: string } = {}) =>
    new NextRequest(`http://localhost${url}`, {
      method: o.body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(o.cookie ? { cookie: o.cookie } : {}) },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
  const pageData = async (body: Row, cookie?: string): Promise<Response> => {
    const { POST } = await load('app/api/page-data/route.ts');
    return POST(req('/api/page-data', { body, cookie }));
  };

  // ---- The pages themselves render no user data ----

  await check('#1 /he/pair?user_id=1 with no credential: neither the props nor the HTML carry the invite token or the partner', async () => {
    seed();
    const r = await callPage('app/[locale]/(app)/pair/page.tsx', 'he', '1');
    const props = r.thrown ?? serialize(r.el);
    const html = r.el ? renderHtml(r.el, 'he') : '';
    const leaks: string[] = [];
    for (const [label, secret] of [['invite token', INVITE_TOKEN], ['partner name', 'PARTNER-SECRET-NAME']]) {
      if (props.includes(secret)) leaks.push(`props carry the ${label}`);
      if (html.includes(secret)) leaks.push(`HTML carries the ${label}`);
    }
    assert(leaks.length === 0, leaks.join('; '));
  });

  await check('#2 dashboard, settings, calendars, select-calendars, subscription: no private data, no Prisma or Google call', async () => {
    const pages: [string, string, string][] = [
      ['dashboard', 'en', '8880004'],
      ['settings', 'he', '5550001'],
      ['calendars', 'he', '5550001'],
      ['select-calendars', 'en', '8880004'],
      ['subscription', 'he', '5550001'],
    ];
    const problems: string[] = [];
    for (const [name, locale, userId] of pages) {
      seed();
      try {
        const r = await callPage(`app/[locale]/(app)/${name}/page.tsx`, locale, userId);
        const out = r.thrown ?? serialize(r.el);
        const secrets = [...new Set(out.match(/[A-Z]+-SECRET[\w@.-]*/g) ?? [])];
        if (secrets.length) problems.push(`${name} carries ${secrets.join(', ')}`);
        if (prismaCalls.length) problems.push(`${name} made ${prismaCalls.length} Prisma calls`);
        if (googleCalls.length) problems.push(`${name} called Google: ${googleCalls.join(', ')}`);
      } catch (err) {
        problems.push(`${name} threw ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  // ---- /api/page-data: one authenticated POST ----

  await check('#3 page-data pair with no credential is 401', async () => {
    seed();
    const res = await pageData({ page: 'pair', user_id: 1, locale: 'he' });
    assert(res.status === 401, `status ${res.status} ${await bodyOf(res)}`);
    assert(!(await fullBody(res)).includes(INVITE_TOKEN), 'the 401 carries the invite token');
  });

  await check('#4 page-data pair with the owner\'s initData is 200 and carries the invite token', async () => {
    seed();
    const res = await pageData({ page: 'pair', user_id: 5550001, locale: 'he', initData: initDataFor(5550001) });
    assert(res.status === 200, `status ${res.status} ${await bodyOf(res)}`);
    assert((await fullBody(res)).includes(INVITE_TOKEN), `no invite token in ${await bodyOf(res)}`);
  });

  await check('#5 page-data pair with another user\'s initData and user_id=1 is 401', async () => {
    seed();
    const res = await pageData({ page: 'pair', user_id: 1, locale: 'he', initData: initDataFor(111111111) });
    assert(res.status === 401, `status ${res.status} ${await bodyOf(res)}`);
    assert(!(await fullBody(res)).includes(INVITE_TOKEN), 'the response carries the invite token');
  });

  await check('#6 page-data settings on the WA cookie: the props carry row 42\'s location', async () => {
    seed();
    const res = await pageData({ page: 'settings', user_id: 42, locale: 'ru' }, waCookie);
    assert(res.status === 200, `status ${res.status} ${await bodyOf(res)}`);
    assert((await fullBody(res)).includes('LOC-SECRET-42'), `no row 42 location in ${await bodyOf(res)}`);
  });

  await check('#6b page-data settings: the props carry the pause switch as the row has it, on and off', async () => {
    for (const want of [true, false]) {
      seed();
      Object.assign(DB.user.find((u: Row) => u.id === 42) as Row, { pauseOnShabbat: want });
      const res = await pageData({ page: 'settings', user_id: 42, locale: 'ru' }, waCookie);
      assert(res.status === 200 && (await fullBody(res)).includes(`"pauseOnShabbat":${want}`), `switch ${want}: ${await bodyOf(res)}`);
    }
  });

  await check('#6c page-data settings: the props carry the zmanim community as the row has it', async () => {
    for (const want of ['sephardi', 'ashkenazi', 'chabad']) {
      seed();
      Object.assign(DB.user.find((u: Row) => u.id === 42) as Row, { zmanimCommunity: want });
      const res = await pageData({ page: 'settings', user_id: 42, locale: 'ru' }, waCookie);
      assert(res.status === 200 && (await fullBody(res)).includes(`"zmanimCommunity":"${want}"`), `community ${want}: ${await bodyOf(res)}`);
    }
  });

  await check('#6c2 page-data settings: the props carry "Address me as" (currentSettings.gender) as the row has it, male or female; a row holding anything else reads as male, as the voice show reads it', async () => {
    for (const [stored, want] of [['female', 'female'], ['male', 'male'], ['', 'male'], ['other', 'male']] as const) {
      seed();
      Object.assign(DB.user.find((u: Row) => u.id === 42) as Row, { gender: stored });
      const res = await pageData({ page: 'settings', user_id: 42, locale: 'ru' }, waCookie);
      assert(res.status === 200, `status ${res.status} ${await bodyOf(res)}`);
      const body = await fullBody(res);
      const gender = body.match(/"currentSettings":\{[^}]*?"gender":"(\w+)"/)?.[1];
      assert(gender === want, `stored ${JSON.stringify(stored)}: the props say ${gender} (want ${want}) in ${await bodyOf(res)}`);
    }
  });

  await check('#6d page-data settings: the props carry where the person\'s week starts, beside currentSettings and never in it: Jewish culture Sunday; else the zone of their place decides over the language (London Monday even in Hebrew, New York Sunday even in Russian); no place at all follows the language; a lookup that never answers or fails still gives the page at once, by the language, and is captured', async () => {
    const show = (value: unknown) => JSON.stringify(value);
    const { REDIS_KEYS } = await load('src/config/redis-keys.ts');
    /** Row 42 as `row` says, asked for its Settings with the place lookup behaving as `how`. */
    const ask = async (row: Row, how: { zone?: string; hang?: boolean; readFails?: boolean } = {}) => {
      seed();
      Object.assign(DB.user.find((u: Row) => u.id === 42) as Row, row);
      geocodeZone = how.hang ? 'hang' : how.zone ?? 'Europe/London';
      redisReadFails = how.readFails ? REDIS_KEYS.userTimezone(42) : null;
      const started = Date.now();
      // A page that waits for a lookup that never answers would end this smoke silently (nothing left to run): the guard turns that into a failure
      let guard: ReturnType<typeof setTimeout> | undefined;
      const stuck = new Promise<null>((resolve) => { guard = setTimeout(() => resolve(null), 3000); });
      const answered = await Promise.race([pageData({ page: 'settings', user_id: 42, locale: row.language }, waCookie), stuck]);
      clearTimeout(guard);
      const took = Date.now() - started;
      // Let a hanging lookup finish, so no lookup is left running for the next case to join
      releaseGeocode?.();
      releaseGeocode = null;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (answered === null) return { status: 0, props: {} as Row, took, text: 'the page did not answer in 3 s', zoneCaptures: [] as string[] };
      const res = answered;
      const text = await fullBody(res);
      const props = JSON.parse(text).props ?? {};
      return { status: res.status, props, took, text, zoneCaptures: captured.filter((c) => c.startsWith('settings-timezone')) };
    };
    const problems: string[] = [];
    const expectWeekStart = (label: string, got: Awaited<ReturnType<typeof ask>>, want: number) => {
      if (got.status !== 200 || got.props.weekStart !== want) problems.push(`${label}: wanted ${want}, got ${got.status} ${show(got.props.weekStart)} ${got.text.slice(0, 120)}`);
      if ('weekStart' in (got.props.currentSettings ?? {})) problems.push(`${label}: weekStart is inside currentSettings`);
    };

    expectWeekStart('Jewish culture, London, Russian', await ask({ culture: 'jewish', language: 'ru' }), 0);
    expectWeekStart('London, English', await ask({ culture: 'default', language: 'en' }), 1);
    expectWeekStart('London, Hebrew', await ask({ culture: 'default', language: 'he' }), 1);
    expectWeekStart('New York, Russian', await ask({ culture: 'default', language: 'ru' }, { zone: 'America/New_York' }), 0);
    expectWeekStart('Cairo, English', await ask({ culture: 'default', language: 'en' }, { zone: 'Africa/Cairo' }), 6);
    // No place and no Google: the zone is only the fallback, so the language decides, whatever the lookup would say
    expectWeekStart('no place, Russian', await ask({ culture: 'default', language: 'ru', location: '' }, { zone: 'America/New_York' }), 1);
    expectWeekStart('no place, Hebrew', await ask({ culture: 'default', language: 'he', location: '' }, { zone: 'Europe/London' }), 0);

    // A lookup that never answers: the page is not held, the language decides, and it is captured
    for (const [language, want] of [['ru', 1], ['he', 0], ['en', 0]] as const) {
      const late = await ask({ culture: 'default', language }, { hang: true });
      expectWeekStart(`no answer, ${language}`, late, want);
      if (late.took > 1000) problems.push(`no answer, ${language}: the page waited ${late.took} ms`);
      if (show(late.zoneCaptures) !== show(['settings-timezone: The timezone lookup took over 2000 ms'])) problems.push(`no answer, ${language}: captured ${show(late.zoneCaptures)}`);
    }
    // A lookup that fails: the same, and the error is the one captured
    for (const [language, want] of [['ru', 1], ['he', 0]] as const) {
      const failed = await ask({ culture: 'default', language }, { readFails: true });
      expectWeekStart(`failed lookup, ${language}`, failed, want);
      if (show(failed.zoneCaptures) !== show(['settings-timezone: redis read failed in smoke'])) problems.push(`failed lookup, ${language}: captured ${show(failed.zoneCaptures)}`);
    }
    // A quick answer captures nothing
    const quick = await ask({ culture: 'default', language: 'en' });
    if (quick.zoneCaptures.length) problems.push(`a quick lookup captured ${show(quick.zoneCaptures)}`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#7 page-data settings in the wrong locale: a redirect to /ru/settings?user_id=42, no props', async () => {
    seed();
    const res = await pageData({ page: 'settings', user_id: 42, locale: 'he' }, waCookie);
    const body = await fullBody(res);
    assert(body.includes('redirect') && body.includes('/ru/settings?user_id=42'), `status ${res.status} ${await bodyOf(res)}`);
    assert(!body.includes('LOC-SECRET-42'), `the redirect carries props: ${await bodyOf(res)}`);
  });

  await check('#8 page-data calendars for a GOOGLE user: their own FamCal calendars (Google as a connection), never another user\'s', async () => {
    seed();
    const res = await pageData({ page: 'calendars', user_id: 8880004, locale: 'en', initData: initDataFor(8880004) });
    const body = await fullBody(res);
    assert(res.status === 200 && body.includes('CAL-SECRET-gina-native') && !body.includes('notNative'), `status ${res.status} ${await bodyOf(res)}`);
    assert(!/CAL-SECRET-(?!gina)/.test(body), `another user's calendar: ${await bodyOf(res)}`);
  });

  // ---- Review fix: the dead /oauth-success route ----

  await check('#9 /oauth-success?user_id=<Telegram id> shows no one\'s name (the dead route is gone, or renders no user)', async () => {
    seed();
    const rel = 'app/oauth-success/page.tsx';
    if (!fs.existsSync(path.join(ROOT, rel))) return;
    process.env.TELEGRAM_BOT_USERNAME ||= 'test_bot';
    const page = (await load(rel)).default;
    const el = await page({ searchParams: Promise.resolve({ user_id: '5550001' }) });
    const out = `${serialize(el)} ${renderHtml(el, 'en')}`;
    assert(!out.includes('Dana'), 'the page shows the name of Telegram user 5550001 (Dana)');
  });

  // ---- Missing Google scopes: the re-connect page has no locale prefix ----

  await check('#10 select-calendars with missing Google scopes (Hebrew user): redirect to /refresh-token with no locale prefix', async () => {
    seed();
    const gina = DB.user.find((u: Row) => u.id === 4) as Row;
    gina.language = 'he';
    googleListError = 'GOOGLE_INSUFFICIENT_SCOPES';
    const res = await pageData({ page: 'select-calendars', user_id: 8880004, locale: 'he', initData: initDataFor(8880004) });
    const body = await fullBody(res);
    assert(body.includes('redirect'), `no redirect: status ${res.status} ${await bodyOf(res)}`);
    assert(body.includes('"/refresh-token?user_id=8880004"'), `the redirect is not to /refresh-token?user_id=8880004: ${await bodyOf(res)}`);
  });

  // ---- The dashboard branch: the calendar home's props, hints and open (spec §7.1, §7.3) ----

  const { REDIS_KEYS } = await load('src/config/redis-keys.ts');
  const show = (value: unknown) => JSON.stringify(value);
  /** The dashboard's props on the wire: the calendar home's, nothing of the old dashboard's. */
  const DASHBOARD_KEYS = ['user', 'locale', 'sources', 'googleConnected', 'googleState', 'trial', 'isEarlyAdopter', 'hints', 'lookahead7', 'jewish'];
  const keysOf = (value: Row) => Object.keys(value).sort().join(',');
  const hintsOf = (props: Row) => `reminders=${props.hints?.reminders} voiceEvents=${props.hints?.voiceEvents}`;
  /** A feature check's answer in the 24 h cache checkFeatureAccess reads first. */
  const cacheFeature = (userId: number, feature: string, allowed: boolean) => {
    redisStore.set(REDIS_KEYS.featureAccess(userId, feature), JSON.stringify({ allowed }));
  };
  /** The users whose webapp_opened rows landed (trackActivityAsync is fire and forget). */
  const opens = async (): Promise<number[]> => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return (DB.userActivity ?? []).filter((r: Row) => r.action === 'webapp_opened').map((r: Row) => Number(r.userId));
  };
  /** page-data's dashboard props for a Telegram user, opened with their own initData. */
  const dashboardFor = async (tgId: number, locale: string): Promise<Row> => {
    const res = await pageData({ page: 'dashboard', user_id: tgId, locale, initData: initDataFor(tgId) });
    const body = res.status === 200 ? await res.clone().json() : null;
    assert(body?.kind === 'props', `${tgId}: status ${res.status} ${await bodyOf(res)}`);
    return body.props as Row;
  };

  await check('#11 the dashboard for a Google user: exactly the calendar home\'s props (no calendarHome flag, no old-dashboard data), the hints, lookahead7 and one webapp_opened under the DB id', async () => {
    seed();
    cacheFeature(4, 'voice_events', true);
    const problems: string[] = [];
    const gina = await dashboardFor(8880004, 'en');
    const want = [...DASHBOARD_KEYS].sort().join(',');
    if (keysOf(gina) !== want) problems.push(`keys ${keysOf(gina)} (want ${want})`);
    if (keysOf(gina.user ?? {}) !== 'id,isAdmin,location,name') problems.push(`user keys ${keysOf(gina.user ?? {})}`);
    // The always-7-days setting rides along for the Send sheet's week dates (false for a user who never set it)
    if (gina.lookahead7 !== false) problems.push(`lookahead7 ${show(gina.lookahead7)}`);
    // The calendar setting rides along for the header's sun button: false for the default calendar
    if (gina.jewish !== false) problems.push(`jewish ${show(gina.jewish)}`);
    // A Google user gets reminders too (they live in FamCal): the same feature checks as anyone
    if (hintsOf(gina) !== 'reminders=true voiceEvents=true' || keysOf(gina.hints ?? {}) !== 'reminders,voiceEvents') problems.push(`hints ${show(gina.hints)}`);
    if (show([...featureChecks].sort()) !== show(['reminders(4)', 'voice_events(4)']) || show(supportChecks) !== show([4])) problems.push(`hint checks ${show({ featureChecks, supportChecks })}`);
    const opened = await opens();
    if (show(opened) !== show([4])) problems.push(`webapp_opened for ${show(opened)} (want [4]: the DB id, once)`);
    // Google is a connection beside FamCal: the facts, not a source (spec "Google as a connection" §2, §4)
    if (show(gina.sources) !== show(['famcal', 'google']) || gina.googleConnected !== true || gina.googleState !== 'connected') problems.push(`google facts ${show({ s: gina.sources, c: gina.googleConnected, st: gina.googleState })}`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#11c the dashboard says whether the calendar setting is Jewish (the header\'s sun button): true for culture jewish, false for the default calendar, and the Hebrew language alone does not make it so', async () => {
    seed();
    const problems: string[] = [];
    const tal = DB.user.find((u: Row) => u.id === 9);
    const dana = DB.user.find((u: Row) => u.id === 1);
    assert(tal && dana, 'the seeded users');
    tal.culture = 'jewish';
    if ((await dashboardFor(111111111, 'en')).jewish !== true) problems.push('culture jewish did not say jewish');
    // Dana reads Hebrew (language he) on the default calendar: Hebrew dates, but no sun
    if ((await dashboardFor(5550001, 'he')).jewish !== false) problems.push('the Hebrew language alone said jewish');
    tal.culture = 'default';
    if ((await dashboardFor(111111111, 'en')).jewish !== false) problems.push('switching the calendar back did not clear it');
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#11a the dashboard\'s Google facts by state: a FamCal user (no token, no calendars) reads FamCal alone and never connected; a token with none chosen is choose; a cleared token with calendars stored is reconnect and reads FamCal alone; no calendarSource, needsOAuth or needsCalendars on the wire', async () => {
    seed();
    const problems: string[] = [];
    const facts = (p: Row) => show({ sources: p.sources, googleConnected: p.googleConnected, googleState: p.googleState });
    const dana = await dashboardFor(5550001, 'he');
    if (facts(dana) !== show({ sources: ['famcal'], googleConnected: false, googleState: 'none' })) problems.push(`Dana ${facts(dana)}`);
    const gina = DB.user.find((u: Row) => u.id === 4);
    assert(gina, 'the seeded Google user');
    const assignments = gina.calendarAssignments;
    gina.calendarAssignments = null;
    const choose = await dashboardFor(8880004, 'en');
    if (facts(choose) !== show({ sources: ['famcal', 'google'], googleConnected: true, googleState: 'choose' })) problems.push(`choose ${facts(choose)}`);
    gina.calendarAssignments = assignments;
    gina.googleRefreshToken = '';
    const cleared = await dashboardFor(8880004, 'en');
    if (facts(cleared) !== show({ sources: ['famcal'], googleConnected: false, googleState: 'reconnect' })) problems.push(`cleared ${facts(cleared)}`);
    for (const p of [dana, choose, cleared]) if ('calendarSource' in p || 'needsOAuth' in p || 'needsCalendars' in p) problems.push(`a legacy fact on the wire: ${keysOf(p)}`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#12 the hints are the real gates (R10): a FamCal user on Telegram with reminders and no voice events; the native-reminders switch off clears reminders; one open per load', async () => {
    seed();
    cacheFeature(1, 'reminders', true);
    cacheFeature(1, 'voice_events', false);
    const problems: string[] = [];
    const first = await dashboardFor(5550001, 'he');
    if (hintsOf(first) !== 'reminders=true voiceEvents=false') problems.push(`hints ${hintsOf(first)}`);
    if (!featureChecks.includes('reminders(1)') || !featureChecks.includes('voice_events(1)')) problems.push(`feature checks ${show(featureChecks)}`);
    redisStore.set(REDIS_KEYS.NATIVE_REMINDERS_ENABLED, 'false');
    const second = await dashboardFor(5550001, 'he');
    if (hintsOf(second) !== 'reminders=false voiceEvents=false') problems.push(`with native reminders off: ${hintsOf(second)}`);
    const opened = await opens();
    if (show(opened) !== show([1, 1])) problems.push(`webapp_opened for ${show(opened)} (want [1,1]: once per load)`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#13 a failing voice-events check reads as no hint: the page still answers, voiceEvents false, with a warning', async () => {
    seed();
    cacheFeature(1, 'reminders', true);
    featureError = 'voice_events';
    const props = await dashboardFor(5550001, 'he');
    assert(hintsOf(props) === 'reminders=true voiceEvents=false', hintsOf(props));
    assert(captured.some(c => c.startsWith('calendar-home-hints: ') && c.includes('voice_events')), `captured: ${show(captured)}`);
  });

  await check('#14 the hints are a read, not a block: a Basic user (no reminders, no voice events) opening the dashboard on an empty feature cache logs no feature_blocked row and no Sentry capture, and caches nothing; the next real checkFeatureAccess still misses and logs what it blocked', async () => {
    seed();
    DB.subscription = [{ id: 'sub-basic', userId: 1, plan: 'BASIC', status: 'ACTIVE', currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, trialStartedAt: null, trialEndsAt: new Date(0) }];
    const sentry = nodeRequire('@sentry/nextjs');
    const messages: string[] = [];
    const realCapture = sentry.captureMessage;
    sentry.captureMessage = (message: string) => { messages.push(message); return ''; };
    const blocked = () => (DB.userActivity ?? []).filter((r: Row) => r.action === 'feature_blocked').length;
    try {
      const props = await dashboardFor(5550001, 'he');
      await new Promise(resolve => setTimeout(resolve, 20));
      const problems: string[] = [];
      if (hintsOf(props) !== 'reminders=false voiceEvents=false') problems.push(`hints ${hintsOf(props)}`);
      if (blocked() !== 0) problems.push(`${blocked()} feature_blocked rows from the hints`);
      if (messages.length) problems.push(`Sentry captures ${show(messages)}`);
      // A quiet read caches nothing: a cached answer is never logged, so a hint cached here would hide the next real block.
      for (const feature of ['reminders', 'voice_events'] as const) {
        if (redisStore.has(REDIS_KEYS.featureAccess(1, feature))) problems.push(`the hint cached ${feature}`);
      }
      assert(problems.length === 0, problems.join('; '));
      // The real gate right after: still a miss, so it logs what it blocked.
      const direct = await (await load('src/services/subscription-service.ts')).checkFeatureAccess(1, 'reminders');
      await new Promise(resolve => setTimeout(resolve, 20));
      assert(direct.allowed === false && blocked() === 1 && messages.includes('User Activity: feature_blocked'),
        `direct ${show(direct)}, rows ${blocked()}, captures ${show(messages)}`);
    } finally {
      sentry.captureMessage = realCapture;
    }
  });

  await check('#15 an open of the dashboard runs the lazy trial expiry (the answer is not on the wire, the side effect is the point): a trial past its end is expired to FREE with its activity row and its cached feature answers cleared; a trial still running is left alone', async () => {
    seed();
    // Both hint answers cached: no hint check reaches the subscription, so only the page's own call can expire the trial.
    cacheFeature(1, 'reminders', true);
    cacheFeature(1, 'voice_events', true);
    DB.subscription = [{ id: 'sub-trial', userId: 1, plan: 'PRO', status: 'TRIALING', currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, trialStartedAt: new Date(Date.now() - 20 * 86_400_000), trialEndsAt: new Date(Date.now() - 86_400_000) }];
    const problems: string[] = [];
    const props = await dashboardFor(5550001, 'he');
    await new Promise(resolve => setTimeout(resolve, 20));
    const sub = DB.subscription.find((r: Row) => r.userId === 1);
    if (sub?.status !== 'EXPIRED' || sub?.plan !== 'FREE') problems.push(`subscription ${show({ status: sub?.status, plan: sub?.plan })}`);
    if (!(DB.userActivity ?? []).some((r: Row) => r.action === 'subscription_expired' && Number(r.userId) === 1)) problems.push('no subscription_expired row');
    if (redisStore.has(REDIS_KEYS.featureAccess(1, 'reminders')) || redisStore.has(REDIS_KEYS.featureAccess(1, 'voice_events'))) problems.push('a cached feature answer stayed');
    if ('subscription' in props || 'usage' in props || 'effectivePlan' in props) problems.push(`the answer reached the wire: ${keysOf(props)}`);
    // A trial still running is left as it is.
    seed();
    DB.subscription = [{ id: 'sub-trial', userId: 1, plan: 'PRO', status: 'TRIALING', currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, trialStartedAt: new Date(), trialEndsAt: new Date(Date.now() + 5 * 86_400_000) }];
    await dashboardFor(5550001, 'he');
    const running = DB.subscription.find((r: Row) => r.userId === 1);
    if (running?.status !== 'TRIALING') problems.push(`a running trial became ${running?.status}`);
    assert(problems.length === 0, problems.join('; '));
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

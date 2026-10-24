// Smoke test for "Disconnect Google" (docs/superpowers/specs/2026-10-25-disconnect-google-design.md):
// disconnectGoogle (src/services/google-disconnect.ts) and POST /api/google-disconnect.
//
// Covered: the order (copy calendars deleted while the token works, then the revoke, then the
// local clear, then the activity row); best effort per copy calendar and for the revoke, with
// the local clear running whatever happened; the box left unticked; every piece of state
// cleared (token, scopes, choices, links, unfinished consents, the Google read cache, live
// colours, the reminder cache entry, feature caches, retries, setup tracks, the timezone) and
// nothing of another user's (user 7 vs 70); the user afterwards being a FamCal-only user who
// can connect again; the route's auth, body and rate limiter.
//
// The service, the sync worker's turn-off code, the reminder cache, setup tracks and the
// route run for real. Faked: Prisma and Redis (in memory), Google (client.ts's test seam), the
// revoke endpoint (fetch), error capture, analytics, the plan check, the Google cache stamp.
// No network, no database.
//
// Run: bash scripts/ci-smokes.sh  (or run-smoke.sh scripts/smoke-google-disconnect.ts)

import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.ENCRYPTION_KEY_PREVIOUS = '';

const results: { name: string; ok: boolean; reason?: string }[] = [];
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
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

// ---- Event log: every Google call, revoke, database write and Redis delete, in order ----

const events: string[] = [];
const captured: { ctx: string; message: string }[] = [];
const tracked: { userId: number; action: string; meta: Row }[] = [];
const stamped: number[] = [];
const featureInvalidated: number[] = [];

// ---- Fake Prisma ----

let DB: Record<string, Row[]> = {};
let failTransaction = false;
const T = (name: string) => (DB[name] ??= []);
const isDbNull = (v: unknown) => v === Prisma.DbNull || v === Prisma.JsonNull;

function matchesWhere(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && typeof cond !== 'bigint') {
      if ('in' in cond) return (cond.in as unknown[]).includes(v);
      throw new Error(`fake prisma: no operator in ${show(cond)}`);
    }
    return typeof cond === 'bigint' || typeof v === 'bigint' ? String(cond) === String(v) : cond === v;
  });
}
function model(name: string): Row {
  return {
    findUnique: async ({ where }: Row) => {
      const row = T(name).find((r) => matchesWhere(r, where));
      return row ? structuredClone(row) : null;
    },
    findMany: async ({ where, select }: Row = {}) =>
      T(name).filter((r) => matchesWhere(r, where)).map((r) => {
        const out = structuredClone(r);
        if (select?.nativeCalendar) out.nativeCalendar = T('nativeCalendar').find((c) => c.id === r.nativeCalendarId) ? { name: T('nativeCalendar').find((c) => c.id === r.nativeCalendarId)!.name } : null;
        return out;
      }),
    update: async ({ where, data }: Row) => {
      const row = T(name).find((r) => matchesWhere(r, where));
      if (!row) throw new Error(`fake prisma: no ${name} row ${show(where)}`);
      events.push(`db:${name}.update`);
      for (const [k, v] of Object.entries(data)) row[k] = isDbNull(v) ? null : structuredClone(v);
      return structuredClone(row);
    },
    updateMany: async ({ where, data }: Row) => {
      const rows = T(name).filter((r) => matchesWhere(r, where));
      events.push(`db:${name}.updateMany`);
      for (const r of rows) for (const [k, v] of Object.entries(data)) r[k] = isDbNull(v) ? null : structuredClone(v);
      return { count: rows.length };
    },
    deleteMany: async ({ where }: Row) => {
      const before = T(name).length;
      events.push(`db:${name}.deleteMany`);
      const gone = T(name).filter((r) => matchesWhere(r, where));
      DB[name] = T(name).filter((r) => !matchesWhere(r, where));
      if (name === 'googleSyncLink') DB.googleSyncItem = T('googleSyncItem').filter((i) => !gone.some((l) => l.id === i.linkId));
      return { count: before - DB[name].length };
    },
  };
}
const fakePrisma: Row = {
  $transaction: async (fn: (tx: Row) => Promise<unknown>) => {
    if (failTransaction) throw new Error('the database is down');
    const snapshot = structuredClone(DB);
    try {
      return await fn(fakePrisma);
    } catch (err) {
      DB = snapshot;
      throw err;
    }
  },
};
for (const name of ['user', 'googleSyncLink', 'googleSyncItem', 'oAuthState', 'nativeCalendar']) fakePrisma[name] = model(name);

// ---- Fake Redis ----

const store = new Map<string, unknown>();
const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const fakeRedis: Row = {
  get: async (k: string) => (store.has(k) ? store.get(k) : null),
  set: async (k: string, v: unknown, o?: { nx?: boolean }) => {
    if (o?.nx && store.has(k)) return null;
    store.set(k, v);
    return 'OK';
  },
  smembers: async (k: string) => [...((store.get(k) as string[] | undefined) ?? [])],
  /** The sync lock's two scripts (worker.ts RENEW_LOCK, RELEASE_LOCK): act only while the key holds the caller's token. */
  eval: async (script: string, keys: string[], args: unknown[]) => {
    if (store.get(keys[0]) !== args[0]) return 0;
    if (/'del'/.test(script)) { store.delete(keys[0]); return 1; }
    return 1;
  },
  mget: async (...ks: string[]) => ks.map((k) => (store.has(k) ? store.get(k) : null)),
  del: async (...ks: string[]) => {
    let n = 0;
    for (const k of ks) if (store.delete(k)) n += 1;
    events.push(`redis:del ${ks.join(' ')}`);
    return n;
  },
  scan: async (_cursor: number | string, opts: { match: string }) => ['0', [...store.keys()].filter((k) => glob(opts.match).test(k))],
};

// ---- Fake Google ----

interface GCal { id: string; account: string; description: string; events: Row[]; failDelete?: boolean }
const google: { calendars: Map<string, GCal>; tokens: Map<string, string>; failAccount: Set<string> } = { calendars: new Map(), tokens: new Map(), failAccount: new Set() };
function fakeGoogle(token: string) {
  const account = google.tokens.get(token);
  const mine = () => [...google.calendars.values()].filter((c) => c.account === account);
  const notFound = () => Object.assign(new Error('Not Found'), { code: 404, response: { status: 404 } });
  return {
    account: async () => {
      if (google.failAccount.has(token)) throw Object.assign(new Error('Invalid Credentials'), { code: 401, response: { status: 401, data: { error: 'invalid_grant' } } });
      if (!account) throw new Error('unknown token');
      return account;
    },
    api: {
      calendarList: { list: async () => ({ data: { items: mine().map((c) => ({ id: c.id, description: c.description })) } }) },
      calendars: {
        get: async ({ calendarId }: Row) => {
          const c = google.calendars.get(calendarId);
          if (!c || c.account !== account) throw notFound();
          events.push(`google:get ${calendarId}`);
          return { data: { description: c.description } };
        },
        delete: async ({ calendarId }: Row) => {
          const c = google.calendars.get(calendarId);
          if (!c) throw notFound();
          if (c.failDelete) throw Object.assign(new Error('Backend Error'), { code: 500, response: { status: 500 } });
          events.push(`google:delete ${calendarId}`);
          google.calendars.delete(calendarId);
          return { data: {} };
        },
      },
      events: {
        list: async ({ calendarId }: Row) => ({ data: { items: google.calendars.get(calendarId)?.events ?? [] } }),
        delete: async ({ calendarId, eventId }: Row) => {
          const c = google.calendars.get(calendarId)!;
          events.push(`google:delete-event ${calendarId}/${eventId}`);
          c.events = c.events.filter((e) => e.id !== eventId);
          return { data: {} };
        },
      },
    },
  };
}

// ---- Fake fetch: Google's revoke endpoint only ----

const revokes: { url: string; body: string; contentType: string | null }[] = [];
let revokeAnswer: { status: number; body: Row } | 'throw' = { status: 200, body: {} };
globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  const url = String(input);
  if (url !== 'https://oauth2.googleapis.com/revoke') throw new Error(`network blocked in smoke: ${url}`);
  const headers = new Headers(init.headers);
  const body = String(init.body);
  revokes.push({ url, body, contentType: headers.get('content-type') });
  events.push(`revoke ${new URLSearchParams(body).get('token')}`);
  if (revokeAnswer === 'throw') throw new TypeError('fetch failed');
  return new Response(JSON.stringify(revokeAnswer.body), { status: revokeAnswer.status, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

// ---- Stubs served to import() ----

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
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.join(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};
function stub(rel: string, exports: Row) {
  const filename = path.join(ROOT, rel);
  stubs[filename] = exports;
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  Module._cache[filename] = mod;
}

const rateLimited = new Set<string>();
const authCalls: { userId: string | null; limiter: string; endpoint: string; initData: unknown }[] = [];
/** Who the fake auth proves: the Telegram id in the header, as user 7. */
const AUTH_USER = 7;

function installStubs() {
  stub('src/utils/prisma.ts', { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() });
  stub('src/utils/redis.ts', { redis: fakeRedis });
  const capture = (e: unknown, ctx: string) => { captured.push({ ctx, message: e instanceof Error ? e.message : String(e) }); };
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
  stub('src/utils/error-notifier.ts', { notifyAdminWarning: async () => undefined, notifyAdminError: async () => undefined, notifyAdminFeedback: async () => undefined, getAdminUserIds: async () => [] });
  const tg = { sendMessage: async () => 1 };
  stub('src/services/telegram/index.ts', { getMessagingService: () => tg, getBot: () => tg, initBot: () => tg });
  stub('src/services/messaging/factory.ts', { getMessagingService: () => tg, getWhatsAppService: () => tg, getTelegramService: () => tg });
  stub('src/lib/timezone.ts', { resolveUserTimezone: async () => 'Asia/Jerusalem' });
  stub('src/services/subscription-service.ts', {
    peekFeatureAccess: async () => ({ allowed: true }),
    checkFeatureAccess: async () => ({ allowed: true }),
    invalidateFeatureAccessCache: async (userId: number) => { featureInvalidated.push(userId); events.push(`features:invalidate ${userId}`); },
  });
  stub('src/services/analytics-service.ts', {
    trackActivity: async (userId: number, action: string, meta: Row) => { tracked.push({ userId, action, meta }); events.push(`activity:${action}`); },
    trackActivityAsync: (userId: number, action: string, meta: Row) => { tracked.push({ userId, action, meta }); events.push(`activity:${action}`); },
  });
  stub('src/services/calendar-read/google.ts', {
    stampGoogleCache: async (userId: number) => { stamped.push(userId); events.push(`stamp ${userId}`); },
  });
  stub('src/lib/rate-limit.ts', { settingsRateLimiter: { name: 'settings' }, generalRateLimiter: { name: 'general' } });
  stub('src/lib/api-auth.ts', {
    verifyUserAuth: async (request: Request, userId: string | null, initData: unknown, limiter: Row, endpoint: string) => {
      authCalls.push({ userId, limiter: limiter.name, endpoint, initData });
      const { NextResponse } = nodeRequire('next/server');
      if (!initData) return { success: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
      if (rateLimited.has(endpoint)) return { success: false, response: NextResponse.json({ error: 'Too many requests' }, { status: 429 }) };
      const user = DB.user.find((u) => u.id === AUTH_USER);
      const { convertPrismaUserToConfig } = await import(path.join(ROOT, 'src/types.ts'));
      return { success: true, via: 'telegram', user: convertPrismaUserToConfig(structuredClone(user)) };
    },
  });
}

// ---- Fixtures ----

const { REDIS_KEYS } = nodeRequire(path.join(ROOT, 'src/config/redis-keys.ts'));
const enc = (s: string): string => nodeRequire(path.join(ROOT, 'src/utils/encryption.ts')).encrypt(s);

const TOKEN = 'refresh-tok-7';
const ACCOUNT = 'acct-7';
const ME = 7;
const OTHER = 70;

function userRow(id: number, o: Row = {}): Row {
  return {
    id, telegramId: BigInt(1000 + id), whatsappPhone: null, whatsappBsuid: null, name: `U${id}`, englishName: '', gender: 'male', language: 'en',
    location: 'Tel Aviv', culture: 'default', messagingPlatform: 'telegram', isAdmin: false, suspendedAt: null, unreachableSince: null,
    googleRefreshToken: enc(TOKEN), calendarAssignments: [{ calendarId: 'primary', labels: ['primary'], name: 'Me', color: '#039BE5' }],
    calendarSource: 'NATIVE', googleScopes: ['calendar.readonly', 'calendar.events', 'https://www.googleapis.com/auth/calendar.app.created'],
    googleSyncNotifiedAt: new Date('2026-10-01T00:00:00Z'), remindersEnabled: true, defaultReminderMinutes: 15, pickupRemindersEnabled: true,
    pairingId: null, globalRules: [], textSummaryEnabled: true, voiceSummaryEnabled: false, voiceInputEnabled: false, weatherEnabled: true,
    includeWeeklyInLookahead: false, includeLookaheadInTomorrow: false, lookaheadAlways7Days: false, locationForced: false,
    createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'), ...o,
  };
}
function linkRow(id: string, userId: number, calendarId: string | null, o: Row = {}): Row {
  return {
    id, userId, nativeCalendarId: calendarId, googleCalendarId: `g-${id}`, googleAccount: ACCOUNT, enabled: true, state: 'ok', unlinkChoice: null,
    unlinkToken: null, dirtySeq: 3, pushedSeq: 3, pushedName: null, lastError: null, backfilledAt: new Date('2026-10-02T00:00:00Z'), ...o,
  };
}
function gcal(linkId: string, o: Partial<GCal> = {}): GCal {
  const c: GCal = { id: `g-${linkId}`, account: ACCOUNT, description: `Managed.\n\n[famcal:${linkId}]`, events: [{ id: `e-${linkId}`, extendedProperties: { private: { famcalSync: linkId } } }], ...o };
  google.calendars.set(c.id, c);
  return c;
}

const keysOf = (userId: number) => ({
  stamp: REDIS_KEYS.gcalStamp(userId), colours: REDIS_KEYS.gcalColours(userId), gone: REDIS_KEYS.gcalGoneWarned(userId),
  range: `gcal:range:v1:${userId}:abc123:Asia/Jerusalem:2026-10-01:2026-10-08`, fresh: REDIS_KEYS.gcalFresh(userId, '2026-10-01', '2026-10-08'),
  connected: REDIS_KEYS.googleConnected(userId), tz: REDIS_KEYS.userTimezone(userId),
  recent: REDIS_KEYS.recentEvents(userId), lastCreated: REDIS_KEYS.lastCreatedEvent(userId),
});

function seed(o: { copies?: string[]; extra?: (() => void) } = {}) {
  DB = {};
  events.length = 0;
  captured.length = 0;
  tracked.length = 0;
  stamped.length = 0;
  featureInvalidated.length = 0;
  revokes.length = 0;
  revokeAnswer = { status: 200, body: {} };
  failTransaction = false;
  google.calendars.clear();
  google.tokens.clear();
  google.failAccount.clear();
  store.clear();
  rateLimited.clear();
  authCalls.length = 0;
  google.tokens.set(TOKEN, ACCOUNT);
  DB.user = [userRow(ME), userRow(OTHER, { googleRefreshToken: enc('other-tok') })];
  DB.nativeCalendar = [{ id: 'home', ownerUserId: ME, name: 'Home' }, { id: 'work', ownerUserId: ME, name: 'Work' }, { id: 'o1', ownerUserId: OTHER, name: 'Theirs' }];
  DB.googleSyncLink = [];
  DB.googleSyncItem = [];
  DB.oAuthState = [{ id: 's1', userId: BigInt(ME), token: 't1' }, { id: 's2', userId: BigInt(OTHER), token: 't2' }];
  for (const [i, id] of (o.copies ?? ['L1', 'L2']).entries()) {
    DB.googleSyncLink.push(linkRow(id, ME, i === 0 ? 'home' : 'work', { pushedName: i === 0 ? 'Home' : 'Work' }));
    DB.googleSyncItem.push({ id: `i-${id}`, linkId: id, nativeEventId: 'ev' });
    gcal(id);
  }
  DB.googleSyncLink.push(linkRow('LO', OTHER, 'o1'));
  DB.googleSyncItem.push({ id: 'i-LO', linkId: 'LO', nativeEventId: 'ev' });
  // Redis: both users' Google caches, so a clear of 7 must leave 70 alone
  for (const uid of [ME, OTHER]) {
    const k = keysOf(uid);
    for (const key of Object.values(k)) store.set(key, 'x');
    store.set(REDIS_KEYS.featureAccess(uid, 'google_sync'), 'x');
    store.set(REDIS_KEYS.setupTrackStart(uid, 'calendars'), 'x');
    store.set(REDIS_KEYS.setupReminder(uid, 'reconnect', 0), 'x');
  }
  // A voice confirmation card still open holds the user's whole config (Google ids included)
  store.set(REDIS_KEYS.pendingEvent('p-me'), { user: { id: ME }, event: {} });
  store.set(REDIS_KEYS.pendingEdit('p-me'), { user: { id: ME }, updates: {} });
  store.set(REDIS_KEYS.pendingDelete('p-me'), { user: { id: ME } });
  store.set(REDIS_KEYS.pendingBatch('p-me'), { user: { id: ME } });
  store.set(REDIS_KEYS.pendingEvent('p-other'), { user: { id: OTHER }, event: {} });
  store.set(REDIS_KEYS.googleSyncLinkRetry('L1'), '2:99999');
  store.set(REDIS_KEYS.googleSyncLinkRetry('LO'), '2:99999');
  store.set(REDIS_KEYS.REMINDER_USERS, [
    { id: ME, telegramId: String(1000 + ME), googleToken: 'sealed', calendarAssignments: [{ calendarId: 'primary' }], defaultReminderMinutes: 15, language: 'en', name: 'U7', pickupRemindersEnabled: true, calendarSource: 'NATIVE', pairingId: null, location: 'Tel Aviv' },
    { id: OTHER, telegramId: String(1000 + OTHER), googleToken: 'sealed-o', calendarAssignments: [{ calendarId: 'primary' }], defaultReminderMinutes: 15, language: 'en', name: 'U70', pickupRemindersEnabled: true, calendarSource: 'NATIVE', pairingId: null, location: 'Tel Aviv' },
  ]);
  o.extra?.();
}

const row = (name: string, id: number | string) => T(name).find((r) => r.id === id);
const link = (id: string): Row => row('googleSyncLink', id) as Row;
const idx = (prefix: string) => events.findIndex((e) => e.startsWith(prefix));
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

async function main() {
  installStubs();
  const logs: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const keep = (...a: unknown[]) => { logs.push(a.map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : show(x))).join(' ')); };
  console.log = keep;
  console.warn = keep;
  console.error = keep;

  let svc: Row | undefined;
  let svcError: unknown;
  try {
    svc = await load('src/services/google-disconnect.ts');
    const client = await load('src/services/google-sync/client.ts');
    client.__useSyncGoogleForTests((token: string) => fakeGoogle(token));
  } catch (err) {
    svcError = err;
  }
  const need = (): Row => {
    if (!svc) throw new Error(`google-disconnect.ts does not load: ${svcError instanceof Error ? svcError.message : String(svcError)}`);
    return svc;
  };
  const run = (deleteCopies: boolean, userId = ME) => need().disconnectGoogle(userId, { deleteCopies });

  // ---- Order ----

  await check('order: the copy calendars are deleted first, then the token is revoked, then the database is cleared, then the activity row', async () => {
    seed();
    await run(true);
    const del1 = idx('google:delete g-L1');
    const del2 = idx('google:delete g-L2');
    const revoke = idx('revoke');
    const clear = idx('db:user.update');
    const act = idx('activity:calendar_disconnected');
    assert(del1 >= 0 && del2 >= 0 && revoke >= 0 && clear >= 0 && act >= 0, `events ${show(events)}`);
    assert(Math.max(del1, del2) < revoke && revoke < clear && clear < act, `order ${show(events)}`);
  });

  await check('copies: both copy calendars are deleted in Google, the result lists none, and the revoke carries the refresh token as a form POST', async () => {
    seed();
    const res = await run(true);
    assert(!google.calendars.has('g-L1') && !google.calendars.has('g-L2'), `calendars left ${show([...google.calendars.keys()])}`);
    assert(show(res.leftover) === '[]' && res.revoked === true, `result ${show(res)}`);
    assert(revokes.length === 1 && revokes[0].contentType?.startsWith('application/x-www-form-urlencoded') && new URLSearchParams(revokes[0].body).get('token') === TOKEN, `revoke ${show(revokes)}`);
  });

  await check('copies: only the user\'s own copies are touched (the other user\'s calendar stays)', async () => {
    seed();
    gcal('LO', { account: 'acct-70' });
    await run(true);
    assert(google.calendars.has('g-LO'), 'the other user\'s Google calendar was deleted');
  });

  // ---- Box unticked ----

  await check('box unticked: no Google calendar is deleted, the token is still revoked, links turned off with their queue cleared, the rest cleared', async () => {
    seed();
    DB.googleSyncLink[0].unlinkChoice = 'keep';
    DB.googleSyncLink[0].unlinkToken = enc('merged-tok');
    DB.googleSyncLink[0].dirtySeq = 5;
    const res = await run(false);
    assert(google.calendars.size === 2, `calendars ${show([...google.calendars.keys()])}`);
    assert(show(res.leftover) === '[]', `leftover ${show(res.leftover)}`);
    assert(revokes.length === 2 && revokes.some((r) => new URLSearchParams(r.body).get('token') === TOKEN) && revokes.some((r) => new URLSearchParams(r.body).get('token') === 'merged-tok'), `revokes ${show(revokes)}`);
    for (const id of ['L1', 'L2']) {
      const l = link(id);
      assert(l && l.enabled === false && l.unlinkChoice === null && l.unlinkToken === null && l.dirtySeq === l.pushedSeq, `${id} ${show(l)}`);
      assert(l.googleCalendarId === `g-${id}`, `${id} must keep its Google calendar id (FamCal keeps hiding it) ${show(l)}`);
    }
  });

  // ---- Failures ----

  await check('a copy calendar that fails to delete is listed, the other is deleted, and the clear still runs', async () => {
    seed();
    google.calendars.get('g-L1')!.failDelete = true;
    const res = await run(true);
    assert(!google.calendars.has('g-L2') && google.calendars.has('g-L1'), `calendars ${show([...google.calendars.keys()])}`);
    assert(show(res.leftover) === show(['FamCal · Home']), `leftover ${show(res.leftover)}`);
    assert(captured.some((c) => c.ctx === 'google-disconnect-copy'), `captured ${show(captured)}`);
    assert(link('L1') && link('L1').enabled === false && !link('L2'), `links ${show(T('googleSyncLink').map((l) => l.id))}`);
    assert(row('user', ME)!.googleRefreshToken === '', 'the token was not cleared');
  });

  await check('a copy calendar holding the user\'s own events is emptied, kept and listed; one that is not FamCal\'s is never touched and listed', async () => {
    seed();
    google.calendars.get('g-L1')!.events.push({ id: 'mine' });
    google.calendars.get('g-L2')!.description = 'a calendar of my own';
    const res = await run(true);
    assert(google.calendars.has('g-L1') && !google.calendars.get('g-L1')!.events.some((e) => e.id === 'e-L1') && google.calendars.get('g-L1')!.events.some((e) => e.id === 'mine'), `L1 ${show(google.calendars.get('g-L1'))}`);
    assert(google.calendars.has('g-L2') && google.calendars.get('g-L2')!.events.length === 1, 'L2 touched');
    assert(show([...res.leftover].sort()) === show(['FamCal · Home', 'FamCal · Work']), `leftover ${show(res.leftover)}`);
  });

  await check('a dead token (Google 401 on the account check): every copy is listed, the revoke is still tried, the clear runs', async () => {
    seed();
    google.failAccount.add(TOKEN);
    const res = await run(true);
    assert(show([...res.leftover].sort()) === show(['FamCal · Home', 'FamCal · Work']), `leftover ${show(res.leftover)}`);
    assert(revokes.length === 1 && row('user', ME)!.googleRefreshToken === '', 'revoke or clear missing');
    assert(captured.filter((c) => c.ctx === 'google-disconnect-copy').length === 2, `captured ${show(captured)}`);
  });

  await check('a revoke that fails (network): captured, revoked false, the clear still runs', async () => {
    seed();
    revokeAnswer = 'throw';
    const res = await run(true);
    assert(res.revoked === false && captured.some((c) => c.ctx === 'google-disconnect-revoke'), `res ${show(res)} captured ${show(captured)}`);
    assert(row('user', ME)!.googleRefreshToken === '' && !T('googleSyncLink').some((l) => l.userId === ME && l.enabled), 'the clear did not run');
  });

  await check('a revoke Google answers 500: captured, revoked false; a 400 invalid_token (already dead) counts as revoked and is not captured', async () => {
    seed();
    revokeAnswer = { status: 500, body: { error: 'backend_error' } };
    let res = await run(true);
    assert(res.revoked === false && captured.some((c) => c.ctx === 'google-disconnect-revoke'), `500: ${show(res)} ${show(captured)}`);
    seed();
    revokeAnswer = { status: 400, body: { error: 'invalid_token', error_description: 'Token expired or revoked' } };
    res = await run(true);
    assert(res.revoked === true && !captured.some((c) => c.ctx === 'google-disconnect-revoke'), `400: ${show(res)} ${show(captured)}`);
  });

  await check('the database failing is the one failure that surfaces: nothing is cleared, and a retry then completes', async () => {
    seed();
    failTransaction = true;
    let threw = false;
    try { await run(true); } catch { threw = true; }
    assert(threw, 'it did not throw');
    assert(row('user', ME)!.googleRefreshToken !== '', 'the token was cleared by a failed transaction');
    failTransaction = false;
    const res = await run(true);
    assert(row('user', ME)!.googleRefreshToken === '' && show(res.leftover) === '[]', `retry ${show(res)}`);
  });

  await check('a Redis step that fails never stops the others (each logged and captured)', async () => {
    seed();
    const realDel = fakeRedis.del;
    fakeRedis.del = async (...ks: string[]) => { if (ks.some((k) => k.startsWith('gcal:colours'))) throw new Error('redis down'); return realDel(...ks); };
    try {
      const res = await run(true);
      assert(res && !store.has(keysOf(ME).gone) && !store.has(REDIS_KEYS.googleConnected(ME)), `later steps skipped ${show([...store.keys()])}`);
      assert(captured.some((c) => c.ctx === 'google-disconnect-cache'), `captured ${show(captured)}`);
    } finally {
      fakeRedis.del = realDel;
    }
  });

  // ---- State cleared ----

  await check('database: token, scopes, choices and the reconnect-notice mark cleared; links gone or off; the unfinished consent gone', async () => {
    seed();
    await run(true);
    const u = row('user', ME)!;
    assert(u.googleRefreshToken === '' && show(u.googleScopes) === '[]' && u.calendarAssignments === null && u.googleSyncNotifiedAt === null, `user ${show(u)}`);
    assert(!T('googleSyncLink').some((l) => l.userId === ME) && !T('googleSyncItem').some((i) => i.linkId === 'L1' || i.linkId === 'L2'), `links ${show(T('googleSyncLink'))}`);
    assert(!T('oAuthState').some((s) => String(s.userId) === String(ME)), 'the user\'s OAuth state is still there');
  });

  await check('redis: the read cache, live colours, gone warning, fresh limit, connected flag, timezone, feature caches, link retries and setup tracks are cleared', async () => {
    seed();
    await run(true);
    const k = keysOf(ME);
    for (const [name, key] of Object.entries(k)) {
      if (name === 'stamp') continue; // stampGoogleCache's own job (stubbed, asserted below)
      assert(!store.has(key), `${name} (${key}) is still in Redis`);
    }
    assert(stamped.includes(ME), 'stampGoogleCache was not called');
    assert(featureInvalidated.includes(ME), 'feature access caches were not invalidated');
    assert(!store.has(REDIS_KEYS.googleSyncLinkRetry('L1')), 'link retry left');
    assert(!store.has(REDIS_KEYS.setupTrackStart(ME, 'calendars')) && !store.has(REDIS_KEYS.setupReminder(ME, 'reconnect', 0)), 'setup tracks left');
  });

  await check('redis: nothing of another user is touched (user 70 shares the id prefix 7)', async () => {
    seed();
    await run(true);
    const k = keysOf(OTHER);
    for (const [name, key] of Object.entries(k)) assert(store.has(key), `${name} of user 70 was deleted`);
    assert(store.has(REDIS_KEYS.googleSyncLinkRetry('LO')) && store.has(REDIS_KEYS.setupTrackStart(OTHER, 'calendars')), 'user 70 retry or track deleted');
    assert(!stamped.includes(OTHER) && !featureInvalidated.includes(OTHER), 'user 70 stamped or invalidated');
    assert(row('user', OTHER)!.googleRefreshToken !== '' && T('googleSyncLink').some((l) => l.id === 'LO') && T('oAuthState').some((s) => s.id === 's2') && google.calendars.has('g-LO') === false, 'user 70\'s rows changed');
  });

  await check('reminder cache: the user stays (reminders are FamCal\'s too) with no token and no Google choices; the other entry is untouched', async () => {
    seed();
    await run(true);
    const cache = store.get(REDIS_KEYS.REMINDER_USERS) as Row[];
    const mine = cache.find((e) => e.id === ME);
    assert(mine && mine.googleToken === '' && !mine.calendarAssignments, `entry ${show(mine)}`);
    assert(cache.find((e) => e.id === OTHER)?.googleToken === 'sealed-o', 'the other entry changed');
  });

  await check('reminder cache: a user who gets no reminders is removed from it', async () => {
    seed();
    row('user', ME)!.remindersEnabled = false;
    await run(true);
    const cache = store.get(REDIS_KEYS.REMINDER_USERS) as Row[];
    assert(!cache.some((e) => e.id === ME) && cache.some((e) => e.id === OTHER), `cache ${show(cache.map((e) => e.id))}`);
  });

  await check('activity: calendar_disconnected is written once for the user, with the counts', async () => {
    seed();
    google.calendars.get('g-L1')!.failDelete = true;
    await run(true);
    const a = tracked.filter((t) => t.action === 'calendar_disconnected');
    assert(a.length === 1 && a[0].userId === ME && a[0].meta.provider === 'google' && a[0].meta.copies_deleted === 1 && a[0].meta.copies_left === 1 && a[0].meta.revoked === true, `tracked ${show(tracked)}`);
  });

  await check('a user with no token and no links: harmless (caches cleared again, no Google call, no revoke)', async () => {
    seed({ copies: [] });
    row('user', ME)!.googleRefreshToken = '';
    DB.googleSyncLink = [];
    const res = await run(true);
    assert(revokes.length === 0 && show(res.leftover) === '[]' && res.revoked === false, `res ${show(res)} revokes ${show(revokes)}`);
    assert(!store.has(keysOf(ME).colours), 'colours left');
  });

  // ---- Afterwards ----

  await check('afterwards: a FamCal-only user: googleStateOf none, sourcesFor famcal only, nothing queued for the sync worker', async () => {
    seed();
    await run(true);
    const { getUserById } = await load('src/services/user-service.ts');
    const { googleStateOf, liveGoogleChoices } = await load('src/lib/google-state.ts');
    const { sourcesFor } = await load('src/services/calendar-read/index.ts');
    const user = await getUserById(ME);
    assert(googleStateOf(user) === 'none' && liveGoogleChoices(user).length === 0, `state ${googleStateOf(user)}`);
    assert(show(sourcesFor(user)) === '["famcal"]', `sources ${show(sourcesFor(user))}`);
    // The worker's pass picks up a link that is on and working, or one turned off with a Remove/Keep
    // queued (worker.ts, the pass's query). None of the user's links is either; the other user's is.
    const pickedUp = (l: Row) => (l.enabled && ['ok', 'creating', 'plan'].includes(l.state))
      || (!l.enabled && l.unlinkChoice !== null && l.dirtySeq > l.pushedSeq && !['token', 'scopes', 'otherAccount'].includes(l.state));
    assert(!T('googleSyncLink').some((l) => l.userId === ME && pickedUp(l)), `the worker would pick up ${show(T('googleSyncLink').filter((l) => l.userId === ME))}`);
    assert(pickedUp(link('LO')!), 'control: the other user\'s link should be picked up');
  });

  await check('afterwards: a legacy Google user (calendarSource GOOGLE) is no "reconnect" user either', async () => {
    seed();
    row('user', ME)!.calendarSource = 'GOOGLE';
    await run(true);
    const { getUserById } = await load('src/services/user-service.ts');
    const { googleStateOf } = await load('src/lib/google-state.ts');
    const state = googleStateOf(await getUserById(ME));
    assert(state === 'none', `state ${state}`);
  });

  await check('afterwards: Connect Google works from scratch: a fresh commit stores the token and the user is "choose calendars"', async () => {
    seed();
    await run(true);
    const connect = await load('src/services/google-connect.ts');
    await connect.commitGoogleToken(ME, 'new-token', { scopes: ['https://www.googleapis.com/auth/calendar.readonly'] });
    const { getUserById } = await load('src/services/user-service.ts');
    const { googleStateOf } = await load('src/lib/google-state.ts');
    const user = await getUserById(ME);
    assert(user.googleRefreshToken === 'new-token' && googleStateOf(user) === 'choose', `state ${googleStateOf(user)} token ${user.googleRefreshToken}`);
  });

  await check('afterwards: a kept copy (box unticked) is still hidden from FamCal\'s Google lists after a reconnect, and does not come back to work', async () => {
    seed();
    await run(false);
    const links = await load('src/services/google-sync/links.ts');
    const filter = await links.syncCopyFilter(ME);
    assert(filter.isCopy({ id: 'g-L1' }) && filter.isCopy({ id: 'g-L2' }), 'copy calendars no longer hidden');
    await links.restoreSyncLinks(ME, ['https://www.googleapis.com/auth/calendar.app.created']);
    assert(link('L1').enabled === false && link('L1').state === 'ok', `link ${show(link('L1'))}`);
  });


  // ---- Review r3: the sync lock (I1) ----

  await check('I1 marker: disconnect never waits on a copy-worker run: with the user\'s sync lock held it still finishes at once, never touches the lock, and sets the busy marker before any Google call and the done marker at the end', async () => {
    seed();
    const lockKey = REDIS_KEYS.googleSyncLock(ME);
    store.set(lockKey, 'a-worker-run');
    const marker = REDIS_KEYS.googleSyncDisconnect(ME);
    const seen: string[] = [];
    const realSet = fakeRedis.set;
    fakeRedis.set = async (k: string, v: unknown, o?: { nx?: boolean }) => { if (k === marker) { seen.push(String(v)); events.push(`marker ${String(v).split(':')[0]}`); } return realSet(k, v, o); };
    try {
      const res = await Promise.race([run(true), new Promise((r) => setTimeout(() => r('hung'), 3000))]);
      assert(res !== 'hung' && (res as Row).revoked === true, 'it hung or failed');
    } finally {
      fakeRedis.set = realSet;
    }
    assert(store.get(lockKey) === 'a-worker-run', 'the worker\'s lock was touched');
    assert(seen.length === 2 && seen[0].startsWith('busy:') && seen[1].startsWith('done:'), `markers ${show(seen)}`);
    assert(idx('marker busy') >= 0 && idx('marker busy') < idx('google:') && idx('marker busy') < idx('revoke') && idx('revoke') < idx('marker done'), `order ${show(events)}`);
  });

  await check('I1 marker: a failed clear leaves the busy marker (the worker must not write after a half-done disconnect) until the retry completes, and a calendar the worker could not delete is listed in the result', async () => {
    seed();
    store.set(REDIS_KEYS.googleSyncOrphans(ME), ['FamCal · Orphan']);
    const res = await run(true);
    assert(show(res.leftover) === show(['FamCal · Orphan']), `leftover ${show(res.leftover)}`);
    assert(!store.has(REDIS_KEYS.googleSyncOrphans(ME)), 'the orphan record was not consumed');
    seed();
    failTransaction = true;
    try { await run(true); } catch { /* expected */ }
    assert(String(store.get(REDIS_KEYS.googleSyncDisconnect(ME))).startsWith('busy:'), `marker ${show(store.get(REDIS_KEYS.googleSyncDisconnect(ME)))}`);
    failTransaction = false;
    await run(true);
    assert(String(store.get(REDIS_KEYS.googleSyncDisconnect(ME))).startsWith('done:'), 'not done after the retry');
  });

  // ---- Review r3: copies the user chose to Keep (I2) ----

  await check('I2: with the box ticked only the ACTIVE copies are deleted; a copy the user turned off with Keep stays in Google untouched, is not listed, and its row stays (turned off)', async () => {
    seed();
    Object.assign(link('L1'), { enabled: false, unlinkChoice: 'keep', pushedSeq: 3, dirtySeq: 3 });
    const res = await run(true);
    assert(google.calendars.has('g-L1') && google.calendars.get('g-L1')!.events.length === 1 && !google.calendars.has('g-L2'), `calendars ${show([...google.calendars.keys()])}`);
    assert(!events.some((e) => e.includes('g-L1')), `g-L1 was touched ${show(events)}`);
    assert(show(res.leftover) === '[]', `leftover ${show(res.leftover)}`);
    const l = link('L1');
    assert(l && l.enabled === false && l.googleCalendarId === 'g-L1', `kept link ${show(l)}`);
    assert(!link('L2'), 'the deleted copy\'s row should be gone');
    const a = tracked.filter((t) => t.action === 'calendar_disconnected');
    assert(a[0].meta.copies_deleted === 1 && a[0].meta.copies_left === 1, `activity ${show(a)}`);
  });

  await check('I2: a Keep still queued (not yet carried out) is the user\'s choice too: that calendar is not deleted', async () => {
    seed();
    Object.assign(link('L1'), { enabled: false, unlinkChoice: 'keep', pushedSeq: 2, dirtySeq: 3 });
    await run(true);
    assert(google.calendars.has('g-L1') && !events.some((e) => e.includes('g-L1')), `events ${show(events)}`);
  });

  // ---- Review r3: a retry after a failed clear (M1) ----

  await check('M1: the database failing after the revoke: the copies already deleted are not remembered as left over on the retry (their rows are gone), and the retry completes with the dead token', async () => {
    seed();
    failTransaction = true;
    let threw = false;
    try { await run(true); } catch { threw = true; }
    assert(threw && revokes.length === 1, 'it should have revoked, then thrown');
    assert(!T('googleSyncLink').some((l) => l.userId === ME), `the deleted copies' rows are still there ${show(T('googleSyncLink').map((l) => l.id))}`);
    failTransaction = false;
    google.failAccount.add(TOKEN); // Google has the token as revoked now
    revokeAnswer = { status: 400, body: { error: 'invalid_token' } };
    const res = await run(true);
    assert(show(res.leftover) === '[]' && res.revoked === true && row('user', ME)!.googleRefreshToken === '', `retry ${show(res)}`);
  });

  // ---- Review r3: the rest of the minors ----

  await check('M2: the voice caches that point at Google go: recent events, last created, and the user\'s own open confirmation cards (not another user\'s)', async () => {
    seed();
    await run(true);
    const k = keysOf(ME);
    assert(!store.has(k.recent) && !store.has(k.lastCreated), 'recent or last-created left');
    for (const key of [REDIS_KEYS.pendingEvent('p-me'), REDIS_KEYS.pendingEdit('p-me'), REDIS_KEYS.pendingDelete('p-me'), REDIS_KEYS.pendingBatch('p-me')]) assert(!store.has(key), `${key} left`);
    assert(store.has(REDIS_KEYS.pendingEvent('p-other')) && store.has(keysOf(OTHER).recent) && store.has(keysOf(OTHER).lastCreated), 'another user\'s voice state was deleted');
  });

  await check('M4: no Google account id or email is kept on a kept link (box unticked, or a copy that failed to delete); the calendar id stays', async () => {
    seed();
    google.calendars.get('g-L1')!.failDelete = true;
    await run(true);
    assert(link('L1') && link('L1').googleAccount === null && link('L1').googleCalendarId === 'g-L1', `link ${show(link('L1'))}`);
    seed();
    await run(false);
    for (const id of ['L1', 'L2']) assert(link(id).googleAccount === null && link(id).googleCalendarId === `g-${id}`, `${id} ${show(link(id))}`);
    assert(link('LO').googleAccount === ACCOUNT, 'another user\'s link changed');
  });

  // ---- Route ----

  const route = await load('app/api/google-disconnect/route.ts').catch((err) => { svcError = err; return null; });
  const post = (body: unknown, headers: Record<string, string> = { 'x-telegram-init-data': 'signed' }, query = 'user_id=7') =>
    route!.POST(new NextRequest(`http://localhost/api/google-disconnect?${query}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  const needRoute = () => { if (!route) throw new Error(`route does not load: ${svcError instanceof Error ? svcError.message : String(svcError)}`); };

  await check('route: 200 with the leftover list; it acts on the proved user (user.id), with the settings limiter and an endpoint name', async () => {
    needRoute();
    seed();
    google.calendars.get('g-L1')!.failDelete = true;
    const res = await post({ deleteCopies: true });
    const body = await res.json();
    assert(res.status === 200 && body.status === 'disconnected' && show(body.leftover) === show(['FamCal · Home']), `${res.status} ${show(body)}`);
    assert(authCalls.length === 1 && authCalls[0].limiter === 'settings' && authCalls[0].endpoint === 'google-disconnect' && authCalls[0].initData === 'signed', `auth ${show(authCalls)}`);
    assert(row('user', ME)!.googleRefreshToken === '' && row('user', OTHER)!.googleRefreshToken !== '', 'wrong user cleared');
  });

  await check('route: no credential is 401 and nothing happens; a spent limiter is 429 and nothing happens', async () => {
    needRoute();
    seed();
    let res = await post({ deleteCopies: true }, {});
    assert(res.status === 401 && row('user', ME)!.googleRefreshToken !== '' && events.length === 0, `401: ${res.status} ${show(events)}`);
    rateLimited.add('google-disconnect');
    res = await post({ deleteCopies: true });
    assert(res.status === 429 && row('user', ME)!.googleRefreshToken !== '' && events.length === 0, `429: ${res.status} ${show(events)}`);
  });

  await check('route: a body without a boolean deleteCopies is 400 and nothing happens', async () => {
    needRoute();
    seed();
    for (const body of [{}, { deleteCopies: 'yes' }, { deleteCopies: 1 }, null]) {
      const res = await post(body);
      assert(res.status === 400, `${show(body)} answered ${res.status}`);
    }
    assert(row('user', ME)!.googleRefreshToken !== '' && !events.some((e) => e.startsWith('google:') || e.startsWith('revoke')), 'something ran');
  });

  await check('route: the initData may travel in the body, as the other routes accept; a database failure is 500 with a generic error and a Sentry capture', async () => {
    needRoute();
    seed();
    failTransaction = true;
    const res = await post({ deleteCopies: true, initData: 'signed' }, {});
    const body = await res.json();
    assert(res.status === 500 && body.error === 'failed' && captured.some((c) => c.ctx === 'google-disconnect'), `${res.status} ${show(body)} ${show(captured)}`);
    assert(!JSON.stringify(body).includes('database is down'), 'the raw error reached the client');
  });

  console.log = saved.log;
  console.warn = saved.warn;
  console.error = saved.error;
  void logs;

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

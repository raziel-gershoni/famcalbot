// Smoke test for the WhatsApp -> Telegram account merge (redeemLinkCode) and the admin
// hard delete (hardDeleteUser). Since native calendars launched, every new WhatsApp user
// owns a NativeCalendar, and NativeCalendar.owner, NativeEvent.creator and
// Pairing.inviter/invitee are ON DELETE RESTRICT. Both paths deleted the user row with
// those rows still pointing at it, so Postgres refused: linking answered 'unknown' for
// every WhatsApp user created since then, and the admin could not delete any NATIVE or
// paired user. The merge also threw away the WhatsApp user's subscription, activity,
// feedback, usage counter and overrides. Owner decision: move everything over.
//
// account-linking, user-moderation, user-service, subscription-service, the reminder
// cache and event-store run for real. Faked at the boundaries: Prisma (in memory, and it
// enforces the schema: a delete hits ON DELETE RESTRICT / CASCADE / SET NULL as the
// migrations declare them, unique columns stay unique, a foreign key must point at a row,
// and a failed transaction rolls back), Redis (in memory), Telegram and messaging (record
// every send), error capture, and fetch (blocked). No network, no DB.
//
// Checks named [guard] already pass before the fix and must keep passing. The others
// fail until the fix lands.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-account-merge.ts

import path from 'path';
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

// ---- Fake Prisma: in-memory tables that keep the schema's constraints ----

let DB: Record<string, Row[]> = {};
const table = (name: string) => (DB[name] ??= []);

/** Every foreign key in prisma/migrations, with its ON DELETE action. Relations with no
 *  onDelete in schema.prisma (subscription, usage, activity, override, feedback) are
 *  RESTRICT, Prisma's default for a required relation. */
type FK = { from: string; field: string; to: string; onDelete: 'Restrict' | 'Cascade' | 'SetNull' };
const FKS: FK[] = [
  { from: 'user', field: 'pairingId', to: 'pairing', onDelete: 'SetNull' },
  { from: 'nativeCalendar', field: 'ownerUserId', to: 'user', onDelete: 'Restrict' },
  { from: 'nativeEvent', field: 'calendarId', to: 'nativeCalendar', onDelete: 'Cascade' },
  { from: 'nativeEvent', field: 'creatorUserId', to: 'user', onDelete: 'Restrict' },
  { from: 'nativeEvent', field: 'forUserId', to: 'user', onDelete: 'SetNull' },
  { from: 'nativeEventInstance', field: 'seriesEventId', to: 'nativeEvent', onDelete: 'Cascade' },
  { from: 'nativeReminderState', field: 'seriesEventId', to: 'nativeEvent', onDelete: 'Cascade' },
  { from: 'nativeReminderState', field: 'doneByUserId', to: 'user', onDelete: 'SetNull' },
  { from: 'pairing', field: 'inviterUserId', to: 'user', onDelete: 'Restrict' },
  { from: 'pairing', field: 'inviteeUserId', to: 'user', onDelete: 'Restrict' },
  { from: 'pairingInvite', field: 'inviterUserId', to: 'user', onDelete: 'Cascade' },
  { from: 'pairingInvite', field: 'acceptedByUserId', to: 'user', onDelete: 'SetNull' },
  { from: 'subscription', field: 'userId', to: 'user', onDelete: 'Restrict' },
  { from: 'usageCounter', field: 'userId', to: 'user', onDelete: 'Restrict' },
  { from: 'userActivity', field: 'userId', to: 'user', onDelete: 'Restrict' },
  { from: 'userFeatureOverride', field: 'userId', to: 'user', onDelete: 'Restrict' },
  { from: 'userFeedback', field: 'userId', to: 'user', onDelete: 'Restrict' },
];
const UNIQUE: Record<string, string[]> = {
  user: ['telegramId', 'whatsappPhone', 'whatsappBsuid'],
  subscription: ['userId'],
  usageCounter: ['userId'],
  userFeatureOverride: ['userId'],
  pairingInvite: ['token'],
};
/** User ids kept in plain columns with no foreign key. */
const PLAIN_USER_REFS: [string, string][] = [['pairing', 'unlinkedByUserId'], ['oAuthState', 'userId']];

const dbError = (code: string, message: string) => Object.assign(new Error(message), { code });

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
    else if (isPlain(v) && 'set' in v) row[k] = v.set;
    else row[k] = v;
  }
}

/** Unique columns and outgoing foreign keys of one row, as Postgres checks them on a write. */
function validate(name: string, row: Row) {
  for (const col of UNIQUE[name] ?? []) {
    if (row[col] == null) continue;
    if (table(name).some(r => r !== row && r.id !== row.id && same(r[col], row[col]))) {
      throw dbError('P2002', `Unique constraint failed on ${name}.${col}`);
    }
  }
  for (const fk of FKS.filter(f => f.from === name)) {
    if (row[fk.field] == null) continue;
    if (!table(fk.to).some(r => same(r.id, row[fk.field]))) {
      throw dbError('P2003', `Foreign key constraint failed on ${name}.${fk.field} (no ${fk.to} ${row[fk.field]})`);
    }
  }
}

/** DELETE with the migrations' ON DELETE actions: RESTRICT refuses, CASCADE deletes, SET NULL clears. */
function removeRows(name: string, rows: Row[]) {
  if (rows.length === 0) return;
  const ids = rows.map(r => r.id);
  const refsOf = (fk: FK) => table(fk.from).filter(r => ids.some(id => same(r[fk.field], id)));
  for (const fk of FKS.filter(f => f.to === name && f.onDelete === 'Restrict')) {
    const refs = refsOf(fk);
    if (refs.length) {
      throw dbError('P2003', `Foreign key constraint failed on ${fk.from}.${fk.field}: ${name} ${show(ids)} is still referenced by ${show(refs.map(r => r.id))}`);
    }
  }
  DB[name] = table(name).filter(r => !ids.includes(r.id));
  for (const fk of FKS.filter(f => f.to === name && f.onDelete !== 'Restrict')) {
    const refs = refsOf(fk);
    if (fk.onDelete === 'Cascade') removeRows(fk.from, refs);
    else refs.forEach(r => { r[fk.field] = null; });
  }
}

const DEFAULTS: Record<string, () => Row> = {
  nativeCalendar: () => ({ color: '#039BE5', labels: [], rules: [], privacy: 'PRIVATE', isDeleted: false }),
  nativeEvent: () => ({ kind: 'EVENT', forUserId: null, isDeleted: false, exdates: [], rrule: null }),
  pairing: () => ({ unlinkedAt: null, unlinkedByUserId: null, acceptedAt: null, inviteeUserId: null }),
  userFeatureOverride: () => ({ earlyAdopter: false }),
};
let seq = 0;

/** A query runs when awaited, or when $transaction runs it, as a PrismaPromise does. */
function lazy(run: () => unknown): Row {
  let started: Promise<unknown> | undefined;
  const go = () => (started ??= new Promise(resolve => resolve(run())));
  return {
    run: go,
    then: (a?: (v: unknown) => unknown, b?: (e: unknown) => unknown) => go().then(a, b),
    catch: (b: (e: unknown) => unknown) => go().catch(b),
  };
}

function model(name: string): Row {
  const t = () => table(name);
  const create = (data: Row): Row => {
    const now = new Date();
    const id = name === 'user' ? Math.max(0, ...t().map(r => Number(r.id))) + 1 : `${name}-${++seq}`;
    const row: Row = { id, createdAt: now, updatedAt: now, ...(DEFAULTS[name]?.() ?? {}) };
    applyData(row, data);
    validate(name, row);
    t().push(row);
    return row;
  };
  const updateRow = (row: Row, data: Row) => {
    const next = { ...row };
    applyData(next, data);
    validate(name, next);
    Object.assign(row, next, 'updatedAt' in row ? { updatedAt: new Date() } : {});
    return row;
  };
  const impl: Record<string, (a: Row) => unknown> = {
    findUnique: (a = {}) => pick(t().find(r => matches(r, a.where)), a.select),
    findUniqueOrThrow: (a = {}) => {
      const r = t().find(x => matches(x, a.where));
      if (!r) throw dbError('P2025', `No ${name} found`);
      return pick(r, a.select);
    },
    findFirst: (a = {}) => pick(sorted(t().filter(r => matches(r, a.where)), a.orderBy)[0], a.select),
    findMany: (a = {}) => sorted(t().filter(r => matches(r, a.where)), a.orderBy).map(r => pick(r, a.select)),
    count: (a = {}) => t().filter(r => matches(r, a.where)).length,
    create: (a) => pick(create(a.data), a.select),
    update: (a) => {
      const row = t().find(r => matches(r, a.where));
      if (!row) throw dbError('P2025', `No ${name} record was found for an update.`);
      return pick(updateRow(row, a.data), a.select);
    },
    updateMany: (a) => {
      const rows = t().filter(r => matches(r, a.where));
      rows.forEach(r => updateRow(r, a.data));
      return { count: rows.length };
    },
    upsert: (a) => {
      const row = t().find(r => matches(r, a.where));
      return pick(row ? updateRow(row, a.update) : create({ ...a.where, ...a.create }), a.select);
    },
    delete: (a) => {
      const row = t().find(r => matches(r, a.where));
      if (!row) throw dbError('P2025', `No ${name} record to delete`);
      removeRows(name, [row]);
      return row;
    },
    deleteMany: (a = {}) => {
      const rows = t().filter(r => matches(r, a.where));
      removeRows(name, rows);
      return { count: rows.length };
    },
  };
  return Object.fromEntries(Object.entries(impl).map(([k, fn]) => [k, (a: Row) => lazy(() => fn(a))]));
}

const models: Record<string, Row> = {};
let transactions = 0;
const fakePrisma: Row = new Proxy({} as Row, {
  get(_t, prop) {
    if (typeof prop !== 'string' || prop === 'then') return undefined;
    if (prop === '$transaction') {
      // All or nothing: a throw restores the tables as they were when it began.
      return async (arg: unknown) => {
        transactions++;
        const before = structuredClone(DB);
        try {
          if (typeof arg === 'function') return await arg(fakePrisma);
          const out: unknown[] = [];
          for (const op of arg as Row[]) out.push(await op.run());
          return out;
        } catch (err) {
          DB = before;
          throw err;
        }
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
  get: async (k: string) => decode(redisStore.get(k)),
  set: async (k: string, v: unknown, o?: Row) => {
    if (o?.nx && redisStore.has(k)) return null;
    redisStore.set(k, encode(v));
    return 'OK';
  },
  del: async (...ks: unknown[]) => ks.flat().reduce((n: number, k) => n + (redisStore.delete(String(k)) ? 1 : 0), 0),
  scan: async () => [0, []],
  expire: async () => 1,
};
const fakeRedis = new Proxy(redisImpl, {
  get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? (async () => null)),
});

// ---- Telegram / messaging: every send is recorded ----

const sent: { via: string; chatId: unknown }[] = [];
const captured: string[] = [];
const recorder = (prefix: string): Row =>
  new Proxy({} as Row, {
    get: (_t, p) =>
      typeof p !== 'string' || p === 'then'
        ? undefined
        : async (chatId: unknown) => { sent.push({ via: `${prefix}.${p}`, chatId }); return { message_id: 1 }; },
  });

// ---- Boundaries: stubs in require's cache, served to import() by a load hook ----

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
  const capture = (e: unknown, ctx: string) => { captured.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`); };
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
  const bot = recorder('bot');
  const telegram = { getBot: () => bot, initBot: () => bot, getMessagingService: () => recorder('tg'), setUserMenuButton: async () => undefined };
  stub('src/services/telegram/index.ts', telegram);
  stub('src/services/telegram/bot.ts', telegram);
  const messaging = {
    ...nodeRequire(path.join(ROOT, 'src/services/messaging/types.ts')),
    getMessagingService: (platform: unknown) => recorder(String(platform)),
    getTelegramService: () => recorder('telegram'),
    getWhatsAppService: () => recorder('whatsapp'),
    detectPlatform: () => 'telegram',
  };
  stub('src/services/messaging/index.ts', messaging);
  stub('src/services/messaging/factory.ts', messaging);
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`network blocked in smoke: ${String(input)}`);
  }) as typeof fetch;
}

// ---- Fixtures ----

const DAY = 86_400_000;
const days = (n: number) => new Date(Date.now() + n * DAY);
const T = 10; // Telegram user (Telegram 5550010) who sent /connect
const W = 20; // WhatsApp-only user, phone 972500000020
const P = 30; // W's partner
const Q = 40; // T's partner
const PHONE = '972500000020';
const CODE = 'ABC234';

function baseUser(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', culture: 'default',
    messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null, calendarSource: 'NATIVE',
    pairingId: null, remindersEnabled: true, suspendedAt: null, unreachableSince: null, whatsappPhone: null,
    whatsappBsuid: null, telegramId: null, isAdmin: false, globalRules: [],
    createdAt: days(-30), updatedAt: days(-1),
    ...o,
  };
}

const calendar = (id: string, ownerUserId: number, name: string, o: Row = {}): Row => ({
  id, ownerUserId, name, color: '#039BE5', labels: [], rules: [], privacy: 'PRIVATE', isDeleted: false,
  createdAt: days(-20), updatedAt: days(-20), ...o,
});
const event = (id: string, calendarId: string, creatorUserId: number, o: Row = {}): Row => ({
  id, calendarId, creatorUserId, title: id, startsAt: days(2), endsAt: days(2), allDay: false, timeZone: 'Asia/Jerusalem',
  rrule: null, exdates: [], kind: 'EVENT', forUserId: null, isDeleted: false, createdAt: days(-5), updatedAt: days(-5), ...o,
});
const trial = (id: string, userId: number, endsInDays: number): Row => ({
  id, userId, plan: 'FREE', status: 'TRIALING', trialStartedAt: days(endsInDays - 14), trialEndsAt: days(endsInDays),
  currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, compedBy: null, compedAt: null, compReason: null,
  telegramPaymentChargeId: null, createdAt: days(-20), updatedAt: days(-20),
});
const paid = (id: string, userId: number, endsInDays: number): Row => ({
  ...trial(id, userId, -30), plan: 'PRO', status: 'ACTIVE', currentPeriodStart: days(endsInDays - 30), currentPeriodEnd: days(endsInDays),
  telegramPaymentChargeId: `charge-${id}`,
});
const pairing = (id: string, inviterUserId: number, inviteeUserId: number, o: Row = {}): Row => ({
  id, status: 'ACTIVE', inviterUserId, inviteeUserId, acceptedAt: days(-10), unlinkedAt: null, unlinkedByUserId: null,
  createdAt: days(-10), ...o,
});

/**
 * T (Telegram, named "Dana Cohen" from the Telegram profile) and W (WhatsApp-only, named
 * "Dana" from the WhatsApp profile) are the same person. Each got a default calendar at
 * signup: named after the user, labels primary + yours, PRIVATE. W also has a Kids
 * calendar and a soft-deleted one, events, a reminder W marked done, a 3-day trial (T's
 * runs 10 days), a usage counter (T has none), an early-adopter override (T's has none),
 * activity, feedback and an open invite. T has a link code waiting in Redis.
 */
function seed() {
  DB = {};
  redisStore.clear();
  sent.length = 0;
  captured.length = 0;
  transactions = 0;
  DB.user = [
    baseUser({ id: 1, name: 'Admin', telegramId: BigInt(5550001), isAdmin: true }),
    baseUser({ id: T, name: 'Dana Cohen', telegramId: BigInt(5550010) }),
    baseUser({ id: W, name: 'Dana', whatsappPhone: PHONE, messagingPlatform: 'whatsapp', remindersEnabled: false }),
    baseUser({ id: P, name: 'Noam', telegramId: BigInt(5550030) }),
    baseUser({ id: Q, name: 'Ari', telegramId: BigInt(5550040) }),
  ];
  DB.nativeCalendar = [
    calendar('cal-t', T, 'Dana Cohen', { labels: ['primary', 'yours'] }),
    calendar('cal-w', W, 'Dana', { labels: ['primary', 'yours'] }),
    calendar('cal-w-kids', W, 'Kids', { labels: ['kids'] }),
    calendar('cal-w-old', W, 'Old', { isDeleted: true }),
    calendar('cal-p', P, 'Noam', { labels: ['primary', 'yours'] }),
    calendar('cal-q', Q, 'Ari', { labels: ['primary', 'yours'] }),
  ];
  DB.nativeEvent = [
    event('ev-t', 'cal-t', T),
    event('ev-w', 'cal-w', W),
    event('rem-w', 'cal-w', W, { kind: 'REMINDER', armedAt: days(-1) }),
    event('ev-w-kids', 'cal-w-kids', W),
    event('ev-w-old', 'cal-w-old', W),
  ];
  DB.nativeReminderState = [
    { id: 'st-w', seriesEventId: 'rem-w', originalStartsAt: days(2), doneAt: days(-1), doneByUserId: W, pingAttempts: 1, createdAt: days(-1), updatedAt: days(-1) },
  ];
  DB.nativeEventInstance = [];
  DB.pairing = [];
  DB.pairingInvite = [
    { id: 'inv-w', token: 'tok-w', inviterUserId: W, expiresAt: days(6), acceptedAt: null, acceptedByUserId: null, revokedAt: null, createdAt: days(-1) },
  ];
  DB.subscription = [trial('sub-t', T, 10), trial('sub-w', W, 3)];
  DB.usageCounter = [{ id: 'use-w', userId: W, textSummariesUsed: 4, voiceSummariesUsed: 1, voiceEventsCreated: 2, remindersTriggered: 0, cycleStartDate: days(-5), updatedAt: days(-1) }];
  DB.userFeatureOverride = [
    { id: 'ovr-t', userId: T, unlimitedSummaries: true, remindersEnabled: null, voiceEventsEnabled: null, unlimitedCalendars: null, earlyAdopter: false, createdAt: days(-9), updatedAt: days(-9) },
    { id: 'ovr-w', userId: W, unlimitedSummaries: null, remindersEnabled: null, voiceEventsEnabled: null, unlimitedCalendars: null, earlyAdopter: true, createdAt: days(-9), updatedAt: days(-9) },
  ];
  DB.userActivity = [
    { id: 'act-w1', userId: W, action: 'text_summary', metadata: null, createdAt: days(-3) },
    { id: 'act-w2', userId: W, action: 'voice_summary', metadata: null, createdAt: days(-2) },
    { id: 'act-t1', userId: T, action: 'text_summary', metadata: null, createdAt: days(-2) },
  ];
  DB.userFeedback = [{ id: 'fb-w', userId: W, text: 'love it', source: 'telegram', createdAt: days(-2) }];
  DB.oAuthState = [];

  redisStore.set(`link:code:${CODE}`, JSON.stringify({ telegramId: 5550010 }));
  redisStore.set('link:user:5550010', CODE);
  for (const id of [T, W]) redisStore.set(`feature:access:${id}:reminders`, JSON.stringify({ allowed: false }));
  redisStore.set('reminders:users', JSON.stringify([
    { id: T, telegramId: '5550010', googleRefreshToken: '', calendarAssignments: null, defaultReminderMinutes: null, language: 'en', name: 'Dana Cohen', pickupRemindersEnabled: true, calendarSource: 'NATIVE', pairingId: null, location: 'Tel Aviv' },
  ]));
}

/** W paired with P (W invited). W's calendars were auto-shared on pairing; P added an event to W's. */
function pairWithP() {
  DB.pairing.push(pairing('pair-wp', W, P));
  userRow(W).pairingId = 'pair-wp';
  userRow(P).pairingId = 'pair-wp';
  for (const c of DB.nativeCalendar) if ([W, P].includes(c.ownerUserId) && !c.isDeleted) c.privacy = 'SHARED_EDITOR';
  DB.nativeEvent.push(event('ev-p-in-w', 'cal-w', P));
}

/** T paired with Q (Q invited). */
function pairTWithQ() {
  DB.pairing.push(pairing('pair-tq', Q, T));
  userRow(T).pairingId = 'pair-tq';
  userRow(Q).pairingId = 'pair-tq';
  for (const c of DB.nativeCalendar) if ([T, Q].includes(c.ownerUserId) && !c.isDeleted) c.privacy = 'SHARED_EDITOR';
}

const userRow = (id: number) => DB.user.find(u => u.id === id) as Row;
const rowOf = (name: string, id: string) => table(name).find(r => r.id === id);

/** Every row, in any table, that still holds this user id. */
function referencesTo(userId: number): string[] {
  const out: string[] = [];
  for (const fk of FKS.filter(f => f.to === 'user')) {
    for (const r of table(fk.from)) if (same(r[fk.field], userId)) out.push(`${fk.from}.${fk.field} (${r.id})`);
  }
  for (const [name, field] of PLAIN_USER_REFS) {
    for (const r of table(name)) if (r[field] != null && Number(r[field]) === userId) out.push(`${name}.${field} (${r.id})`);
  }
  return out;
}

const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

async function link(): Promise<Row> {
  const { redeemLinkCode } = await load('src/services/account-linking.ts');
  return redeemLinkCode(CODE, PHONE);
}

async function main() {
  installStubs();

  // ---- The fake keeps the schema ----

  await check('#0 [guard] the fake refuses to delete a user who still owns a calendar, as Postgres does, and rolls the transaction back', async () => {
    seed();
    let error = '';
    try {
      await fakePrisma.$transaction(async (tx: Row) => {
        await tx.userFeedback.deleteMany({ where: { userId: W } });
        await tx.user.delete({ where: { id: W } });
      });
    } catch (err) {
      error = (err as Error).message;
    }
    assert(/nativeCalendar\.ownerUserId/.test(error), `error: ${error}`);
    assert(userRow(W) && DB.userFeedback.length === 1, 'the transaction did not roll back');
  });

  // ---- Merge: default calendars, nothing left behind ----

  await check('#1 a WhatsApp-only NATIVE user merges into the Telegram user: success, W\'s default-calendar events land in T\'s default calendar', async () => {
    seed();
    const result = await link();
    assert(result.success === true, `result ${show(result)}; captured ${show(captured)}`);
    assert(!userRow(W), 'W still exists');
    assert(!rowOf('nativeCalendar', 'cal-w'), 'W\'s emptied default calendar is still there');
    for (const id of ['ev-w', 'rem-w']) {
      const ev = rowOf('nativeEvent', id);
      assert(ev?.calendarId === 'cal-t' && ev.creatorUserId === T, `${id}: ${show(ev)}`);
    }
    assert(rowOf('nativeEvent', 'ev-t')?.calendarId === 'cal-t', 'T\'s own event moved');
    assert(rowOf('nativeReminderState', 'st-w')?.doneByUserId === T, `reminder state ${show(rowOf('nativeReminderState', 'st-w'))}`);
    const t = userRow(T);
    assert(t.whatsappPhone === PHONE && t.messagingPlatform === 'all', `T ${show({ whatsappPhone: t.whatsappPhone, messagingPlatform: t.messagingPlatform })}`);
    assert(result.user?.whatsappPhone === PHONE && String(result.user?.telegramId) === '5550010', `returned user ${show(result.user)}`);
  });

  await check('#2 after the merge no row anywhere still holds W\'s id; W\'s other calendars (soft-deleted too) belong to T, and T still has exactly one primary calendar', async () => {
    seed();
    const result = await link();
    assert(result.success === true, `result ${show(result)}`);
    const left = referencesTo(W);
    assert(left.length === 0, `still pointing at W: ${show(left)}`);
    const kids = rowOf('nativeCalendar', 'cal-w-kids');
    const old = rowOf('nativeCalendar', 'cal-w-old');
    assert(kids?.ownerUserId === T && !kids.isDeleted && rowOf('nativeEvent', 'ev-w-kids')?.calendarId === 'cal-w-kids', `kids ${show(kids)}`);
    assert(old?.ownerUserId === T && old.isDeleted === true && rowOf('nativeEvent', 'ev-w-old')?.calendarId === 'cal-w-old', `old ${show(old)}`);
    const primaries = DB.nativeCalendar.filter(c => c.ownerUserId === T && !c.isDeleted && c.labels.includes('primary'));
    assert(primaries.length === 1, `T's primary calendars ${show(primaries.map(c => c.id))}`);
  });

  await check('#3 W\'s usage counter moves (T had none), T\'s override is kept with W\'s early-adopter flag, and W\'s activity and feedback move to T', async () => {
    seed();
    const result = await link();
    assert(result.success === true, `result ${show(result)}`);
    const usage = DB.usageCounter.filter(u => u.userId === T);
    assert(usage.length === 1 && usage[0].id === 'use-w' && usage[0].textSummariesUsed === 4, `usage ${show(DB.usageCounter)}`);
    const ovr = DB.userFeatureOverride;
    assert(ovr.length === 1 && ovr[0].id === 'ovr-t' && ovr[0].earlyAdopter === true && ovr[0].unlimitedSummaries === true, `overrides ${show(ovr)}`);
    assert(DB.userActivity.filter(a => a.userId === T).length === 3, `activity ${show(DB.userActivity)}`);
    assert(rowOf('userFeedback', 'fb-w')?.userId === T, `feedback ${show(DB.userFeedback)}`);
  });

  await check('#4 after the merge the feature-access caches of both ids and the link code are gone', async () => {
    seed();
    const result = await link();
    assert(result.success === true, `result ${show(result)}`);
    const left = [...redisStore.keys()].filter(k => k.startsWith('feature:access:') || k.startsWith('link:'));
    assert(left.length === 0, `Redis keys left: ${show(left)}`);
  });

  // ---- Merge: pairing ----

  await check('#5 W paired, T not: the pairing moves to T, and P still sees and edits everything P saw, its own event included', async () => {
    seed();
    pairWithP();
    const result = await link();
    assert(result.success === true, `result ${show(result)}; captured ${show(captured)}`);
    const pr = rowOf('pairing', 'pair-wp');
    assert(pr?.status === 'ACTIVE' && pr.inviterUserId === T && pr.inviteeUserId === P, `pairing ${show(pr)}`);
    assert(userRow(T).pairingId === 'pair-wp' && userRow(P).pairingId === 'pair-wp', `pairingIds T=${userRow(T).pairingId} P=${userRow(P).pairingId}`);
    const { getCalendarAccess, listVisibleCalendars } = await load('src/services/native-calendar/event-store.ts');
    const ev = rowOf('nativeEvent', 'ev-p-in-w');
    const cal = rowOf('nativeCalendar', ev?.calendarId);
    assert(cal?.ownerUserId === T, `P's event is in ${show(cal)}`);
    const access = await getCalendarAccess({ id: P, pairingId: 'pair-wp' }, cal);
    assert(access === 'editor', `P's access to the calendar holding P's event: ${access}`);
    const visible = (await listVisibleCalendars(P, 'pair-wp')).map((c: Row) => c.id);
    assert(visible.includes(cal.id), `P sees ${show(visible)}`);
    assert(rowOf('nativeCalendar', 'cal-t')?.privacy === 'PRIVATE', 'T\'s private calendar was shared with P');
    const primaries = DB.nativeCalendar.filter(c => c.ownerUserId === T && !c.isDeleted && c.labels.includes('primary'));
    assert(primaries.length === 1, `T's primary calendars ${show(primaries.map(c => c.id))}`);
    const cached = JSON.parse(redisStore.get('reminders:users') ?? '[]').find((u: Row) => u.id === T);
    assert(cached?.pairingId === 'pair-wp', `reminder cache entry for T ${show(cached)}`);
    assert(referencesTo(W).length === 0, `still pointing at W: ${show(referencesTo(W))}`);
  });

  await check('#6 both paired: W is unpaired (P too), T keeps Q, and the merge succeeds', async () => {
    seed();
    pairWithP();
    pairTWithQ();
    const result = await link();
    assert(result.success === true, `result ${show(result)}; captured ${show(captured)}`);
    const wp = rowOf('pairing', 'pair-wp');
    assert(wp?.status === 'UNLINKED' && wp.unlinkedAt instanceof Date, `W's pairing ${show(wp)}`);
    assert(userRow(P).pairingId === null, `P.pairingId ${userRow(P).pairingId}`);
    assert(userRow(T).pairingId === 'pair-tq' && userRow(Q).pairingId === 'pair-tq', `T=${userRow(T).pairingId} Q=${userRow(Q).pairingId}`);
    assert(rowOf('pairing', 'pair-tq')?.status === 'ACTIVE', 'T\'s pairing changed');
    assert(!userRow(W) && referencesTo(W).length === 0, `still pointing at W: ${show(referencesTo(W))}`);
  });

  await check('#7 T on Google: W\'s calendars move soft-deleted (either/or per user) and W\'s pairing is unlinked, not moved', async () => {
    seed();
    pairWithP();
    Object.assign(userRow(T), { calendarSource: 'GOOGLE' });
    rowOf('nativeCalendar', 'cal-t')!.isDeleted = true;
    const result = await link();
    assert(result.success === true, `result ${show(result)}; captured ${show(captured)}`);
    const live = DB.nativeCalendar.filter(c => c.ownerUserId === T && !c.isDeleted);
    assert(live.length === 0, `T has live native calendars ${show(live.map(c => c.id))}`);
    assert(rowOf('nativeEvent', 'ev-w')?.creatorUserId === T, `ev-w ${show(rowOf('nativeEvent', 'ev-w'))}`);
    assert(userRow(T).pairingId === null && rowOf('pairing', 'pair-wp')?.status === 'UNLINKED', `T.pairingId ${userRow(T).pairingId}; pairing ${show(rowOf('pairing', 'pair-wp'))}`);
  });

  // ---- Merge: subscription ----

  await check('#8 W\'s subscription runs longer (paid, 20 days left; T is on a 3-day trial): T ends up with W\'s', async () => {
    seed();
    DB.subscription = [trial('sub-t', T, 3), paid('sub-w', W, 20)];
    const result = await link();
    assert(result.success === true, `result ${show(result)}; captured ${show(captured)}`);
    const subs = DB.subscription.filter(s => s.userId === T);
    assert(subs.length === 1 && subs[0].id === 'sub-w' && subs[0].plan === 'PRO' && subs[0].status === 'ACTIVE', `T's subscriptions ${show(DB.subscription)}`);
  });

  await check('#9 T\'s subscription runs longer (paid, 20 days; W on a 3-day trial): T keeps its own', async () => {
    seed();
    DB.subscription = [paid('sub-t', T, 20), trial('sub-w', W, 3)];
    const result = await link();
    assert(result.success === true, `result ${show(result)}; captured ${show(captured)}`);
    assert(DB.subscription.length === 1 && DB.subscription[0].id === 'sub-t' && DB.subscription[0].userId === T, `subscriptions ${show(DB.subscription)}`);
  });

  await check('#10 a comp never runs out: W comped by an admin beats T\'s 20 paid days', async () => {
    seed();
    DB.subscription = [paid('sub-t', T, 20), { ...paid('sub-w', W, 0), currentPeriodEnd: null, compedBy: 1, compedAt: days(-1) }];
    const result = await link();
    assert(result.success === true, `result ${show(result)}; captured ${show(captured)}`);
    assert(DB.subscription.length === 1 && DB.subscription[0].id === 'sub-w' && DB.subscription[0].userId === T, `subscriptions ${show(DB.subscription)}`);
  });

  // ---- Link without a merge ----

  await check('#11 [guard] no WhatsApp-only user: the phone is set on the Telegram user and the code is spent', async () => {
    seed();
    const { redeemLinkCode } = await load('src/services/account-linking.ts');
    const result = await redeemLinkCode(CODE, '972500000099');
    assert(result.success === true, `result ${show(result)}`);
    const t = userRow(T);
    assert(t.whatsappPhone === '972500000099' && t.messagingPlatform === 'all', `T ${show({ whatsappPhone: t.whatsappPhone, messagingPlatform: t.messagingPlatform })}`);
    assert(!redisStore.has(`link:code:${CODE}`) && !redisStore.has('link:user:5550010'), 'the link code is still there');
    assert(userRow(W).whatsappPhone === PHONE, 'W changed');
  });

  await check('#12 the phone belongs to another Telegram account: phone_in_use, and nothing is merged or deleted', async () => {
    seed();
    userRow(W).telegramId = BigInt(5550020);
    const before = show(DB);
    const result = await link();
    assert(result.success === false && result.error === 'phone_in_use', `result ${show(result)}`);
    assert(show(DB) === before, 'the database changed');
  });

  // ---- Admin hard delete ----

  await check('#13 hardDeleteUser on a paired NATIVE user who also added an event to the partner\'s calendar: it succeeds, and the partner keeps the calendar and both events', async () => {
    seed();
    pairWithP();
    DB.nativeEvent.push(event('ev-w-in-p', 'cal-p', W), event('ev-p', 'cal-p', P));
    // P set a reminder for W; W marked it done. An older pairing W started with Q was unlinked by W.
    DB.nativeEvent.push(event('rem-p-for-w', 'cal-p', P, { kind: 'REMINDER', forUserId: W, armedAt: days(-1) }));
    DB.nativeReminderState.push({ id: 'st-p', seriesEventId: 'rem-p-for-w', originalStartsAt: days(2), doneAt: days(-1), doneByUserId: W, pingAttempts: 1, createdAt: days(-1), updatedAt: days(-1) });
    DB.pairing.push(pairing('pair-old', W, Q, { status: 'UNLINKED', unlinkedAt: days(-12), unlinkedByUserId: W }));
    DB.pairingInvite.push({ id: 'inv-p', token: 'tok-p', inviterUserId: P, expiresAt: days(-3), acceptedAt: days(-10), acceptedByUserId: W, revokedAt: null, createdAt: days(-11) });
    DB.oAuthState.push({ id: 'oauth-w', userId: BigInt(W), token: 'state-w', createdAt: days(0), expiresAt: days(1) });
    redisStore.set('reminders:users', JSON.stringify([{ id: W, telegramId: '5550020' }, { id: P, telegramId: '5550030' }]));

    const { hardDeleteUser } = await load('src/lib/user-moderation.ts');
    await hardDeleteUser(W, 1);

    assert(!userRow(W), 'W still exists');
    assert(rowOf('nativeCalendar', 'cal-p')?.ownerUserId === P, 'P\'s calendar is gone');
    assert(rowOf('nativeEvent', 'ev-p')?.calendarId === 'cal-p', 'P\'s own event is gone');
    const added = rowOf('nativeEvent', 'ev-w-in-p');
    assert(added?.calendarId === 'cal-p' && added.creatorUserId === P, `the event W added to P's calendar: ${show(added)}`);
    assert(!DB.nativeCalendar.some(c => c.ownerUserId === W), 'W\'s calendars are still there');
    assert(userRow(P).pairingId === null && rowOf('pairing', 'pair-wp') === undefined, `P.pairingId ${userRow(P).pairingId}; pairing ${show(rowOf('pairing', 'pair-wp'))}`);
    const left = referencesTo(W);
    assert(left.length === 0, `still pointing at W: ${show(left)}`);
    const cached = JSON.parse(redisStore.get('reminders:users') ?? '[]').map((u: Row) => u.id);
    assert(!cached.includes(W) && cached.includes(P), `reminder cache ${show(cached)}`);
  });

  await check('#14 hardDeleteUser on the invitee of a pairing: the partner is unpaired and the pairing stays as UNLINKED history', async () => {
    seed();
    pairWithP();
    const pr = rowOf('pairing', 'pair-wp')!;
    Object.assign(pr, { inviterUserId: P, inviteeUserId: W });
    const { hardDeleteUser } = await load('src/lib/user-moderation.ts');
    await hardDeleteUser(W, 1);
    assert(!userRow(W), 'W still exists');
    const after = rowOf('pairing', 'pair-wp');
    assert(after?.status === 'UNLINKED' && after.inviterUserId === P && after.inviteeUserId === null, `pairing ${show(after)}`);
    assert(userRow(P).pairingId === null, `P.pairingId ${userRow(P).pairingId}`);
  });

  if (sent.length) results.push({ name: 'nothing is sent to Telegram or WhatsApp', ok: false, reason: show(sent) });

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

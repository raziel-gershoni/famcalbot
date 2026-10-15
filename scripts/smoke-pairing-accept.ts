// Smoke test for accepting a pairing invite: one token or one acceptor can be claimed
// only once even when two accepts race (the service used to read, then write, so two
// accepts of one token both made an ACTIVE pairing); the API accept tells the inviter,
// as the chat accept always did; names go into Telegram HTML escaped; and unlinking
// still takes the partner's access away.
//
// pairing-service, pair-handler, event-store and the accept route run for real. Faked at
// the boundaries: Prisma (in memory; an updateMany checks and sets in one tick, as one
// UPDATE ... WHERE does, and a transaction has no isolation, like READ COMMITTED between
// statements), Redis (in memory), the rate limiter (always allows), Telegram and
// messaging (record every send), error capture, and fetch (blocked). No network, no DB.
//
// Review fix (#6): the names are escaped for Telegram's HTML, so the WhatsApp adapter,
// which turns that HTML into WhatsApp text, decodes the entities again.
//
// Follow-ups: an accept links the two users lowest id first, so A taking B's invite while
// B takes A's no longer locks the two User rows in opposite orders and deadlocks (#7-#9;
// the fake has no locks, so with the old order both sides of #8 lose instead); and the
// chat replies and the inviter's notice are in the recipient's language (#10).
//
// Pairing leftovers: a WhatsApp inviter is told by the famcal_notify template, whose
// button opens the dashboard link, since free-form text outside their 24h window never
// arrives (#6, #10, #11); the loser of a mutual accept, or someone tapping a stale invite
// from their own partner, hears they two are already paired (#12, #13); and unlinking
// sets both people's calendars back to PRIVATE (#14). For #12 the fake now holds a user
// row a transaction wrote until that transaction ends: another transaction's write to it
// waits, then re-checks its where, as an UPDATE waits on a row lock under READ COMMITTED.
// The fake still has no rollback, so the loser's half-made pairing stays behind.
//
// The check named [guard] already passes before the fix and must keep passing. The
// others fail until the fix lands. Numbers follow the design's smoke list.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-pairing-accept.ts

import path from 'path';
import crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
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

/** JSON that can show a BigInt telegramId. */
const show = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));

// ---- Fake Prisma: in-memory tables, any model ----

const DB: Record<string, Row[]> = {};
const prismaCalls: string[] = [];
/** Every write to the user table: the where it used and the row ids it hit. */
const userWrites: { method: string; where: Row; data: Row; hit: number[] }[] = [];

/** The open transaction a call runs in, and when each one ends. */
const currentTx = new AsyncLocalStorage<number>();
const txEnds = new Map<number, Promise<void>>();
let txSeq = 0;
/** User row id -> the open transaction that wrote it. */
const userRowLocks = new Map<number, number>();

/** Wait until no other open transaction holds these user rows, then hold them for this one. */
async function lockUserRows(ids: number[]) {
  const tx = currentTx.getStore();
  if (tx === undefined) return;
  for (const id of ids) {
    let holder: number | undefined;
    while ((holder = userRowLocks.get(id)) !== undefined && holder !== tx) await txEnds.get(holder);
    userRowLocks.set(id, tx);
  }
}

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
    // Checks and sets in one tick, as a single UPDATE ... WHERE does. A user row another
    // open transaction wrote is waited for first, then the where is checked against it.
    updateMany: async (a: Row) => {
      if (name === 'user') {
        const byId = typeof a.where?.id === 'number' ? t().filter(r => r.id === a.where.id) : t().filter(r => matches(r, a.where));
        await lockUserRows(byId.map(r => r.id));
      }
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
        if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
        const tx = ++txSeq;
        let end = () => {};
        txEnds.set(tx, new Promise<void>(r => { end = r; }));
        try {
          return await currentTx.run(tx, () => arg(fakePrisma));
        } finally {
          for (const [id, holder] of userRowLocks) if (holder === tx) userRowLocks.delete(id);
          txEnds.delete(tx);
          end();
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

type Sent = { via: string; platform: string; chatId: unknown; text?: string; options?: Row };
const sent: Sent[] = [];
const captured: string[] = [];

const recorder = (platform: string, prefix: string): Row =>
  new Proxy({} as Row, {
    get: (_t, p) =>
      typeof p !== 'string' || p === 'then'
        ? undefined
        : async (chatId: unknown, ...rest: unknown[]) => {
            sent.push({
              via: `${prefix}.${p}`, platform, chatId,
              text: typeof rest[0] === 'string' ? rest[0] : undefined,
              options: isPlain(rest[1]) ? rest[1] : undefined,
            });
            if (p === 'streamMessage') return { finalize: async () => 1, cancel: async () => undefined, update: async () => undefined };
            return { message_id: 1 };
          },
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
    // Like the real factory: Telegram needs the bot instance, which callers get from ./bot.
    getMessagingService: (platform: unknown, botArg?: unknown) => {
      if (platform === 'telegram' && !botArg) throw new Error('Telegram bot instance required for Telegram adapter');
      return recorder(String(platform), String(platform));
    },
    getTelegramService: () => recorder('telegram', 'telegram'),
    getWhatsAppService: () => recorder('whatsapp', 'whatsapp'),
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
const TOKEN_1 = crypto.randomBytes(32).toString('hex');
const TOKEN_2 = crypto.randomBytes(32).toString('hex');
const TOKEN_3 = crypto.randomBytes(32).toString('hex');

function baseUser(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', culture: 'default',
    messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null, calendarSource: 'NATIVE',
    pairingId: null, remindersEnabled: false, suspendedAt: null, unreachableSince: null, whatsappPhone: null,
    whatsappBsuid: null, telegramId: null, isAdmin: false, globalRules: [], voiceInputEnabled: true,
    createdAt: new Date(Date.now() - 30 * DAY), updatedAt: new Date(Date.now() - DAY),
    ...o,
  };
}

/**
 * Inviters 1 (Dana, Telegram 5550001) and 3 (Ari, Telegram 5550003) each hold an open
 * invite. 2 (Telegram 7770002) and 5 (Telegram 7770005) accept. 2 also holds an open
 * invite, for the mutual accept. All NATIVE, unpaired, English.
 */
function seed() {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  prismaCalls.length = 0;
  userWrites.length = 0;
  sent.length = 0;
  captured.length = 0;
  DB.user = [
    baseUser({ id: 1, name: 'Dana', telegramId: BigInt(5550001) }),
    baseUser({ id: 2, name: 'Noam', telegramId: BigInt(7770002) }),
    baseUser({ id: 3, name: 'Ari', telegramId: BigInt(5550003) }),
    baseUser({ id: 5, name: 'Lior', telegramId: BigInt(7770005) }),
  ];
  const invite = (id: string, token: string, inviterUserId: number): Row => ({
    id, token, inviterUserId, expiresAt: new Date(Date.now() + 6 * DAY),
    acceptedAt: null, acceptedByUserId: null, revokedAt: null, createdAt: new Date(Date.now() - DAY),
  });
  DB.pairingInvite = [invite('inv-1', TOKEN_1, 1), invite('inv-2', TOKEN_2, 2), invite('inv-3', TOKEN_3, 3)];
  DB.pairing = [];
  DB.nativeCalendar = [
    { id: 'cal-1', ownerUserId: 1, name: 'Dana private', color: '#336699', labels: ['primary'], privacy: 'PRIVATE', isDeleted: false, createdAt: new Date(Date.now() - 9 * DAY) },
    { id: 'cal-2', ownerUserId: 2, name: 'Noam', color: '#993366', labels: ['primary'], privacy: 'PRIVATE', isDeleted: false, createdAt: new Date(Date.now() - 8 * DAY) },
  ];
}

const userRow = (id: number) => DB.user.find(u => u.id === id) as Row;
const toChat = (chatId: number) => sent.filter(s => Number(s.chatId) === chatId);
const settle = () => new Promise(r => setTimeout(r, 25));

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

/** 'ok' for a fulfilled accept, else the PairingError code (or the message). */
const outcome = (r: PromiseSettledResult<unknown>) =>
  r.status === 'fulfilled' ? 'ok' : String((r.reason as Row)?.code ?? (r.reason as Error)?.message ?? r.reason);

async function main() {
  installStubs();

  const { NextRequest } = nodeRequire('next/server');

  // ---- Single use under a race ----

  await check('#1 two concurrent accepts of one token (users 2 and 5): one pairs, the other gets INVITE_ALREADY_USED', async () => {
    seed();
    const { acceptInvite } = await load('src/services/pairing-service.ts');
    const got = (await Promise.allSettled([acceptInvite(TOKEN_1, 2), acceptInvite(TOKEN_1, 5)])).map(outcome);
    assert(got.filter(g => g === 'ok').length === 1 && got.includes('INVITE_ALREADY_USED'),
      `outcomes ${show(got)}; ACTIVE pairings ${show(DB.pairing.filter(p => p.status === 'ACTIVE').map(p => [p.inviterUserId, p.inviteeUserId]))}`);
  });

  await check('#2 one acceptor takes two invites at once: one pairs, the other gets INVITEE_ALREADY_PAIRED', async () => {
    seed();
    const { acceptInvite } = await load('src/services/pairing-service.ts');
    const got = (await Promise.allSettled([acceptInvite(TOKEN_1, 5), acceptInvite(TOKEN_3, 5)])).map(outcome);
    assert(got.filter(g => g === 'ok').length === 1 && got.includes('INVITEE_ALREADY_PAIRED'),
      `outcomes ${show(got)}; ACTIVE pairings ${show(DB.pairing.filter(p => p.status === 'ACTIVE').map(p => [p.inviterUserId, p.inviteeUserId]))}`);
  });

  // ---- The inviter hears about it ----

  await check('#3 API accept: the inviter gets exactly one message', async () => {
    seed();
    const { POST } = await load('app/api/pair/accept/route.ts');
    const res: Response = await POST(new NextRequest('http://localhost/api/pair/accept?user_id=7770002', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN_1, initData: initDataFor(7770002) }),
    }));
    await settle();
    assert(res.status === 200, `status ${res.status}`);
    const msgs = toChat(5550001);
    assert(msgs.length === 1, `messages to the inviter (Telegram 5550001): ${show(msgs)}`);
  });

  await check('#4 chat accept: an acceptor named <b>x</b> reaches the inviter escaped (and the inviter\'s name reaches the acceptor escaped)', async () => {
    seed();
    userRow(2).name = '<b>x</b>';
    userRow(1).name = '<i>Dana</i>';
    const { handlePairAccept } = await load('src/services/telegram/pair-handler.ts');
    await handlePairAccept(7770002, 2, TOKEN_1, 'en', 'telegram');
    await settle();
    const toInviter = toChat(5550001).map(m => m.text ?? '');
    assert(toInviter.length === 1, `messages to the inviter: ${show(toInviter)}`);
    assert(toInviter[0].includes('&lt;b&gt;x&lt;/b&gt;') && !toInviter[0].includes('<b>x</b>'), `to the inviter: ${toInviter[0]}`);
    const toAcceptor = toChat(7770002).map(m => m.text ?? '');
    assert(toAcceptor.some(t => t.includes('&lt;i&gt;Dana&lt;/i&gt;')) && !toAcceptor.some(t => t.includes('<i>Dana</i>')),
      `to the acceptor: ${show(toAcceptor)}`);
  });

  // ---- Unlink ----

  await check('#5 [guard] after unlink the partner\'s access to the shared calendar is none', async () => {
    seed();
    const { acceptInvite, unlink } = await load('src/services/pairing-service.ts');
    const { getCalendarAccess } = await load('src/services/native-calendar/event-store.ts');
    await acceptInvite(TOKEN_1, 2);
    const pairingId = userRow(2).pairingId;
    const danaCal = DB.nativeCalendar.find(c => c.id === 'cal-1') as Row;
    const before = await getCalendarAccess({ id: 2, pairingId }, danaCal);
    assert(before === 'editor', `while paired: ${before}`);
    await unlink(1);
    const after = await getCalendarAccess({ id: 2, pairingId: userRow(2).pairingId }, danaCal);
    assert(after === 'none', `after unlink: ${after}`);
    const stale = await getCalendarAccess({ id: 2, pairingId }, danaCal);
    assert(stale === 'none', `after unlink, with the old pairingId: ${stale}`);
  });

  // ---- WhatsApp recipients (review fix) ----

  await check('#6 WhatsApp reads names as typed: "Dana & Roy <3" reaches a WhatsApp acceptor (chat accept) with no &amp;; the WhatsApp inviter (API accept) gets the notify template, not text', async () => {
    const { WhatsAppAdapter } = await load('src/services/messaging/whatsapp-adapter.ts');
    const { MessageFormat } = await load('src/services/messaging/types.ts');
    const shownOnWhatsApp = (text: string): string => new WhatsAppAdapter('test', 'test').formatText(text, MessageFormat.HTML);
    const NAME = 'Dana & Roy <3';
    const problems: string[] = [];

    // API accept: the WhatsApp inviter (1) is told by the template, which carries no name
    seed();
    Object.assign(userRow(1), { messagingPlatform: 'whatsapp', whatsappPhone: '972500000001' });
    userRow(2).name = NAME;
    const { POST } = await load('app/api/pair/accept/route.ts');
    const res: Response = await POST(new NextRequest('http://localhost/api/pair/accept?user_id=7770002', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN_1, initData: initDataFor(7770002) }),
    }));
    await settle();
    if (res.status !== 200) problems.push(`API accept: status ${res.status}`);
    const toInviter = sent.filter(m => m.platform === 'whatsapp' && String(m.chatId) === '972500000001');
    if (toInviter.length !== 1 || toInviter[0].text || toInviter[0].options?.whatsappTemplate?.name !== 'famcal_notify_en') {
      problems.push(`the WhatsApp inviter got ${show(toInviter)}`);
    }

    // Chat accept on WhatsApp: the acceptor (2) is told the inviter's name
    seed();
    userRow(1).name = NAME;
    Object.assign(userRow(2), { messagingPlatform: 'whatsapp', whatsappPhone: '972500000002' });
    const { handlePairAccept } = await load('src/services/telegram/pair-handler.ts');
    await handlePairAccept('972500000002', 2, TOKEN_1, 'en', 'whatsapp');
    await settle();
    const toAcceptor = sent.filter(m => m.platform === 'whatsapp' && String(m.chatId) === '972500000002').map(m => shownOnWhatsApp(m.text ?? ''));
    if (!toAcceptor.some(t => t.includes(NAME))) problems.push(`the WhatsApp acceptor reads ${show(toAcceptor)}`);

    assert(problems.length === 0, problems.join('; '));
  });

  // ---- Mutual accept: users are linked lowest id first ----

  await check('#7 both directions (2 takes 1\'s invite; 1 takes 2\'s) link user 1 first, then 2, each only while unpaired and NATIVE', async () => {
    const { acceptInvite } = await load('src/services/pairing-service.ts');
    const problems: string[] = [];
    for (const [token, acceptor] of [[TOKEN_1, 2], [TOKEN_2, 1]] as const) {
      seed();
      await acceptInvite(token, acceptor);
      const links = userWrites.filter(w => w.method === 'updateMany');
      const order = links.flatMap(w => w.hit);
      if (show(order) !== show([1, 2])) problems.push(`user ${acceptor} accepting linked ${show(order)}`);
      const loose = links.filter(w => w.where.pairingId !== null || w.where.calendarSource !== 'NATIVE');
      if (loose.length) problems.push(`user ${acceptor} accepting linked with ${show(loose.map(w => w.where))}`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#8 mutual accept at once (2 takes 1\'s invite while 1 takes 2\'s): one pairs, the other gets a PairingError, and 1 and 2 share one pairing', async () => {
    seed();
    const { acceptInvite, PairingError } = await load('src/services/pairing-service.ts');
    const settled = await Promise.allSettled([acceptInvite(TOKEN_1, 2), acceptInvite(TOKEN_2, 1)]);
    const got = settled.map(outcome);
    const strays = settled.filter(r => r.status === 'rejected' && !(r.reason instanceof PairingError));
    assert(got.filter(g => g === 'ok').length === 1 && strays.length === 0
      && userRow(1).pairingId != null && userRow(1).pairingId === userRow(2).pairingId,
    `outcomes ${show(got)}; pairingId of 1 ${userRow(1).pairingId}, of 2 ${userRow(2).pairingId}`);
  });

  await check('#9 [guard] a user someone else paired between the read and the link gets the error for their role, in both directions', async () => {
    const { acceptInvite } = await load('src/services/pairing-service.ts');
    const cases = [
      { token: TOKEN_1, acceptor: 2, pairedMeanwhile: 1, want: 'INVITER_ALREADY_PAIRED' },
      { token: TOKEN_1, acceptor: 2, pairedMeanwhile: 2, want: 'INVITEE_ALREADY_PAIRED' },
      { token: TOKEN_2, acceptor: 1, pairedMeanwhile: 2, want: 'INVITER_ALREADY_PAIRED' },
      { token: TOKEN_2, acceptor: 1, pairedMeanwhile: 1, want: 'INVITEE_ALREADY_PAIRED' },
    ];
    const users = fakePrisma.user as Row;
    const realUpdateMany = users.updateMany;
    const problems: string[] = [];
    try {
      for (const c of cases) {
        seed();
        // Another accept commits just as this one starts linking: its first link sees
        // the user already paired.
        let fired = false;
        users.updateMany = (a: Row) => {
          if (!fired) { fired = true; userRow(c.pairedMeanwhile).pairingId = 'pairing-elsewhere'; }
          return realUpdateMany(a);
        };
        const got = outcome((await Promise.allSettled([acceptInvite(c.token, c.acceptor)]))[0]);
        if (got !== c.want) problems.push(`user ${c.acceptor} accepting, ${c.pairedMeanwhile} paired meanwhile: ${got}, want ${c.want}`);
      }
    } finally {
      users.updateMany = realUpdateMany;
    }
    assert(problems.length === 0, problems.join('; '));
  });

  // ---- Chat pairing text in the recipient's language ----

  await check('#10 he and ru users read the accept reply, an error and the inviter\'s notice (on WhatsApp the template) in their own language, on Telegram and WhatsApp and from the API accept', async () => {
    const { WhatsAppAdapter } = await load('src/services/messaging/whatsapp-adapter.ts');
    const { MessageFormat } = await load('src/services/messaging/types.ts');
    const { handlePairAccept } = await load('src/services/telegram/pair-handler.ts');
    const { POST } = await load('app/api/pair/accept/route.ts');
    const shownOnWhatsApp = (text: string): string => new WhatsAppAdapter('test', 'test').formatText(text, MessageFormat.HTML);
    const script: Record<string, RegExp> = { he: /[֐-׿]/, ru: /[Ѐ-ӿ]/ };
    const problems: string[] = [];

    // The acceptor's language differs from the inviter's, so each message must follow its own reader.
    for (const r of [
      { platform: 'telegram', acceptorLang: 'he', inviterLang: 'ru', acceptorChat: '7770002', inviterChat: '5550001' },
      { platform: 'whatsapp', acceptorLang: 'ru', inviterLang: 'he', acceptorChat: '972500000002', inviterChat: '972500000001' },
    ]) {
      seed();
      Object.assign(userRow(1), { language: r.inviterLang, name: 'Dana & Roy' });
      Object.assign(userRow(2), { language: r.acceptorLang, name: 'Noam & Co' });
      if (r.platform === 'whatsapp') {
        Object.assign(userRow(1), { messagingPlatform: 'whatsapp', whatsappPhone: r.inviterChat });
        Object.assign(userRow(2), { messagingPlatform: 'whatsapp', whatsappPhone: r.acceptorChat });
      }
      const amp = r.platform === 'whatsapp' ? '&' : '&amp;';
      const read = (chat: string) => sent.filter(m => String(m.chatId) === chat)
        .map(m => (r.platform === 'whatsapp' ? shownOnWhatsApp(m.text ?? '') : m.text ?? ''));
      const chatId = r.platform === 'whatsapp' ? r.acceptorChat : Number(r.acceptorChat);
      await handlePairAccept(chatId, 2, TOKEN_1, r.acceptorLang, r.platform);
      await settle();
      await handlePairAccept(chatId, 2, TOKEN_1, r.acceptorLang, r.platform); // used by now
      await settle();
      const [success, error] = read(r.acceptorChat);
      const where = `${r.platform}, acceptor ${r.acceptorLang}, inviter ${r.inviterLang}`;
      if (!success || !script[r.acceptorLang].test(success) || !success.includes(`Dana ${amp} Roy`)) problems.push(`${where}: accept reply ${show(success)}`);
      if (!error || !script[r.acceptorLang].test(error) || error === success) problems.push(`${where}: error ${show(error)}`);
      if (r.platform === 'whatsapp') {
        const notices = sent.filter(m => String(m.chatId) === r.inviterChat);
        const template = notices[0]?.options?.whatsappTemplate;
        if (notices.length !== 1 || notices[0].text || template?.name !== `famcal_notify_${r.inviterLang}` || template?.language !== r.inviterLang) {
          problems.push(`${where}: inviter notice ${show(notices)}`);
        }
      } else {
        const notices = read(r.inviterChat);
        if (notices.length !== 1 || !script[r.inviterLang].test(notices[0]) || !notices[0].includes(`Noam ${amp} Co`)) problems.push(`${where}: inviter notice ${show(notices)}`);
      }
    }

    // API accept by a user with no name: the Russian inviter's notice has no English stand-in
    seed();
    userRow(1).language = 'ru';
    userRow(2).name = '';
    const res: Response = await POST(new NextRequest('http://localhost/api/pair/accept?user_id=7770002', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN_1, initData: initDataFor(7770002) }),
    }));
    await settle();
    const notice = toChat(5550001).map(m => m.text ?? '');
    if (res.status !== 200 || notice.length !== 1 || !script.ru.test(notice[0]) || /[A-Za-z]/.test(notice[0])) {
      problems.push(`API accept, nameless acceptor: status ${res.status}, notice ${show(notice)}`);
    }

    assert(problems.length === 0, problems.join('; '));
  });

  // ---- Pairing leftovers ----

  await check('#11 a WhatsApp inviter gets only the famcal_notify template, in their language, its button carrying "settings", which a tap answers with the dashboard link; a Telegram inviter still gets the text', async () => {
    const { notifyInviterOfAccept } = await load('src/services/telegram/pair-handler.ts');
    const problems: string[] = [];
    for (const [language, want] of [['en', 'en'], ['he', 'he'], ['ru', 'ru'], ['fr', 'en']] as const) {
      seed();
      Object.assign(userRow(1), { messagingPlatform: 'whatsapp', whatsappPhone: '+972500000001', language });
      await notifyInviterOfAccept(1, 'Noam');
      const got = sent.filter(m => String(m.chatId) === '+972500000001');
      if (got.length !== 1 || got[0].platform !== 'whatsapp' || got[0].text
        || show(got[0].options?.whatsappTemplate) !== show({ name: `famcal_notify_${want}`, language: want, buttonPayload: 'settings' })) {
        problems.push(`WhatsApp inviter in ${language}: ${show(got)}`);
      }
    }

    // The tap: WhatsApp sends the button's payload back as a message from the inviter
    const { handleWhatsAppWebhook } = await load('src/services/webhook-handlers.ts');
    sent.length = 0;
    const tap = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: {
        contacts: [{ profile: { name: 'Dana' }, wa_id: '972500000001' }],
        messages: [{ from: '972500000001', id: 'wamid.tap-1', timestamp: '0', type: 'button', button: { payload: 'settings', text: 'Open' } }],
      } }] }],
    };
    const quiet = console.log;
    console.log = () => undefined;
    try {
      await handleWhatsAppWebhook({ body: tap }, { status: () => ({ json: () => undefined }) });
    } finally {
      console.log = quiet;
    }
    const answer = sent.filter(m => String(m.chatId) === '+972500000001');
    if (answer.length !== 1 || !String(answer[0].options?.whatsappUrlButton?.url ?? '').includes('/api/auth/magic?token=')) {
      problems.push(`the tap was answered with ${show(answer)}`);
    }

    seed();
    await notifyInviterOfAccept(1, 'Noam');
    const tg = toChat(5550001);
    if (tg.length !== 1 || tg[0].options?.whatsappTemplate || !tg[0].text?.includes('Noam accepted your invite')) problems.push(`Telegram inviter: ${show(tg)}`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#12 mutual accept at once: the loser gets ALREADY_PAIRED_TOGETHER (service, chat and API), and only the winner\'s inviter is told', async () => {
    const { acceptInvite } = await load('src/services/pairing-service.ts');
    const { handlePairAccept } = await load('src/services/telegram/pair-handler.ts');
    const { POST } = await load('app/api/pair/accept/route.ts');
    const problems: string[] = [];
    const isNotice = (m: Sent) => /accepted your invite/.test(m.text ?? '');

    seed();
    const got = (await Promise.allSettled([acceptInvite(TOKEN_1, 2), acceptInvite(TOKEN_2, 1)])).map(outcome);
    if (show([...got].sort()) !== show(['ALREADY_PAIRED_TOGETHER', 'ok']) || !userRow(1).pairingId || userRow(1).pairingId !== userRow(2).pairingId) {
      problems.push(`service: outcomes ${show(got)}, pairingId of 1 ${userRow(1).pairingId}, of 2 ${userRow(2).pairingId}`);
    }

    seed();
    await Promise.all([handlePairAccept(7770002, 2, TOKEN_1, 'en', 'telegram'), handlePairAccept(5550001, 1, TOKEN_2, 'en', 'telegram')]);
    await settle();
    const together = sent.filter(m => /You two are already paired/.test(m.text ?? ''));
    if (together.length !== 1 || sent.filter(isNotice).length !== 1) problems.push(`chat: ${show(sent.map(m => [m.chatId, m.text]))}`);

    seed();
    const post = (tgId: number, token: string) => POST(new NextRequest(`http://localhost/api/pair/accept?user_id=${tgId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, initData: initDataFor(tgId) }),
    })) as Promise<Response>;
    const responses = await Promise.all([post(7770002, TOKEN_1), post(5550001, TOKEN_2)]);
    await settle();
    const answers = await Promise.all(responses.map(async r => `${r.status} ${(await r.json()).error ?? 'ok'}`));
    if (show([...answers].sort()) !== show(['200 ok', '400 ALREADY_PAIRED_TOGETHER']) || sent.filter(isNotice).length !== 1) {
      problems.push(`API: ${show(answers)}, notices ${show(sent.filter(isNotice))}`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#13 a stale invite between two people already paired gives ALREADY_PAIRED_TOGETHER both ways (in en/he/ru, unlike "paired with someone"), and tells the inviter nothing; a third party still gets the old codes', async () => {
    const { acceptInvite } = await load('src/services/pairing-service.ts');
    const { handlePairAccept } = await load('src/services/telegram/pair-handler.ts');
    const { POST } = await load('app/api/pair/accept/route.ts');
    const problems: string[] = [];
    /** 1 and 2 paired before; their old invites (and 3's) are still open. */
    const pairedSeed = () => {
      seed();
      DB.pairing.push({ id: 'pairing-12', status: 'ACTIVE', inviterUserId: 1, inviteeUserId: 2, acceptedAt: new Date(Date.now() - DAY), unlinkedAt: null, unlinkedByUserId: null });
      userRow(1).pairingId = 'pairing-12';
      userRow(2).pairingId = 'pairing-12';
    };

    for (const c of [
      { token: TOKEN_2, acceptor: 1, want: 'ALREADY_PAIRED_TOGETHER' },
      { token: TOKEN_1, acceptor: 2, want: 'ALREADY_PAIRED_TOGETHER' },
      { token: TOKEN_1, acceptor: 5, want: 'INVITER_ALREADY_PAIRED' },
      { token: TOKEN_3, acceptor: 2, want: 'INVITEE_ALREADY_PAIRED' },
    ]) {
      pairedSeed();
      const got = outcome((await Promise.allSettled([acceptInvite(c.token, c.acceptor)]))[0]);
      if (got !== c.want || DB.pairing.length !== 1) problems.push(`user ${c.acceptor} taking ${c.token === TOKEN_1 ? 1 : c.token === TOKEN_2 ? 2 : 3}'s invite: ${got}, want ${c.want}; pairings ${DB.pairing.length}`);
    }

    // The chat reply, on Telegram and WhatsApp: user 1 taps 2's invite (together), then 3's
    // (1 is paired with someone); 5 taps 1's (the inviter is paired with someone)
    const script: Record<string, RegExp> = { en: /You two are already paired/, he: /[֐-׿]/, ru: /[Ѐ-ӿ]/ };
    for (const platform of ['telegram', 'whatsapp']) {
      for (const lang of ['en', 'he', 'ru']) {
        const [chat1, chat5] = platform === 'whatsapp' ? ['+972500000001', '+972500000005'] : [5550001, 7770005];
        pairedSeed();
        await handlePairAccept(chat1, 1, TOKEN_2, lang, platform);
        await handlePairAccept(chat1, 1, TOKEN_3, lang, platform);
        await handlePairAccept(chat5, 5, TOKEN_1, lang, platform);
        await settle();
        const [together, inviteeElsewhere] = sent.filter(m => String(m.chatId) === String(chat1)).map(m => m.text ?? '');
        const inviterElsewhere = sent.filter(m => String(m.chatId) === String(chat5)).map(m => m.text ?? '');
        if (sent.length !== 3 || !together || !script[lang].test(together) || together === inviteeElsewhere || together === inviterElsewhere[0]) {
          problems.push(`${platform} ${lang}: ${show(sent.map(m => [m.chatId, m.text]))}`);
        }
      }
    }

    pairedSeed();
    const res: Response = await POST(new NextRequest('http://localhost/api/pair/accept?user_id=7770002', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN_1, initData: initDataFor(7770002) }),
    }));
    await settle();
    const body = await res.json();
    if (res.status !== 400 || body.error !== 'ALREADY_PAIRED_TOGETHER' || toChat(5550001).length) problems.push(`API: ${res.status} ${show(body)}, to the inviter ${show(toChat(5550001))}`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#14 unlink sets every calendar of both people back to PRIVATE, after the users as accept does; neither sees the other\'s calendars; others\' calendars and a failed unlink change nothing', async () => {
    seed();
    const at = new Date(Date.now() - 7 * DAY);
    DB.nativeCalendar.push(
      { id: 'cal-2b', ownerUserId: 2, name: 'Noam work', color: '#000000', labels: [], privacy: 'SHARED_VIEWER', isDeleted: false, createdAt: at },
      { id: 'cal-2c', ownerUserId: 2, name: 'Noam old', color: '#000000', labels: [], privacy: 'SHARED_EDITOR', isDeleted: true, createdAt: at },
      { id: 'cal-3', ownerUserId: 3, name: 'Ari', color: '#000000', labels: ['primary'], privacy: 'SHARED_EDITOR', isDeleted: false, createdAt: at },
    );
    const { acceptInvite, unlink } = await load('src/services/pairing-service.ts');
    const { listVisibleCalendars } = await load('src/services/native-calendar/event-store.ts');
    const problems: string[] = [];
    const usersThenCalendars = (calls: string[]) => {
      const lastUser = calls.lastIndexOf('user.updateMany');
      const calendars = calls.indexOf('nativeCalendar.updateMany');
      return lastUser >= 0 && calendars > lastUser;
    };

    prismaCalls.length = 0;
    await acceptInvite(TOKEN_1, 2);
    if (!usersThenCalendars(prismaCalls)) problems.push(`accept wrote ${show(prismaCalls)}`);
    const pairingId = userRow(1).pairingId;
    if (!(await listVisibleCalendars(2, pairingId)).some((c: Row) => c.id === 'cal-1')) problems.push('while paired 2 does not see cal-1');

    prismaCalls.length = 0;
    const result = await unlink(2);
    if (show(result) !== show({ partnerUserId: 1 })) problems.push(`unlink returned ${show(result)}`);
    if (!usersThenCalendars(prismaCalls)) problems.push(`unlink wrote ${show(prismaCalls)}`);
    const privacy = Object.fromEntries(DB.nativeCalendar.map(c => [c.id, c.privacy]));
    const want = { 'cal-1': 'PRIVATE', 'cal-2': 'PRIVATE', 'cal-2b': 'PRIVATE', 'cal-2c': 'PRIVATE', 'cal-3': 'SHARED_EDITOR' };
    if (show(privacy) !== show(want)) problems.push(`after unlink ${show(privacy)}`);
    for (const [viewer, other] of [[1, 2], [2, 1]]) {
      for (const pid of [userRow(viewer).pairingId, pairingId]) {
        const seen = (await listVisibleCalendars(viewer, pid)).filter((c: Row) => c.ownerUserId === other);
        if (seen.length) problems.push(`${viewer} (pairingId ${pid}) still sees ${show(seen.map((c: Row) => c.id))}`);
      }
    }

    const notPaired = outcome((await Promise.allSettled([unlink(3)]))[0]);
    if (notPaired !== 'NOT_PAIRED' || DB.nativeCalendar.find(c => c.id === 'cal-3')?.privacy !== 'SHARED_EDITOR') {
      problems.push(`unlink of unpaired 3: ${notPaired}, cal-3 ${DB.nativeCalendar.find(c => c.id === 'cal-3')?.privacy}`);
    }
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

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
// The check named [guard] already passes before the fix and must keep passing. The
// others fail until the fix lands. Numbers follow the design's smoke list.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-pairing-accept.ts

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
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`network blocked in smoke: ${String(input)}`);
  }) as typeof fetch;
}

// ---- Fixtures ----

const DAY = 86_400_000;
const TOKEN_1 = crypto.randomBytes(32).toString('hex');
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
 * invite. 2 (Telegram 7770002) and 5 (Telegram 7770005) accept. All NATIVE, unpaired.
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
  DB.pairingInvite = [invite('inv-1', TOKEN_1, 1), invite('inv-3', TOKEN_3, 3)];
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

  await check('#6 WhatsApp reads names as typed: "Dana & Roy <3" reaches a WhatsApp inviter (API accept) and acceptor (chat accept) with no &amp;', async () => {
    const { WhatsAppAdapter } = await load('src/services/messaging/whatsapp-adapter.ts');
    const { MessageFormat } = await load('src/services/messaging/types.ts');
    const shownOnWhatsApp = (text: string): string => new WhatsAppAdapter('test', 'test').formatText(text, MessageFormat.HTML);
    const NAME = 'Dana & Roy <3';
    const problems: string[] = [];

    // API accept: the WhatsApp inviter (1) is told the acceptor's name
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
    const toInviter = sent.filter(m => m.platform === 'whatsapp' && String(m.chatId) === '972500000001').map(m => shownOnWhatsApp(m.text ?? ''));
    if (toInviter.length !== 1 || !toInviter[0].includes(NAME)) problems.push(`the WhatsApp inviter reads ${show(toInviter)}`);

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

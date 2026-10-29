// Smoke test for what a Telegram Stars payment credits, and when the paid month ends (the legal-app review's concerns 5
// and 6; the final review's I-1, I-2 and M-1; CLAUDE.md's wall-time rule):
//
//  - M1 a paid month ends one calendar month after the payment, at the same wall time on the person's clock
//    (getSubscriptionEndDate, through src/utils/wall-time.ts): a month with a clock change (31 days and an hour), the
//    31st into a 30-day month, 31 January into February (28 days, 29 in a leap year), December into January, a wall
//    time the clocks skip that day (moved forward by the jump), New York; the same instants whatever zone the server
//    runs in (the smoke re-runs M1 and M2 under three process zones).
//  - M2 the subscription code moves no Date by its local fields, and a new usage counter starts on the 1st at 00:00 on
//    Israel's clock.
//  - M3 a payment credits the month to that end, in the person's zone, writes its one Payment row (the charge id, the
//    plan, the Stars, the month), and the one confirmation shows that day and time.
//  - R1 a repeated successful_payment for the same charge (Telegram delivering the update again) credits once, writes
//    one row and sends one confirmation, one after the other or at the same time; the paid month isn't moved by the
//    repeat; a new charge credits again, with a row of its own.
//  - R2 a zone lookup that doesn't answer never holds the webhook's answer: the payment is credited and confirmed within
//    the screens' own wait (TZ_LOOKUP_MS), in Israel's zone, and the fallback is logged; one that throws is logged too.
//  - R3 the same charge delivered again after it was refunded credits nothing and confirms nothing.
//  - P1 every way to pay stores the plan paid for: a new person, a trial (Basic or Pro), an upgrade, a renewal, an old
//    renewal invoice paid after the plan lapsed, an old Basic invoice paid while on Pro, a payment over a free gift.
//  - E1 a credit that fails before it commits (the row's insert, or the subscription's update) writes nothing, tells
//    the person nothing and throws, so the webhook answers 500 and Telegram delivers it again; that delivery credits
//    once. The webhook route answers a throw with 500.
//  - E2 a confirmation that fails after the credit is logged and captured, and the short fallback goes out in the
//    person's language, as plain text; the credit stays, and nothing says activation failed.
//  - E3 a payload that can't be read, and a payer the bot doesn't know, are answered with the activation error (in
//    the person's language when known), captured, and credit nothing; no copy is written in the handler itself.
//
// The real payment handler, subscription service and zone lookup (src/lib/timezone.ts) run over a fake Prisma (the
// subscription, usage and payment rows; updateMany's where read as Postgres reads it; the payment's unique charge id;
// a transaction that runs one at a time and puts every row back when it throws) and a fake Redis; the bot, analytics
// and error capture are recorded. No network, no database.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-payment-credit.ts

import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const CHILD = process.env.SMOKE_ZONE_CHILD === '1';

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
const show = (v: unknown) => JSON.stringify(v);

// ---- Boundaries ----

const sent: { chatId: unknown; text: string; options?: Row }[] = [];
const logs: string[] = [];
const captured: string[] = [];
let zoneMode: 'cached' | 'hang' | 'throw' = 'cached';
const ZONES: Record<number, string> = { 11: 'America/New_York', 12: 'Asia/Jerusalem' };
const USERS: Row[] = [
  { id: 11, telegramId: BigInt(5011), language: 'en', location: 'New York', googleRefreshToken: null },
  { id: 12, telegramId: BigInt(5012), language: 'he', location: 'Haifa', googleRefreshToken: null },
];

type TableName = 'subscription' | 'usageCounter' | 'payment';
let DB: Record<TableName, Row[]> = { subscription: [], usageCounter: [], payment: [] };
const copy = <T>(row: T): T => (row ? structuredClone(row) : row);
/** A where as Postgres reads it: OR, a plain value, and { not: x } (NULL <> x is not true, so NULL never matches). */
const matches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return (want as Row[]).some((w) => matches(row, w));
    if (want && typeof want === 'object' && !(want instanceof Date) && 'not' in want) return row[key] !== null && row[key] !== undefined && row[key] !== want.not;
    return row[key] === want;
  });
/** A model call that throws while listed ("payment.createMany"): the database failing. */
const failing = new Set<string>();
const guard = (name: string, method: string) => {
  if (failing.has(`${name}.${method}`)) throw new Error(`${name}.${method} failed (smoke)`);
};
let seq = 0;
const table = (name: TableName) => ({
  findUnique: async ({ where }: Row) => copy(DB[name].find((r) => matches(r, where)) ?? null),
  findUniqueOrThrow: async ({ where }: Row) => {
    const row = DB[name].find((r) => matches(r, where));
    if (!row) throw new Error(`no ${name} for ${show(where)}`);
    return copy(row);
  },
  findFirst: async ({ where }: Row) => copy(DB[name].find((r) => matches(r, where)) ?? null),
  findMany: async ({ where }: Row = {}) => DB[name].filter((r) => matches(r, where ?? {})).map(copy),
  create: async ({ data }: Row) => {
    guard(name, 'create');
    const row = { id: `${name}-${++seq}`, telegramPaymentChargeId: null, currentPeriodStart: null, currentPeriodEnd: null, compedBy: null, ...data };
    DB[name].push(row);
    return copy(row);
  },
  /** INSERT … ON CONFLICT DO NOTHING on the payment's unique charge id (skipDuplicates). */
  createMany: async ({ data, skipDuplicates }: Row) => {
    guard(name, 'createMany');
    let count = 0;
    for (const item of data as Row[]) {
      const clash = name === 'payment' && DB.payment.some((r) => r.telegramPaymentChargeId === item.telegramPaymentChargeId);
      if (clash && skipDuplicates) continue;
      if (clash) throw new Error('Unique constraint failed on the fields: (`telegramPaymentChargeId`)');
      DB[name].push({ id: `${name}-${++seq}`, refundedAt: null, createdAt: new Date(), ...item });
      count++;
    }
    return { count };
  },
  update: async ({ where, data }: Row) => {
    guard(name, 'update');
    const row = DB[name].find((r) => matches(r, where));
    if (!row) throw new Error(`no ${name} for ${show(where)}`);
    Object.assign(row, data);
    return copy(row);
  },
  updateMany: async ({ where, data }: Row) => {
    guard(name, 'updateMany');
    const rows = DB[name].filter((r) => matches(r, where));
    for (const row of rows) Object.assign(row, data);
    return { count: rows.length };
  },
  upsert: async ({ where, update, create }: Row) => {
    guard(name, 'upsert');
    const row = DB[name].find((r) => matches(r, where));
    if (row) return copy(Object.assign(row, update));
    const made = { id: `${name}-${++seq}`, ...create };
    DB[name].push(made);
    return copy(made);
  },
});
const models = { subscription: table('subscription'), usageCounter: table('usageCounter'), payment: table('payment') };
/**
 * The root client's models refuse a call made inside a transaction's own callback: Prisma runs such a call on another
 * connection, outside the transaction, so it would neither wait for it nor roll back with it.
 */
const inTx = new AsyncLocalStorage<boolean>();
const rootModels = Object.fromEntries(Object.entries(models).map(([name, model]) => [name, Object.fromEntries(Object.entries(model).map(([method, fn]) => [method, (...args: unknown[]) => {
  if (inTx.getStore()) throw new Error(`prisma.${name}.${method} used inside an interactive transaction (use tx)`);
  return (fn as (...a: unknown[]) => unknown)(...args);
}]))])) as unknown as typeof models;
/** Transactions run one at a time, as two inserts of one unique charge id do in Postgres; a throw puts every row back. */
let txQueue: Promise<unknown> = Promise.resolve();
const prisma = {
  ...rootModels,
  user: { findUnique: async ({ where }: Row) => USERS.find((u) => u.id === where.id) ?? null },
  $transaction: (fn: (tx: typeof models) => Promise<unknown>) => {
    const run = txQueue.then(async () => {
      const before = structuredClone(DB);
      try {
        return await inTx.run(true, () => fn(models));
      } catch (error) {
        DB = before;
        throw error;
      }
    });
    txQueue = run.catch(() => undefined);
    return run;
  },
};

const redis = {
  get: async (key: string) => {
    if (zoneMode === 'hang') return new Promise(() => undefined);
    if (zoneMode === 'throw') throw new Error('redis down (smoke)');
    const id = Number(/(\d+)/.exec(key)?.[1]);
    return /tz/i.test(key) ? (ZONES[id] ?? null) : null;
  },
  set: async () => 'OK',
  del: async () => 1,
};
/** Which sends throw (Telegram refusing a message), while it is set. */
let sendFails: ((text: string, options?: Row) => boolean) | null = null;
const messaging = {
  sendMessage: async (chatId: unknown, text: string, options?: Row) => {
    if (sendFails?.(text, options)) throw new Error('ETELEGRAM: 502 Bad Gateway (smoke)');
    sent.push({ chatId, text, options });
  },
};

const stubs: Record<string, object> = {
  [`${SRC}/utils/prisma.ts`]: { prisma },
  [`${SRC}/utils/redis.ts`]: { redis },
  [`${SRC}/services/telegram/index.ts`]: { getBot: () => ({ answerPreCheckoutQuery: async () => true, sendInvoice: async () => ({}) }), getMessagingService: () => messaging },
  [`${SRC}/services/user-service.ts`]: { getUserByTelegramId: async (id: number) => USERS.find((u) => Number(u.telegramId) === Number(id)) ?? null },
  [`${SRC}/services/analytics-service.ts`]: { trackActivity: async () => undefined, addBreadcrumb: () => undefined, setUserContext: () => undefined },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (e: unknown, context: string) => void captured.push(`${context}: ${e instanceof Error ? e.message : String(e)}`),
    captureWarning: () => undefined,
    captureInfo: () => undefined,
  },
  [`${SRC}/services/reminder-cache.ts`]: { getEarlyAdoptionMode: async () => false },
  [`${SRC}/services/zmanim/pause.ts`]: { isPaused: async () => false },
  [`${SRC}/services/calendar.ts`]: { getUserCalendarTimezone: async () => null },
  [`${SRC}/services/weather/geocoding.ts`]: { geocodeLocation: async () => ({ timezone: null }), fetchWithTimeout: async () => new Response('{}') },
};
const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {
    // An unresolvable request goes to the real loader, which says why
  }
  return stubs[resolved] ?? realLoad.call(this, request, parent, isMain);
};

const CONSOLE = { log: console.log, warn: console.warn, error: console.error };
/** Runs fn with the console's lines kept in `logs`; the console comes back when fn settles, or at once with `restore`. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const take = (...args: unknown[]) => void logs.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  Object.assign(console, { log: take, warn: take, error: take });
  try {
    return await fn();
  } finally {
    restore();
  }
}
const restore = () => Object.assign(console, CONSOLE);

// ---- M1, M2: pure, and the same under every process zone ----

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
/** [paid at (wall time), zone, the month's end (wall time)] */
const MONTHS: [string, string, string][] = [
  ['2026-10-15T10:00:00', IL, '2026-11-15T10:00:00'], // summer time ends on 25 October: 31 days and an hour
  ['2026-10-31T23:30:00', IL, '2026-11-30T23:30:00'], // the 31st into a 30-day month
  ['2027-01-31T08:15:00', IL, '2027-02-28T08:15:00'],
  ['2028-01-31T08:15:00', IL, '2028-02-29T08:15:00'], // a leap year
  ['2026-12-15T21:00:00', IL, '2027-01-15T21:00:00'],
  ['2027-02-26T02:30:00', IL, '2027-03-26T03:30:00'], // 02:30 on 26 March 2027 never happens in Israel: forward by the jump
  ['2026-10-31T21:00:00', NY, '2026-11-30T21:00:00'], // New York's clocks go back on 1 November
];

async function pure() {
  const { wallTimeToInstant, instantToWallTime } = await import('../src/utils/wall-time');
  const { getSubscriptionEndDate } = await import('../src/services/subscription-service');
  const ends = MONTHS.map(([paid, zone]) => {
    const end = getSubscriptionEndDate(wallTimeToInstant(paid, zone), zone);
    return Number.isNaN(end.getTime()) ? 'Invalid Date' : end.toISOString();
  });
  DB.usageCounter.length = 0;
  const { getOrCreateUsageCounter } = await import('../src/services/subscription-service');
  const counter = await getOrCreateUsageCounter(77);
  const month = instantToWallTime(new Date(), IL).slice(0, 7);
  return { ends, counterStart: (counter.cycleStartDate as Date).toISOString(), firstOfMonth: wallTimeToInstant(`${month}-01T00:00`, IL).toISOString() };
}

async function main() {
  if (CHILD) {
    console.log(JSON.stringify(await pure()));
    return;
  }
  const { wallTimeToInstant, instantToWallTime } = await import('../src/utils/wall-time');
  const own = await pure();

  await check('M1 a paid month ends one calendar month on, at the same wall time on the person\'s clock: a month with a clock change, the 31st into 30 days, 31 January into February (and a leap year), December into January, a skipped wall time forward by the jump, New York; the same under three process zones', () => {
    MONTHS.forEach(([paid, zone, want], i) => {
      const got = own.ends[i] === 'Invalid Date' ? own.ends[i] : instantToWallTime(new Date(own.ends[i]), zone);
      assert(got === want, `paid ${paid} ${zone}: ends ${got}, want ${want}`);
    });
    const hours = (new Date(own.ends[0]).getTime() - wallTimeToInstant(MONTHS[0][0], IL).getTime()) / 3_600_000;
    assert(hours === 31 * 24 + 1, `the clock-change month is ${hours} hours`);
    for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Chatham']) {
      const out = execFileSync(process.execPath, [...process.execArgv, __filename], { cwd: ROOT, env: { ...process.env, TZ: zone, SMOKE_ZONE_CHILD: '1' }, encoding: 'utf8' });
      const line = out.split('\n').find((l) => l.startsWith('{'));
      assert(line && show(JSON.parse(line).ends) === show(own.ends), `under TZ=${zone}: ${line}`);
    }
  });

  await check('M2 the subscription code moves no Date by its local fields, and a new usage counter starts on the 1st at 00:00 on Israel\'s clock, whatever the server\'s zone', () => {
    const src = fs.readFileSync(path.join(SRC, 'services/subscription-service.ts'), 'utf8').replace(/^\s*(?:\/\/|\*).*$/gm, '');
    // Date.UTC and getUTC* read no zone; a Date built from, or moved by, its local fields does
    const local = src.match(/\.(?:get|set)(?:Date|Month|FullYear|Hours|Minutes|Day)\(|fromZonedTime|new Date\((?!Date\.UTC\()[^()]*,[^()]*\)/g);
    assert(!local, `local fields: ${show(local)}`);
    assert(own.counterStart === own.firstOfMonth, `the counter starts ${own.counterStart}, want ${own.firstOfMonth}`);
  });

  const handler = await import('../src/services/payment-handler');
  const D = await import('../src/lib/plan-disclosure');
  const messages = (l: string) => JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'));
  const PRICE: Record<string, number> = { BASIC: 2500, PRO: 5000 };
  const pay = (user: Row, charge: string, action: 'upgrade' | 'renew' = 'upgrade', plan: 'BASIC' | 'PRO' = 'PRO', payload?: string) =>
    handler.handleSuccessfulPayment(Number(user.telegramId), Number(user.telegramId), {
      currency: 'XTR',
      total_amount: PRICE[plan],
      invoice_payload: payload ?? JSON.stringify({ plan, userId: user.id, action }),
      telegram_payment_charge_id: charge,
      provider_payment_charge_id: '',
    });
  const reset = () => {
    DB = { subscription: [], usageCounter: [], payment: [] };
    sent.length = 0;
    logs.length = 0;
    captured.length = 0;
    failing.clear();
    sendFails = null;
    zoneMode = 'cached';
  };
  const subOf = (id: number) => DB.subscription.find((r) => r.userId === id) as Row;
  const paymentsOf = (id: number) => DB.payment.filter((r) => r.userId === id);
  const confirmation = (user: Row, zone: string, plan: 'basic' | 'pro' = 'pro') => {
    const l = user.language;
    const m = messages(l);
    return D.paymentConfirmation({ template: m.subscription.paymentSuccess, words: m.bot.policy, locale: l, planName: m.subscription.plans[plan].name, price: PRICE[plan.toUpperCase()], periodEnd: subOf(user.id).currentPeriodEnd, timeZone: zone });
  };
  const DAY = 86_400_000;
  const ago = (days: number) => new Date(Date.now() - days * DAY);
  /** A subscription row as the app leaves it, for a person about to pay. */
  const seedSub = (userId: number, row: Row) =>
    DB.subscription.push({ id: `sub-${userId}`, userId, plan: 'FREE', status: 'TRIALING', telegramPaymentChargeId: null, trialStartedAt: ago(3), trialEndsAt: new Date(Date.now() + 11 * DAY), currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, compedBy: null, compedAt: null, compReason: null, createdAt: ago(3), ...row });
  /** The Payment row matches the subscription's month and the charge, plan and Stars paid. */
  const rowMatches = (userId: number, charge: string, plan: string) => {
    const rows = DB.payment.filter((r) => r.telegramPaymentChargeId === charge);
    const sub = subOf(userId);
    assert(rows.length === 1, `${charge}: ${rows.length} payment rows`);
    const [r] = rows;
    assert(r.userId === userId && r.plan === plan && r.amount === PRICE[plan] && r.currency === 'XTR' && r.refundedAt === null, `${charge}: the row ${show(r)}`);
    assert(r.periodStart.getTime() === sub.currentPeriodStart.getTime() && r.periodEnd.getTime() === sub.currentPeriodEnd.getTime() && r.paidAt.getTime() === r.periodStart.getTime(), `${charge}: the row's month ${show(r)} is not the subscription's ${show([sub.currentPeriodStart, sub.currentPeriodEnd])}`);
  };

  await check('M3 a payment credits the month to its end on the person\'s clock (New York, Israel), writes its Payment row, and the one confirmation shows that day and time', async () => {
    for (const user of USERS) {
      reset();
      const zone = ZONES[user.id];
      await quietly(() => pay(user, `chg_${user.id}`));
      const sub = subOf(user.id);
      assert(sub?.status === 'ACTIVE' && sub.plan === 'PRO' && sub.telegramPaymentChargeId === `chg_${user.id}`, `${user.id}: the row ${show(sub)}`);
      const start = instantToWallTime(sub.currentPeriodStart, zone);
      const end = instantToWallTime(sub.currentPeriodEnd, zone);
      assert(end.slice(11) === start.slice(11) && end.slice(0, 10) > start.slice(0, 10), `${user.id}: ${start} to ${end} in ${zone}`);
      rowMatches(user.id, `chg_${user.id}`, 'PRO');
      assert(sent.length === 1 && sent[0].text === confirmation(user, zone), `${user.id}: ${sent.length} sends:\n${sent[0]?.text}`);
    }
  });

  await check('R1 the same charge delivered again (one after the other, or at the same time) credits once, writes one row and confirms once, and the month isn\'t moved; a new charge credits again with its own row', async () => {
    const user = USERS[0];
    for (const how of ['in turn', 'at once'] as const) {
      reset();
      if (how === 'in turn') {
        await quietly(() => pay(user, 'chg_A'));
        const first = copy(subOf(user.id));
        await quietly(() => pay(user, 'chg_A'));
        assert(subOf(user.id).currentPeriodEnd.getTime() === first.currentPeriodEnd.getTime(), `${how}: the repeat moved the month`);
      } else {
        await quietly(() => Promise.all([pay(user, 'chg_A'), pay(user, 'chg_A'), pay(user, 'chg_A')]));
      }
      assert(sent.length === 1, `${how}: ${sent.length} confirmations`);
      assert(paymentsOf(user.id).length === 1, `${how}: ${paymentsOf(user.id).length} payment rows`);
      assert(logs.some((line) => line.includes('chg_A') && /already credited/.test(line)), `${how}: the repeat is not logged: ${show(logs)}`);
    }
    await quietly(() => pay(user, 'chg_B', 'renew'));
    assert(sent.length === 2 && subOf(user.id).telegramPaymentChargeId === 'chg_B', `a new charge: ${sent.length} confirmations, ${subOf(user.id).telegramPaymentChargeId}`);
    assert(show(paymentsOf(user.id).map((r) => r.telegramPaymentChargeId)) === show(['chg_A', 'chg_B']), `the rows: ${show(paymentsOf(user.id))}`);
  });

  await check('R2 a zone lookup that never answers doesn\'t hold the webhook: credited and confirmed within the lookup\'s wait, in Israel\'s zone, the fallback logged; one that throws is logged and answers Israel too', async () => {
    const { TZ_LOOKUP_MS } = await import('../src/lib/timezone');
    const user = USERS[0];
    for (const mode of ['hang', 'throw'] as const) {
      reset();
      zoneMode = mode;
      const started = Date.now();
      const done = quietly(() => pay(user, `chg_${mode}`));
      const late = new Promise((resolve) => setTimeout(() => resolve('late'), TZ_LOOKUP_MS + 1500));
      const first = await Promise.race([done.then(() => 'done'), late]);
      restore(); // a webhook still waiting must not keep the console
      assert(first === 'done', `${mode}: the webhook was still waiting after ${TZ_LOOKUP_MS + 1500} ms`);
      const sub = subOf(user.id);
      assert(sub && instantToWallTime(sub.currentPeriodEnd, IL).slice(11) === instantToWallTime(sub.currentPeriodStart, IL).slice(11), `${mode}: the month is not on Israel's clock`);
      assert(sent.length === 1 && sent[0].text === confirmation(user, IL), `${mode}: the confirmation:\n${sent[0]?.text}`);
      assert(logs.some((line) => line.includes(String(user.id)) && /Asia\/Jerusalem/.test(line)), `${mode}: the fallback is not logged: ${show(logs)}`);
      if (mode === 'hang') assert(Date.now() - started >= TZ_LOOKUP_MS - 50, `${mode}: answered before the wait was over`);
    }
  });

  await check('R3 a charge delivered again after it was refunded (its row marked, the plan ended) credits nothing and confirms nothing', async () => {
    reset();
    const user = USERS[1];
    await quietly(() => pay(user, 'chg_R'));
    // What the admin's refund leaves (subscription-service's recordRefund): the row marked, the plan on Free, the charge id gone
    DB.payment[0].refundedAt = new Date();
    Object.assign(subOf(user.id), { plan: 'FREE', status: 'EXPIRED', telegramPaymentChargeId: null, currentPeriodStart: null, currentPeriodEnd: null });
    sent.length = 0;
    await quietly(() => pay(user, 'chg_R'));
    const sub = subOf(user.id);
    assert(sub.plan === 'FREE' && sub.status === 'EXPIRED' && sub.telegramPaymentChargeId === null, `credited again: ${show(sub)}`);
    assert(sent.length === 0, `${sent.length} messages: ${show(sent.map((m) => m.text))}`);
    assert(DB.payment.length === 1 && DB.payment[0].refundedAt !== null, `the rows: ${show(DB.payment)}`);
  });

  await check('P1 every way to pay stores the plan paid for, ACTIVE, with the month from now and the comp cleared: a new person, a trial buying Basic or Pro, Basic to Pro, renewing Pro, an old renewal invoice paid after the plan lapsed, an old Basic invoice paid while on Pro, a payment over a free gift', async () => {
    const user = USERS[1];
    const cases: [string, Row | null, 'upgrade' | 'renew', 'BASIC' | 'PRO'][] = [
      ['a new person (no row yet)', null, 'upgrade', 'BASIC'],
      ['a trial buys Pro', {}, 'upgrade', 'PRO'],
      ['a trial buys Basic', {}, 'upgrade', 'BASIC'],
      ['Basic moves to Pro', { plan: 'BASIC', status: 'ACTIVE', telegramPaymentChargeId: 'chg_old', currentPeriodStart: ago(5), currentPeriodEnd: new Date(Date.now() + 25 * DAY) }, 'upgrade', 'PRO'],
      ['Pro renews while it runs', { plan: 'PRO', status: 'ACTIVE', telegramPaymentChargeId: 'chg_old', currentPeriodStart: ago(28), currentPeriodEnd: new Date(Date.now() + 2 * DAY) }, 'renew', 'PRO'],
      ['a cancelled Pro that still runs renews', { plan: 'PRO', status: 'CANCELED', cancelAtPeriodEnd: true, telegramPaymentChargeId: 'chg_old', currentPeriodStart: ago(28), currentPeriodEnd: new Date(Date.now() + 2 * DAY) }, 'renew', 'PRO'],
      ['an old Pro renewal invoice paid after the plan lapsed (expiry set it FREE)', { plan: 'FREE', status: 'EXPIRED', telegramPaymentChargeId: 'chg_old', currentPeriodStart: ago(40), currentPeriodEnd: ago(10) }, 'renew', 'PRO'],
      ['an old Basic invoice paid while on Pro', { plan: 'PRO', status: 'ACTIVE', telegramPaymentChargeId: 'chg_old', currentPeriodStart: ago(3), currentPeriodEnd: new Date(Date.now() + 27 * DAY) }, 'upgrade', 'BASIC'],
      ['a payment over a free Pro gift', { plan: 'PRO', status: 'ACTIVE', compedBy: 9, compedAt: ago(2), compReason: 'pilot', currentPeriodStart: ago(2) }, 'upgrade', 'BASIC'],
    ];
    for (const [label, row, action, plan] of cases) {
      reset();
      if (row) seedSub(user.id, row);
      const before = Date.now();
      await quietly(() => pay(user, `chg_${label.length}`, action, plan));
      const sub = subOf(user.id);
      assert(sub && sub.plan === plan && sub.status === 'ACTIVE' && sub.compedBy === null && sub.cancelAtPeriodEnd === false, `${label}: ${show(sub)}`);
      assert(sub.currentPeriodStart.getTime() >= before && sub.telegramPaymentChargeId === `chg_${label.length}`, `${label}: the month or the charge: ${show(sub)}`);
      rowMatches(user.id, `chg_${label.length}`, plan);
      assert(sent.length === 1 && sent[0].text === confirmation(user, ZONES[user.id], plan === 'PRO' ? 'pro' : 'basic'), `${label}: the confirmation:\n${sent[0]?.text}`);
    }
  });

  await check('E1 a credit that fails before it commits (the row\'s insert, or the subscription\'s update after it) writes nothing, tells the person nothing and throws (the webhook answers 500 and Telegram delivers it again); that delivery credits once; the route answers a throw with 500', async () => {
    const user = USERS[1];
    for (const failure of ['payment.createMany', 'subscription.update', 'usageCounter.upsert']) {
      reset();
      seedSub(user.id, {});
      const trial = copy(subOf(user.id));
      failing.add(failure);
      let threw = false;
      await quietly(() => pay(user, 'chg_E')).catch(() => (threw = true));
      assert(threw, `${failure}: the handler did not throw, so the webhook answers 200 and Telegram never delivers it again`);
      assert(DB.payment.length === 0 && show(subOf(user.id)) === show(trial), `${failure}: half credited: ${show(DB.payment)} ${show(subOf(user.id))}`);
      assert(sent.length === 0, `${failure}: the person was told: ${show(sent.map((m) => m.text))}`);
      assert(logs.some((line) => line.includes('chg_E') && /deliver/i.test(line)), `${failure}: not logged: ${show(logs)}`);
      failing.clear();
      await quietly(() => pay(user, 'chg_E'));
      const rowsNow = paymentsOf(user.id).length;
      const sentNow = sent.length as number;
      assert(subOf(user.id).plan === 'PRO' && rowsNow === 1 && sentNow === 1, `${failure}: the next delivery: ${show(subOf(user.id))} ${rowsNow} rows, ${sentNow} messages`);
    }
    // The route: a handler that throws is answered 500 (Telegram delivers it again); the payment branch has no catch of its own
    const route = fs.readFileSync(path.join(ROOT, 'app/api/webhook/route.ts'), 'utf8');
    assert(/catch \(error\) \{\s*captureError\(error, 'webhook'[^}]*\}\);?\s*return NextResponse\.json\(\s*\{ error: 'Internal server error' \},\s*\{ status: 500 \}/.test(route), 'the webhook route no longer answers a throw with 500');
    const hooks = fs.readFileSync(path.join(SRC, 'services/webhook-handlers.ts'), 'utf8');
    assert(/if \(update\.message\?\.successful_payment\) \{[^}]*await handleSuccessfulPayment\([^)]*\);\s*res\.status\(200\)/.test(hooks), 'the successful_payment branch no longer lets a throw reach the route');
  });

  await check('E2 a confirmation that fails after the credit is logged and captured, and the short fallback goes out in the person\'s language as plain text; the credit stays, and no message says activation failed', async () => {
    for (const user of USERS) {
      reset();
      sendFails = (_text, options) => options?.format !== undefined; // the HTML confirmation fails; the plain fallback goes through
      await quietly(() => pay(user, `chg_F${user.id}`));
      const sub = subOf(user.id);
      const m = messages(user.language);
      assert(sub.plan === 'PRO' && DB.payment.length === 1, `${user.id}: the credit did not stay: ${show(sub)}`);
      const want = D.paymentFallback({ template: m.subscription.paymentFallback, locale: user.language, planName: m.subscription.plans.pro.name, periodEnd: sub.currentPeriodEnd, timeZone: ZONES[user.id] });
      assert(sent.length === 1 && sent[0].text === want && sent[0].options?.format === undefined, `${user.id}: the fallback: ${show(sent)}`);
      assert(!sent.some((x) => x.text === m.subscription.paymentError), `${user.id}: told activation failed`);
      assert(captured.some((c) => c.startsWith('payment-confirmation')), `${user.id}: not captured: ${show(captured)}`);
      assert(logs.some((line) => line.includes(`chg_F${user.id}`) && /confirmation/i.test(line)), `${user.id}: not logged: ${show(logs)}`);
    }
    // Both fail: logged and captured twice, and the handler still answers (200), the credit kept
    reset();
    const user = USERS[0];
    sendFails = () => true;
    await quietly(() => pay(user, 'chg_G'));
    assert(subOf(user.id).plan === 'PRO' && captured.filter((c) => c.startsWith('payment-confirmation')).length === 2, `both sends failing: ${show(captured)}`);
  });

  await check('E3 a payload that can\'t be read, and a payer the bot doesn\'t know, get the activation error (the person\'s language when known), are captured, and credit nothing; the handler holds no copy of its own', async () => {
    reset();
    const he = USERS[1];
    await quietly(() => pay(he, 'chg_bad', 'upgrade', 'PRO', '{not json'));
    assert(sent.length === 1 && sent[0].text === messages('he').subscription.paymentError, `a bad payload: ${show(sent)}`);
    assert(DB.payment.length === 0 && !subOf(he.id), 'a bad payload credited');
    assert(captured.some((c) => c.startsWith('payment-successful')), `a bad payload: not captured: ${show(captured)}`);
    reset();
    await quietly(() => pay(he, 'chg_plan', 'upgrade', 'PRO', JSON.stringify({ plan: 'FREE', userId: he.id, action: 'upgrade' })));
    assert(sent.length === 1 && sent[0].text === messages('he').subscription.paymentError && DB.payment.length === 0, `a payload for no paid plan: ${show(sent)}`);
    reset();
    const stranger = { id: 99, telegramId: BigInt(5099), language: 'ru' };
    await quietly(() => pay(stranger, 'chg_who'));
    assert(sent.length === 1 && sent[0].text === messages('en').subscription.paymentError && DB.payment.length === 0, `an unknown payer: ${show(sent)}`);
    assert(captured.some((c) => c.startsWith('payment-successful')), `an unknown payer: not captured: ${show(captured)}`);
    const src = fs.readFileSync(path.join(SRC, 'services/payment-handler.ts'), 'utf8').replace(/^\s*(?:\/\/|\*).*$/gm, '');
    // No English fallback beside a message key (`t.x || 'words'`, `t.x ? … : \`words\``): every word the person reads is in messages
    assert(!/\|\|\s*['`][^'`]*[A-Za-z]{2,} [A-Za-z]{2,}|There was an error activating|View Subscription|\(1 month\)|FamCalBot \$\{/.test(src), 'English copy is written in the handler');
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  // A webhook left waiting (R2 failing) holds the event loop: exit all the same
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

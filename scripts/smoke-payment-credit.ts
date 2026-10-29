// Smoke test for what a Telegram Stars payment credits, and when the paid month ends (the legal-app review's concerns 5
// and 6; CLAUDE.md's wall-time rule):
//
//  - M1 a paid month ends one calendar month after the payment, at the same wall time on the person's clock
//    (getSubscriptionEndDate, through src/utils/wall-time.ts): a month with a clock change (31 days and an hour), the
//    31st into a 30-day month, 31 January into February (28 days, 29 in a leap year), December into January, a wall
//    time the clocks skip that day (moved forward by the jump), New York; the same instants whatever zone the server
//    runs in (the smoke re-runs M1 and M2 under three process zones).
//  - M2 the subscription code moves no Date by its local fields, and a new usage counter starts on the 1st at 00:00 on
//    Israel's clock.
//  - M3 a payment credits the month to that end, in the person's zone, and the one confirmation shows that day and time.
//  - R1 a repeated successful_payment for the same charge (Telegram delivering the update again) credits once and sends
//    one confirmation, one after the other or at the same time; the paid month isn't moved by the repeat; a new charge
//    credits again.
//  - R2 a zone lookup that doesn't answer never holds the webhook's answer: the payment is credited and confirmed within
//    the screens' own wait (TZ_LOOKUP_MS), in Israel's zone, and the fallback is logged; one that throws is logged too.
//
// The real payment handler, subscription service and zone lookup (src/lib/timezone.ts) run over a fake Prisma (the
// subscription and usage rows, updateMany's where read as Postgres reads it) and a fake Redis; the bot, analytics and
// error capture are recorded. No network, no database.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-payment-credit.ts

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

const DB: { subscription: Row[]; usageCounter: Row[] } = { subscription: [], usageCounter: [] };
const copy = <T>(row: T): T => (row ? structuredClone(row) : row);
/** A where as Postgres reads it: OR, a plain value, and { not: x } (NULL <> x is not true, so NULL never matches). */
const matches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return (want as Row[]).some((w) => matches(row, w));
    if (want && typeof want === 'object' && !(want instanceof Date) && 'not' in want) return row[key] !== null && row[key] !== undefined && row[key] !== want.not;
    return row[key] === want;
  });
const table = (name: 'subscription' | 'usageCounter') => ({
  findUnique: async ({ where }: Row) => copy(DB[name].find((r) => r.userId === where.userId) ?? null),
  findUniqueOrThrow: async ({ where }: Row) => {
    const row = DB[name].find((r) => r.userId === where.userId);
    if (!row) throw new Error(`no ${name} for ${where.userId}`);
    return copy(row);
  },
  create: async ({ data }: Row) => {
    const row = { id: `${name}-${data.userId}`, telegramPaymentChargeId: null, currentPeriodStart: null, currentPeriodEnd: null, compedBy: null, ...data };
    DB[name].push(row);
    return copy(row);
  },
  update: async ({ where, data }: Row) => {
    const row = DB[name].find((r) => r.userId === where.userId);
    if (!row) throw new Error(`no ${name} for ${where.userId}`);
    Object.assign(row, data);
    return copy(row);
  },
  updateMany: async ({ where, data }: Row) => {
    const rows = DB[name].filter((r) => matches(r, where));
    for (const row of rows) Object.assign(row, data);
    return { count: rows.length };
  },
  upsert: async ({ where, update, create }: Row) => {
    const row = DB[name].find((r) => r.userId === where.userId);
    if (row) return copy(Object.assign(row, update));
    const made = { id: `${name}-${create.userId}`, ...create };
    DB[name].push(made);
    return copy(made);
  },
});
const prisma = { subscription: table('subscription'), usageCounter: table('usageCounter'), user: { findUnique: async ({ where }: Row) => USERS.find((u) => u.id === where.id) ?? null } };

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
const messaging = { sendMessage: async (chatId: unknown, text: string, options?: Row) => void sent.push({ chatId, text, options }) };

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
  const pay = (user: Row, charge: string, action: 'upgrade' | 'renew' = 'upgrade') =>
    handler.handleSuccessfulPayment(Number(user.telegramId), Number(user.telegramId), {
      currency: 'XTR',
      total_amount: 5000,
      invoice_payload: JSON.stringify({ plan: 'PRO', userId: user.id, action }),
      telegram_payment_charge_id: charge,
      provider_payment_charge_id: '',
    });
  const reset = () => {
    DB.subscription.length = 0;
    DB.usageCounter.length = 0;
    sent.length = 0;
    logs.length = 0;
    captured.length = 0;
    zoneMode = 'cached';
  };
  const subOf = (id: number) => DB.subscription.find((r) => r.userId === id) as Row;
  const confirmation = (user: Row, zone: string) => {
    const l = user.language;
    const m = messages(l);
    return D.paymentConfirmation({ template: m.subscription.paymentSuccess, words: m.bot.policy, locale: l, planName: m.subscription.plans.pro.name, price: 5000, periodEnd: subOf(user.id).currentPeriodEnd, timeZone: zone });
  };

  await check('M3 a payment credits the month to its end on the person\'s clock (New York, Israel), and the one confirmation shows that day and time', async () => {
    for (const user of USERS) {
      reset();
      const zone = ZONES[user.id];
      await quietly(() => pay(user, `chg_${user.id}`));
      const sub = subOf(user.id);
      assert(sub?.status === 'ACTIVE' && sub.plan === 'PRO' && sub.telegramPaymentChargeId === `chg_${user.id}`, `${user.id}: the row ${show(sub)}`);
      const start = instantToWallTime(sub.currentPeriodStart, zone);
      const end = instantToWallTime(sub.currentPeriodEnd, zone);
      assert(end.slice(11) === start.slice(11) && end.slice(0, 10) > start.slice(0, 10), `${user.id}: ${start} to ${end} in ${zone}`);
      assert(sent.length === 1 && sent[0].text === confirmation(user, zone), `${user.id}: ${sent.length} sends:\n${sent[0]?.text}`);
    }
  });

  await check('R1 the same charge delivered again (one after the other, or at the same time) credits once and confirms once, and the month isn\'t moved; a new charge credits again', async () => {
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
      assert(logs.some((line) => line.includes('chg_A') && /already credited/.test(line)), `${how}: the repeat is not logged: ${show(logs)}`);
    }
    await quietly(() => pay(user, 'chg_B', 'renew'));
    assert(sent.length === 2 && subOf(user.id).telegramPaymentChargeId === 'chg_B', `a new charge: ${sent.length} confirmations, ${subOf(user.id).telegramPaymentChargeId}`);
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

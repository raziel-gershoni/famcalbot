// Smoke test for the Shabbat and Yom Tov pause on the subscription messages (plan
// docs/superpowers/plans/2026-10-28-zmanim-reminders.md, Task 2): the renewal reminders and the expiry notice
// that the daily health run sends (src/services/subscription-reminders.ts), and the trial-expired notice that
// the first plan check after a trial finds it over sends (src/services/subscription-service.ts).
//
// In Shabbat or Yom Tov a person whose switch is on gets none of them:
//   - the 3-day renewal reminder is not sent and not marked sent, so the next daily run sends it (the period is still open);
//   - the last-day reminder has one run only (the 24 hours before the period ends), so paused it is dropped, and it is not
//     sent late (the period has ended by the next run, and "tomorrow you switch to Free" would be false): the expiry notice
//     of that run tells the person instead;
//   - the expiry notice is skipped, but the downgrade itself is made on time (the plan is the plan, whatever the
//     day), so the notice is not sent afterwards either;
//   - the trial-expired notice is skipped; the trial is over all the same.
// A person with the switch off gets them as before.
//
// Real code over fakes at the boundaries: Prisma (in memory, honouring `select`, so a column the code forgets to
// select is missing), Redis, Telegram and WhatsApp (record every send), the early-adoption switch, error capture
// and analytics. The clock is set by hand. No network, no DB.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-pause-subscription.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-pause-subscription.ts

import Module from 'node:module';
import path from 'node:path';

import { REDIS_KEYS } from '../src/config/redis-keys';

const ROOT = path.resolve(__dirname, '..');

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
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

const show = (value: unknown): string => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v));

// ---- Clock ----

let clock = 0;
const RealDate = Date;
class ClockDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(clock);
    else super(...(args as [number, number, number, number, number, number, number]));
  }
  static now() {
    return clock;
  }
}
globalThis.Date = ClockDate as unknown as DateConstructor;
const at = (iso: string): number => RealDate.parse(iso);

// ---- @hebcal/core is ESM-only and tsx loads src/ as CommonJS: point it at its ESM build ----

const internals = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string; _cache: Record<string, unknown> };
const resolveFilename = internals._resolveFilename;
internals._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.resolve(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};

// ---- Fakes ----

type Row = Record<string, unknown>;
const redisStore = new Map<string, unknown>();
const fakeRedis = {
  get: async (key: string) => (redisStore.has(key) ? redisStore.get(key) : null),
  set: async (key: string, value: unknown) => { redisStore.set(key, value); return 'OK'; },
  del: async (key: string) => (redisStore.delete(key) ? 1 : 0),
  exists: async (key: string) => (redisStore.has(key) ? 1 : 0),
};

const JERUSALEM = { latitude: 31.778, longitude: 35.235, elevationM: 754 };
const DAY = 24 * 60 * 60 * 1000;

/** Users 1 (switch on, Jerusalem) and 2 (switch off); both on Telegram. */
const users: Record<number, Row> = {};
let subscriptions: Row[] = [];
const subscriptionWrites: Row[] = [];
const pick = (row: Row, select: Record<string, boolean>): Row => Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]]));

const fakePrisma = {
  subscription: {
    findMany: async ({ where, include }: { where: Row; include?: { user?: { select: Record<string, boolean> } } }) => {
      const statuses = (where.status as { in: string[] }).in;
      const end = where.currentPeriodEnd as { gt?: Date; lte?: Date; lt?: Date };
      return subscriptions
        .filter(s => statuses.includes(s.status as string) && s.plan !== 'FREE')
        .filter(s => (where.compedBy === null ? s.compedBy === null : true))
        .filter(s => {
          const t = (s.currentPeriodEnd as Date).getTime();
          return (end.gt === undefined || t > end.gt.getTime()) && (end.lte === undefined || t <= end.lte.getTime()) && (end.lt === undefined || t < end.lt.getTime());
        })
        .map(s => ({ ...s, user: include?.user ? pick(users[s.userId as number], include.user.select) : undefined }));
    },
    findUnique: async ({ where }: { where: { userId: number } }) => subscriptions.find(s => s.userId === where.userId) ?? null,
    update: async ({ where, data }: { where: { userId: number }; data: Row }) => {
      const row = subscriptions.find(s => s.userId === where.userId)!;
      Object.assign(row, data);
      subscriptionWrites.push({ userId: where.userId, ...data });
      return row;
    },
  },
  usageCounter: {
    findMany: async () => [],
    findUnique: async ({ where }: { where: { userId: number } }) => ({ userId: where.userId, cycleStartDate: new RealDate(clock), textSummariesUsed: 0, voiceSummariesUsed: 0, voiceEventsCreated: 0, remindersTriggered: 0 }),
  },
  userFeatureOverride: { findUnique: async () => null },
  user: {
    findUnique: async ({ where, select }: { where: { id: number }; select: Record<string, boolean> }) => (users[where.id] ? pick(users[where.id], select) : null),
  },
};

type Sent = { chatId: string; text: string };
let sent: Sent[] = [];
const recorder = { sendMessage: async (chatId: string | number, text: string) => { sent.push({ chatId: String(chatId), text }); } };
let trialNotices: number[] = [];
let activity: string[] = [];
let logs: string[] = [];

// A stub is served to require() from Module._cache and to import() by a load hook that writes it out as an ES module.
const stubs: Record<string, Row> = {};
(globalThis as { smokeStubs?: typeof stubs }).smokeStubs = stubs;
(Module as unknown as { registerHooks: (hooks: unknown) => void }).registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? new URL(url).pathname : '';
    if (!(file in stubs)) return nextLoad(url, context);
    const names = Object.keys(stubs[file]).filter(name => /^[A-Za-z_$][\w$]*$/.test(name));
    const source = `const s = globalThis.smokeStubs[${JSON.stringify(file)}];\n${names.map(name => `export const ${name} = s[${JSON.stringify(name)}];`).join('\n')}\n`;
    return { format: 'module', source, shortCircuit: true };
  },
});

function installStubs(): void {
  const stub = (rel: string, exports: Row) => {
    const filename = path.join(ROOT, rel);
    stubs[filename] = exports;
    const mod = new (Module as unknown as new (id: string) => Row)(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    internals._cache[filename] = mod;
  };
  stub('src/utils/redis.ts', { redis: fakeRedis });
  stub('src/utils/prisma.ts', { prisma: fakePrisma });
  stub('src/lib/error-capture.ts', {
    captureError: () => {}, captureWarning: () => {}, captureInfo: () => {},
  });
  stub('src/services/telegram/index.ts', {
    getBot: () => ({}),
    sendTrialExpiredNotification: async (telegramId: number) => { trialNotices.push(telegramId); },
    sendReminderDowngradeNotification: async () => {},
  });
  stub('src/services/messaging/factory.ts', {
    getTelegramService: () => recorder,
    getWhatsAppService: () => ({ sendMessage: async () => { throw new Error('the subscription messages went to WhatsApp'); } }),
  });
  stub('src/services/analytics-service.ts', {
    trackActivity: async (userId: number, action: string) => { activity.push(`${userId}:${action}`); },
    trackActivityAsync: () => {},
  });
  stub('src/services/reminder-cache.ts', { getEarlyAdoptionMode: async () => false });
  stub('src/services/calendar.ts', { getUserCalendarTimezone: async () => null });
  stub('src/services/weather/geocoding.ts', {
    fetchWithTimeout: async () => { throw new Error('a lookup was attempted'); },
    geocodeLocation: async () => { throw new Error('the geocode path was used'); },
  });
}

function reset(): void {
  redisStore.clear();
  sent = [];
  trialNotices = [];
  activity = [];
  logs = [];
  subscriptionWrites.length = 0;
  for (const key of Object.keys(users)) delete users[Number(key)];
  users[1] = { id: 1, telegramId: BigInt(1001), whatsappPhone: null, whatsappBsuid: null, messagingPlatform: 'telegram', language: 'en', name: 'Dana', location: 'somewhere', pauseOnShabbat: true, zmanimCommunity: 'sephardi', ...JERUSALEM };
  users[2] = { id: 2, telegramId: BigInt(1002), whatsappPhone: null, whatsappBsuid: null, messagingPlatform: 'telegram', language: 'en', name: 'Noa', location: 'somewhere', pauseOnShabbat: false, zmanimCommunity: 'sephardi', ...JERUSALEM };
  redisStore.set('tz:user:1', 'Asia/Jerusalem');
  redisStore.set('tz:user:2', 'Asia/Jerusalem');
  subscriptions = [];
  (globalThis as unknown as { __pauseCache?: Map<number, unknown> }).__pauseCache?.clear();
}

/** A paid subscription of `userId` that ends at `end`. */
const paid = (userId: number, end: number): Row => ({
  userId, plan: 'PRO', status: 'ACTIVE', compedBy: null, currentPeriodEnd: new RealDate(end), trialEndsAt: new RealDate(end - 30 * DAY),
});

async function main(): Promise<void> {
  installStubs();
  /* eslint-disable @typescript-eslint/no-require-imports */
  const reminders = require('../src/services/subscription-reminders') as { processSubscriptionReminders: () => Promise<void> };
  const service = require('../src/services/subscription-service') as { getSubscriptionWithUsage: (userId: number) => Promise<{ effectivePlan: string }> };
  /* eslint-enable @typescript-eslint/no-require-imports */

  const realLog = console.log;
  const hide = (line: string) => line.startsWith('[Subscription') || line.startsWith('[Feature Access') || line.startsWith('[pause]');
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[pause]')) logs.push(line);
    else if (!hide(line)) realLog(...args);
  };
  const run = async (iso: string) => {
    clock = at(iso);
    await reminders.processSubscriptionReminders();
  };
  const to = (userId: number) => sent.filter(s => s.chatId === String(1000 + userId));

  // Saturday 17 October 2026, 10:00 in Israel (07:00 UTC) is inside Shabbat (Friday 17:50 to Saturday 18:39).
  const SATURDAY = '2026-10-17T07:00:00Z';
  const SUNDAY = '2026-10-18T07:00:00Z';

  await check('pause: a renewal reminder due in Shabbat is not sent to a person whose switch is on (and not marked sent), the person whose switch is off gets theirs, and the next daily run sends the first', async () => {
    reset();
    const end = at('2026-10-20T07:00:00Z'); // 3 days after Saturday: the 3-day reminder
    subscriptions = [paid(1, end), paid(2, end)];
    await run(SATURDAY);
    assert(to(1).length === 0 && to(2).length === 1, `Saturday: ${show(sent.map(s => s.chatId))}`);
    assert(logs.join('|') === '[pause] skipped 3day subscription reminder for 1', `logged: ${logs.join('|') || '(nothing)'}`);
    assert(!redisStore.has(REDIS_KEYS.subscriptionReminder(BigInt(1001), '2026-10-20', '3day')), 'marked sent while paused');
    assert(redisStore.has(REDIS_KEYS.subscriptionReminder(BigInt(1002), '2026-10-20', '3day')), 'the sent one is marked');
    logs.length = 0;
    await run(SUNDAY);
    assert(to(1).length === 1 && to(2).length === 1, `Sunday: user 1 ${to(1).length}, user 2 ${to(2).length} (user 2 was sent once already)`);
    assert(logs.length === 0, `Sunday logged: ${logs.join('|')}`);
  });

  await check('pause: the last-day reminder has one run (the 24 hours before the period ends): paused in Shabbat it is dropped, never sent late and never marked sent, and the next run tells the person by the expiry notice, not by a stale "last day" message; a period that ends a day earlier is reminded on Friday', async () => {
    reset();
    subscriptions = [paid(1, at('2026-10-17T20:00:00Z'))]; // ends Saturday evening, 23:00 in Israel: its last-day run is Saturday's, in Shabbat
    await run(SATURDAY);
    assert(to(1).length === 0 && logs.join('|') === '[pause] skipped 3day subscription reminder for 1|[pause] skipped lastday subscription reminder for 1', `Saturday: ${show(sent)} ${logs.join('|')}`);
    assert(!redisStore.has(REDIS_KEYS.subscriptionReminder(BigInt(1001), '2026-10-17', 'lastday')), 'marked sent while paused');
    logs.length = 0;
    await run(SUNDAY); // the period has ended: the sweep finds nothing to remind, and the expiry notice goes out (Sunday is outside Shabbat)
    assert(to(1).length === 1 && to(1)[0].text.includes('has ended') && !to(1)[0].text.includes('Last day'), `Sunday: ${show(to(1).map(m => m.text.split('\n')[0]))}`);
    assert(!redisStore.has(REDIS_KEYS.subscriptionReminder(BigInt(1001), '2026-10-17', 'lastday')), 'a last-day reminder was sent after the period had ended');
    // The control: the same person, the period ending on Saturday 02:00 UTC, is reminded by Friday morning's run (outside the window).
    reset();
    subscriptions = [paid(1, at('2026-10-17T02:00:00Z'))];
    await run('2026-10-16T07:00:00Z'); // Friday 10:00 in Israel, before candle lighting at 17:50
    assert(to(1).some(m => m.text.includes('Last day')) && logs.length === 0, `Friday: ${show(to(1).map(m => m.text.split('\n')[0]))} ${logs.join('|')}`); // (the 3-day one goes too: it reaches four days ahead)
  });

  await check('pause: an expired subscription is downgraded on time, whatever the day; only the expiry notice is skipped (logged) for the person whose switch is on, and it is not sent later', async () => {
    reset();
    const ended = at('2026-10-16T21:00:00Z'); // Friday, 24:00 in Israel
    subscriptions = [paid(1, ended), paid(2, ended)];
    await run(SATURDAY);
    assert(subscriptions[0].status === 'EXPIRED' && subscriptions[0].plan === 'FREE' && subscriptions[1].status === 'EXPIRED', `downgraded: ${show(subscriptions.map(s => [s.userId, s.status, s.plan]))}`);
    assert(to(1).length === 0 && to(2).length === 1, `notices: ${show(sent.map(s => s.chatId))}`);
    assert(logs.join('|') === '[pause] skipped subscription expiry notice for 1', `logged: ${logs.join('|') || '(nothing)'}`);
    assert(activity.includes('2:subscription_expired') && !activity.includes('1:subscription_expired'), `activity ${activity.join(',')}`);
    await run(SUNDAY);
    assert(to(1).length === 0, 'the expiry notice was sent after Shabbat');
  });

  await check('pause: outside Shabbat nothing changes: the same subscriptions on a Tuesday are all reminded and noticed', async () => {
    reset();
    const tuesday = '2026-10-20T07:00:00Z';
    subscriptions = [paid(1, at('2026-10-23T07:00:00Z')), paid(2, at('2026-10-23T07:00:00Z')), paid(3, at('2026-10-19T00:00:00Z'))];
    users[3] = { ...users[1], id: 3, telegramId: BigInt(1003) };
    redisStore.set('tz:user:3', 'Asia/Jerusalem');
    await run(tuesday);
    assert(to(1).length === 1 && to(2).length === 1 && to(3).length === 1 && logs.length === 0, `Tuesday: ${show(sent.map(s => s.chatId))} ${logs.join('|')}`);
  });

  await check('pause: the trial-expired notice (sent by the first plan check that finds the trial over) is skipped for a paused person, the trial still ends; another person is told', async () => {
    reset();
    clock = at(SATURDAY);
    const trial = (userId: number): Row => ({ userId, plan: 'FREE', status: 'TRIALING', compedBy: null, trialEndsAt: new RealDate(at('2026-10-10T00:00:00Z')), currentPeriodEnd: null });
    subscriptions = [trial(1), trial(2)];
    const paused = await service.getSubscriptionWithUsage(1);
    const other = await service.getSubscriptionWithUsage(2);
    assert(subscriptions[0].status === 'EXPIRED' && subscriptions[1].status === 'EXPIRED' && paused.effectivePlan === 'FREE' && other.effectivePlan === 'FREE', `trials: ${show(subscriptions.map(s => [s.userId, s.status]))}`);
    assert(trialNotices.join(',') === '1002', `notices: ${trialNotices.join(',') || '(nothing)'}`);
    assert(logs.join('|') === '[pause] skipped trial-expired notice for 1', `logged: ${logs.join('|') || '(nothing)'}`);
  });

  console.log = realLog;
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

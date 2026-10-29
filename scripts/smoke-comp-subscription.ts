// Smoke test for giving a person free Pro ("comping") and stopping it, in src/services/subscription-service.ts, and for the one
// rule that says who can be given it (src/lib/comp-eligibility.ts, `holdsPaidPlan`).
//
// The rule (owner, 2026-10-28):
//   - a free trial is not paid: Pro can be given during one, and the gift replaces the trial (the row becomes PRO / ACTIVE, with
//     the trial's own dates left alone);
//   - stopping the gift gives back the trial days that are left (TRIALING, when the trial's end is still ahead), otherwise the
//     person is Free / EXPIRED;
//   - a paid plan (ACTIVE) and a cancelled one that still runs (CANCELED, period end ahead) stay refused: they paid for that time;
//     an already-given Pro is refused too;
//   - the gift is silent: no message on giving, none on stopping.
//
// Real code over fakes at the boundaries: Prisma (in memory, one Subscription row per user as in the schema), Redis (records every
// delete, so the cache invalidation is seen), the early-adoption switch, Telegram, error capture and analytics. The clock is set by
// hand. No network, no DB.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-comp-subscription.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-comp-subscription.ts

import fs from 'node:fs';
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

const show = (value: unknown): string => JSON.stringify(value);

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
const DAY = 24 * 60 * 60 * 1000;
const NOW = at('2026-10-28T08:00:00Z');
const ADMIN = 9;

// ---- Fakes ----

type Row = Record<string, unknown>;
const FEATURES = ['text_summary', 'voice_summary', 'reminders', 'voice_events', 'calendars', 'google_sync'];

const redisStore = new Map<string, unknown>();
let redisDeletes: string[] = [];
const fakeRedis = {
  get: async (key: string) => (redisStore.has(key) ? redisStore.get(key) : null),
  set: async (key: string, value: unknown) => { redisStore.set(key, value); return 'OK'; },
  del: async (key: string) => { redisDeletes.push(key); return redisStore.delete(key) ? 1 : 0; },
};

const subscriptions = new Map<number, Row>();
let subscriptionWrites: Row[] = [];
const usage = new Map<number, Row>();
let usageUpserts: Row[] = [];
const overrides = new Map<number, Row>();

const fakePrisma = {
  subscription: {
    findUnique: async ({ where }: { where: { userId: number } }) => {
      const row = subscriptions.get(where.userId);
      return row ? { ...row } : null;
    },
    create: async ({ data }: { data: Row }) => {
      const row: Row = {
        id: subscriptions.size + 1, plan: 'FREE', status: 'TRIALING', currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
        compedBy: null, compedAt: null, compReason: null, telegramPaymentChargeId: null, createdAt: new RealDate(clock), ...data,
      };
      subscriptions.set(data.userId as number, row);
      subscriptionWrites.push({ op: 'create', ...data });
      return { ...row };
    },
    update: async ({ where, data }: { where: { userId: number }; data: Row }) => {
      const row = subscriptions.get(where.userId);
      if (!row) throw new Error(`no subscription for ${where.userId}`);
      Object.assign(row, data);
      subscriptionWrites.push({ op: 'update', userId: where.userId, ...data });
      return { ...row };
    },
  },
  usageCounter: {
    findUnique: async ({ where }: { where: { userId: number } }) => {
      const row = usage.get(where.userId);
      return row ? { ...row } : null;
    },
    create: async ({ data }: { data: Row }) => {
      const row = { textSummariesUsed: 0, voiceSummariesUsed: 0, voiceEventsCreated: 0, remindersTriggered: 0, ...data };
      usage.set(data.userId as number, row);
      return { ...row };
    },
    update: async ({ where, data }: { where: { userId: number }; data: Row }) => {
      const row = usage.get(where.userId) as Row;
      Object.assign(row, data);
      return { ...row };
    },
    upsert: async ({ where, update, create }: { where: { userId: number }; update: Row; create: Row }) => {
      usageUpserts.push({ userId: where.userId, update });
      const row = usage.get(where.userId);
      if (row) Object.assign(row, update);
      else usage.set(where.userId, { textSummariesUsed: 0, voiceSummariesUsed: 0, voiceEventsCreated: 0, remindersTriggered: 0, ...create });
      return { ...(usage.get(where.userId) as Row) };
    },
  },
  userFeatureOverride: {
    findUnique: async ({ where }: { where: { userId: number } }) => overrides.get(where.userId) ?? null,
  },
  user: {
    findUnique: async ({ where }: { where: { id: number } }) => ({
      telegramId: BigInt(1000 + where.id), language: 'en', location: null, pauseOnShabbat: false, zmanimCommunity: 'sephardi', latitude: null, longitude: null, elevationM: null,
    }),
  },
};

let earlyAdoption = false;
let trialNotices: number[] = [];
let activity: string[] = [];
let captured: string[] = [];

// A stub is served to require() from Module._cache and to import() by a load hook that writes it out as an ES module.
const internals = Module as unknown as { _cache: Record<string, unknown> };
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
    captureError: (_error: unknown, where: string) => { captured.push(where); }, captureWarning: () => {}, captureInfo: () => {},
  });
  stub('src/services/telegram/index.ts', {
    getBot: () => ({}),
    sendTrialExpiredNotification: async (telegramId: number) => { trialNotices.push(telegramId); },
    sendReminderDowngradeNotification: async () => {},
  });
  stub('src/services/analytics-service.ts', {
    trackActivity: async (userId: number, action: string) => { activity.push(`${userId}:${action}`); },
    trackActivityAsync: () => {},
  });
  stub('src/services/reminder-cache.ts', { getEarlyAdoptionMode: async () => earlyAdoption });
}

function reset(): void {
  redisStore.clear();
  redisDeletes = [];
  subscriptions.clear();
  subscriptionWrites = [];
  usage.clear();
  usageUpserts = [];
  overrides.clear();
  trialNotices = [];
  activity = [];
  captured = [];
  earlyAdoption = false;
  clock = NOW;
}

/** A person's row as the schema has it (one per user). */
function seed(userId: number, over: Row): Row {
  const row: Row = {
    id: userId, userId, plan: 'FREE', status: 'TRIALING', trialStartedAt: new RealDate(NOW - 5 * DAY), trialEndsAt: new RealDate(NOW + 9 * DAY),
    currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, compedBy: null, compedAt: null, compReason: null,
    telegramPaymentChargeId: null, createdAt: new RealDate(NOW - 5 * DAY), ...over,
  };
  subscriptions.set(userId, row);
  usage.set(userId, { userId, cycleStartDate: new RealDate(NOW - 3 * DAY), textSummariesUsed: 7, voiceSummariesUsed: 3, voiceEventsCreated: 2, remindersTriggered: 4 });
  return row;
}

const trial = (userId: number, endsInDays: number): Row => seed(userId, { status: 'TRIALING', trialEndsAt: new RealDate(NOW + endsInDays * DAY) });
const expired = (userId: number): Row => seed(userId, { status: 'EXPIRED', trialEndsAt: new RealDate(NOW - 20 * DAY) });
const activePaid = (userId: number): Row => seed(userId, { plan: 'BASIC', status: 'ACTIVE', trialEndsAt: new RealDate(NOW - 20 * DAY), currentPeriodStart: new RealDate(NOW - 10 * DAY), currentPeriodEnd: new RealDate(NOW + 20 * DAY) });
const canceled = (userId: number, endsInDays: number): Row => seed(userId, { plan: 'BASIC', status: 'CANCELED', cancelAtPeriodEnd: true, trialEndsAt: new RealDate(NOW - 40 * DAY), currentPeriodStart: new RealDate(NOW - 25 * DAY), currentPeriodEnd: new RealDate(NOW + endsInDays * DAY) });

const row = (userId: number): Row => subscriptions.get(userId) as Row;
const time = (value: unknown): number => (value as Date).getTime();

async function main(): Promise<void> {
  installStubs();
  /* eslint-disable @typescript-eslint/no-require-imports */
  const service = require('../src/services/subscription-service') as {
    grantCompedSubscription: (userId: number, adminId: number, reason?: string) => Promise<{ ok: boolean; code?: string; plan?: string; status?: string; subscription?: Row }>;
    revokeCompedSubscription: (userId: number, adminId: number) => Promise<{ ok: boolean; code?: string }>;
    getSubscriptionWithUsage: (userId: number) => Promise<{ effectivePlan: string; subscription: Row }>;
    checkFeatureAccess: (userId: number, feature: string) => Promise<{ allowed: boolean; reason?: string }>;
  };
  /* eslint-enable @typescript-eslint/no-require-imports */

  const realLog = console.log;
  const hide = (line: string) => line.startsWith('[Subscription') || line.startsWith('[Feature Access') || line.startsWith('[admin-');
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (!hide(line)) realLog(...args);
  };

  const grant = (userId: number, reason?: string) => service.grantCompedSubscription(userId, ADMIN, reason);
  const revoke = (userId: number) => service.revokeCompedSubscription(userId, ADMIN);
  const silent = () => trialNotices.length === 0 && captured.length === 0;

  // ---- The rule, on its own ----

  await check('holdsPaidPlan: true for ACTIVE and for CANCELED with a period end ahead; false for TRIALING (live or lapsed), EXPIRED, CANCELED past its end, and a CANCELED row with no end; a string end (the Mini App\'s) reads the same as a Date', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { holdsPaidPlan } = require('../src/lib/comp-eligibility') as { holdsPaidPlan: (sub: { status: string; currentPeriodEnd: Date | string | null }, now: Date) => boolean };
    const now = new RealDate(NOW);
    const ahead = new RealDate(NOW + DAY);
    const behind = new RealDate(NOW - DAY);
    const table: Array<[string, { status: string; currentPeriodEnd: Date | string | null }, boolean]> = [
      ['ACTIVE with an end ahead', { status: 'ACTIVE', currentPeriodEnd: ahead }, true],
      ['ACTIVE with no end', { status: 'ACTIVE', currentPeriodEnd: null }, true],
      ['CANCELED with an end ahead', { status: 'CANCELED', currentPeriodEnd: ahead }, true],
      ['CANCELED with an end ahead (as an ISO string)', { status: 'CANCELED', currentPeriodEnd: ahead.toISOString() }, true],
      ['CANCELED past its end', { status: 'CANCELED', currentPeriodEnd: behind }, false],
      ['CANCELED past its end (as an ISO string)', { status: 'CANCELED', currentPeriodEnd: behind.toISOString() }, false],
      ['CANCELED ending this very moment', { status: 'CANCELED', currentPeriodEnd: now }, false],
      ['CANCELED with no end', { status: 'CANCELED', currentPeriodEnd: null }, false],
      ['CANCELED with an end nobody can read', { status: 'CANCELED', currentPeriodEnd: 'not a date' }, false],
      ['TRIALING', { status: 'TRIALING', currentPeriodEnd: null }, false],
      ['TRIALING with a stray period end ahead', { status: 'TRIALING', currentPeriodEnd: ahead }, false],
      ['EXPIRED', { status: 'EXPIRED', currentPeriodEnd: null }, false],
    ];
    const wrong = table.filter(([, sub, want]) => holdsPaidPlan(sub, now) !== want).map(([label]) => label);
    assert(wrong.length === 0, `wrong: ${wrong.join('; ')}`);
  });

  await check('comp-eligibility.ts is safe for the Mini App: no import of its own, so no Prisma and no server code reaches the browser; the service and the Plan view use it, and the old hasPaidAccess is gone', () => {
    const rule = fs.readFileSync(path.join(ROOT, 'src/lib/comp-eligibility.ts'), 'utf8');
    assert(!/^\s*(import\s|.*\brequire\()/m.test(rule), 'comp-eligibility.ts imports something');
    const service = fs.readFileSync(path.join(ROOT, 'src/services/subscription-service.ts'), 'utf8');
    assert(/from '\.\.\/lib\/comp-eligibility'/.test(service) && /holdsPaidPlan\(existing, now\)/.test(service), 'the service does not ask holdsPaidPlan');
    assert(!/hasPaidAccess/.test(service), 'hasPaidAccess is still in the service');
    const plan = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/admin-panel/views/profile/Plan.tsx'), 'utf8');
    assert(/from '@\/src\/lib\/comp-eligibility'/.test(plan) && /holdsPaidPlan\(sub, now\)/.test(plan), 'the Plan view does not ask holdsPaidPlan');
    assert(!/hasPaidAccess/.test(plan), 'the Plan view carries its own copy of the rule');
  });

  // ---- Giving ----

  await check('grant over a live trial succeeds: the row becomes PRO / ACTIVE with the comp marked, no period end, the trial\'s own dates untouched; the usage is reset, the grant is tracked, and the six feature-access keys and the downgrade-notified key are deleted', async () => {
    reset();
    const before = trial(1, 9);
    const trialEnd = time(before.trialEndsAt);
    const trialStart = time(before.trialStartedAt);
    const result = await grant(1, 'pilot');
    assert(result.ok === true && result.subscription?.plan === 'PRO' && result.subscription?.status === 'ACTIVE', `result ${show(result)}`);
    const after = row(1);
    assert(after.plan === 'PRO' && after.status === 'ACTIVE' && after.compedBy === ADMIN && after.compReason === 'pilot' && time(after.compedAt) === NOW, `row ${show(after)}`);
    assert(after.currentPeriodEnd === null && time(after.currentPeriodStart) === NOW && after.cancelAtPeriodEnd === false, `period ${show(after)}`);
    assert(time(after.trialEndsAt) === trialEnd && time(after.trialStartedAt) === trialStart, 'the trial\'s dates changed');
    assert(usageUpserts.length === 1 && (usage.get(1) as Row).textSummariesUsed === 0 && (usage.get(1) as Row).remindersTriggered === 0 && time((usage.get(1) as Row).cycleStartDate) === NOW, `usage ${show(usage.get(1))}`);
    assert(activity.includes('1:admin_granted_premium'), `activity ${activity.join(',')}`);
    const want = [...FEATURES.map(f => REDIS_KEYS.featureAccess(1, f)), REDIS_KEYS.reminderDowngradeNotified(1)].sort();
    assert(show([...redisDeletes].sort()) === show(want), `deleted ${show(redisDeletes)}`);
    assert(silent(), `a notice or an error: trial ${trialNotices.join(',')}, captured ${captured.join(',')}`);
  });

  await check('grant over a trial that is over but was never flipped to EXPIRED (nobody opened their plan since) succeeds too', async () => {
    reset();
    trial(1, -1);
    const result = await grant(1);
    assert(result.ok === true && row(1).plan === 'PRO' && row(1).status === 'ACTIVE' && row(1).compedBy === ADMIN, `result ${show(result)}, row ${show(row(1))}`);
  });

  await check('grant is still refused for a paid plan (ACTIVE), a cancelled one that still runs (ALREADY_ACTIVE, with its plan and status) and an already-given Pro (ALREADY_COMPED); the row is not touched', async () => {
    reset();
    activePaid(1);
    canceled(2, 5);
    seed(3, { plan: 'PRO', status: 'ACTIVE', compedBy: 4, compedAt: new RealDate(NOW - DAY), currentPeriodEnd: null });
    const frozen = show([row(1), row(2), row(3)]);
    const r1 = await grant(1);
    const r2 = await grant(2);
    const r3 = await grant(3);
    assert(show(r1) === show({ ok: false, code: 'ALREADY_ACTIVE', plan: 'BASIC', status: 'ACTIVE' }), `ACTIVE: ${show(r1)}`);
    assert(show(r2) === show({ ok: false, code: 'ALREADY_ACTIVE', plan: 'BASIC', status: 'CANCELED' }), `CANCELED ahead: ${show(r2)}`);
    assert(show(r3) === show({ ok: false, code: 'ALREADY_COMPED' }), `comped: ${show(r3)}`);
    assert(subscriptionWrites.length === 0 && usageUpserts.length === 0 && redisDeletes.length === 0 && activity.length === 0, `a refusal wrote: ${show(subscriptionWrites)}, ${activity.join(',')}`);
    assert(show([row(1), row(2), row(3)]) === frozen, 'a refused row changed');
  });

  await check('grant is allowed for an EXPIRED person, a CANCELED one past the period end, and a person with no row at all (the row is created, trial end = now: there is no trial to give back)', async () => {
    reset();
    expired(1);
    canceled(2, -2);
    const r1 = await grant(1);
    const r2 = await grant(2);
    const r3 = await grant(3);
    assert(r1.ok && r2.ok && r3.ok, `results ${show([r1, r2, r3])}`);
    for (const id of [1, 2, 3]) assert(row(id).plan === 'PRO' && row(id).status === 'ACTIVE' && row(id).compedBy === ADMIN && row(id).currentPeriodEnd === null, `row ${id}: ${show(row(id))}`);
    assert(subscriptionWrites.filter(w => w.op === 'create').length === 1 && time(row(3).trialEndsAt) === NOW && time(row(3).trialStartedAt) === NOW, `created: ${show(subscriptionWrites.filter(w => w.op === 'create'))}`);
  });

  // ---- Stopping ----

  await check('revoke mid-trial gives back the trial days that are left: FREE / TRIALING, the comp fields cleared, the period cleared, trialEndsAt exactly what it was; the plan then reads as Pro again (the trial)', async () => {
    reset();
    const before = trial(1, 9);
    const trialEnd = time(before.trialEndsAt);
    assert((await grant(1, 'pilot')).ok, 'the grant');
    clock = NOW + 4 * DAY; // four days into the gift: five trial days are left
    const result = await revoke(1);
    assert(result.ok === true, `result ${show(result)}`);
    const after = row(1);
    assert(after.plan === 'FREE' && after.status === 'TRIALING', `row ${show(after)}`);
    assert(after.compedBy === null && after.compedAt === null && after.compReason === null && after.currentPeriodStart === null && after.currentPeriodEnd === null && after.cancelAtPeriodEnd === false, `fields ${show(after)}`);
    assert(time(after.trialEndsAt) === trialEnd, `trialEndsAt moved: ${show(after.trialEndsAt)}`);
    const plan = await service.getSubscriptionWithUsage(1);
    assert(plan.effectivePlan === 'PRO' && plan.subscription.status === 'TRIALING', `the plan after: ${plan.effectivePlan} ${plan.subscription.status}`);
    assert(activity.includes('1:admin_revoked_premium') && trialNotices.length === 0 && captured.length === 0, `activity ${activity.join(',')}, notices ${trialNotices.join(',')}`);
  });

  await check('revoke after the trial\'s end gives FREE / EXPIRED (the same gift, stopped later than the trial would have run); a trial ending this very moment is over too', async () => {
    reset();
    trial(1, 9);
    assert((await grant(1)).ok, 'the grant');
    clock = NOW + 10 * DAY;
    assert((await revoke(1)).ok === true, 'the revoke');
    assert(row(1).plan === 'FREE' && row(1).status === 'EXPIRED' && row(1).compedBy === null && row(1).currentPeriodEnd === null, `row ${show(row(1))}`);
    const plan = await service.getSubscriptionWithUsage(1);
    assert(plan.effectivePlan === 'FREE', `the plan after: ${plan.effectivePlan}`);
    // The strict edge: the trial ends exactly now
    reset();
    trial(2, 9);
    assert((await grant(2)).ok, 'the grant');
    clock = NOW + 9 * DAY;
    assert((await revoke(2)).ok === true && row(2).status === 'EXPIRED', `the edge: ${show(row(2))}`);
  });

  await check('revoke after a gift made from no row, or over an expired person, gives FREE / EXPIRED (there was no trial left to give back); a revoke of a row that is not a gift is refused and writes nothing', async () => {
    reset();
    expired(1);
    assert((await grant(1)).ok && (await grant(2)).ok, 'the grants (one over EXPIRED, one from no row)');
    assert((await revoke(1)).ok && (await revoke(2)).ok, 'the revokes');
    assert(row(1).status === 'EXPIRED' && row(1).plan === 'FREE' && row(2).status === 'EXPIRED' && row(2).plan === 'FREE', `rows ${show([row(1), row(2)])}`);
    clock = NOW + 3 * DAY;
    assert((await service.getSubscriptionWithUsage(2)).effectivePlan === 'FREE', 'a person given Pro from nothing is Free after it');
    // Not a gift
    reset();
    trial(1, 9);
    activePaid(2);
    const writesBefore = subscriptionWrites.length;
    const r1 = await revoke(1);
    const r2 = await revoke(2);
    const r3 = await revoke(3);
    assert([r1, r2, r3].every(r => r.ok === false && r.code === 'NOT_COMPED') && subscriptionWrites.length === writesBefore && activity.length === 0, `${show([r1, r2, r3])}, writes ${subscriptionWrites.length}`);
    assert(row(2).plan === 'BASIC' && row(2).status === 'ACTIVE' && row(1).status === 'TRIALING', 'a row that was not a gift changed');
  });

  // ---- What the person can use ----

  await check('access: a gift over a lapsed trial allows reminders at once (the cache of the "upgrade needed" answer is cleared by the grant), stopping it after the trial\'s end shuts them again at once, and stopping it mid-trial leaves them on (the trial is Pro)', async () => {
    reset();
    trial(1, -1);
    const closed = await service.checkFeatureAccess(1, 'reminders'); // finds the trial over, flips it, caches "upgrade_required"
    assert(closed.allowed === false && closed.reason === 'upgrade_required' && row(1).status === 'EXPIRED', `before the gift: ${show(closed)} ${row(1).status}`);
    await new Promise(resolve => setImmediate(resolve)); // the cache write is not awaited by the service
    assert(redisStore.has(REDIS_KEYS.featureAccess(1, 'reminders')), 'the closed answer was not cached, so this check proves nothing');
    assert((await grant(1)).ok, 'the grant over the expired person');
    const open = await service.checkFeatureAccess(1, 'reminders');
    assert(open.allowed === true, `with the gift: ${show(open)}`);
    await new Promise(resolve => setImmediate(resolve));
    assert((await revoke(1)).ok, 'the revoke');
    const closedAgain = await service.checkFeatureAccess(1, 'reminders');
    assert(closedAgain.allowed === false && closedAgain.reason === 'upgrade_required', `after stopping: ${show(closedAgain)}`);
    // Over a live trial: the gift is Pro either way, and stopping it mid-trial is Pro still, until the trial ends
    reset();
    trial(2, 9);
    assert((await grant(2)).ok, 'the grant over the trial');
    assert((await service.checkFeatureAccess(2, 'reminders')).allowed === true, 'with the gift');
    await new Promise(resolve => setImmediate(resolve));
    clock = NOW + 2 * DAY;
    assert((await revoke(2)).ok && row(2).status === 'TRIALING', 'the revoke mid-trial');
    assert((await service.checkFeatureAccess(2, 'reminders')).allowed === true, 'mid-trial after stopping');
    await new Promise(resolve => setImmediate(resolve));
    clock = NOW + 10 * DAY;
    redisStore.clear(); // the cache keeps an answer 24 hours; ten days on, the "allowed" cached above has expired
    const over = await service.checkFeatureAccess(2, 'reminders');
    assert(over.allowed === false && over.reason === 'upgrade_required' && row(2).status === 'EXPIRED', `after the trial: ${show(over)} ${row(2).status}`);
  });

  await check('access order is unchanged: with early access on everyone is allowed with or without the gift (the gift is a no-op for access); an admin\'s feature grant allows the feature on a plan that lacks it, before the gift and after stopping it', async () => {
    reset();
    earlyAdoption = true;
    expired(1);
    assert((await service.checkFeatureAccess(1, 'reminders')).allowed === true, 'early access, no gift');
    assert((await grant(1)).ok, 'the grant');
    assert((await service.checkFeatureAccess(1, 'reminders')).allowed === true, 'early access, gift');
    assert((await revoke(1)).ok, 'the revoke');
    assert((await service.checkFeatureAccess(1, 'reminders')).allowed === true, 'early access, stopped');
    reset();
    expired(2);
    overrides.set(2, { userId: 2, remindersEnabled: true, unlimitedSummaries: null, voiceEventsEnabled: null, unlimitedCalendars: null, earlyAdopter: false });
    assert((await service.checkFeatureAccess(2, 'reminders')).allowed === true, 'a feature grant on a free plan');
    assert((await service.checkFeatureAccess(2, 'voice_events')).allowed === false, 'the grant is for reminders only');
    assert((await grant(2)).ok && (await revoke(2)).ok, 'a gift and stopping it');
    assert((await service.checkFeatureAccess(2, 'reminders')).allowed === true && (await service.checkFeatureAccess(2, 'voice_events')).allowed === false, 'the feature grant after the gift');
  });

  // ---- Silence ----

  await check('the gift is silent: no message to the person on giving or stopping; a gift over a lapsed trial is not flipped to EXPIRED by a later plan check, so the "your trial ended" notice never goes; the notice goes once, as always, for a trial whose gift was stopped mid-trial and then ran out', async () => {
    reset();
    trial(1, -1);
    assert((await grant(1)).ok, 'the grant');
    const plan = await service.getSubscriptionWithUsage(1);
    assert(plan.effectivePlan === 'PRO' && row(1).status === 'ACTIVE' && trialNotices.length === 0, `a plan check after the gift: ${plan.effectivePlan} ${row(1).status} notices ${trialNotices.join(',')}`);
    clock = NOW + 30 * DAY;
    await service.getSubscriptionWithUsage(1);
    assert(row(1).status === 'ACTIVE' && !activity.includes('1:subscription_expired') && trialNotices.length === 0, `much later: ${row(1).status}`);
    assert((await revoke(1)).ok && trialNotices.length === 0, 'stopping it sent a notice');
    // Stopped mid-trial: the trial is back, and when it runs out the normal notice goes, once
    reset();
    trial(2, 9);
    assert((await grant(2)).ok, 'the grant');
    clock = NOW + 3 * DAY;
    assert((await revoke(2)).ok && row(2).status === 'TRIALING' && trialNotices.length === 0, 'the revoke mid-trial');
    clock = NOW + 10 * DAY;
    await service.getSubscriptionWithUsage(2);
    await service.getSubscriptionWithUsage(2);
    assert(row(2).status === 'EXPIRED' && show(trialNotices) === show([1002]), `the trial ran out: ${row(2).status}, notices ${show(trialNotices)}`);
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

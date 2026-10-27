// Smoke test for the admin panel's data layer (app/[locale]/admin-panel/data/; plan
// docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Task 1): the one request helper, a hook per area, the
// formatters, and the blocklist route's self-ban guard. Real React on the small fake DOM (the hooks are probed through a
// component), a fake Telegram.WebApp and a fake fetch. No network, no DB.
//  - D1 every request the panel makes, for every row of the research map: the exact URL, method, header and body (deep
//    equal); the launch data in the header always and in the body of a POST, never in a URL;
//  - D2 a 500, a { success: false } answer, a body that is no JSON and a throw each give { ok: false } and one log, and
//    never a throw; a code in capitals is passed on, the route's prose is not;
//  - D3 a switch flips at once and goes back when the post fails; a second tap while it saves sends nothing;
//  - D4 the profile's load is guarded: two loads, the first answered last, the second wins (data and activity);
//  - D5 the activity lists are guarded: one fetch when a list opens, one per filter, "Show more" ignores a tap while a
//    page is on its way, and an answer for a list that has changed is dropped;
//  - D6 every action carries the person's database id (never the viewer's Telegram id) and, when it works, reloads the
//    profile and the list; a delete clears the profile and reloads the list; a failure reloads nothing;
//  - D7 the formatters in en, he and ru: "ago" in each language's own words, 24-hour dates, the plan line with its plurals;
//  - D8 POST /api/admin/users/blocklist answers 400 SELF_BAN when an admin bans their own Telegram id or number, and bans
//    anyone else's;
//  - D9 React logs no warning.
//
// Run with the fake env from the task brief (no dotenv), under two clocks:
//   TZ=UTC npx tsx scripts/smoke-admin-data.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-admin-data.ts

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { act, createElement, useEffect } from 'react';
import { createTranslator } from 'next-intl';
import { fakeWindow, installWindow, mount, type Row } from './lib/fake-dom';
import { calls, defaultRespond, deferred, detail, INIT_DATA, installFakeFetch, json, listItem, OTHER, ok, PHONE, TARGET, VIEWER_TELEGRAM_ID, world, type Call } from './lib/admin-world';
import type { AdminResult, Outcome } from '../app/[locale]/admin-panel/data/admin-api';

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

// Test values, used only when the fake env left them unset.
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.CRON_SECRET ||= 'test-cron';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

type Locale = 'en' | 'he' | 'ru';
const LOCALES: Locale[] = ['en', 'he', 'ru'];
const messages: Record<Locale, Row> = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))])) as Record<Locale, Row>;

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message || String(err.stack).split('\n').slice(0, 4).join(' | ') : String(err) });
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
/** JSON with sorted keys: two values with the same content show the same. */
function canon(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
}

// ---- React must not warn; what the layer itself logs is kept to be asserted ----

const reactWarnings: string[] = [];
const adminLogs: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map((a) => (typeof a === 'string' ? a : canon(a))).join(' ');
    if (text.startsWith('[admin]')) return void adminLogs.push(text);
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's.
    if (text.startsWith('(node:')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- The world: Telegram, a fake fetch and a small admin back end (scripts/lib/admin-world.ts) ----

installFakeFetch();

/** How many requests have been sent since the last reset (a function, so that a narrowed type does not stick). */
const sent = () => calls.length;
const reset = () => {
  calls.splice(0);
  adminLogs.length = 0;
  world.respond = defaultRespond;
};

const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });

/** Mount a hook in a probe component; `latest()` is what it returned on the last render. */
function hooked<T>(useIt: () => T) {
  const box: { value: T | null } = { value: null };
  function Probe() {
    const value = useIt();
    useEffect(() => {
      box.value = value;
    });
    return null;
  }
  installWindow();
  fakeWindow.Telegram = { WebApp: { initData: INIT_DATA } };
  const m = mount(createElement(Probe));
  return {
    latest: () => box.value as T,
    /** Run something with the hook's current value inside act, and wait for it. */
    run: async <R>(fn: (hook: T) => Promise<R> | R): Promise<R> => {
      let out!: R;
      await act(async () => {
        out = await fn(box.value as T);
      });
      return out;
    },
    unmount: () => m.unmount(),
  };
}

/** The call at `index` is this request: method, URL and (for a body) the launch data with it. */
function expectCall(call: Call | undefined, method: string, url: string, body?: Row, label = url) {
  assert(call, `${label}: no request was sent`);
  assert(call.method === method && call.url === url, `${label}: sent ${call.method} ${call.url}, wanted ${method} ${url}`);
  assert(call.headers['x-telegram-init-data'] === INIT_DATA, `${label}: the header is ${call.headers['x-telegram-init-data']}`);
  assert(!/initData/i.test(call.url), `${label}: initData is in the URL`);
  if (body === undefined) assert(call.body === undefined, `${label}: a body was sent: ${canon(call.body)}`);
  else assert(canon(call.body) === canon({ ...body, initData: INIT_DATA }), `${label}: body ${canon(call.body)}, wanted ${canon({ ...body, initData: INIT_DATA })}`);
}

// ---- D8's route harness: the blocklist route for real over a small in-memory Prisma ----

const DB: { user: Row[]; blockedIdentifier: Row[] } = { user: [], blockedIdentifier: [] };
const blocked = () => DB.blockedIdentifier;
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b);
const fakePrisma = {
  user: {
    findUnique: async ({ where }: Row) => DB.user.find((u) => Object.entries(where).every(([k, v]) => same(u[k], v))) ?? null,
  },
  blockedIdentifier: {
    upsert: async ({ where, update, create }: Row) => {
      const row = DB.blockedIdentifier.find((r) => Object.entries(where).every(([k, v]) => same(r[k], v)));
      if (row) return Object.assign(row, update);
      const made = { id: blocked().length + 1, telegramId: null, whatsappPhone: null, createdAt: new Date(), ...create };
      DB.blockedIdentifier.push(made);
      return made;
    },
    deleteMany: async () => ({ count: 0 }),
    findMany: async () => DB.blockedIdentifier,
    findFirst: async () => null,
  },
};
const redisStore = new Map<string, string>();
const fakeRedis = new Proxy({} as Row, {
  get: (_t, p) => (typeof p !== 'string' || p === 'then' ? undefined : async (...a: unknown[]) => (p === 'set' ? (redisStore.set(String(a[0]), String(a[1])), 'OK') : null)),
});

const Module = nodeRequire('module');
const stubs: Record<string, Row> = {};
(globalThis as Row).__smokeStubs = stubs;
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs)) return nextLoad(url, context);
    const names = Object.keys(stubs[file]).filter((n) => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
    const source = [`const s = globalThis.__smokeStubs[${JSON.stringify(file)}];`, ...names.map((n) => `export const ${n} = s[${JSON.stringify(n)}];`), 'export default (s.__esModule ? s.default : s);'].join('\n');
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
const captured: string[] = [];
function installRouteStubs() {
  stub('src/utils/prisma.ts', { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() });
  stub('src/utils/redis.ts', { redis: fakeRedis });
  stub('src/lib/error-capture.ts', {
    captureError: (e: unknown, ctx: string) => void captured.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`),
    captureWarning: () => undefined,
    captureInfo: () => undefined,
  });
}
function initDataFor(tgId: number): string {
  const params: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAH-smoke', user: JSON.stringify({ id: tgId, first_name: 'Test' }) };
  const checkString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN ?? '').digest();
  const hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  return [...Object.entries(params), ['hash', hash]].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}
const ADMIN_TELEGRAM = 111111111;
const ADMIN_PHONE = '+972501112222';
function seedRoute() {
  DB.user = [
    { id: 9, name: 'Admin', telegramId: BigInt(ADMIN_TELEGRAM), whatsappPhone: ADMIN_PHONE, whatsappBsuid: null, isAdmin: true, googleRefreshToken: '', language: 'en', messagingPlatform: 'telegram', culture: 'default', calendarSource: 'NATIVE' },
    { id: 42, name: 'Other', telegramId: BigInt(222222222), whatsappPhone: '+972503334444', whatsappBsuid: null, isAdmin: false, googleRefreshToken: '', language: 'en', messagingPlatform: 'telegram', culture: 'default', calendarSource: 'NATIVE' },
  ];
  DB.blockedIdentifier = [];
  redisStore.clear();
  captured.length = 0;
}

// ---- The checks ----

async function main() {
  const api = await import('../app/[locale]/admin-panel/data/admin-api');
  const { useAdminSettings } = await import('../app/[locale]/admin-panel/data/use-admin-settings');
  const { useUsers, filterUsers, resetAllSetupReminders } = await import('../app/[locale]/admin-panel/data/use-users');
  const { useUserProfile } = await import('../app/[locale]/admin-panel/data/use-user-profile');
  const { useActivity } = await import('../app/[locale]/admin-panel/data/use-activity');
  const { useFeedback } = await import('../app/[locale]/admin-panel/data/use-feedback');
  const { useBlocklist } = await import('../app/[locale]/admin-panel/data/use-blocklist');
  const format = await import('../app/[locale]/admin-panel/data/format');
  const { NextRequest } = nodeRequire('next/server');
  installRouteStubs();

  const FLAGS = { remindersEnabled: false, nativeRemindersEnabled: true, earlyAdoptionMode: false, voiceAutoCreateHighConf: false, voiceTtsOutcome: false };

  /** The people list and one person's profile together, as the panel's shell wires them (an action reloads the list). */
  const useBoth = () => {
    const users = useUsers();
    const profile = useUserProfile(users.load);
    return { users, profile };
  };
  const OVERRIDES = { unlimitedSummaries: true, remindersEnabled: false, voiceEventsEnabled: true, unlimitedCalendars: false, earlyAdopter: true, reason: 'beta tester' };
  // Every action of a profile, with the request it sends (method, URL, body without the launch data).
  const ACTIONS: { name: string; run: (p: ReturnType<typeof useUserProfile>) => Promise<Outcome>; method: string; url: string; body?: Row }[] = [
    {
      name: 'saveOverrides',
      run: (p) => p.saveOverrides(OVERRIDES),
      method: 'POST',
      url: '/api/admin/user-overrides',
      body: { user_id: TARGET, unlimitedSummaries: true, remindersEnabled: null, voiceEventsEnabled: true, unlimitedCalendars: null, earlyAdopter: true, reason: 'beta tester' },
    },
    { name: 'grantComp', run: (p) => p.grantComp('pilot'), method: 'POST', url: '/api/admin/subscription', body: { user_id: TARGET, reason: 'pilot' } },
    { name: 'grantComp without a reason', run: (p) => p.grantComp(''), method: 'POST', url: '/api/admin/subscription', body: { user_id: TARGET, reason: null } },
    { name: 'revokeComp', run: (p) => p.revokeComp(), method: 'DELETE', url: `/api/admin/subscription?user_id=${TARGET}` },
    { name: 'sendReminder', run: (p) => p.sendReminder('location'), method: 'POST', url: '/api/admin/send-reminder', body: { user_id: TARGET, reminder_type: 'location' } },
    { name: 'resetReminders', run: (p) => p.resetReminders(), method: 'POST', url: '/api/admin/reset-reminders', body: { user_id: TARGET } },
    { name: 'switchToWhatsApp', run: (p) => p.switchToWhatsApp(' +972501234567 '), method: 'POST', url: '/api/admin/switch-platform', body: { user_id: TARGET, whatsapp_phone: '+972501234567' } },
    { name: 'suspend', run: (p) => p.suspend('spam'), method: 'POST', url: '/api/admin/users/moderation', body: { action: 'suspend', user_id: TARGET, reason: 'spam' } },
    { name: 'suspend without a reason', run: (p) => p.suspend(''), method: 'POST', url: '/api/admin/users/moderation', body: { action: 'suspend', user_id: TARGET, reason: null } },
    { name: 'unsuspend', run: (p) => p.unsuspend(), method: 'POST', url: '/api/admin/users/moderation', body: { action: 'unsuspend', user_id: TARGET, reason: null } },
    {
      name: 'ban',
      run: (p) => p.ban({ telegram: true, whatsapp: true, reason: 'abuse' }),
      method: 'POST',
      url: '/api/admin/users/blocklist',
      body: { action: 'ban', telegramId: 7000000 + TARGET, whatsappPhone: PHONE[TARGET], reason: 'abuse' },
    },
    {
      name: 'ban (Telegram only)',
      run: (p) => p.ban({ telegram: true, whatsapp: false, reason: '' }),
      method: 'POST',
      url: '/api/admin/users/blocklist',
      body: { action: 'ban', telegramId: 7000000 + TARGET, whatsappPhone: null, reason: null },
    },
    { name: 'hardDelete', run: (p) => p.hardDelete('DELETE'), method: 'POST', url: '/api/admin/users/moderation', body: { action: 'hard_delete', user_id: TARGET, reason: null, confirmation: 'DELETE' } },
  ];
  const openProfile = async (h: ReturnType<typeof hooked<ReturnType<typeof useBoth>>>, id = TARGET) => {
    await h.run((x) => x.profile.load(id));
    await settle();
  };

  await check('D1 every request of the research map: the exact URL, method, header and body, the launch data in the header always and in the body of a POST, in no URL', async () => {
    reset();
    installWindow();
    fakeWindow.Telegram = { WebApp: { initData: INIT_DATA } };

    // The loader's two calls and the helper's three verbs
    await api.adminGet('settings');
    await api.adminGet('stats');
    expectCall(calls[0], 'GET', '/api/admin/settings', undefined, 'settings');
    expectCall(calls[1], 'GET', '/api/admin/stats', undefined, 'stats');
    await api.adminGet('user-activity', { user_id: TARGET, limit: 20, offset: 40, action: undefined });
    expectCall(calls[2], 'GET', `/api/admin/user-activity?user_id=${TARGET}&limit=20&offset=40`, undefined, 'a param left undefined is left out');
    await api.adminDelete('subscription', { user_id: TARGET });
    expectCall(calls[3], 'DELETE', `/api/admin/subscription?user_id=${TARGET}`, undefined, 'DELETE');
    world.respond = () => ok({ usersReset: 3 });
    const everyone = await resetAllSetupReminders();
    world.respond = defaultRespond;
    assert(everyone.ok && everyone.data.usersReset === 3, `reset all answered ${canon(everyone)}`);
    expectCall(calls[4], 'POST', '/api/admin/reset-reminders', { reset_all: true }, 'reset all');
    assert(calls[4].headers['content-type'] === 'application/json', `POST content type ${calls[4].headers['content-type']}`);

    // The people list
    reset();
    const lists = hooked(useBoth);
    await lists.run((x) => x.users.load());
    expectCall(calls[0], 'GET', '/api/admin/user-overrides?list=all', undefined, 'the list');
    lists.unmount();

    // The global activity log: opening, a filter, the next page
    reset();
    const log = hooked(useActivity);
    await settle();
    expectCall(calls[0], 'GET', '/api/admin/user-activity?limit=20&offset=0', undefined, 'activity opens');
    await log.run((x) => x.setFilter('login'));
    await settle();
    expectCall(calls[1], 'GET', '/api/admin/user-activity?limit=20&offset=0&action=login', undefined, 'activity filter');
    await log.run((x) => x.loadMore());
    expectCall(calls[2], 'GET', '/api/admin/user-activity?limit=20&offset=20&action=login', undefined, 'activity show more');
    assert(sent() === 3, `${sent()} requests for three steps`);
    log.unmount();

    // Feedback and the blocklist
    reset();
    const feedback = hooked(useFeedback);
    await feedback.run((x) => x.load());
    await feedback.run((x) => x.loadMore());
    expectCall(calls[0], 'GET', '/api/admin/feedback?limit=50', undefined, 'feedback');
    expectCall(calls[1], 'GET', '/api/admin/feedback?limit=50&offset=50', undefined, 'feedback show more');
    feedback.unmount();
    reset();
    const blocklist = hooked(useBlocklist);
    await blocklist.run((x) => x.load());
    expectCall(calls[0], 'GET', '/api/admin/users/blocklist', undefined, 'blocklist');
    const entry = blocklist.latest().entries[0];
    await blocklist.run((x) => x.unban(entry));
    expectCall(calls[1], 'POST', '/api/admin/users/blocklist', { action: 'unban', telegramId: 99, whatsappPhone: null }, 'unban');
    expectCall(calls[2], 'GET', '/api/admin/users/blocklist', undefined, 'the blocklist reloads after an unban');
    blocklist.unmount();

    // The five switches
    reset();
    const settings = hooked(() => useAdminSettings(FLAGS));
    for (const [flag, value] of [
      ['remindersEnabled', true],
      ['nativeRemindersEnabled', false],
      ['earlyAdoptionMode', true],
      ['voiceAutoCreateHighConf', true],
      ['voiceTtsOutcome', true],
    ] as const) {
      const before = sent();
      await settings.run((x) => x.setFlag(flag, value));
      assert(sent() === before + 1, `${flag}: ${sent() - before} requests`);
      expectCall(calls[before], 'POST', '/api/admin/settings', { [flag]: value }, flag);
    }
    settings.unmount();

    // A profile: opening it, then each action
    reset();
    const both = hooked(useBoth);
    await openProfile(both);
    const opening = calls.map((c) => `${c.method} ${c.url}`).sort();
    assert(canon(opening) === canon([`GET /api/admin/user-activity?user_id=${TARGET}&limit=20&offset=0`, `GET /api/admin/user-overrides?user_id=${TARGET}`]), `opening a profile: ${canon(opening)}`);
    for (const call of calls) expectCall(call, 'GET', call.url, undefined, 'opening a profile');
    for (const action of ACTIONS.filter((a) => a.name !== 'hardDelete')) {
      reset();
      const outcome = await both.run((x) => action.run(x.profile));
      assert(outcome.ok, `${action.name}: ${canon(outcome)}`);
      expectCall(calls[0], action.method, action.url, action.body, action.name);
    }
    reset();
    await both.run((x) => ACTIONS[ACTIONS.length - 1].run(x.profile));
    const del = ACTIONS[ACTIONS.length - 1];
    expectCall(calls[0], del.method, del.url, del.body, del.name);
    both.unmount();
  });

  await check('D2 a 500, a { success: false } answer, a body that is no JSON and a throw each give { ok: false } and one [admin] log, and never throw; a code in capitals is kept, a route\'s prose is not', async () => {
    reset();
    installWindow();
    fakeWindow.Telegram = { WebApp: { initData: INIT_DATA } };
    const verbs: [string, () => Promise<AdminResult<unknown>>][] = [
      ['GET', () => api.adminGet('stats')],
      ['POST', () => api.adminPost('settings', { remindersEnabled: true })],
      ['DELETE', () => api.adminDelete('subscription', { user_id: TARGET })],
    ];
    const answers: [string, () => Response | Promise<Response>, number, string | undefined][] = [
      ['a 500', () => json({ error: 'Failed to fetch stats' }, 500), 500, undefined],
      ['a 200 that says success: false', () => json({ success: false }, 200), 200, undefined],
      ['a 200 with no success', () => json({}, 200), 200, undefined],
      ['a 200 with no JSON', () => new Response('<html>', { status: 200 }), 200, undefined],
      ['a 400 with a code', () => json({ error: 'SELF_BAN' }, 400), 400, 'SELF_BAN'],
      ['a 409 with prose', () => json({ error: 'User already has an active plan (PRO / ACTIVE)' }, 409), 409, undefined],
      ['a 401', () => json({ error: 'Unauthorized' }, 401), 401, undefined],
      ['a throw', () => Promise.reject(new TypeError('Failed to fetch')), 0, undefined],
    ];
    const problems: string[] = [];
    for (const [verb, run] of verbs) {
      for (const [what, answer, status, code] of answers) {
        reset();
        world.respond = answer;
        let result: AdminResult<unknown>;
        try {
          result = await run();
        } catch (error) {
          problems.push(`${verb} with ${what}: it threw ${String(error)}`);
          continue;
        }
        if (result.ok) problems.push(`${verb} with ${what}: ok`);
        else if (result.status !== status || result.code !== code) problems.push(`${verb} with ${what}: ${canon(result)}`);
        if (adminLogs.length !== 1 || !/^\[admin\] [\w/-]+ failed:/.test(adminLogs[0])) problems.push(`${verb} with ${what}: logs ${canon(adminLogs)}`);
      }
    }
    // A good answer: ok, with the body as data
    reset();
    world.respond = () => ok({ users: [] });
    const good = await api.adminGet<{ users: unknown[] }>('user-overrides', { list: 'all' });
    if (!good.ok || good.data.users.length !== 0 || adminLogs.length) problems.push(`a good answer: ${canon(good)} ${canon(adminLogs)}`);
    // The outcome of an action
    reset();
    world.respond = () => json({ error: 'SELF_BAN' }, 400);
    const outcome = api.outcomeOf(await api.adminPost('users/blocklist', {}));
    if (outcome.ok || outcome.code !== 'SELF_BAN') problems.push(`outcomeOf: ${canon(outcome)}`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('D3 setFlag flips the switch at once, keeps it when the post worked and puts it back when it failed (and says so); a second tap while it saves sends nothing', async () => {
    reset();
    const h = hooked(() => useAdminSettings(FLAGS));
    // It flips before the answer
    const gate = deferred<Response>();
    world.respond = () => gate.promise;
    let pending!: Promise<Outcome>;
    await act(async () => {
      pending = h.latest().setFlag('earlyAdoptionMode', true);
    });
    assert(h.latest().flags.earlyAdoptionMode === true && h.latest().saving.earlyAdoptionMode === true, `while saving: ${canon(h.latest())}`);
    // A second tap while it saves
    const second = await h.run((x) => x.setFlag('earlyAdoptionMode', false));
    assert(api.isBusy(second) && sent() === 1, `the second tap: ${canon(second)}, ${sent()} requests`);
    // Another switch is its own
    world.respond = defaultRespond;
    const other = await h.run((x) => x.setFlag('voiceTtsOutcome', true));
    assert(other.ok && h.latest().flags.voiceTtsOutcome === true && sent() === 2, `another switch: ${canon(other)}`);
    await act(async () => {
      gate.resolve(ok({}));
      await pending;
    });
    assert(h.latest().flags.earlyAdoptionMode === true && h.latest().saving.earlyAdoptionMode === false, `after a good answer: ${canon(h.latest())}`);
    // A failure puts it back
    reset();
    world.respond = () => json({ error: 'Failed to update settings' }, 500);
    const failed = await h.run((x) => x.setFlag('earlyAdoptionMode', false));
    assert(!failed.ok && failed.status === 500, `the outcome: ${canon(failed)}`);
    assert(h.latest().flags.earlyAdoptionMode === true && h.latest().saving.earlyAdoptionMode === false, `after a failure: ${canon(h.latest())}`);
    assert(adminLogs.length === 1, `logs ${canon(adminLogs)}`);
    // A thrown request too
    reset();
    world.respond = () => Promise.reject(new TypeError('Failed to fetch'));
    const thrown = await h.run((x) => x.setFlag('remindersEnabled', true));
    assert(!thrown.ok && thrown.status === 0 && h.latest().flags.remindersEnabled === false, `a throw: ${canon(thrown)} ${canon(h.latest().flags)}`);
    h.unmount();
  });

  await check('D4 the profile load is guarded: load(A) then load(B) with A answered last shows B only (its data and its activity); a load that comes back after the screen is gone lands nowhere', async () => {
    reset();
    const gates: Record<string, ReturnType<typeof deferred<Response>>> = {};
    const gate = (key: string) => (gates[key] ??= deferred<Response>());
    const gatedRespond = (call: Call): Response | Promise<Response> => {
      const url = new URL(call.url, 'http://localhost');
      const id = url.searchParams.get('user_id');
      if (id && (url.pathname.endsWith('user-overrides') || url.pathname.endsWith('user-activity'))) {
        const key = `${url.pathname.split('/').pop()}:${id}`;
        return gate(key).promise.then(() => defaultRespond(call));
      }
      return defaultRespond(call);
    };
    world.respond = gatedRespond;
    const h = hooked(() => useUserProfile(() => undefined));
    let a!: Promise<void>;
    let b!: Promise<void>;
    await act(async () => {
      a = h.latest().load(TARGET);
      b = h.latest().load(OTHER);
    });
    assert(h.latest().profile === null && h.latest().status === 'loading', 'both loads are on their way: the screen waits');
    // B answers first, then A, the one that was asked first
    await act(async () => {
      gate(`user-overrides:${OTHER}`).resolve(ok());
      gate(`user-activity:${OTHER}`).resolve(ok());
      await b;
    });
    await act(async () => {
      gate(`user-overrides:${TARGET}`).resolve(ok());
      gate(`user-activity:${TARGET}`).resolve(ok());
      await a;
    });
    const shown = h.latest();
    assert(shown.profile?.id === OTHER && shown.profile.name === 'Dan' && shown.status === 'ready', `the profile: ${canon(shown.profile)}`);
    assert(shown.activity.items.length === 20 && shown.activity.items.every((item) => item.id.startsWith(`a${OTHER}-`)), `the activity: ${canon(shown.activity.items.map((i) => i.id))}`);

    // A load answered after the screen is gone
    reset();
    world.respond = gatedRespond;
    gates[`user-overrides:${TARGET}`] = deferred<Response>();
    gates[`user-activity:${TARGET}`] = deferred<Response>();
    let late!: Promise<void>;
    await act(async () => {
      late = h.latest().load(TARGET);
    });
    h.unmount();
    gates[`user-overrides:${TARGET}`].resolve(ok());
    gates[`user-activity:${TARGET}`].resolve(ok());
    await late;
    await settle();
    assert(reactWarnings.length === 0, `warnings: ${reactWarnings.join(' | ')}`);
  });

  await check('D5 the activity lists: one request when the list opens and one per filter; Show more sends once for two quick taps, appends the next page and drops duplicates; a filter picked while a page is on its way drops that page; a person\'s activity ignores Show more while a page is on its way, and drops a page when another person is opened', async () => {
    // The global log
    reset();
    const log = hooked(useActivity);
    await settle();
    assert(sent() === 1, `${sent()} requests when it opened`);
    assert(log.latest().items.length === 20 && log.latest().hasMore && log.latest().status === 'ready' && log.latest().stats[0]?.action === 'login', `the first page: ${log.latest().items.length}`);
    const gate = deferred<Response>();
    world.respond = () => gate.promise;
    let more!: Promise<void>;
    await act(async () => {
      more = log.latest().loadMore();
      void log.latest().loadMore();
    });
    assert(sent() === 2, `two quick taps on Show more sent ${sent() - 1}`);
    assert(log.latest().loadingMore, 'Show more is busy while its page is on its way');
    // A filter picked now makes that page stale
    world.respond = defaultRespond;
    await act(async () => {
      log.latest().setFilter('settings_changed');
    });
    await settle();
    await act(async () => {
      gate.resolve(defaultRespond({ url: '/api/admin/user-activity?limit=20&offset=20', method: 'GET', headers: {} }));
      await more;
    });
    const filtered = log.latest();
    assert(filtered.filter === 'settings_changed' && filtered.items.length === 20 && filtered.items.every((i) => i.action === 'settings_changed'), `after the filter: ${filtered.items.length} items, ${canon(filtered.items.map((i) => i.action))}`);
    // Show more on the filtered list appends, once
    reset();
    await log.run((x) => x.loadMore());
    assert(sent() === 1 && log.latest().items.length === 40 && new Set(log.latest().items.map((i) => i.id)).size === 40, `show more: ${sent()} requests, ${log.latest().items.length} items`);
    log.unmount();

    // A person's activity
    reset();
    const both = hooked(useBoth);
    await openProfile(both);
    assert(both.latest().profile.activity.items.length === 20 && both.latest().profile.activity.hasMore, 'the first page of a person\'s activity');
    reset();
    const slow = deferred<Response>();
    world.respond = () => slow.promise;
    let page2!: Promise<void>;
    await act(async () => {
      page2 = both.latest().profile.loadMoreActivity();
      void both.latest().profile.loadMoreActivity();
    });
    assert(sent() === 1 && both.latest().profile.activity.loading, `a person's Show more sent ${sent()} for two taps`);
    expectCall(calls[0], 'GET', `/api/admin/user-activity?user_id=${TARGET}&limit=20&offset=20`, undefined, 'a person\'s Show more');
    // Another person is opened while that page is on its way: it lands nowhere
    world.respond = defaultRespond;
    await act(async () => {
      void both.latest().profile.load(OTHER);
    });
    await settle();
    await act(async () => {
      slow.resolve(defaultRespond({ url: `/api/admin/user-activity?user_id=${TARGET}&limit=20&offset=20`, method: 'GET', headers: {} }));
      await page2;
    });
    const items = both.latest().profile.activity.items;
    assert(items.length === 20 && items.every((i) => i.id.startsWith(`a${OTHER}-`)), `after another person was opened: ${canon(items.map((i) => i.id))}`);
    both.unmount();
  });

  await check('D6 every action carries the person\'s database id and never the viewer\'s Telegram id, and a success reloads the profile and the list (a delete only the list, and the profile is cleared); a failure reloads nothing and leaves the profile as it was; a second action while one runs sends nothing', async () => {
    for (const action of ACTIONS) {
      reset();
      const both = hooked(useBoth);
      await openProfile(both);
      reset();
      const outcome = await both.run((x) => action.run(x.profile));
      assert(outcome.ok, `${action.name}: ${canon(outcome)}`);
      const requests = calls.map((c) => `${c.method} ${c.url}`);
      // The launch data is the viewer's own (it names their Telegram id); everything else a request carries is the person's
      const carries = (c: Call) => canon({ ...c.body, initData: undefined }).includes(String(VIEWER_TELEGRAM_ID)) || c.url.includes(String(VIEWER_TELEGRAM_ID));
      assert(!calls.some(carries), `${action.name}: the viewer's Telegram id is in a request: ${canon(calls)}`);
      assert(requests[0] === `${action.method} ${action.url}`, `${action.name}: first ${requests[0]}`);
      const reloadsList = requests.includes('GET /api/admin/user-overrides?list=all');
      const reloadsProfile = requests.includes(`GET /api/admin/user-overrides?user_id=${TARGET}`);
      assert(reloadsList, `${action.name}: the list was not reloaded: ${canon(requests)}`);
      if (action.name === 'hardDelete') {
        assert(!reloadsProfile && both.latest().profile.profile === null && both.latest().profile.status === 'idle', `hardDelete: the profile is cleared and not asked for again: ${canon(requests)}`);
      } else {
        assert(reloadsProfile && both.latest().profile.profile?.id === TARGET, `${action.name}: the profile was not reloaded: ${canon(requests)}`);
      }
      assert(both.latest().profile.working === null, `${action.name}: still working`);
      both.unmount();
    }

    // A failure: nothing reloads, the profile stays, the outcome says why, and one log is made
    for (const action of ACTIONS) {
      reset();
      const both = hooked(useBoth);
      await openProfile(both);
      const before: string = canon(both.latest().profile.profile);
      reset();
      world.respond = (call) => (call.method === 'GET' ? defaultRespond(call) : json({ error: 'Failed' }, 500));
      const outcome = await both.run((x) => action.run(x.profile));
      assert(!outcome.ok && outcome.status === 500, `${action.name}: ${canon(outcome)}`);
      assert(sent() === 1, `${action.name}: a failed action sent ${sent()} requests`);
      assert(canon(both.latest().profile.profile) === before && both.latest().profile.working === null, `${action.name}: the profile changed after a failure`);
      assert(adminLogs.length === 1, `${action.name}: logs ${canon(adminLogs)}`);
      both.unmount();
    }

    // One action at a time
    reset();
    const both = hooked(useBoth);
    await openProfile(both);
    reset();
    const gate = deferred<Response>();
    world.respond = (call) => (call.method === 'GET' ? defaultRespond(call) : gate.promise);
    let first!: Promise<Outcome>;
    await act(async () => {
      first = both.latest().profile.suspend('a');
    });
    assert(both.latest().profile.working === 'suspend', 'working names the action');
    const second = await both.run((x) => x.profile.resetReminders());
    assert(api.isBusy(second) && sent() === 1, `a second action: ${canon(second)}, ${sent()} requests`);
    await act(async () => {
      gate.resolve(ok());
      await first;
    });
    // No person open: an action sends nothing; a ban with nothing to ban sends nothing
    await both.run((x) => x.profile.clear());
    reset();
    const none = await both.run((x) => x.profile.suspend(''));
    assert(!none.ok && none.code === 'NO_TARGET' && sent() === 0, `no person: ${canon(none)}`);
    both.unmount();

    reset();
    const solo = hooked(useBoth);
    world.respond = (call) => {
      const url = new URL(call.url, 'http://localhost');
      return url.pathname.endsWith('user-overrides') && url.searchParams.has('user_id') ? ok({ user: { ...detail(TARGET), telegramId: null, whatsappPhone: null } }) : defaultRespond(call);
    };
    await openProfile(solo);
    reset();
    const nothing = await solo.run((x) => x.profile.ban({ telegram: true, whatsapp: true, reason: '' }));
    assert(!nothing.ok && nothing.code === 'NO_IDENTIFIER' && sent() === 0, `a ban with no identifier: ${canon(nothing)}`);
    solo.unmount();
  });

  await check('D6b the people list: the filters and the search (name or Telegram id, any case), a newer load makes an older answer stale, and a list that failed to refresh keeps its rows', async () => {
    const mk = (id: number, name: string, sub: Row | null, extra: Row = {}) => ({ ...listItem(id), name, telegramId: 1000 + id, subscription: sub, ...extra }) as never;
    const people = [
      mk(1, 'Noa Levi', { plan: 'FREE', status: 'TRIALING', trialEndsAt: null, trialDaysRemaining: 5, currentPeriodEnd: null }),
      mk(2, 'Dan Cohen', { plan: 'PRO', status: 'ACTIVE', trialEndsAt: null, trialDaysRemaining: null, currentPeriodEnd: '2026-12-01T00:00:00.000Z' }, { hasOverride: true }),
      mk(3, 'Ron', { plan: 'FREE', status: 'EXPIRED', trialEndsAt: null, trialDaysRemaining: null, currentPeriodEnd: null }),
      mk(4, 'Mia', null),
    ];
    const names = (filter: Parameters<typeof filterUsers>[1], search = '') => filterUsers(people, filter, search).map((u) => u.name);
    assert(canon(names('all')) === canon(['Noa Levi', 'Dan Cohen', 'Ron', 'Mia']), `all: ${canon(names('all'))}`);
    assert(canon(names('trial')) === canon(['Noa Levi']), `trial: ${canon(names('trial'))}`);
    assert(canon(names('paid')) === canon(['Dan Cohen']), `paid: ${canon(names('paid'))}`);
    assert(canon(names('free')) === canon(['Ron', 'Mia']), `free: ${canon(names('free'))}`);
    assert(canon(names('override')) === canon(['Dan Cohen']), `override: ${canon(names('override'))}`);
    assert(canon(names('all', ' LEVI ')) === canon(['Noa Levi']) && canon(names('all', '1002')) === canon(['Dan Cohen']) && canon(names('all', 'zzz')) === '[]', 'the search');
    assert(canon(names('paid', 'noa')) === '[]', 'a filter and a search together');

    reset();
    const gates = [deferred<Response>(), deferred<Response>()];
    let n = 0;
    world.respond = () => gates[n++].promise;
    const h = hooked(useUsers);
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = h.latest().load();
      second = h.latest().load();
    });
    await act(async () => {
      gates[1].resolve(ok({ users: [listItem(OTHER)] }));
      await second;
    });
    await act(async () => {
      gates[0].resolve(ok({ users: [listItem(TARGET)] }));
      await first;
    });
    assert(h.latest().users.length === 1 && h.latest().users[0].id === OTHER && h.latest().status === 'ready', `the newer answer wins: ${canon(h.latest().users.map((u) => u.id))}`);
    // A failed refresh keeps what is there; a first load that fails says so
    world.respond = () => json({ error: 'x' }, 500);
    await h.run((x) => x.load());
    assert(h.latest().users.length === 1 && h.latest().status === 'ready', 'a failed refresh keeps the rows');
    h.unmount();
    reset();
    world.respond = () => json({ error: 'x' }, 500);
    const fresh = hooked(useUsers);
    await fresh.run((x) => x.load());
    assert(fresh.latest().status === 'failed' && fresh.latest().users.length === 0, `a first load that failed: ${fresh.latest().status}`);
    fresh.unmount();
  });

  await check('D7 the formatters: "ago" in each language\'s own words, a date with a 24-hour time, and the plan line with the plurals of en, he and ru', () => {
    const now = new Date(2026, 9, 27, 12, 0, 0);
    const ago = (seconds: number, locale: string) => format.relativeTime(new Date(now.getTime() - seconds * 1000).toISOString(), locale, now);
    const want: Record<string, [number, Record<string, string>][]> = {
      now: [[20, { en: 'now', he: 'עכשיו', ru: 'сейчас' }]],
      minutes: [
        [60, { en: '1 minute ago', he: 'לפני דקה', ru: '1 минуту назад' }],
        [300, { en: '5 minutes ago', he: 'לפני 5 דקות', ru: '5 минут назад' }],
        [21 * 60, { en: '21 minutes ago', he: 'לפני 21 דקות', ru: '21 минуту назад' }],
      ],
      hours: [
        [2 * 3600, { en: '2 hours ago', he: 'לפני שעתיים', ru: '2 часа назад' }],
        [3 * 3600, { en: '3 hours ago', he: 'לפני 3 שעות', ru: '3 часа назад' }],
      ],
      days: [
        [86400, { en: 'yesterday', he: 'אתמול', ru: 'вчера' }],
        [5 * 86400, { en: '5 days ago', he: 'לפני 5 ימים', ru: '5 дней назад' }],
      ],
      months: [[65 * 86400, { en: '2 months ago', he: 'לפני חודשיים', ru: '2 месяца назад' }]],
    };
    const problems: string[] = [];
    for (const rows of Object.values(want)) {
      for (const [seconds, texts] of rows) {
        for (const locale of LOCALES) if (ago(seconds, locale) !== texts[locale]) problems.push(`${seconds}s ${locale}: "${ago(seconds, locale)}" for "${texts[locale]}"`);
      }
    }
    assert(problems.length === 0, problems.join('; '));
    assert(format.relativeTime(new Date(now.getTime() + 5 * 60000).toISOString(), 'en', now) === 'in 5 minutes', 'a time ahead of now');
    assert(format.relativeTime(new Date(now.getTime() + 10000).toISOString(), 'en', now) === 'now', 'a server clock a few seconds ahead reads as now');
    assert(format.relativeTime('not a time', 'en', now) === '' && format.dateTime24('not a time', 'en') === '' && format.dateOnly('', 'en') === '', 'a value that is no instant gives ""');

    // 24-hour dates; the instants are local ones, so 15:45 holds under any clock
    const at = new Date(2026, 9, 3, 15, 45).toISOString();
    const late = new Date(2026, 9, 3, 0, 5).toISOString();
    const dates: Record<Locale, [string, string]> = { en: ['3 Oct 2026, 15:45', '3 Oct 2026, 00:05'], he: ['3 באוק׳ 2026, 15:45', '3 באוק׳ 2026, 00:05'], ru: ['3 окт. 2026, 15:45', '3 окт. 2026, 00:05'] };
    for (const locale of LOCALES) {
      assert(format.dateTime24(at, locale) === dates[locale][0], `${locale}: "${format.dateTime24(at, locale)}"`);
      assert(format.dateTime24(late, locale) === dates[locale][1], `${locale} after midnight: "${format.dateTime24(late, locale)}"`);
      assert(!/\b[AP]M\b/i.test(format.dateTime24(at, locale)), `${locale}: a 12-hour time`);
    }
    assert(format.dateOnly(at, 'he') === '3 באוק׳ 2026', `dateOnly: "${format.dateOnly(at, 'he')}"`);

    // The plan line, with the real messages and next-intl's own formatter
    const sub = (o: Row) => ({ subscription: { plan: 'FREE', status: 'TRIALING', trialDaysRemaining: null, currentPeriodEnd: null, ...o } }) as never;
    const until = new Date(2026, 10, 3, 12, 0).toISOString();
    const expected: Record<Locale, Record<string, string>> = {
      en: { none: 'Free', trial1: 'Pro · trial, 1 day left', trial9: 'Pro · trial, 9 days left', until: 'Basic · until 3 Nov 2026', comped: 'Pro · free from an admin', expired: 'Free · expired' },
      he: { none: 'חינם', trial1: 'Pro · תקופת ניסיון, נשאר יום אחד', trial2: 'Pro · תקופת ניסיון, נשארו יומיים', trial9: 'Pro · תקופת ניסיון, נשארו 9 ימים', until: 'בסיסי · עד 3 בנוב׳ 2026', comped: 'Pro · במתנה מהניהול', expired: 'חינם · פג תוקף' },
      ru: { none: 'Бесплатный', trial1: 'Pro · пробный период, остался 1 день', trial2: 'Pro · пробный период, осталось 2 дня', trial5: 'Pro · пробный период, осталось 5 дней', trial21: 'Pro · пробный период, остался 21 день', until: 'Базовый · до 3 нояб. 2026', comped: 'Pro · бесплатно от администратора', expired: 'Бесплатный · срок истёк' },
    };
    for (const locale of LOCALES) {
      const t = createTranslator({ locale, messages: messages[locale], namespace: 'admin' }) as unknown as Parameters<typeof format.planLine>[1];
      const line = (o: Row | null) => format.planLine(o === null ? { subscription: null } : sub(o), t, locale, now);
      const got: Record<string, string> = {
        none: line(null),
        trial1: line({ trialDaysRemaining: 1 }),
        trial9: line({ trialDaysRemaining: 9 }),
        until: line({ plan: 'BASIC', status: 'ACTIVE', currentPeriodEnd: until }),
        comped: line({ plan: 'PRO', status: 'ACTIVE', comped: true }),
        expired: line({ status: 'EXPIRED' }),
      };
      if (locale === 'he') got.trial2 = line({ trialDaysRemaining: 2 });
      if (locale === 'ru') Object.assign(got, { trial2: line({ trialDaysRemaining: 2 }), trial5: line({ trialDaysRemaining: 5 }), trial21: line({ trialDaysRemaining: 21 }) });
      for (const [key, text] of Object.entries(expected[locale])) assert(got[key] === text, `${locale} ${key}: "${got[key]}" for "${text}"`);
      // The edges: a trial with no days left is Free; a paid plan with no end is the plan; a lapsed cancelled plan is Free; a cancelled one still running says until
      assert(line({ trialDaysRemaining: null }) === expected[locale].none, `${locale}: a trial that has run out`);
      assert(line({ plan: 'PRO', status: 'ACTIVE' }) === 'Pro', `${locale}: a paid plan with no end`);
      assert(line({ plan: 'BASIC', status: 'CANCELED', currentPeriodEnd: new Date(2026, 8, 1).toISOString() }) === expected[locale].none, `${locale}: a cancelled plan that ended`);
      assert(line({ plan: 'BASIC', status: 'CANCELED', currentPeriodEnd: until }) === expected[locale].until, `${locale}: a cancelled plan that still runs`);
    }
  });

  await check('D8 POST /api/admin/users/blocklist answers 400 SELF_BAN when an admin bans their own Telegram id or WhatsApp number (in any format), writes nothing, and still bans anyone else; an unban of one\'s own is not refused', async () => {
    const post = async (body: Row): Promise<{ status: number; body: Row }> => {
      const { POST } = await import('../app/api/admin/users/blocklist/route');
      const res: Response = await POST(
        new NextRequest('http://localhost/api/admin/users/blocklist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, initData: initDataFor(ADMIN_TELEGRAM) }),
        }),
      );
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    const quiet = { log: console.log };
    console.log = () => undefined;
    try {
      seedRoute();
      const own = await post({ action: 'ban', telegramId: ADMIN_TELEGRAM, whatsappPhone: null, reason: 'oops' });
      assert(own.status === 400 && own.body.error === 'SELF_BAN', `own Telegram id: ${own.status} ${canon(own.body)} ${captured.join(' | ')}`);
      const ownString = await post({ action: 'ban', telegramId: String(ADMIN_TELEGRAM) });
      assert(ownString.status === 400 && ownString.body.error === 'SELF_BAN', `own Telegram id as text: ${ownString.status}`);
      const ownPhone = await post({ action: 'ban', telegramId: null, whatsappPhone: ADMIN_PHONE });
      assert(ownPhone.status === 400 && ownPhone.body.error === 'SELF_BAN', `own number: ${ownPhone.status} ${canon(ownPhone.body)}`);
      const formatted = await post({ action: 'ban', whatsappPhone: '+972 50-111-2222' });
      assert(formatted.status === 400 && formatted.body.error === 'SELF_BAN', `own number, spaced: ${formatted.status}`);
      const mixed = await post({ action: 'ban', telegramId: 222222222, whatsappPhone: ADMIN_PHONE });
      assert(mixed.status === 400 && mixed.body.error === 'SELF_BAN', `someone's id with one's own number: ${mixed.status}`);
      assert(blocked().length === 0 && redisStore.size === 0, `a refused ban wrote ${canon(DB.blockedIdentifier)} ${redisStore.size} keys`);

      const other = await post({ action: 'ban', telegramId: 222222222, whatsappPhone: '+972503334444', reason: 'spam' });
      assert(other.status === 200 && other.body.success === true, `someone else: ${other.status} ${canon(other.body)} ${captured.join(' | ')}`);
      assert(blocked().length === 2 && DB.blockedIdentifier.every((r) => r.bannedBy === 9 && r.bannedReason === 'spam'), `rows: ${canon(DB.blockedIdentifier)}`);
      const unban = await post({ action: 'unban', telegramId: ADMIN_TELEGRAM });
      assert(unban.status === 200, `an unban of one's own: ${unban.status}`);
      const empty = await post({ action: 'ban' });
      assert(empty.status === 400 && empty.body.error !== 'SELF_BAN', `no identifier: ${empty.status} ${canon(empty.body)}`);
    } finally {
      console.log = quiet.log;
    }
  });

  await check('D9 React logged no warning, and every failure above was logged by the layer', async () => {
    assert(reactWarnings.length === 0, `warnings: ${reactWarnings.join(' | ')}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

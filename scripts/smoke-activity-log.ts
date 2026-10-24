// Smoke test for the activity log: which rows the bot and the Mini App write to UserActivity,
// what the admin's per-user timeline shows for them, and the daily 90-day purge.
//   - purgeOldActivity / handleActivityPurge (src/services/analytics-service.ts, src/cron/handlers.ts):
//     deletes rows older than 90 days in batches through the createdAt index, keeps the rest,
//     and says how many it deleted;
//   - changedSettingFields (src/lib/settings-changes.ts): the names of the settings a save
//     changed, never their values;
//   - activityDetail (src/lib/admin-activity.ts): the timeline's readable detail for the new rows;
//   - loadPageData (src/lib/page-data.ts): one settings_viewed / subscription_page_viewed /
//     webapp_opened row per open of the Settings, Subscription and calendar home screens;
//   - executeCommand (src/services/telegram/command-pipeline.ts): resolves true on success, and an
//     error it shows the user is one user_error_shown row.
// The commands' own command_completed rows are checked in scripts/smoke-week-commands.ts.
// Prisma and every service behind the pages are faked. No network, no DB.
//
// Run: TZ=Asia/Jerusalem npx tsx scripts/smoke-activity-log.ts

import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}
function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (v: unknown) => JSON.stringify(v);

// ---- Clock ----
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-24T03:30:00Z');

// ---- Fake Prisma: UserActivity only, with the calls the purge and the writer make ----
type Row = { id: string; userId: number; action: string; metadata?: unknown; createdAt: Date };
let activity: Row[] = [];
const calls: string[] = [];
const fakePrisma = {
  userActivity: {
    create: async ({ data }: { data: { userId: number; action: string; metadata?: unknown } }) => {
      activity.push({ id: `a${activity.length}`, createdAt: new Date(), ...data });
      return data;
    },
    findMany: async ({ where, take, orderBy }: { where: { createdAt: { lt: Date } }; select: { id: boolean }; take: number; orderBy: { createdAt: string } }) => {
      calls.push(`findMany lt=${where.createdAt.lt.toISOString()} take=${take} order=${orderBy.createdAt}`);
      return activity.filter((r) => r.createdAt < where.createdAt.lt).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, take).map((r) => ({ id: r.id }));
    },
    deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
      calls.push(`deleteMany ${where.id.in.length}`);
      const ids = new Set(where.id.in);
      const before = activity.length;
      activity = activity.filter((r) => !ids.has(r.id));
      return { count: before - activity.length };
    },
  },
  adminSettings: { findUnique: async () => ({ remindersEnabled: true }) },
};

// ---- Stubs for page-data's services ----
const SRC = path.resolve(__dirname, '../src');
const sub = {
  subscription: { plan: 'PRO', status: 'ACTIVE', currentPeriodEnd: null, cancelAtPeriodEnd: false, trialEndsAt: new Date(NOW.getTime() + DAY) },
  effectivePlan: 'PRO',
  usage: { textSummariesUsed: 1, voiceSummariesUsed: 0, voiceEventsCreated: 0, remindersTriggered: 0, cycleStartDate: NOW },
};
const stubs: Record<string, Record<string, unknown>> = {
  [`${SRC}/utils/prisma.ts`]: { prisma: fakePrisma },
  [`${SRC}/lib/error-capture.ts`]: { captureError: () => undefined, captureWarning: () => undefined, captureInfo: () => undefined },
  [`${SRC}/services/subscription-service.ts`]: {
    getSubscriptionWithUsage: async () => sub,
    getTrialStatus: async () => ({ isTrialing: false, trialEndsAt: null, daysLeft: 0 }),
    checkEarlyAdopterAccess: async () => false,
    peekFeatureAccess: async () => ({ allowed: true }),
  },
  [`${SRC}/services/native-reminders/support.ts`]: { getReminderSupport: async () => ({ supported: true }), canReceiveReminderPings: async () => true },
  [`${SRC}/services/calendar/index.ts`]: { listUserCalendars: async () => [], scrubbedGoogleError: () => '' },
  [`${SRC}/services/calendar-read/index.ts`]: { sourcesFor: () => ['famcal'] },
  [`${SRC}/services/native-calendar/event-store.ts`]: { listVisibleCalendars: async () => [] },
  [`${SRC}/services/native-calendar/onboarding.ts`]: { ensurePrimaryNativeCalendar: async () => undefined },
  [`${SRC}/services/pairing-service.ts`]: { getActivePartner: async () => null, getActiveInvite: async () => null },
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
  } catch {}
  return stubs[resolved] ?? realLoad.call(this, request, parent, isMain);
};
(globalThis as { activitySmokeStubs?: typeof stubs }).activitySmokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    const stub = stubs[file];
    if (!stub) return nextLoad(url, context);
    const names = Object.keys(stub).map((n) => `export const ${n} = fake[${JSON.stringify(n)}];`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.activitySmokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

const USER = {
  id: 7, name: 'Dana', language: 'en', location: 'Tel Aviv', culture: 'default', messagingPlatform: 'telegram', isAdmin: false,
  textSummaryEnabled: true, voiceSummaryEnabled: true, weatherEnabled: true, includeLookaheadInTomorrow: false, lookaheadAlways7Days: false,
  preferredMorningHour: 7, preferredEveningHour: 19, dailySummaryDays: [0, 1], tomorrowSummaryDays: [0, 1], remindersEnabled: false,
  pickupRemindersEnabled: true, voiceInputEnabled: false, reminderTime: null, googleRefreshToken: '', calendarAssignments: [],
} as never;

async function main() {
  const analytics = await import('../src/services/analytics-service');
  const unhandled: unknown[] = [];
  process.on('unhandledRejection', (r) => unhandled.push(r));

  // trackActivityAsync writes through the real writer; let its promise settle.
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const rowsOf = (action: string) => activity.filter((r) => r.action === action);

  await check('purge: rows older than 90 days go, in batches of 5000 read through createdAt; newer ones stay; the count is returned', async () => {
    activity = [];
    calls.length = 0;
    for (let i = 0; i < 12_000; i++) activity.push({ id: `old${i}`, userId: 1, action: 'x', createdAt: new Date(NOW.getTime() - (91 + (i % 200)) * DAY) });
    activity.push({ id: 'edge', userId: 1, action: 'x', createdAt: new Date(NOW.getTime() - 89 * DAY) });
    for (let i = 0; i < 50; i++) activity.push({ id: `new${i}`, userId: 1, action: 'x', createdAt: new Date(NOW.getTime() - i * DAY) });
    const deleted = await analytics.purgeOldActivity(NOW);
    assert(deleted === 12_000, `deleted ${deleted}`);
    assert(activity.length === 51 && activity.every((r) => !r.id.startsWith('old')), `${activity.length} left`);
    const cutoff = new Date(NOW.getTime() - 90 * DAY).toISOString();
    assert(calls.every((c) => !c.startsWith('findMany') || (c.includes(`lt=${cutoff}`) && c.includes('take=5000') && c.includes('order=asc'))), calls.join(' | '));
    assert(calls.filter((c) => c.startsWith('deleteMany')).join() === 'deleteMany 5000,deleteMany 5000,deleteMany 2000', calls.join(' | '));
  });

  await check('purge: nothing old means nothing deleted and one read; the daily job logs the count', async () => {
    activity = [{ id: 'n', userId: 1, action: 'x', createdAt: new Date(NOW.getTime() - DAY) }];
    calls.length = 0;
    assert((await analytics.purgeOldActivity(NOW)) === 0 && calls.length === 1, calls.join(' | '));
    activity = [{ id: 'o', userId: 1, action: 'x', createdAt: new Date(NOW.getTime() - 120 * DAY) }];
    const logs: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    try {
      const { handleActivityPurge } = await import('../src/cron/handlers');
      const result = await handleActivityPurge();
      assert(result.success && result.deleted === 1, show(result));
    } finally {
      console.log = log;
    }
    assert(logs.some((l) => l.includes('Deleted 1 activity rows older than 90 days')), logs.join(' | '));
  });

  await check('settings_changed: only the names of the fields that changed, no values; a save that changes nothing has none', async () => {
    const { changedSettingFields } = await import('../src/lib/settings-changes');
    const before = { language: 'he', location: 'Haifa', globalRules: ['a'], dailySummaryDays: [0, 1], defaultReminderMinutes: undefined, reminderTime: null, remindersEnabled: false };
    const same = changedSettingFields(before, { language: 'he', location: 'Haifa', globalRules: ['a'], dailySummaryDays: [0, 1], defaultReminderMinutes: undefined, reminderTime: '09:00', remindersEnabled: undefined, name: undefined });
    assert(same.length === 0, `unchanged save: ${show(same)}`);
    const got = changedSettingFields(before, { language: 'en', location: 'Haifa', globalRules: ['a', 'b'], reminderTime: '07:15', remindersEnabled: true, defaultReminderMinutes: 15 });
    assert(show(got) === show(['language', 'globalRules', 'reminderTime', 'remindersEnabled', 'defaultReminderMinutes']), show(got));
    assert(!show(got).includes('Haifa') && !show(got).includes('07:15'), 'a value leaked');
  });

  await check('admin timeline: the new rows read as words, any other row keeps its JSON, cut at 60', async () => {
    const { activityDetail } = await import('../src/lib/admin-activity');
    assert(activityDetail('command_completed', { command: 'summary', platform: 'telegram' }) === 'summary · telegram', 'command');
    assert(activityDetail('settings_changed', { changed_fields: ['language', 'location'] }) === 'language, location', 'settings');
    assert(activityDetail('user_error_shown', { error_type: 'timeout', command: 'Weather Command' }) === 'timeout · Weather Command', 'error');
    assert(activityDetail('calendar_connected', { provider: 'google' }) === 'google', 'connected');
    assert(activityDetail('webapp_opened', null) === '' && activityDetail('webapp_opened', {}) === '', 'empty');
    assert(activityDetail('voice_event_failed', { error_type: 'x' }) === '{"error_type":"x"}', 'other rows keep JSON');
    assert(activityDetail('settings_changed', {}) === '', 'no metadata');
    assert(activityDetail('other', { a: 'x'.repeat(100) }).length === 63, 'cut');
  });

  await check('Mini App opens: Settings, Subscription and the calendar home each write one row, under the DB id', async () => {
    activity = [];
    const { loadPageData } = await import('../src/lib/page-data');
    const settings = await loadPageData('settings', USER, 7, 'en');
    const subscription = await loadPageData('subscription', USER, 7, 'en');
    const dashboard = await loadPageData('dashboard', USER, 7, 'en');
    assert(settings.kind === 'props' && subscription.kind === 'props' && dashboard.kind === 'props', `${settings.kind} ${subscription.kind} ${dashboard.kind}`);
    await settle();
    const got = activity.map((r) => `${r.userId}:${r.action}`).sort();
    assert(show(got) === show(['7:settings_viewed', '7:subscription_page_viewed', '7:webapp_opened']), show(got));
  });

  await check('executeCommand: true when the command ran to the end; an error shown to the user is one user_error_shown row, with no row when no user id is given', async () => {
    activity = [];
    const { executeCommand } = await import('../src/services/telegram/command-pipeline');
    const sent: string[] = [];
    const service = { sendMessage: async (_c: unknown, text: string) => { sent.push(text); return 1; }, sendTypingIndicator: async () => undefined };
    const base = { chatId: 1, language: 'en', messagingService: service as never, errorKey: 'weatherFetch', commandName: 'Weather Command' };
    const errorLog = console.error;
    console.error = () => undefined;
    try {
      const ok = await executeCommand({ ...base, userId: 7, operation: async () => 1, onSuccess: async () => undefined });
      assert(ok === true && sent.length === 0, 'success');
      const failed = await executeCommand({ ...base, userId: 7, operation: async () => { throw new Error('boom'); }, onSuccess: async () => undefined });
      assert(failed === false && sent.length === (1 as number), 'failure');
      await executeCommand({ ...base, operation: async () => { throw new Error('boom'); }, onSuccess: async () => undefined });
    } finally {
      console.error = errorLog;
    }
    await settle();
    const rows = rowsOf('user_error_shown');
    assert(rows.length === 1 && show(rows[0].metadata) === show({ error_type: 'weatherFetch', command: 'Weather Command' }), show(rows));
  });

  assert(unhandled.length === 0, `unhandled rejections: ${unhandled.map(String).join(', ')}`);
}

main().then(() => {
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.name}${r.reason ? ` — ${r.reason}` : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed.length ? 1 : 0);
}, (err) => {
  console.error(err);
  process.exit(1);
});

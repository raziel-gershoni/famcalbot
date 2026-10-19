// Smoke test for the native reminders gate (spec R3) and its admin switch: which users get
// reminders and in which order the reasons apply, the switch read through Redis with the
// DB behind it (on by default, as the column is), the admin settings route writing it,
// escapeHtml in its leaf module, the bot.nativeReminders copy every later task reads (the
// created reply's when wording read as whole sentences in en, he and ru), and the settings
// page's event-alert copy renamed (R9). Redis, Prisma, the feature check and the admin
// check are faked; the due gate is the real one. The voice chain is never loaded: the
// confirmations.ts re-export is checked in its source. No network, no clock.
//
// Run: npx tsx scripts/smoke-native-reminder-support.ts

import Module from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';

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

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ---- Environment: fakes only, set before anything under test loads ----

process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.GEMINI_API_KEY = 'test-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.DATABASE_URL = 'postgresql://test@db.invalid/test';

/** Any request that slips past the fakes is refused and counted. */
const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

// ---- Fakes ----

/** Every Redis and DB write, in order, so a test can tell which came first. */
const writes: string[] = [];

/** Redis as Upstash behaves: values round-trip through JSON. `down` makes every call throw. */
const store = new Map<string, string>();
const redisState = { down: false, reads: 0, failWrites: false };
const fakeRedis = {
  get: async (key: string) => {
    redisState.reads++;
    if (redisState.down) throw new Error('redis is down');
    return store.has(key) ? JSON.parse(store.get(key)!) : null;
  },
  set: async (key: string, value: unknown) => {
    if (redisState.down || redisState.failWrites) throw new Error('redis is down');
    writes.push(`redis ${key}=${JSON.stringify(value)}`);
    store.set(key, JSON.stringify(value));
    return 'OK';
  },
  del: async (key: string) => (store.delete(key) ? 1 : 0),
};

/** The AdminSettings singleton. Prisma returns only the selected columns and applies column defaults on create. */
const COLUMN_DEFAULTS = { remindersEnabled: false, earlyAdoptionMode: true, voiceAutoCreateHighConf: false, voiceTtsOutcome: false, nativeRemindersEnabled: true };
const db = { row: null as Record<string, unknown> | null, down: false, reads: 0 };
const upserts: { update: Record<string, unknown>; create: Record<string, unknown> }[] = [];
const fakePrisma = {
  adminSettings: {
    findUnique: async ({ select }: { where: { id: string }; select?: Record<string, boolean> }) => {
      db.reads++;
      if (db.down) throw new Error('db is down');
      if (!db.row) return null;
      const row = db.row;
      return select ? Object.fromEntries(Object.keys(select).map(k => [k, row[k]])) : { ...row };
    },
    upsert: async ({ update, create }: { where: { id: string }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
      if (db.down) throw new Error('db is down');
      upserts.push({ update, create });
      writes.push(`db ${JSON.stringify(db.row ? update : create)}`);
      db.row = db.row ? { ...db.row, ...update } : { ...COLUMN_DEFAULTS, ...create };
      return { ...db.row };
    },
  },
};

/** checkFeatureAccess('reminders') per user id: true, false, or an error it throws. */
const access: Record<number, boolean | Error> = {};
const accessChecks: string[] = [];
const fakeSubscriptionService = {
  checkFeatureAccess: async (userId: number, feature: string) => {
    accessChecks.push(`${userId}:${feature}`);
    const allowed = access[userId];
    if (allowed instanceof Error) throw allowed;
    return allowed ? { allowed: true } : { allowed: false, reason: 'upgrade_required' };
  },
  // The quiet read the home's hints use: the same answer, recorded apart.
  peekFeatureAccess: async (userId: number, feature: string) => {
    accessChecks.push(`peek ${userId}:${feature}`);
    const allowed = access[userId];
    if (allowed instanceof Error) throw allowed;
    return allowed ? { allowed: true } : { allowed: false, reason: 'upgrade_required' };
  },
  invalidateAllFeatureAccessCaches: async () => {},
};

/** The admin check: initData 'admin' is an admin, anything else is refused. */
const fakeAdminAuth = {
  verifyAdminAccess: async (initData: string | undefined) =>
    initData === 'admin' ? { authorized: true, adminId: 1 } : { authorized: false, error: 'Unauthorized' },
};

// The stubs go into require's cache before the modules that import them load.
const SRC = path.resolve(__dirname, '../src');
const ModuleWithCache = Module as unknown as {
  new (id: string): { filename: string; loaded: boolean; exports: unknown };
  _cache: Record<string, unknown>;
};
function stub(file: string, exports: Record<string, unknown>) {
  const filename = path.join(SRC, file);
  const mod = new ModuleWithCache(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  ModuleWithCache._cache[filename] = mod;
}
stub('utils/redis.ts', { redis: fakeRedis });
stub('utils/prisma.ts', { prisma: fakePrisma });
stub('services/subscription-service.ts', fakeSubscriptionService);
stub('lib/admin-auth.ts', fakeAdminAuth);
stub('lib/error-capture.ts', { captureError: () => {}, captureWarning: () => {}, captureInfo: () => {} });

function reset() {
  store.clear();
  writes.length = 0;
  upserts.length = 0;
  accessChecks.length = 0;
  Object.assign(redisState, { down: false, reads: 0, failWrites: false });
  Object.assign(db, { row: null, down: false, reads: 0 });
  for (const id of Object.keys(access)) delete access[Number(id)];
}

const FLAG = 'nrem:enabled';

/** Every key the later tasks read, as listed in the plan. */
const COPY_KEYS = [
  'ping.from', 'buttons.done', 'buttons.snooze15', 'buttons.snooze60', 'buttons.snoozeTomorrow',
  'done', 'snoozedUntil', 'alreadyDone', 'notYours', 'changed', 'doneBy', 'moved',
  'card.title', 'card.forPartner', 'card.noTimeSet', 'card.timePassed', 'card.partnerNotOnTelegram', 'card.keepAsMine',
  'created.self', 'created.partner', 'created.dateOnly', 'created.passed', 'bulk.timePassed', 'bulk.noTimeSet',
  'when.todayAt', 'when.tomorrowAt', 'when.dateAt', 'when.today', 'when.tomorrow', 'when.date',
  'typed.processing', 'typed.notUnderstood',
  'anchor.notFound', 'anchor.ambiguous', 'anchor.needsTime', 'permissionDenied',
];
const PARAMS: Record<string, string> = {
  name: 'Dana', title: 'Buy milk', time: '15:40', when: 'Thu 10:00', date: 'Thu, Oct 15', description: 'dentist',
};

async function main() {
  const { getReminderSupport, isNativeRemindersEnabled, setNativeRemindersEnabled } = await import('../src/services/native-reminders/support');
  const { __resetDueGateForTests, setNextDue, shouldRunPass } = await import('../src/services/native-reminders/due-gate');
  const { GET, POST } = await import('../app/api/admin/settings/route');
  const { NextRequest } = await import('next/server');
  const { escapeHtml } = await import('../src/utils/html');
  const { getBotMessage } = await import('../src/lib/bot-messages');

  // The code under test logs its Redis and DB failures; keep the output to the results.
  const quiet = { log: console.log, error: console.error, warn: console.warn };
  Object.assign(console, { log: () => {}, error: () => {}, warn: () => {} });

  const post = (body: Record<string, unknown>) =>
    POST(new NextRequest('http://localhost/api/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
  const get = () => GET(new NextRequest('http://localhost/api/admin/settings', { headers: { 'x-telegram-init-data': 'admin' } }));

  // ---- getReminderSupport: the reasons, in order ----

  await check('a Google user gets reminders too (they live in FamCal, Google as a connection): supported through the same switch and feature checks', async () => {
    reset();
    access[1] = true;
    const support = await getReminderSupport({ id: 1, telegramId: 1001 });
    assert(support.supported && support.reason === undefined, JSON.stringify(support));
    assert(accessChecks.join() === '1:reminders', `feature checks ${accessChecks}`);
  });

  await check('the first failing reason wins: no Telegram and the switch off is no_telegram', async () => {
    reset();
    store.set(FLAG, 'false');
    const support = await getReminderSupport({ id: 2, telegramId: null });
    assert(support.reason === 'no_telegram', JSON.stringify(support));
  });

  await check('a WhatsApp-only user is no_telegram, with no Redis read', async () => {
    reset();
    access[3] = true;
    for (const telegramId of [null, undefined]) {
      const support = await getReminderSupport({ id: 3, telegramId });
      assert(!support.supported && support.reason === 'no_telegram', `${telegramId}: ${JSON.stringify(support)}`);
    }
    assert(redisState.reads === 0 && accessChecks.length === 0, `redis reads ${redisState.reads}, feature checks ${accessChecks}`);
  });

  await check('switch off: disabled, and the feature is not checked', async () => {
    reset();
    store.set(FLAG, 'false');
    access[4] = true;
    const support = await getReminderSupport({ id: 4, telegramId: 1004 });
    assert(!support.supported && support.reason === 'disabled', JSON.stringify(support));
    assert(accessChecks.length === 0, `feature checks ${accessChecks}`);
  });

  await check('no Pro, trial, override or early adoption: no_access, from the reminders feature', async () => {
    reset();
    access[5] = false;
    const support = await getReminderSupport({ id: 5, telegramId: 1005 });
    assert(!support.supported && support.reason === 'no_access', JSON.stringify(support));
    assert(accessChecks.join() === '5:reminders', `feature checks ${accessChecks}`);
  });

  await check('everything holds: supported with no reason, whatever type the Telegram id has', async () => {
    reset();
    access[6] = true;
    for (const telegramId of [1006, BigInt(1006), '1006']) {
      const support = await getReminderSupport({ id: 6, telegramId });
      assert(support.supported && support.reason === undefined, `${typeof telegramId}: ${JSON.stringify(support)}`);
    }
  });

  await check('a failing feature check fails closed as no_access instead of throwing', async () => {
    reset();
    access[7] = new Error('db is down');
    const support = await getReminderSupport({ id: 7, telegramId: 1007 });
    assert(!support.supported && support.reason === 'no_access', JSON.stringify(support));
  });

  await check('quiet: true reads through peekFeatureAccess (no logging gate), with the same answers and failing closed', async () => {
    reset();
    access[8] = true;
    access[9] = false;
    access[10] = new Error('db is down');
    const yes = await getReminderSupport({ id: 8, telegramId: 1008 }, { quiet: true });
    const no = await getReminderSupport({ id: 9, telegramId: 1009 }, { quiet: true });
    const down = await getReminderSupport({ id: 10, telegramId: 1010 }, { quiet: true });
    assert(yes.supported && !no.supported && no.reason === 'no_access', JSON.stringify({ yes, no }));
    assert(!down.supported && down.reason === 'no_access', JSON.stringify(down));
    assert(accessChecks.join() === 'peek 8:reminders,peek 9:reminders,peek 10:reminders', `feature checks ${accessChecks}`);
  });

  // ---- isNativeRemindersEnabled: Redis first, the DB behind it, on by default ----

  await check('no Redis value and no settings row: on, and Redis now holds it', async () => {
    reset();
    assert((await isNativeRemindersEnabled()) === true, 'read as off');
    assert(store.get(FLAG) === 'true', `redis holds ${store.get(FLAG)}`);
  });

  await check('no Redis value and the row says off: off, cached so the next read skips the DB', async () => {
    reset();
    db.row = { ...COLUMN_DEFAULTS, nativeRemindersEnabled: false };
    assert((await isNativeRemindersEnabled()) === false, 'first read is on');
    assert((await isNativeRemindersEnabled()) === false, 'second read is on');
    assert(db.reads === 1, `${db.reads} DB reads`);
  });

  await check('Redis says off: off, with no DB read', async () => {
    reset();
    store.set(FLAG, 'false');
    db.row = { ...COLUMN_DEFAULTS, nativeRemindersEnabled: true };
    assert((await isNativeRemindersEnabled()) === false, 'read as on');
    assert(db.reads === 0, `${db.reads} DB reads`);
  });

  await check('Redis down: the DB value, and nothing thrown', async () => {
    reset();
    redisState.down = true;
    db.row = { ...COLUMN_DEFAULTS, nativeRemindersEnabled: false };
    assert((await isNativeRemindersEnabled()) === false, 'read as on');
  });

  await check('Redis and the DB both down: on', async () => {
    reset();
    redisState.down = true;
    db.down = true;
    assert((await isNativeRemindersEnabled()) === true, 'read as off');
  });

  await check('a failed cache write still returns the DB value', async () => {
    reset();
    redisState.failWrites = true;
    db.row = { ...COLUMN_DEFAULTS, nativeRemindersEnabled: false };
    assert((await isNativeRemindersEnabled()) === false, 'read as on');
  });

  // ---- setNativeRemindersEnabled: Redis, then the due gate ----

  await check('setting the switch writes nrem:enabled and reopens the due gate', async () => {
    reset();
    __resetDueGateForTests();
    const now = new Date('2026-10-14T10:00:00Z');
    setNextDue(null, now);
    assert(!shouldRunPass(now), 'the gate was open before the switch changed');
    await setNativeRemindersEnabled(true);
    assert(store.get(FLAG) === 'true', `redis holds ${store.get(FLAG)}`);
    assert(shouldRunPass(now), 'the gate stayed closed');
  });

  await check('a failed Redis write is swallowed and still reopens the due gate', async () => {
    reset();
    __resetDueGateForTests();
    const now = new Date('2026-10-14T10:00:00Z');
    setNextDue(null, now);
    redisState.failWrites = true;
    await setNativeRemindersEnabled(false);
    assert(shouldRunPass(now), 'the gate stayed closed');
  });

  await check('the switch adds no Redis key under reminder: or reminders:', async () => {
    reset();
    await isNativeRemindersEnabled();
    await setNativeRemindersEnabled(true);
    const keys = [...store.keys()];
    assert(keys.length > 0 && keys.every(k => k.startsWith('nrem:')), `keys ${keys}`);
  });

  // ---- The admin settings route ----

  await check('POST with only nativeRemindersEnabled: the DB, then Redis, then the answer', async () => {
    reset();
    db.row = { ...COLUMN_DEFAULTS };
    const res = await post({ nativeRemindersEnabled: false, initData: 'admin' });
    const body = await res.json();
    assert(res.status === 200, `status ${res.status}: ${JSON.stringify(body)}`);
    assert(body.nativeRemindersEnabled === false, `answered ${JSON.stringify(body)}`);
    assert(JSON.stringify(upserts[0]?.update) === '{"nativeRemindersEnabled":false}', `update ${JSON.stringify(upserts[0]?.update)}`);
    assert(writes.join(' | ') === 'db {"nativeRemindersEnabled":false} | redis nrem:enabled=false', `writes ${writes.join(' | ')}`);
  });

  await check('POST on a fresh database creates the row with the switch', async () => {
    reset();
    const res = await post({ nativeRemindersEnabled: false, initData: 'admin' });
    assert(res.status === 200, `status ${res.status}`);
    assert(JSON.stringify(upserts[0]?.create) === '{"id":"global","nativeRemindersEnabled":false}', `create ${JSON.stringify(upserts[0]?.create)}`);
    assert(db.row?.nativeRemindersEnabled === false, `row ${JSON.stringify(db.row)}`);
  });

  await check('POST of another toggle leaves the native switch alone', async () => {
    reset();
    db.row = { ...COLUMN_DEFAULTS };
    const res = await post({ voiceTtsOutcome: true, initData: 'admin' });
    const body = await res.json();
    assert(res.status === 200, `status ${res.status}`);
    assert(!('nativeRemindersEnabled' in upserts[0].update), `update ${JSON.stringify(upserts[0].update)}`);
    assert(!store.has(FLAG), 'nrem:enabled was written');
    assert(body.nativeRemindersEnabled === true, `answered ${JSON.stringify(body)}`);
  });

  await check('POST with no known field is still a 400, and a non-boolean switch is no field', async () => {
    reset();
    for (const body of [{ initData: 'admin' }, { nativeRemindersEnabled: 'no', initData: 'admin' }]) {
      const res = await post(body);
      assert(res.status === 400, `${JSON.stringify(body)}: status ${res.status}`);
    }
    assert(upserts.length === 0, `${upserts.length} upserts`);
  });

  await check('POST without admin initData is refused and writes nothing', async () => {
    reset();
    const res = await post({ nativeRemindersEnabled: false, initData: 'someone' });
    assert(res.status === 401, `status ${res.status}`);
    assert(writes.length === 0, `writes ${writes}`);
  });

  await check('GET returns the switch: on with no settings row, off when the row says so', async () => {
    reset();
    const fresh = await (await get()).json();
    assert(fresh.nativeRemindersEnabled === true, `no row: ${JSON.stringify(fresh)}`);
    db.row = { ...COLUMN_DEFAULTS, nativeRemindersEnabled: false };
    const off = await (await get()).json();
    assert(off.nativeRemindersEnabled === false, `row off: ${JSON.stringify(off)}`);
  });

  // ---- escapeHtml ----

  await check('escapeHtml escapes &, < and > in any language', () => {
    assert(escapeHtml('<b>Tom & Jerry</b>') === '&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;', escapeHtml('<b>Tom & Jerry</b>'));
    assert(escapeHtml('תור <רופא> & בדיקה') === 'תור &lt;רופא&gt; &amp; בדיקה', escapeHtml('תור <רופא> & בדיקה'));
    assert(escapeHtml('Купить <молоко> & хлеб') === 'Купить &lt;молоко&gt; &amp; хлеб', escapeHtml('Купить <молоко> & хлеб'));
    // A create the parser left with no title: the card prints nothing there instead of throwing
    assert(escapeHtml(undefined) === '' && escapeHtml(null) === '', `${escapeHtml(undefined)} / ${escapeHtml(null)}`);
  });

  await check('escapeHtml lives in the leaf src/utils/html.ts, and confirmations.ts re-exports it', () => {
    const leaf = readFileSync(path.resolve(__dirname, '../src/utils/html.ts'), 'utf8');
    assert(!/^\s*import\b|\brequire\(/m.test(leaf), 'src/utils/html.ts imports something');
    const confirmations = readFileSync(path.resolve(__dirname, '../src/services/voice/confirmations.ts'), 'utf8');
    assert(/^export \{ escapeHtml \} from '\.\.\/\.\.\/utils\/html';$/m.test(confirmations), 'confirmations.ts does not re-export it');
    assert(!/function escapeHtml\b/.test(confirmations), 'confirmations.ts still has its own escapeHtml');
  });

  // ---- Copy ----

  await check('every bot.nativeReminders key the later tasks read exists in en, he and ru', async () => {
    const missing: string[] = [];
    for (const locale of ['en', 'he', 'ru']) {
      for (const key of COPY_KEYS) {
        const text = await getBotMessage(locale, `nativeReminders.${key}`);
        if (typeof text !== 'string' || text === `nativeReminders.${key}` || !text.trim()) missing.push(`${locale}:${key}`);
      }
    }
    assert(missing.length === 0, `missing ${missing.join(', ')}`);
  });

  await check('every key fills in all its placeholders in every locale', async () => {
    const bad: string[] = [];
    for (const locale of ['en', 'he', 'ru']) {
      for (const key of COPY_KEYS) {
        const english = await getBotMessage('en', `nativeReminders.${key}`);
        const wanted = [...english.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
        const text = await getBotMessage(locale, `nativeReminders.${key}`, PARAMS);
        if (/\{\w+\}/.test(text) || wanted.some(p => !text.includes(PARAMS[p]))) bad.push(`${locale}:${key} → ${text}`);
      }
    }
    assert(bad.length === 0, bad.join('\n     '));
  });

  await check('the created reply reads as one sentence with every when form, in en, he and ru', async () => {
    // {date} as Task 11's formatReminderWhen passes it: the short Intl date in each language.
    const samples: Record<string, { name: string; date: string; want: string[] }> = {
      en: {
        name: 'Dana',
        date: 'Thu, Oct 15',
        want: [
          "⏰ I'll remind you today at 17:00.",
          "⏰ I'll remind you tomorrow at 17:00.",
          "⏰ I'll remind you on Thu, Oct 15 at 17:00.",
          "⏰ I'll remind Dana today at 17:00.",
          "⏰ I'll remind Dana tomorrow at 17:00.",
          "⏰ I'll remind Dana on Thu, Oct 15 at 17:00.",
          '⏰ Reminder set for today.',
          '⏰ Reminder set for tomorrow.',
          '⏰ Reminder set for Thu, Oct 15.',
        ],
      },
      he: {
        name: 'דנה',
        date: 'יום ה׳, 15 באוק׳',
        want: [
          '⏰ אזכיר לך היום ב-17:00.',
          '⏰ אזכיר לך מחר ב-17:00.',
          '⏰ אזכיר לך ביום ה׳, 15 באוק׳, ב-17:00.',
          '⏰ התזכורת בשביל דנה תישלח היום ב-17:00.',
          '⏰ התזכורת בשביל דנה תישלח מחר ב-17:00.',
          '⏰ התזכורת בשביל דנה תישלח ביום ה׳, 15 באוק׳, ב-17:00.',
          '⏰ התזכורת נקבעה להיום.',
          '⏰ התזכורת נקבעה למחר.',
          '⏰ התזכורת נקבעה ליום ה׳, 15 באוק׳.',
        ],
      },
      ru: {
        name: 'Дана',
        date: 'чт, 15 окт.',
        want: [
          '⏰ Напомню тебе сегодня в 17:00.',
          '⏰ Напомню тебе завтра в 17:00.',
          '⏰ Напомню тебе чт, 15 окт. в 17:00.',
          '⏰ Дана получит напоминание сегодня в 17:00.',
          '⏰ Дана получит напоминание завтра в 17:00.',
          '⏰ Дана получит напоминание чт, 15 окт. в 17:00.',
          '⏰ Напоминание на сегодня поставлено.',
          '⏰ Напоминание на завтра поставлено.',
          '⏰ Напоминание на чт, 15 окт. поставлено.',
        ],
      },
    };
    const bad: string[] = [];
    for (const [locale, { name, date, want }] of Object.entries(samples)) {
      const when = (key: string) => getBotMessage(locale, `nativeReminders.when.${key}`, { time: '17:00', date });
      const timed = [await when('todayAt'), await when('tomorrowAt'), await when('dateAt')];
      const dated = [await when('today'), await when('tomorrow'), await when('date')];
      const got: string[] = [];
      for (const w of timed) got.push(await getBotMessage(locale, 'nativeReminders.created.self', { when: w }));
      for (const w of timed) got.push(await getBotMessage(locale, 'nativeReminders.created.partner', { name, when: w }));
      for (const w of dated) got.push(await getBotMessage(locale, 'nativeReminders.created.dateOnly', { when: w }));
      got.forEach((line, i) => {
        if (line !== want[i]) bad.push(`${locale}: "${line}", want "${want[i]}"`);
      });
    }
    assert(bad.length === 0, bad.join('\n     '));
  });

  await check('the settings page calls event alerts alerts (R9), with its keys unchanged', () => {
    const want: Record<string, { title: string; old: RegExp }> = {
      en: { title: 'Event alerts', old: /remind/i },
      he: { title: 'התראות על אירועים', old: /תזכור/ },
      ru: { title: 'Уведомления о событиях', old: /напомина/i },
    };
    const keys = ['remindersSection', 'remindersEnabled', 'remindersEnabledDescription', 'remindersBetaDescription', 'defaultReminderMinutes',
      'defaultReminderMinutesHelp', 'pickupRemindersEnabled', 'pickupRemindersDescription', 'remindersProRequired'];
    for (const [locale, { title, old }] of Object.entries(want)) {
      const settings = JSON.parse(readFileSync(path.resolve(__dirname, '../messages', `${locale}.json`), 'utf8')).settings;
      assert(settings.remindersSection === title, `${locale} section: ${settings.remindersSection}`);
      for (const key of keys) {
        assert(typeof settings[key] === 'string', `${locale}: settings.${key} is gone`);
        assert(!old.test(settings[key]), `${locale}: settings.${key} still says "${settings[key]}"`);
      }
    }
  });

  await check('an anchor that can\'t be placed asks for the reminder again with a time, not a question no reply reaches', async () => {
    const en = {
      notFound: "I couldn't find “dentist” in your calendar. Send it again with a time, like “remind me at 16:00 to …”.",
      ambiguous: 'I found more than one “dentist”. Send it again with a time, like “remind me at 16:00 to …”.',
      needsTime: '“dentist” is all day. Send it again with a time, like “remind me at 16:00 to …”.',
    };
    const bad: string[] = [];
    for (const [key, want] of Object.entries(en)) {
      const got = await getBotMessage('en', `nativeReminders.anchor.${key}`, PARAMS);
      if (got !== want) bad.push(`en:${key} → ${got}`);
    }
    for (const locale of ['he', 'ru']) {
      for (const key of Object.keys(en)) {
        const got = await getBotMessage(locale, `nativeReminders.anchor.${key}`, PARAMS);
        if (got.includes('?') || !got.includes('16:00') || !got.includes('dentist')) bad.push(`${locale}:${key} → ${got}`);
      }
    }
    assert(bad.length === 0, bad.join('\n     '));
  });

  await check('the plans name both things the \'reminders\' feature gates: reminders and event alerts', () => {
    const want: Record<string, RegExp[]> = {
      en: [/remind/i, /alert/i],
      he: [/תזכורות/, /התראות/],
      ru: [/Напоминания/, /уведомления/],
    };
    for (const [locale, words] of Object.entries(want)) {
      const subscription = JSON.parse(readFileSync(path.resolve(__dirname, '../messages', `${locale}.json`), 'utf8')).subscription;
      for (const text of [subscription.features.reminders, subscription.planFeatures.remindersIncluded, subscription.planFeatures.remindersExcluded]) {
        assert(words.every(w => w.test(text)), `${locale}: "${text}"`);
      }
      // The payment-success message puts subscription.features into HTML unescaped
      assert(!/[&<>]/.test(subscription.features.reminders), `${locale}: "${subscription.features.reminders}" breaks HTML`);
    }
  });

  await check('the admin panel has a label and a description for the switch in every locale', () => {
    for (const locale of ['en', 'he', 'ru']) {
      const features = JSON.parse(readFileSync(path.resolve(__dirname, '../messages', `${locale}.json`), 'utf8')).admin.features;
      assert(typeof features.nativeReminders === 'string' && features.nativeReminders.trim() !== '', `${locale}: no label`);
      assert(typeof features.nativeRemindersDescription === 'string' && features.nativeRemindersDescription.trim() !== '', `${locale}: no description`);
    }
  });

  await check('no network', () => {
    assert(networkAttempts.length === 0, `network attempts: ${networkAttempts.join(', ')}`);
  });

  Object.assign(console, quiet);
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

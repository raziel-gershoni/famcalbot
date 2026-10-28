// Smoke test for "Address me as" (Settings, the gender row). User.gender was 'male' from signup and nothing
// could change it, so the voice show, the AI summaries and a partner's calendar person-gender
// (user-calendars.ts reads the owner's gender) all treated every woman as a man. The Settings page now
// saves it through /api/settings:
//  - A1 the route accepts 'male' and 'female', writes the row and tracks the field's name (never its value);
//  - A2 it refuses anything else with 400 and writes nothing, not even the other settings of that request;
//  - A3 the value saves and reloads: the next read of the row says what was saved, and a save that sends no
//    gender (an older page, a language-only save) leaves it alone;
//  - A4 the voice show's listener gender is the saved one (buildShowContext);
//  - A5 a partner's calendar person-gender follows the owner's saved gender (getCalendarAssignmentsForUser),
//    and so does the show's spouse;
//  - A6 the summary prompts say the user's gender in Hebrew and Russian from the saved value;
//  - A7 no cache holds the gender: the reminder cache entry the route syncs after a save does not carry it,
//    so there is nothing to invalidate.
// The page side (the row, Save, the body) is in smoke-settings-render (S13) and page-data's props in
// smoke-page-auth (#6c2).
//
// The route, user-service, the show's context and the calendar helpers run for real over fakes at the
// boundaries: Prisma (in memory, writes counted), Redis (in memory), error capture, the rate limiter, auth
// (the proved user is the one the URL names), Telegram, and the activity log (recorded). No network, no DB.
//
// Run with the fake env runner: scripts/run-smoke.sh scripts/smoke-address-me-as.ts <TZ>

import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.CRON_SECRET ||= 'test-cron';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.ENCRYPTION_KEY_PREVIOUS = '';

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
const show = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
const eq = (a: unknown, b: unknown, what: string) => assert(show(a) === show(b), `${what}: ${show(a)} (want ${show(b)})`);

globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network blocked in smoke: ${String(input)}`);
}) as typeof fetch;

// ---- Fake Prisma: in-memory tables ----

let DB: Record<string, Row[]> = {};
const table = (name: string) => (DB[name] ??= []);
/** Every write to the user table: the method and the data it carried. */
const userWrites: { method: string; data: Row }[] = [];
const NULLS = new Set<unknown>();
const norm = (v: unknown) => (NULLS.has(v) || v === undefined ? null : v);
function same(a: unknown, b: unknown): boolean {
  a = norm(a); b = norm(b);
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') return a != null && b != null && String(a) === String(b);
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}
const isPlain = (v: unknown): v is Row => v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && !NULLS.has(v);

function matches(row: Row, where?: Row): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    if (k === 'AND') return ([] as Row[]).concat(cond).every(c => matches(row, c));
    if (k === 'OR') return (cond as Row[]).some(c => matches(row, c));
    if (k === 'NOT') return !([] as Row[]).concat(cond).some(c => matches(row, c));
    const v = row[k];
    if (isPlain(cond)) {
      if ('equals' in cond && !same(v, cond.equals)) return false;
      if ('in' in cond && !(cond.in as unknown[]).some(x => same(v, x))) return false;
      if ('not' in cond && (isPlain(cond.not) ? matches(row, { [k]: cond.not }) : same(v, cond.not))) return false;
      return true;
    }
    return same(v, cond);
  });
}
function pick(row: Row | undefined, select?: Row): Row | null {
  if (!row) return null;
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]]));
}
function applyData(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (isPlain(v) && 'set' in v) row[k] = v.set;
    else if (isPlain(v) && ('connect' in v || 'create' in v || 'disconnect' in v)) continue;
    else row[k] = NULLS.has(v) ? null : v;
  }
}
let seq = 0;
function model(name: string): Row {
  const t = () => table(name);
  const create = (data: Row): Row => {
    const now = new Date(Date.now() + ++seq);
    const id = name === 'user' ? Math.max(0, ...t().map(r => Number(r.id))) + 1 : `${name}-${seq}`;
    const row: Row = { id, createdAt: now, updatedAt: now };
    applyData(row, data);
    t().push(row);
    return row;
  };
  const updateOne = (where: Row, data: Row): Row => {
    const row = t().find(r => matches(r, where));
    if (!row) throw Object.assign(new Error(`No ${name} record was found for an update.`), { code: 'P2025' });
    if (name === 'user') userWrites.push({ method: 'update', data });
    applyData(row, data);
    row.updatedAt = new Date();
    return row;
  };
  return {
    findUnique: async (a: Row = {}) => pick(t().find(r => matches(r, a.where)), a.select),
    findFirst: async (a: Row = {}) => pick(t().filter(r => matches(r, a.where))[0], a.select),
    findMany: async (a: Row = {}) => t().filter(r => matches(r, a.where)).map(r => pick(r, a.select)),
    count: async (a: Row = {}) => t().filter(r => matches(r, a.where)).length,
    create: async (a: Row) => pick(create(a.data), a.select),
    update: async (a: Row) => pick(updateOne(a.where, a.data), a.select),
    updateMany: async (a: Row) => {
      const rows = t().filter(r => matches(r, a.where));
      if (name === 'user') userWrites.push({ method: 'updateMany', data: a.data });
      rows.forEach(r => applyData(r, a.data));
      return { count: rows.length };
    },
    upsert: async (a: Row) => {
      const row = t().find(r => matches(r, a.where));
      return row ? pick(updateOne(a.where, a.update), a.select) : pick(create({ ...a.where, ...a.create }), a.select);
    },
    deleteMany: async () => ({ count: 0 }),
    groupBy: async () => [],
    aggregate: async () => ({ _count: {}, _sum: {}, _max: {}, _min: {} }),
  };
}
const models: Record<string, Row> = {};
const fakePrisma: Row = new Proxy({} as Row, {
  get(_t, prop) {
    if (typeof prop !== 'string' || prop === 'then') return undefined;
    if (prop === '$transaction') return async (arg: unknown) => (typeof arg === 'function' ? arg(fakePrisma) : Promise.all(arg as Promise<unknown>[]));
    if (prop.startsWith('$')) return async () => undefined;
    return (models[prop] ??= model(prop));
  },
});

// ---- Fake Redis ----

const redisStore = new Map<string, string>();
const decode = (raw: string | undefined) => {
  if (raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return raw; }
};
const redisImpl: Row = {
  get: async (k: string) => decode(redisStore.get(k)),
  set: async (k: string, v: unknown, o?: Row) => {
    if (o?.nx && redisStore.has(k)) return null;
    redisStore.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    return 'OK';
  },
  del: async (...ks: unknown[]) => ks.flat().reduce((n: number, k) => n + (redisStore.delete(String(k)) ? 1 : 0), 0),
  exists: async (...ks: string[]) => ks.filter(k => redisStore.has(k)).length,
  mget: async (...ks: unknown[]) => ks.flat().map(k => decode(redisStore.get(String(k)))),
  scan: async () => [0, []],
  expire: async () => 1,
  ttl: async () => -1,
};
const fakeRedis = new Proxy(redisImpl, {
  get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? (async () => null)),
});

// ---- Module stubs ----

const captured: string[] = [];
/** The settings_changed rows the route tracked. */
const activities: { userId: number; type: string; meta: unknown }[] = [];
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
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};
function stub(rel: string, exports: Row) {
  const filename = path.join(ROOT, rel);
  stubs[filename] = exports;
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  Module._cache[filename] = mod;
}
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

function installStubs() {
  stub('src/utils/prisma.ts', { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() });
  stub('src/utils/redis.ts', { redis: fakeRedis });
  stub('src/lib/error-capture.ts', {
    captureError: (e: unknown, ctx: string) => { captured.push(`error:${ctx}:${e instanceof Error ? e.message : String(e)}`); },
    captureWarning: (m: string, ctx: string) => { captured.push(`warning:${ctx}:${m}`); },
    captureInfo: () => {},
  });
  stub('src/lib/rate-limit.ts', {
    settingsRateLimiter: {}, commandRateLimiter: {}, generalRateLimiter: {}, tokenPollRateLimiter: {},
    checkRateLimit: async () => ({ success: true, limit: 99, remaining: 99, reset: 0 }),
    getRateLimitHeaders: () => ({}),
  });
  // The proved user is the one the URL names (the credential check has its own smokes)
  stub('src/lib/api-auth.ts', {
    verifyUserAuth: async (_req: unknown, userId: string | null) => {
      const { getUserById } = await load('src/services/user-service.ts');
      const user = await getUserById(Number(userId));
      return user ? { success: true, user } : { success: false, response: new Response('{}', { status: 404 }) };
    },
  });
  const telegram = { getMessagingService: () => ({}), setUserMenuButton: async () => {}, getBot: () => ({}), initBot: () => ({}) };
  stub('src/services/telegram/index.ts', telegram);
  stub('src/services/telegram/bot.ts', telegram);
  stub('src/services/analytics-service.ts', {
    trackActivityAsync: (userId: number, type: string, meta: unknown) => { activities.push({ userId, type, meta }); },
  });
  stub('src/services/calendar.ts', { ...nodeRequire(path.join(ROOT, 'src/services/calendar.ts')) });
}

// ---- Fixtures ----

const DAY = 86_400_000;
const days = (n: number) => new Date(Date.now() + n * DAY);
function baseUser(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', culture: 'default',
    messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null,
    calendarSource: 'NATIVE', pairingId: null, remindersEnabled: false, suspendedAt: null, suspendedBy: null,
    suspendedReason: null, unreachableSince: null, whatsappPhone: null, whatsappBsuid: null, telegramId: null,
    isAdmin: false, globalRules: [], textSummaryEnabled: true, voiceSummaryEnabled: true, voiceInputEnabled: false,
    weatherEnabled: true,
    includeLookaheadInTomorrow: false, lookaheadAlways7Days: false, preferredMorningHour: 7, preferredEveningHour: 19,
    dailySummaryDays: [0, 1, 2, 3, 4, 5, 6], tomorrowSummaryDays: [0, 1, 2, 3, 4, 5, 6], defaultReminderMinutes: null,
    pickupRemindersEnabled: true, reminderStartAt: null, createdAt: days(-400), updatedAt: days(-1),
    ...o,
  };
}
const cal = (id: string, ownerUserId: number, name: string, o: Row = {}): Row => ({
  id, ownerUserId, name, color: '#039BE5', labels: [], rules: [], privacy: 'PRIVATE', isDeleted: false, personName: null,
  personEnglishName: null, personGender: null, createdAt: days(-300), updatedAt: days(-20), ...o,
});

// Users: 1 Dana and 2 Amir are partners (Amir's calendar names no person, so Dana's view of it is named after him
// and gendered by his row); 3 Noa, on her own.
function seed() {
  DB = {};
  redisStore.clear();
  captured.length = 0;
  activities.length = 0;
  userWrites.length = 0;
  DB.user = [
    baseUser({ id: 1, name: 'Dana', gender: 'female', telegramId: BigInt(5550001), pairingId: 'pair-12' }),
    baseUser({ id: 2, name: 'Amir', telegramId: BigInt(5550002), pairingId: 'pair-12' }),
    baseUser({ id: 3, name: 'Noa', telegramId: BigInt(5550003) }),
  ];
  DB.pairing = [{ id: 'pair-12', status: 'ACTIVE', inviterUserId: 1, inviteeUserId: 2, acceptedAt: days(-50), createdAt: days(-50) }];
  DB.nativeCalendar = [
    cal('cal-1', 1, 'Dana', { labels: ['primary', 'yours'], privacy: 'SHARED_EDITOR' }),
    cal('cal-2', 2, 'Amir', { labels: ['primary', 'yours'], privacy: 'SHARED_EDITOR' }),
    cal('cal-3', 3, 'Noa', { labels: ['primary', 'yours'] }),
  ];
}
const userRow = (id: number) => table('user').find(u => u.id === id) as Row;
async function configOf(id: number): Promise<Row> {
  const { getUserById } = await load('src/services/user-service.ts');
  return getUserById(id);
}

/** A settings save from the mini app, through the real route. */
async function save(userId: number, body: Row): Promise<{ status: number; body: Row }> {
  const mod = await load('app/api/settings/route.ts');
  const { NextRequest } = await import('next/server');
  const req = new NextRequest(`https://famcal.test/api/settings?user_id=${userId}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  const log = console.log;
  console.log = () => {};
  try {
    const res: Response = await mod.POST(req);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    console.log = log;
  }
}

async function main() {
  installStubs();
  const { Prisma } = await import('@prisma/client');
  for (const v of [Prisma.JsonNull, Prisma.DbNull, Prisma.AnyNull]) NULLS.add(v);

  await check('A1 the route accepts "male" and "female": 200, the row holds it, and the activity log gets the field\'s name (gender), never its value; a save that changes nothing logs nothing', async () => {
    seed();
    const toFemale = await save(2, { gender: 'female' });
    assert(toFemale.status === 200, `female: ${show(toFemale)}`);
    eq(userRow(2).gender, 'female', 'the row after female');
    eq(activities.map(a => [a.userId, a.type, a.meta]), [[2, 'settings_changed', { changed_fields: ['gender'] }]], 'activity');
    assert(!JSON.stringify(activities).includes('female'), 'the activity carries the value');
    const toMale = await save(2, { gender: 'male' });
    assert(toMale.status === 200, `male: ${show(toMale)}`);
    eq(userRow(2).gender, 'male', 'the row after male');
    activities.length = 0;
    const again = await save(2, { gender: 'male' });
    assert(again.status === 200 && activities.length === 0, `the same value again: ${show(again)} ${show(activities)}`);
  });

  await check('A2 anything else is refused with 400 "Invalid gender" and writes nothing, not even the other settings of that request', async () => {
    const bad: unknown[] = ['other', '', ' female', 'Female', 'FEMALE', 'MALE', 'non-binary', 'f', null, 0, 1, true, ['female'], { gender: 'female' }];
    for (const value of bad) {
      seed();
      const res = await save(2, { gender: value, language: 'he', weatherEnabled: false });
      assert(res.status === 400 && res.body.error === 'Invalid gender', `${show(value)}: ${show(res)}`);
      eq([userRow(2).gender, userRow(2).language, userRow(2).weatherEnabled], ['male', 'en', true], `${show(value)}: the row`);
      assert(userWrites.length === 0 && activities.length === 0, `${show(value)}: wrote ${show(userWrites)} ${show(activities)}`);
    }
    // And a good one beside the other settings still saves them all together
    seed();
    const ok = await save(2, { gender: 'female', language: 'he', weatherEnabled: false });
    assert(ok.status === 200, show(ok));
    eq([userRow(2).gender, userRow(2).language, userRow(2).weatherEnabled], ['female', 'he', false], 'a good save');
  });

  await check('A3 the value saves and reloads: the next read of the row says what was saved, and a save without a gender (an older page, a language-only save) leaves it alone', async () => {
    seed();
    eq((await configOf(3)).gender, 'male', 'where everyone starts');
    assert((await save(3, { gender: 'female' })).status === 200, 'the save');
    eq((await configOf(3)).gender, 'female', 'reloaded');
    assert((await save(3, { weatherEnabled: false })).status === 200, 'a save without a gender');
    assert((await save(3, { language: 'ru', gender: undefined })).status === 200, 'a save with the gender unset');
    eq([(await configOf(3)).gender, (await configOf(3)).weatherEnabled], ['female', false], 'still female');
    assert((await save(3, { gender: 'male' })).status === 200, 'and back');
    eq((await configOf(3)).gender, 'male', 'back to male');
  });

  await check('A4 the voice show\'s listener gender is the saved one: male where everyone starts, female after she saves it', async () => {
    seed();
    const { buildShowContext } = await load('src/services/voice-show/context.ts');
    const listener = async (id: number) => buildShowContext('summary', await configOf(id), 'daily').listener;
    eq(await listener(3), { name: 'Noa', gender: 'male' }, 'before');
    assert((await save(3, { gender: 'female' })).status === 200, 'the save');
    eq(await listener(3), { name: 'Noa', gender: 'female' }, 'after');
    assert((await save(3, { gender: 'male' })).status === 200, 'the save back');
    eq(await listener(3), { name: 'Noa', gender: 'male' }, 'and back');
  });

  await check('A5 a partner\'s calendar person-gender follows the owner\'s saved gender: Dana sees Amir\'s calendar as a male spouse, then a female one once he saves "female", and the show\'s spouse follows', async () => {
    seed();
    const { getCalendarAssignmentsForUser } = await load('src/services/calendar-provider/user-calendars.ts');
    const { buildShowContext } = await load('src/services/voice-show/context.ts');
    const danaSees = async () => {
      const dana = await configOf(1);
      const calendars: Row[] = await getCalendarAssignmentsForUser(dana);
      const partner = calendars.find(c => c.calendarId === 'native:cal-2') as Row;
      return { person: [partner.personName, partner.personGender], spouse: buildShowContext('s', dana, 'daily', false, calendars).spouse };
    };
    eq(await danaSees(), { person: ['Amir', 'male'], spouse: { name: 'Amir', gender: 'male' } }, 'before');
    assert((await save(2, { gender: 'female' })).status === 200, 'the save');
    eq(await danaSees(), { person: ['Amir', 'female'], spouse: { name: 'Amir', gender: 'female' } }, 'after');
    assert((await save(2, { gender: 'male' })).status === 200, 'the save back');
    eq(await danaSees(), { person: ['Amir', 'male'], spouse: { name: 'Amir', gender: 'male' } }, 'and back');
  });

  await check('A6 the summary prompts address the user from the saved value: Hebrew says נקבה and Russian "женский род" for a woman, זכר and "мужской род" for a man', async () => {
    seed();
    const { buildCalendarSummaryPrompt: he } = await load('src/prompts/calendar-summary/he.ts');
    const { buildCalendarSummaryPrompt: ru } = await load('src/prompts/calendar-summary/ru.ts');
    const data = (userGender: unknown): Row => ({
      userName: 'Noa', userEnglishName: '', userGender, hasSpouseCalendar: false, currentGregorianDate: '2026-10-28', summaryGregorianDate: '2026-10-28',
      summaryHebrewDate: '', greeting: 'x', userEventsText: '', spouseEventsText: '', otherEventsText: '', language: 'he',
    });
    const say = async (id: number) => (await configOf(id)).gender;
    assert((await save(3, { gender: 'female' })).status === 200, 'the save');
    const woman = await say(3);
    assert(he(data(woman)).includes('נקבה - השתמש בצורות דקדוק מתאימות') && ru(data(woman)).includes('женский род'), 'Hebrew or Russian does not say female');
    assert((await save(3, { gender: 'male' })).status === 200, 'the save back');
    const man = await say(3);
    assert(he(data(man)).includes('זכר - השתמש בצורות דקדוק מתאימות') && ru(data(man)).includes('мужской род'), 'Hebrew or Russian does not say male');
  });

  await check('A7 nothing caches the gender: the reminder cache entry the route syncs after a save carries none, so a save has nothing of it to invalidate (the voice show, the summaries and the calendar helpers read the row each time)', async () => {
    seed();
    Object.assign(userRow(3), { remindersEnabled: true, googleRefreshToken: '' });
    assert((await save(3, { gender: 'female' })).status === 200, 'the save');
    const cached = decode(redisStore.get('reminders:users:v2')) as Row[] | null;
    assert(cached?.some(c => c.id === 3), `the entry is synced: ${show(cached)}`);
    for (const key of redisStore.keys()) assert(!/gender|female/i.test(redisStore.get(key) ?? ''), `${key} holds a gender`);
  });

  const failed = results.filter(r => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
  if (captured.length) console.log(`captured: ${captured.length}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

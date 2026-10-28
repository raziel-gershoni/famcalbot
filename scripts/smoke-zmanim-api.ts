// Smoke test for GET /api/zmanim, the home's sun sheet (app/api/zmanim/route.ts, zmanDayList in
// src/services/zmanim/reminder-times.ts; types and request in src/lib/calendar-view/zmanim-list.ts).
//
// The route, api-auth, telegram-auth, the place logic, the pause's windows and the calculator run for real over a
// faked Prisma, Redis and geocoding fetch (no network, no database). What it pins:
//   - Harish, 2026-10-28 (32.46182, 35.04555, 270 m, Sephardi): every row is the golden time (the owner's Zmanei Yosef
//     screenshot within one minute, and what we show pinned), in the order of the day, with the opinions and the
//     two halachic hours (the GRA's 55:24 and the Magen Avraham's 66:29, each within two seconds of Zmanei Yosef's 55:25 and 66:30);
//   - the candle lighting on the day a Shabbat or Yom Tov window begins and on every Friday (a Friday inside a longer
//     window, a Yom Tov on Friday, is the Shabbat's candles), always that day's own time, 20 minutes before the plain sunset
//     row; the window itself begins at that sunset (the owner's ruling 2026-10-28: the pause starts at sunset, not at candle
//     lighting), so the window's start is the eve's sunset row to the millisecond and the candle row is strictly before it;
//     the end only on the day one ends, and the ends are exactly the instants shabbatYomTovWindows (the pause's windows)
//     gives: a Friday, a Saturday, a Wednesday with neither, Yom
//     Kippur (a Sunday eve and a Monday end), Shavuot on a Friday in Israel and Pesach abroad (a Friday inside a window), a
//     Saturday or a weekday inside a longer window (the candle lighting "not before" the day's end of Shabbat), the end
//     of a Saturday that is also a Yom Tov ("Shabbat and Yom Tov end"), and Sukkot abroad (two days); and a sweep of 400
//     days in Israel and in New York for the rules a person reads the list by;
//   - no saved place: the zone's main city and source 'zone', at once, without waiting for the place lookup; a zone with
//     no main city and no place: place null and no rows;
//   - a polar day: null times and a null hour, never a failure;
//   - the community sets (Chabad has no Magen Avraham hour and names the Baal HaTanya);
//   - the request: no date means today in the person's zone, a bad or out-of-range date is 400, no initData is 401,
//     every answer is private and not stored, a failure is 500 and reported.
//
// Run with the fake env from the task brief (no dotenv). This file re-runs itself once per server zone (UTC,
// Asia/Jerusalem, America/New_York) as child processes, so one command covers all three; nothing here may depend on
// the zone the process has:
//   npx tsx scripts/smoke-zmanim-api.ts

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(__dirname, '..');
const ZONES = ['UTC', 'Asia/Jerusalem', 'America/New_York'] as const;
const CHILD = 'ZMANIM_API_SMOKE_CHILD';

// ---- The parent: one child per process zone ----

async function runChildren(): Promise<void> {
  const outputs = await Promise.all(
    ZONES.map(
      (zone) =>
        new Promise<{ zone: string; code: number; text: string }>((resolve) => {
          // process.execArgv carries tsx's loader flags, so the child compiles TypeScript the same way.
          const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], {
            env: { ...process.env, TZ: zone, [CHILD]: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let text = '';
          child.stdout.on('data', (chunk) => (text += chunk));
          child.stderr.on('data', (chunk) => (text += chunk));
          child.on('close', (code) => resolve({ zone, code: code ?? 1, text }));
        }),
    ),
  );
  let failed = 0;
  for (const { zone, code, text } of outputs) {
    console.log(`\n===== process TZ=${zone} =====\n${text.trimEnd()}`);
    if (code !== 0) failed++;
  }
  console.log(`\n${ZONES.length - failed}/${ZONES.length} process zones passed (${ZONES.join(', ')})`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---- Checks ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
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
function assertSame(got: unknown, want: unknown, label: string): void {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.CRON_SECRET ||= 'test-cron';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const nodeRequire = createRequire(__filename);
const Module = nodeRequire('module');
// @hebcal/core is ESM-only and tsx loads src/ as CommonJS: point it at its ESM build before the module under test loads.
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.resolve(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};

// ---- Fakes: Prisma (the user table), Redis, the geocoding fetch, error capture, the rate limiter ----

const users = new Map<number, Row>();
const redisStore = new Map<string, unknown>();
const captured: { ctx: string; extra: Row | undefined; message: string }[] = [];
const rateChecks: string[] = [];
const consoleLines: string[] = [];
type Request = { url: string };
const requests: Request[] = [];
let heldNominatim: Promise<void> | null = null;

const fakeRedis = {
  get: async (key: string) => (redisStore.has(key) ? redisStore.get(key) : null),
  set: async (key: string, value: unknown) => { redisStore.set(key, value); return 'OK'; },
  del: async (key: string) => (redisStore.delete(key) ? 1 : 0),
};

const fakePrisma = {
  user: {
    findUnique: async ({ where }: { where: Row }) => {
      const all = [...users.values()];
      const hit = where.telegramId !== undefined ? all.find((u) => u.telegramId === where.telegramId) : all.find((u) => u.id === where.id);
      return hit ? { ...hit } : null;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const row = users.get(where.id);
      if (!row || row.location !== where.location) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  },
};

async function fakeFetchWithTimeout(url: string): Promise<Response> {
  requests.push({ url });
  const parsed = new URL(url);
  const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (parsed.host === 'nominatim.openstreetmap.org') {
    if (heldNominatim) await heldNominatim;
    return respond([{ lat: '32.46182', lon: '35.04555', boundingbox: ['32.4418', '32.4818', '35.0255', '35.0655'] }]);
  }
  if (parsed.host === 'api.open-meteo.com' && parsed.pathname === '/v1/elevation') {
    const lats = (parsed.searchParams.get('latitude') ?? '').split(',');
    return respond({ elevation: lats.map(() => 270) });
  }
  if (parsed.host === 'api.open-meteo.com') return respond({ timezone: 'Asia/Jerusalem' });
  throw new Error(`unexpected request: ${url}`);
}

function stub(rel: string, exports: Row): void {
  const filename = path.join(ROOT, rel);
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  Module._cache[filename] = mod;
}

/** Stubs served to import() by a load hook (the route is loaded as an ES module by tsx). */
const stubs: Record<string, Row> = {};
(globalThis as Row).__smokeStubs = stubs;
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs)) return nextLoad(url, context);
    const names = Object.keys(stubs[file]).filter((n) => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
    const source = [
      `const s = globalThis.__smokeStubs[${JSON.stringify(file)}];`,
      ...names.map((n) => `export const ${n} = s[${JSON.stringify(n)}];`),
      'export default (s.__esModule ? s.default : s);',
    ].join('\n');
    return { format: 'module', source, shortCircuit: true };
  },
});

function installStubs(): void {
  const put = (rel: string, exports: Row) => {
    stubs[path.join(ROOT, rel)] = exports;
    stub(rel, exports);
  };
  put('src/utils/prisma.ts', { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() });
  put('src/utils/redis.ts', { redis: fakeRedis });
  put('src/lib/error-capture.ts', {
    captureError: (e: unknown, ctx: string, extra?: Row) => { captured.push({ ctx, extra, message: e instanceof Error ? e.message : String(e) }); },
    captureWarning: (message: string, ctx: string, extra?: Row) => { captured.push({ ctx, extra, message }); },
    captureInfo: () => undefined,
  });
  put('src/lib/rate-limit.ts', {
    calendarRateLimiter: { name: 'calendar' },
    checkRateLimit: async (limiter: Row, identifier: string | number) => {
      rateChecks.push(`${limiter?.name}:${String(identifier)}`);
      return { success: true, remaining: 19, reset: 0 };
    },
    getRateLimitHeaders: () => ({}),
  });
  put('src/services/weather/geocoding.ts', { fetchWithTimeout: fakeFetchWithTimeout, geocodeLocation: async () => { throw new Error('the cached geocode path was used'); } });
  put('src/services/calendar.ts', { getUserCalendarTimezone: async () => null });
}

// ---- Fixtures ----

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const TG = { harish: 1001, plain: 1002, zone: 1003, noCity: 1004, polar: 1005, chabad: 1006, ashkenazi: 1007, ny: 1008, boom: 1009 };
const ID = { harish: 1, plain: 2, zone: 3, noCity: 4, polar: 5, chabad: 6, ashkenazi: 7, ny: 8, boom: 9 };

function baseUser(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'he', location: '', latitude: null, longitude: null, elevationM: null, zmanimCommunity: 'sephardi',
    pauseOnShabbat: false, culture: 'jewish', messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null, calendarSource: 'NATIVE',
    pairingId: null, remindersEnabled: false, suspendedAt: null, unreachableSince: null, whatsappPhone: null, whatsappBsuid: null, isAdmin: false,
    globalRules: [], voiceInputEnabled: true, textSummaryEnabled: true, voiceSummaryEnabled: false, weatherEnabled: true,
    createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'), ...o,
  };
}

function seed(): void {
  users.clear();
  redisStore.clear();
  captured.length = 0;
  rateChecks.length = 0;
  consoleLines.length = 0;
  requests.length = 0;
  heldNominatim = null;
  const fills = (globalThis as Row).__zmanimPlaceFill;
  fills?.running.clear();
  fills?.filled.clear();
  fills?.failedAt.clear();
  const add = (key: keyof typeof ID, tz: string, o: Row) => {
    users.set(ID[key], baseUser({ id: ID[key], name: key, telegramId: BigInt(TG[key]), ...o }));
    redisStore.set(`tz:user:${ID[key]}`, tz);
  };
  add('harish', IL, { location: 'חריש', latitude: 32.46182, longitude: 35.04555, elevationM: 270 });
  // No place name, no coordinates, in Israel: the zone's main city stands in
  add('plain', IL, {});
  // A place name and no coordinates yet: the lookup runs in the background
  add('zone', IL, { location: 'Harish, Israel' });
  // A zone with no main city and nothing saved: nothing to count from
  add('noCity', 'Asia/Tokyo', {});
  add('polar', 'Atlantic/Reykjavik', { location: 'Reykjavik', latitude: 64.1466, longitude: -21.9426, elevationM: 20, zmanimCommunity: 'ashkenazi' });
  add('chabad', IL, { location: 'Jerusalem', latitude: 31.778, longitude: 35.235, elevationM: 754, zmanimCommunity: 'chabad' });
  add('ashkenazi', IL, { location: 'Bnei Brak', latitude: 32.083, longitude: 34.833, elevationM: 40, zmanimCommunity: 'ashkenazi' });
  add('ny', NY, { location: 'New York', latitude: 40.7127, longitude: -74.006, elevationM: 10 });
  // A zone no clock knows: the calculation throws, and the route reports it
  add('boom', 'Not/AZone', { location: 'Nowhere', latitude: 10, longitude: 10, elevationM: 0 });
}

/** Valid Telegram initData for a Telegram user id, signed with the bot token. */
function initDataFor(tgId: number): string {
  const params: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAH-smoke',
    user: JSON.stringify({ id: tgId, first_name: 'Test' }),
  };
  const checkString = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN ?? '').digest();
  const hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  return [...Object.entries(params), ['hash', hash]].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

// ---- The golden tables (scripts/smoke-zmanim.ts): Harish, 2026-10-28 ----

/** The owner's Zmanei Yosef screenshot (minutes, 24-hour). */
const SCREENSHOT: Record<string, string> = {
  ALOT: '04:44', MISHEYAKIR: '04:56', NETZ: '05:53', SOF_SHMA_MGA: '08:04', SOF_SHMA_GRA: '08:37', SOF_TFILA: '09:32', CHATZOT: '11:23',
  MINCHA_GEDOLA: '11:54', MINCHA_KETANA: '14:38', PLAG_HALACHA_BERURA: '15:47', PLAG_YALKUT_YOSEF: '15:59', SHKIA: '16:56',
  TZEIT: '17:09', TZEIT_LECHUMRA: '17:14', CHATZOT_HALAYLA: '23:24',
};
/** What we show, pinned. */
const OURS: Record<string, string> = {
  ALOT: '04:44', MISHEYAKIR: '04:56', NETZ: '05:54', SOF_SHMA_MGA: '08:03', SOF_SHMA_GRA: '08:37', SOF_TFILA: '09:32', CHATZOT: '11:23',
  MINCHA_GEDOLA: '11:54', MINCHA_KETANA: '14:38', PLAG_HALACHA_BERURA: '15:47', PLAG_YALKUT_YOSEF: '15:59', SHKIA: '16:55',
  TZEIT: '17:09', TZEIT_LECHUMRA: '17:15', CHATZOT_HALAYLA: '23:24',
};
/** The Sephardi set's keys in the order of the day, without the two the windows give. */
const SEPHARDI_ORDER = Object.keys(OURS);
/** The rows that end a Shabbat or a Yom Tov: of Shabbat, of a Yom Tov, and of a Saturday that is also a Yom Tov. */
const END_KEYS = ['SHABBAT_ENDS', 'YOM_TOV_ENDS', 'SHABBAT_YOM_TOV_ENDS'];
/** The Sephardi set with one more row at the place the end of Shabbat sits (before the midnight): the day's end, or the candle lighting "not before" it. */
const withNightRow = (key: string): string[] => [...SEPHARDI_ORDER.slice(0, -1), key, SEPHARDI_ORDER[SEPHARDI_ORDER.length - 1]];

const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** The weekday of a civil date (0 = Sunday), the same in any process zone. */
const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

async function runChecks(): Promise<void> {
  console.log(`process TZ=${process.env.TZ} (Intl: ${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  installStubs();
  seed();
  const { NextRequest } = nodeRequire('next/server');
  const wall = nodeRequire(path.join(ROOT, 'src/utils/wall-time.ts')) as { instantToWallTime: (instant: Date, zone: string) => string };
  const compute = nodeRequire(path.join(ROOT, 'src/services/zmanim/compute.ts')) as {
    zmanimForDay: (date: string, place: Row, community: string) => Record<string, Date | null>;
    shabbatYomTovWindows: (range: { from: Date; to: Date }, place: Row, community: string) => Array<[Date, Date]>;
    halachicHourMs: (date: string, place: Row, community: string) => { day: number | null; mga: number | null };
  };
  const route = (await import(path.join(ROOT, 'app/api/zmanim/route.ts'))) as Row;

  // The routes log; keep the output to the results, and keep what they write.
  const quiet = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    (console as Row)[level] = (...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')); };
  }
  const restoreConsole = () => Object.assign(console, quiet);

  type Call = { tg?: number; header?: boolean; userId?: string | number };
  type Reply = { status: number; body: Row; res: Response };
  const get = async (qs: string, o: Call = {}): Promise<Reply> => {
    const headers: Record<string, string> = o.header === false ? {} : { 'x-telegram-init-data': initDataFor(o.tg ?? TG.harish) };
    const res: Response = await route.GET(new NextRequest(`http://localhost/api/zmanim?user_id=${o.userId ?? o.tg ?? TG.harish}${qs ? `&${qs}` : ''}`, { headers }));
    let body: Row = {};
    try { body = JSON.parse(await res.clone().text()); } catch { /* not JSON */ }
    return { status: res.status, body, res };
  };
  const listOf = async (tg: number, date: string): Promise<Row> => {
    const reply = await get(`date=${date}`, { tg });
    assert(reply.status === 200, `${tg} ${date}: status ${reply.status} ${show(reply.body)}`);
    return reply.body;
  };
  const rowsOf = (list: Row): Row[] => list.rows as Row[];
  const keysOf = (list: Row): string[] => rowsOf(list).map((r) => r.key);
  const rowOf = (list: Row, key: string): Row => {
    const found = rowsOf(list).find((r) => r.key === key);
    assert(found, `no ${key} row in ${show(keysOf(list))}`);
    return found;
  };
  const hm = (iso: string | null, zone: string): string => {
    assert(typeof iso === 'string', `not an instant: ${String(iso)}`);
    return wall.instantToWallTime(new Date(iso), zone).slice(11, 16);
  };
  const atOf = (list: Row, key: string): string => hm(rowOf(list, key).at, list.tz);
  const HARISH_PLACE = { latitude: 32.46182, longitude: 35.04555, elevationM: 270, timeZone: IL };
  const NY_PLACE = { latitude: 40.7127, longitude: -74.006, elevationM: 10, timeZone: NY };
  const NOT_STORED = 'private, no-store';

  // ================= Harish =================

  await check('Harish, Wednesday 2026-10-28, Sephardi: the saved place and the community, the zone, the rows in the order of the day with their opinions and the golden times (the screenshot within one minute, and what we show pinned), no candle lighting or end on a weekday', async () => {
    seed();
    const reply = await get('date=2026-10-28');
    assert(reply.status === 200 && reply.res.headers.get('cache-control') === NOT_STORED, `status ${reply.status} ${reply.res.headers.get('cache-control')}`);
    const list = reply.body;
    assertSame({ day: list.day, tz: list.tz, community: list.community, place: list.place }, { day: '2026-10-28', tz: IL, community: 'sephardi', place: { source: 'saved', name: 'חריש' } }, 'the header');
    assertSame(keysOf(list), SEPHARDI_ORDER, 'the rows, in the order of the day');
    for (const [key, want] of Object.entries(OURS)) assert(atOf(list, key) === want, `${key}: ${atOf(list, key)}, pinned ${want}`);
    for (const [key, want] of Object.entries(SCREENSHOT)) assert(Math.abs(minutesOf(atOf(list, key)) - minutesOf(want)) <= 1, `${key}: ${atOf(list, key)}, the screenshot ${want}`);
    const opinions = Object.fromEntries(rowsOf(list).filter((r) => r.opinion !== null).map((r) => [r.key, r.opinion]));
    assertSame(opinions, { SOF_SHMA_MGA: 'mga', SOF_SHMA_GRA: 'gra', PLAG_HALACHA_BERURA: 'halachaBerura', PLAG_YALKUT_YOSEF: 'yalkutYosef' }, 'the opinions');
    assert(!keysOf(list).includes('CANDLE_LIGHTING') && !keysOf(list).includes('SHABBAT_ENDS') && !keysOf(list).includes('YOM_TOV_ENDS'), 'a Wednesday earns neither');
    // The rows are the module's own instants (one code path): the same as zmanimForDay, ISO to the millisecond.
    const direct = compute.zmanimForDay('2026-10-28', HARISH_PLACE, 'sephardi');
    for (const key of SEPHARDI_ORDER) assert(rowOf(list, key).at === direct[key]!.toISOString(), `${key} is not zmanimForDay's instant`);
  });

  await check('Harish: the halachic hour is 55:24 under the GRA (3 324 000 ms) and 66:29 under the Magen Avraham (3 988 800 ms), exactly what the calculator gives and within two seconds of Zmanei Yosef\'s 55:25 and 66:30, the GRA first', async () => {
    seed();
    const list = await listOf(TG.harish, '2026-10-28');
    assertSame(list.hours.map((h: Row) => h.opinion), ['gra', 'mga'], 'the opinions');
    assertSame(list.hours.map((h: Row) => h.ms), [3_324_000, 3_988_800], 'the hours, in milliseconds');
    assert(Math.abs(list.hours[0].ms - (55 * 60 + 25) * 1000) <= 2000, `GRA ${list.hours[0].ms}`);
    assert(Math.abs(list.hours[1].ms - (66 * 60 + 30) * 1000) <= 2000, `MGA ${list.hours[1].ms}`);
    const direct = compute.halachicHourMs('2026-10-28', HARISH_PLACE, 'sephardi');
    assertSame([list.hours[0].ms, list.hours[1].ms], [direct.day, direct.mga], 'the module\'s own hours');
  });

  // ================= Shabbat and Yom Tov =================

  await check('a Friday earns the candle lighting (before the sunset, 20 minutes before it) and not the end; a Saturday earns the end of Shabbat (after the nightfalls, before midnight) and not the candle lighting; the window begins at the Friday\'s sunset row and ends at the Saturday\'s end row, exactly the pause\'s windows\' edges, and the candle row is the day\'s own time, before the start', async () => {
    seed();
    const friday = await listOf(TG.harish, '2026-10-30');
    const saturday = await listOf(TG.harish, '2026-10-31');
    assert(keysOf(friday).indexOf('CANDLE_LIGHTING') === keysOf(friday).indexOf('SHKIA') - 1 && !keysOf(friday).includes('SHABBAT_ENDS') && !keysOf(friday).includes('YOM_TOV_ENDS'), `Friday ${show(keysOf(friday))}`);
    const lastNight = keysOf(saturday).slice(-3);
    assertSame(lastNight, ['TZEIT_LECHUMRA', 'SHABBAT_ENDS', 'CHATZOT_HALAYLA'], 'Saturday ends in the order of the day');
    assert(!keysOf(saturday).includes('CANDLE_LIGHTING') && !keysOf(saturday).includes('YOM_TOV_ENDS'), `Saturday ${show(keysOf(saturday))}`);
    // The windows the pause reads, over the whole weekend
    const windows = compute.shabbatYomTovWindows({ from: new Date('2026-10-29T12:00:00Z'), to: new Date('2026-11-01T12:00:00Z') }, HARISH_PLACE, 'sephardi');
    assert(windows.length === 1, `${windows.length} windows`);
    assert(rowOf(friday, 'SHKIA').at === windows[0][0].toISOString(), 'Friday\'s sunset row is the window\'s start');
    const ownCandles = compute.zmanimForDay('2026-10-30', HARISH_PLACE, 'sephardi').CANDLE_LIGHTING!;
    assert(rowOf(friday, 'CANDLE_LIGHTING').at === ownCandles.toISOString() && rowOf(friday, 'CANDLE_LIGHTING').opinion === null, 'Friday\'s candle lighting is the day\'s own time');
    assert(Date.parse(rowOf(friday, 'CANDLE_LIGHTING').at) < windows[0][0].getTime() && windows[0][0].getTime() - Date.parse(rowOf(friday, 'CANDLE_LIGHTING').at) === 20 * 60_000, 'and 20 minutes before the window\'s start, not the start');
    assert(rowOf(saturday, 'SHABBAT_ENDS').at === windows[0][1].toISOString(), 'Saturday\'s end is the window\'s end');
    // And the relations a person can check by hand: 20 minutes before the sunset, and 30 minutes after it in Israel
    assert(minutesOf(atOf(friday, 'SHKIA')) - minutesOf(atOf(friday, 'CANDLE_LIGHTING')) === 20, `candles ${atOf(friday, 'CANDLE_LIGHTING')}, sunset ${atOf(friday, 'SHKIA')}`);
    const afterSunset = minutesOf(atOf(saturday, 'SHABBAT_ENDS')) - minutesOf(atOf(saturday, 'SHKIA'));
    assert(afterSunset === 30 || afterSunset === 31, `Shabbat ends ${afterSunset} minutes after the sunset`);
    // The regular rows of that Friday and Saturday are the same set
    assertSame(keysOf(saturday).filter((k) => k !== 'SHABBAT_ENDS'), SEPHARDI_ORDER, 'Saturday\'s other rows');
    assertSame(keysOf(friday).filter((k) => k !== 'CANDLE_LIGHTING'), SEPHARDI_ORDER, 'Friday\'s other rows');
  });

  await check('Yom Tov: the eve of Yom Kippur (Sunday the 20th) earns the candle lighting and the day (Monday the 21st) its end as the end of a Yom Tov, not of Shabbat; the Saturday before it is a window of its own with its own end; the days around earn neither; the list and the windows agree on the edges of every one of 60 days', async () => {
    seed();
    const saturday = await listOf(TG.harish, '2026-09-19');
    const eve = await listOf(TG.harish, '2026-09-20');
    const day = await listOf(TG.harish, '2026-09-21');
    const after = await listOf(TG.harish, '2026-09-22');
    assert(keysOf(saturday).includes('SHABBAT_ENDS') && !keysOf(saturday).includes('CANDLE_LIGHTING'), `the Saturday before ${show(keysOf(saturday))}`);
    assert(keysOf(eve).includes('CANDLE_LIGHTING') && !keysOf(eve).some((k) => k.endsWith('_ENDS')), `the eve ${show(keysOf(eve))}`);
    assert(keysOf(day).includes('YOM_TOV_ENDS') && !keysOf(day).includes('SHABBAT_ENDS') && !keysOf(day).includes('CANDLE_LIGHTING'), `the day ${show(keysOf(day))}`);
    assertSame(keysOf(day).slice(-3), ['TZEIT_LECHUMRA', 'YOM_TOV_ENDS', 'CHATZOT_HALAYLA'], 'the end sits where the end of Shabbat does');
    assertSame(keysOf(after), SEPHARDI_ORDER, 'the day after has the plain set');
    const windows = compute.shabbatYomTovWindows({ from: new Date('2026-09-19T12:00:00Z'), to: new Date('2026-09-22T12:00:00Z') }, HARISH_PLACE, 'sephardi');
    assert(windows.length === 2 && rowOf(eve, 'SHKIA').at === windows[1][0].toISOString() && rowOf(day, 'YOM_TOV_ENDS').at === windows[1][1].toISOString(), `windows ${show(windows)}`);
    const eveCandles = compute.zmanimForDay('2026-09-20', HARISH_PLACE, 'sephardi').CANDLE_LIGHTING!;
    assert(rowOf(eve, 'CANDLE_LIGHTING').at === eveCandles.toISOString() && Date.parse(rowOf(eve, 'CANDLE_LIGHTING').at) < windows[1][0].getTime(), 'Erev Yom Kippur: the candle row is the day\'s own time, before the window\'s start (its sunset)');
    // The whole run of days: the window edges appear exactly on the days they fall (in Israel's zone), to the millisecond
    const dayOf = (instant: Date) => wall.instantToWallTime(instant, IL).slice(0, 10);
    const all = compute.shabbatYomTovWindows({ from: new Date(Date.UTC(2026, 8, 1)), to: new Date(Date.UTC(2026, 10, 30)) }, HARISH_PLACE, 'sephardi');
    assert(all.length >= 8, `${all.length} windows in the autumn`);
    for (let n = 0; n < 60; n++) {
      const date = new Date(Date.UTC(2026, 8, 8 + n)).toISOString().slice(0, 10);
      const list = await listOf(TG.harish, date);
      const starts = all.filter(([start]) => dayOf(start) === date).map(([start]) => start.toISOString());
      const ends = all.filter(([, end]) => dayOf(end) === date).map(([, end]) => end.toISOString());
      const candles = rowsOf(list).filter((r) => r.key === 'CANDLE_LIGHTING').map((r) => r.at);
      const sunsets = rowsOf(list).filter((r) => r.key === 'SHKIA').map((r) => r.at);
      assertSame(rowsOf(list).filter((r) => END_KEYS.includes(r.key)).map((r) => r.at), ends, `${date}: the ends`);
      // The window's start is the sunset row; the candle lighting is the day's own time, on a window's eve and on every Friday (the Shabbat's, inside a longer window), and never the start
      assertSame(starts, starts.length > 0 ? sunsets : [], `${date}: the window starts are the sunset row`);
      assertSame(candles, starts.length > 0 || weekdayOf(date) === 5 ? [compute.zmanimForDay(date, HARISH_PLACE, 'sephardi').CANDLE_LIGHTING!.toISOString()] : [], `${date}: the candle lighting is the day's own`);
      assert(starts.every((start) => !candles.includes(start)), `${date}: no candle row is a window's start ${show(candles)} ${show(starts)}`);
    }
  });

  await check('a Saturday inside a longer window carries the candle lighting "not before" its own end of Shabbat, and neither the window\'s candle lighting nor an end: Rosh Hashana 5787 is the Friday\'s candles (the 11th) to the Sunday\'s end (the 13th), the Saturday between them (a Shabbat and the first day) lights the second day\'s candles after its own Shabbat ends', async () => {
    seed();
    const friday = await listOf(TG.harish, '2026-09-11');
    const saturday = await listOf(TG.harish, '2026-09-12');
    const sunday = await listOf(TG.harish, '2026-09-13');
    assert(keysOf(friday).includes('CANDLE_LIGHTING'), 'the Friday has the candles');
    assertSame(keysOf(saturday), withNightRow('CANDLE_LIGHTING_NOT_BEFORE'), 'Saturday inside the window: the plain set and the candles "not before", where the end of Shabbat sits');
    const notBefore = rowOf(saturday, 'CANDLE_LIGHTING_NOT_BEFORE');
    const windows = compute.shabbatYomTovWindows({ from: new Date('2026-09-10T12:00:00Z'), to: new Date('2026-09-14T12:00:00Z') }, HARISH_PLACE, 'sephardi');
    assert(windows.length === 1 && rowOf(sunday, 'YOM_TOV_ENDS').at === windows[0][1].toISOString(), `windows ${show(windows)}`);
    // The Saturday's own end of Shabbat (30 minutes after its sunset in Israel), not the window's end on Sunday
    const own = compute.zmanimForDay('2026-09-12', HARISH_PLACE, 'sephardi').SHABBAT_ENDS!;
    assert(notBefore.at === own.toISOString() && notBefore.opinion === null && notBefore.at !== windows[0][1].toISOString(), `the time ${notBefore.at}, the Saturday's own ${own.toISOString()}`);
    assert(keysOf(sunday).includes('YOM_TOV_ENDS') && !keysOf(sunday).includes('SHABBAT_ENDS') && !keysOf(sunday).includes('CANDLE_LIGHTING_NOT_BEFORE'), `Sunday ${show(keysOf(sunday))}`);
  });

  await check('a Friday inside a longer window still carries the Shabbat\'s candle lighting, at its own time and not the window\'s start (the eve\'s sunset): Shavuot 5787 is a Friday in Israel (the 11th: the window runs from Thursday the 10th to Saturday the 12th), Pesach 5787 abroad runs from Wednesday the 21st to Saturday the 24th with its second day on the Friday (New York)', async () => {
    seed();
    const cases = [
      { who: TG.harish, place: HARISH_PLACE, label: 'Israel', eve: '2027-06-10', friday: '2027-06-11', saturday: '2027-06-12', from: '2027-06-09T12:00:00Z', to: '2027-06-13T12:00:00Z' },
      { who: TG.ny, place: NY_PLACE, label: 'New York', eve: '2027-04-21', friday: '2027-04-23', saturday: '2027-04-24', from: '2027-04-20T12:00:00Z', to: '2027-04-25T12:00:00Z' },
    ];
    for (const c of cases) {
      const eveList = await listOf(c.who, c.eve);
      const friday = await listOf(c.who, c.friday);
      const saturday = await listOf(c.who, c.saturday);
      const windows = compute.shabbatYomTovWindows({ from: new Date(c.from), to: new Date(c.to) }, c.place, 'sephardi');
      assert(windows.length === 1, `${c.label}: ${windows.length} windows`);
      assert(rowOf(eveList, 'SHKIA').at === windows[0][0].toISOString(), `${c.label}: the window starts at the eve's sunset row`);
      const eveCandles = compute.zmanimForDay(c.eve, c.place, 'sephardi').CANDLE_LIGHTING!;
      assert(rowOf(eveList, 'CANDLE_LIGHTING').at === eveCandles.toISOString() && eveCandles.getTime() < windows[0][0].getTime(), `${c.label}: the eve's candles are the day's own time, before the window's start`);
      const candles = rowsOf(friday).filter((r) => r.key === 'CANDLE_LIGHTING');
      const own = compute.zmanimForDay(c.friday, c.place, 'sephardi').CANDLE_LIGHTING!;
      assert(candles.length === 1 && candles[0].at === own.toISOString() && candles[0].opinion === null, `${c.label}: the Friday's candle lighting ${show(candles)}, its own ${own.toISOString()}`);
      assert(candles[0].at !== windows[0][0].toISOString(), `${c.label}: the Friday's candles are not the window's start`);
      assert(keysOf(friday).indexOf('CANDLE_LIGHTING') === keysOf(friday).indexOf('SHKIA') - 1, `${c.label}: the candles sit before the sunset ${show(keysOf(friday))}`);
      assert(!keysOf(friday).some((k) => END_KEYS.includes(k) || k === 'CANDLE_LIGHTING_NOT_BEFORE'), `${c.label}: nothing else on the Friday ${show(keysOf(friday))}`);
      // The Saturday ends the window; it is a Shabbat only (the Yom Tov was on the Friday or earlier)
      assert(keysOf(saturday).includes('SHABBAT_ENDS') && rowOf(saturday, 'SHABBAT_ENDS').at === windows[0][1].toISOString() && !keysOf(saturday).includes('SHABBAT_YOM_TOV_ENDS'), `${c.label}: Saturday ${show(keysOf(saturday).slice(-3))}`);
    }
    // Abroad the first day (the Thursday) lights the second day's candles after its own end of Shabbat and Yom Tov, and has no candle lighting
    const thursday = await listOf(TG.ny, '2027-04-22');
    assertSame(keysOf(thursday), withNightRow('CANDLE_LIGHTING_NOT_BEFORE'), 'Pesach, the first day abroad');
    assert(rowOf(thursday, 'CANDLE_LIGHTING_NOT_BEFORE').at === compute.zmanimForDay('2027-04-22', NY_PLACE, 'sephardi').SHABBAT_ENDS!.toISOString(), 'the Thursday\'s own end');
  });

  await check('a Saturday that is also a Yom Tov ends as "Shabbat and Yom Tov end": Sukkot 2026 in Israel (the 26th) and a Yom Kippur on Shabbat (the 12th of October 2024); a Saturday that is only a Shabbat, even one that follows a Friday Yom Tov, still ends as Shabbat; a Yom Tov after Shabbat ends as a Yom Tov (Sunday, abroad), and the Saturday night before it carries the candles "not before"', async () => {
    seed();
    const sukkot = await listOf(TG.harish, '2026-09-26');
    const kippur = await listOf(TG.harish, '2024-10-12');
    for (const [label, list, date] of [['Sukkot', sukkot, '2026-09-26'], ['Yom Kippur', kippur, '2024-10-12']] as const) {
      assert(keysOf(list).includes('SHABBAT_YOM_TOV_ENDS') && !keysOf(list).includes('SHABBAT_ENDS') && !keysOf(list).includes('YOM_TOV_ENDS'), `${label}: ${show(keysOf(list).slice(-3))}`);
      assertSame(keysOf(list).slice(-3), ['TZEIT_LECHUMRA', 'SHABBAT_YOM_TOV_ENDS', 'CHATZOT_HALAYLA'], `${label}: the end sits where the end of Shabbat does`);
      const windows = compute.shabbatYomTovWindows({ from: new Date(`${date}T00:00:00Z`), to: new Date(`${date}T23:00:00Z`) }, HARISH_PLACE, 'sephardi');
      assert(windows.length === 1 && rowOf(list, 'SHABBAT_YOM_TOV_ENDS').at === windows[0][1].toISOString(), `${label}: the window's end`);
    }
    assert(keysOf(await listOf(TG.harish, '2026-10-31')).includes('SHABBAT_ENDS'), 'a plain Shabbat');
    // Simchat Torah abroad: Shemini Atzeret is a Saturday (the 3rd), Simchat Torah the Sunday (the 4th)
    const saturday = await listOf(TG.ny, '2026-10-03');
    const sunday = await listOf(TG.ny, '2026-10-04');
    assert(keysOf(saturday).includes('CANDLE_LIGHTING_NOT_BEFORE') && !keysOf(saturday).some((k) => END_KEYS.includes(k)), `Saturday ${show(keysOf(saturday))}`);
    assert(keysOf(sunday).includes('YOM_TOV_ENDS') && !keysOf(sunday).includes('SHABBAT_YOM_TOV_ENDS') && !keysOf(sunday).includes('SHABBAT_ENDS'), `Sunday ${show(keysOf(sunday))}`);
  });

  for (const [label, who, place, zone] of [['Israel', TG.harish, HARISH_PLACE, IL], ['New York', TG.ny, NY_PLACE, NY]] as const) {
    await check(`the rules a person reads the list by hold on every one of 400 days from 2026-09-01 in ${label}: every Friday has its candle lighting (its own time); no other day has one unless a window begins (then it is that day's own CANDLE_LIGHTING, strictly before the window's start, which is the eve's sunset row to the millisecond); every Saturday has exactly one of the end of Shabbat, the end of Shabbat and Yom Tov and the candles "not before"; the ends are the windows' ends to the millisecond; "not before" is a rest day inside a window that is neither a Friday nor its last day, at the day's own end; no key twice`, async () => {
      seed();
      const dayOf = (instant: Date) => wall.instantToWallTime(instant, zone).slice(0, 10);
      const all = compute.shabbatYomTovWindows({ from: new Date(Date.UTC(2026, 7, 28)), to: new Date(Date.UTC(2027, 10, 5)) }, place, 'sephardi');
      assert(all.length > 60, `${all.length} windows`);
      for (let n = 0; n < 400; n++) {
        const date = new Date(Date.UTC(2026, 8, 1 + n)).toISOString().slice(0, 10);
        const dow = weekdayOf(date);
        const list = await listOf(who, date);
        const keys = keysOf(list);
        assert(new Set(keys).size === keys.length, `${date}: a key twice ${show(keys)}`);
        const own = compute.zmanimForDay(date, place, 'sephardi');
        const count = (key: string) => keys.filter((k) => k === key).length;
        // The candle lighting: the day's own time on a window's eve and on every Friday; the window starts at the sunset row
        const starts = all.filter(([start]) => dayOf(start) === date);
        assert(count('CANDLE_LIGHTING') === (dow === 5 || starts.length > 0 ? 1 : 0), `${date}: ${count('CANDLE_LIGHTING')} candle lighting rows on a weekday ${dow}`);
        if (starts.length > 0) {
          assert(rowOf(list, 'SHKIA').at === starts[0][0].toISOString(), `${date}: the window's start is the eve's sunset row`);
          assert(rowOf(list, 'CANDLE_LIGHTING').at === own.CANDLE_LIGHTING!.toISOString() && Date.parse(rowOf(list, 'CANDLE_LIGHTING').at) < starts[0][0].getTime(), `${date}: the eve's candle row is the day's own CANDLE_LIGHTING, strictly before the start`);
        }
        if (dow === 5) assert(rowOf(list, 'CANDLE_LIGHTING').at === own.CANDLE_LIGHTING!.toISOString(), `${date}: the Friday's own candle lighting`);
        // The ends: the windows' ends, and a Saturday's three kinds
        assertSame(rowsOf(list).filter((r) => END_KEYS.includes(r.key)).map((r) => r.at), all.filter(([, end]) => dayOf(end) === date).map(([, end]) => end.toISOString()), `${date}: the ends`);
        assert(!(dow === 6 && count('YOM_TOV_ENDS') > 0) && !(dow !== 6 && (count('SHABBAT_ENDS') > 0 || count('SHABBAT_YOM_TOV_ENDS') > 0)), `${date}: an end of the wrong kind for a weekday ${dow}: ${show(keys.filter((k) => END_KEYS.includes(k)))}`);
        // "Not before": a rest day inside a window, neither a Friday nor the window's last day
        const inside = all.some(([start, end]) => dayOf(start) < date && date < dayOf(end));
        assert(count('CANDLE_LIGHTING_NOT_BEFORE') === (inside && dow !== 5 ? 1 : 0), `${date}: ${count('CANDLE_LIGHTING_NOT_BEFORE')} "not before" rows (inside a window: ${inside})`);
        if (inside && dow !== 5) assert(rowOf(list, 'CANDLE_LIGHTING_NOT_BEFORE').at === own.SHABBAT_ENDS!.toISOString(), `${date}: the day's own end`);
        if (dow === 6) assert(count('SHABBAT_ENDS') + count('SHABBAT_YOM_TOV_ENDS') + count('CANDLE_LIGHTING_NOT_BEFORE') === 1, `${date}: a Saturday carries ${show(keys.filter((k) => END_KEYS.includes(k) || k === 'CANDLE_LIGHTING_NOT_BEFORE'))}`);
      }
    });
  }

  await check('Yom Tov follows the place: Sukkot 2026 is one day in Israel (Shabbat and Yom Tov the 26th: "Shabbat and Yom Tov end", the 27th earns nothing) and two abroad (New York: the window runs to the Sunday the 27th, a Yom Tov\'s end, and the Saturday inside it lights the second day\'s candles "not before"), each the pause\'s window', async () => {
    seed();
    const israelSaturday = await listOf(TG.harish, '2026-09-26');
    const israelSunday = await listOf(TG.harish, '2026-09-27');
    assert(keysOf(israelSaturday).includes('SHABBAT_YOM_TOV_ENDS') && keysOf(israelSunday).length === SEPHARDI_ORDER.length, `Israel ${show(keysOf(israelSaturday).slice(-3))} ${keysOf(israelSunday).length}`);
    const friday = await listOf(TG.ny, '2026-09-25');
    const saturday = await listOf(TG.ny, '2026-09-26');
    const sunday = await listOf(TG.ny, '2026-09-27');
    const monday = await listOf(TG.ny, '2026-09-28');
    assert(keysOf(friday).includes('CANDLE_LIGHTING'), 'Friday');
    assert(!keysOf(saturday).some((k) => END_KEYS.includes(k) || k === 'CANDLE_LIGHTING') && keysOf(saturday).includes('CANDLE_LIGHTING_NOT_BEFORE'), `Saturday inside it ${show(keysOf(saturday))}`);
    assert(keysOf(sunday).includes('YOM_TOV_ENDS') && !keysOf(sunday).includes('SHABBAT_ENDS'), `Sunday ${show(keysOf(sunday))}`);
    assert(!keysOf(monday).some((k) => END_KEYS.includes(k) || k === 'CANDLE_LIGHTING' || k === 'CANDLE_LIGHTING_NOT_BEFORE'), `Monday ${show(keysOf(monday))}`);
    const windows = compute.shabbatYomTovWindows({ from: new Date('2026-09-25T00:00:00Z'), to: new Date('2026-09-29T00:00:00Z') }, NY_PLACE, 'sephardi');
    assert(windows.length === 1 && rowOf(friday, 'SHKIA').at === windows[0][0].toISOString() && rowOf(sunday, 'YOM_TOV_ENDS').at === windows[0][1].toISOString(), `windows ${show(windows)}`);
    assert(rowOf(friday, 'CANDLE_LIGHTING').at === compute.zmanimForDay('2026-09-25', NY_PLACE, 'sephardi').CANDLE_LIGHTING!.toISOString() && rowOf(friday, 'CANDLE_LIGHTING').at !== windows[0][0].toISOString(), 'New York: the Friday\'s candles are its own time, not the start');
    assertSame({ tz: friday.tz, evening: hm(rowOf(sunday, 'YOM_TOV_ENDS').at, NY) > '18:00' && hm(rowOf(sunday, 'YOM_TOV_ENDS').at, NY) < '20:30' }, { tz: NY, evening: true }, 'read on New York\'s clock');
  });

  // ================= The place =================

  await check('no saved place: the zone\'s main city (Jerusalem) stands in, source "zone", every row has a time, the instants are Jerusalem\'s own and differ from Harish\'s', async () => {
    seed();
    const list = await listOf(TG.plain, '2026-10-28');
    assertSame(list.place, { source: 'zone' }, 'the place');
    assert(rowsOf(list).every((r) => typeof r.at === 'string'), 'a time on every row');
    assertSame(keysOf(list), SEPHARDI_ORDER, 'the same set');
    const jerusalem = compute.zmanimForDay('2026-10-28', { latitude: 31.778, longitude: 35.235, elevationM: 754, timeZone: IL }, 'sephardi');
    assert(rowOf(list, 'SHKIA').at === jerusalem.SHKIA!.toISOString(), 'Jerusalem\'s sunset (hebcal\'s own list of cities)');
    assert(rowOf(list, 'NETZ').at !== rowOf(await listOf(TG.harish, '2026-10-28'), 'NETZ').at, 'not Harish\'s sunrise');
    assertSame(list.hours.map((h: Row) => h.opinion), ['gra', 'mga'], 'the hours');
  });

  await check('a place name with no coordinates yet does not hold the sheet up: it answers at once from the zone\'s main city (source "zone") while the lookup runs in the background, and the next time it has the saved place', async () => {
    seed();
    let release = () => {};
    heldNominatim = new Promise<void>((resolve) => { release = resolve; });
    try {
      const asked = get('date=2026-10-28', { tg: TG.zone });
      let answered = false;
      void asked.then(() => { answered = true; });
      for (let i = 0; i < 20 && !answered; i++) await new Promise((resolve) => setImmediate(resolve));
      assert(answered, 'the sheet waited for the place lookup');
      const reply = await asked;
      assert(reply.status === 200 && show(reply.body.place) === show({ source: 'zone' }), `${reply.status} ${show(reply.body.place)}`);
      assert(requests.length === 1, `the lookup started: ${requests.length} request(s)`);
    } finally {
      release();
    }
    const fills = (globalThis as Row).__zmanimPlaceFill;
    await fills.running.get(`${ID.zone}|Harish, Israel`);
    await new Promise((resolve) => setImmediate(resolve));
    const next = await listOf(TG.zone, '2026-10-28');
    assertSame(next.place, { source: 'saved', name: 'Harish, Israel' }, 'the next time');
    assert(atOf(next, 'SOF_SHMA_GRA') === '08:37', `Harish's Shema ${atOf(next, 'SOF_SHMA_GRA')}`);
  });

  await check('a zone with no main city and no saved place has nothing to count from: place null, no rows and no hours, still 200 (the sheet says so and points to Settings)', async () => {
    seed();
    const list = await listOf(TG.noCity, '2026-10-28');
    assertSame({ place: list.place, rows: list.rows, hours: list.hours, tz: list.tz, day: list.day, community: list.community }, { place: null, rows: [], hours: [], tz: 'Asia/Tokyo', day: '2026-10-28', community: 'sephardi' }, 'the empty answer');
  });

  // ================= Polar days =================

  await check('a day the sun does not make a zman is null, never a failure: Reykjavik in June (Ashkenazi) has a sunrise but no 16.1 or 8.5 degree dawn and nightfall, the rest are times', async () => {
    seed();
    const list = await listOf(TG.polar, '2026-06-21');
    assert(rowOf(list, 'ALOT').at === null && rowOf(list, 'TZEIT').at === null, 'no dawn, no nightfall');
    assert(typeof rowOf(list, 'NETZ').at === 'string' && typeof rowOf(list, 'SHKIA').at === 'string', 'a sunrise and a sunset');
    assert(keysOf(list).length === 13, `${keysOf(list).length} rows`);
    // The day has a sunrise and a sunset, so the GRA\'s hour exists; the Magen Avraham\'s day starts at the 16.1 degree dawn, which does not
    assert(typeof list.hours[0].ms === 'number' && list.hours[1].ms === null, `hours ${show(list.hours)}`);
    assert(consoleLines.some((l) => l.startsWith('[zmanim] no ')), 'the missing times are logged');
  });

  await check('a day with no sunrise or sunset at all (Svalbard in June): every row is null and the hour is null, still 200', async () => {
    seed();
    users.get(ID.polar)!.latitude = 78.22;
    users.get(ID.polar)!.longitude = 15.65;
    users.get(ID.polar)!.elevationM = 0;
    users.get(ID.polar)!.zmanimCommunity = 'sephardi';
    redisStore.set(`tz:user:${ID.polar}`, 'Arctic/Longyearbyen');
    const list = await listOf(TG.polar, '2026-06-21');
    assert(list.rows.length === SEPHARDI_ORDER.length && list.rows.every((r: Row) => r.at === null), `rows ${show(list.rows.filter((r: Row) => r.at !== null))}`);
    assertSame(list.hours, [{ opinion: 'gra', ms: null }, { opinion: 'mga', ms: null }], 'the hours');
  });

  // ================= The communities =================

  await check('Chabad: the Baal HaTanya\'s opinion on Shema and plag, one halachic hour (the Baal HaTanya\'s, no Magen Avraham), no second plag, no stricter nightfall', async () => {
    seed();
    const list = await listOf(TG.chabad, '2026-10-28');
    assertSame({ community: list.community, place: list.place }, { community: 'chabad', place: { source: 'saved', name: 'Jerusalem' } }, 'the header');
    assert(!keysOf(list).includes('SOF_SHMA_MGA') && !keysOf(list).includes('PLAG_YALKUT_YOSEF') && !keysOf(list).includes('TZEIT_LECHUMRA'), show(keysOf(list)));
    assert(rowOf(list, 'SOF_SHMA_GRA').opinion === 'baalHatanya' && rowOf(list, 'PLAG_GRA').opinion === 'baalHatanya', 'the opinions');
    assertSame(list.hours.map((h: Row) => h.opinion), ['baalHatanya'], 'one hour');
    assert(typeof list.hours[0].ms === 'number' && list.hours[0].ms > 50 * 60_000, `hour ${list.hours[0].ms}`);
  });

  await check('Ashkenazi: GRA plag, the GRA and Magen Avraham hours, and its own times (Bnei Brak, 8.5 degrees for nightfall)', async () => {
    seed();
    const list = await listOf(TG.ashkenazi, '2026-10-28');
    assert(keysOf(list).includes('PLAG_GRA') && !keysOf(list).includes('PLAG_HALACHA_BERURA'), show(keysOf(list)));
    assertSame(list.hours.map((h: Row) => h.opinion), ['gra', 'mga'], 'the hours');
    const direct = compute.zmanimForDay('2026-10-28', { latitude: 32.083, longitude: 34.833, elevationM: 40, timeZone: IL }, 'ashkenazi');
    for (const row of rowsOf(list)) assert(row.at === direct[row.key]!.toISOString(), `${row.key}`);
  });

  // ================= The request =================

  await check('no date is today in the person\'s zone; a date is read as that civil day in their zone (an instant near midnight in New York is its own day, not the server\'s)', async () => {
    seed();
    const bare = await get('', { tg: TG.harish });
    const today = wall.instantToWallTime(new Date(), IL).slice(0, 10);
    assert(bare.status === 200 && bare.body.day === today, `bare: ${bare.status} ${bare.body.day} (today ${today})`);
    const ny = await listOf(TG.ny, '2026-03-08');
    assert(ny.day === '2026-03-08' && hm(rowOf(ny, 'NETZ').at, NY) >= '06:00' && hm(rowOf(ny, 'NETZ').at, NY) <= '07:30', `New York on the change-of-clock day: sunrise ${hm(rowOf(ny, 'NETZ').at, NY)}`);
  });

  await check('a bad date is 400, private, and nothing is calculated: not a day (2026-02-30), not a date, a year before 1900 or after 2100', async () => {
    seed();
    for (const date of ['2026-02-30', 'tomorrow', '2026-1-05', '1899-12-31', '2101-01-01', '']) {
      const reply = await get(`date=${encodeURIComponent(date)}`);
      assert(reply.status === 400 && reply.body.error === 'bad_request' && reply.res.headers.get('cache-control') === NOT_STORED, `${show(date)}: ${reply.status} ${show(reply.body)}`);
    }
    for (const date of ['1900-01-01', '2100-12-31']) assert((await get(`date=${date}`)).status === 200, `${date} is allowed`);
  });

  await check('auth: no init data is 401 and private, another user\'s id is 401, no user_id is 400; nothing is counted and the limiter is keyed by the proved user', async () => {
    seed();
    rateChecks.length = 0;
    const none = await get('date=2026-10-28', { header: false });
    assert(none.status === 401 && none.res.headers.get('cache-control') === NOT_STORED && none.body.rows === undefined, `no init data: ${none.status} ${show(none.body)}`);
    assert(rateChecks.length === 0, 'a refused request was counted');
    const other = await get('date=2026-10-28', { tg: TG.plain, userId: ID.harish });
    assert(other.status === 401, `another user's id ${other.status}`);
    const missing = await route.GET(new NextRequest('http://localhost/api/zmanim?date=2026-10-28', { headers: { 'x-telegram-init-data': initDataFor(TG.harish) } }));
    assert(missing.status === 400, `no user_id ${missing.status}`);
    const query = await route.GET(new NextRequest(`http://localhost/api/zmanim?user_id=${TG.harish}&initData=${encodeURIComponent(initDataFor(TG.harish))}`));
    assert(query.status === 401, `init data in the query string (never read there) ${query.status}`);
    rateChecks.length = 0;
    await get('date=2026-10-28');
    assertSame(rateChecks, [`calendar:u${ID.harish}`], 'the limiter');
  });

  await check('a failure is reported and answered 500: a zone no clock knows throws inside the calculation, and the route captures it under zmanim-list with the user id only (no place, no name) and answers { error: "internal_error" }, private', async () => {
    seed();
    captured.length = 0;
    const reply = await get('date=2026-10-28', { tg: TG.boom });
    assert(reply.status === 500 && reply.body.error === 'internal_error' && reply.res.headers.get('cache-control') === NOT_STORED, `${reply.status} ${show(reply.body)}`);
    assert(captured.length >= 1 && captured.some((c) => c.ctx === 'zmanim-list'), `captured ${show(captured.map((c) => c.ctx))}`);
    const own = captured.find((c) => c.ctx === 'zmanim-list')!;
    assertSame(own.extra, { user_id: ID.boom }, 'the context');
    assert(!show(captured).includes('Nowhere'), 'the place name leaked into the report');
  });

  await check('server only: the route and the list module answer in the person\'s zone whatever the process zone is (the whole file is run under UTC, Asia/Jerusalem and America/New_York) and the instants are ISO strings', async () => {
    seed();
    const list = await listOf(TG.harish, '2026-10-28');
    assert(rowsOf(list).every((r) => typeof r.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(r.at)), 'ISO strings on whole minutes');
    assert(atOf(list, 'SOF_SHMA_GRA') === '08:37', `08:37 on the person's clock, process zone ${process.env.TZ}`);
  });

  restoreConsole();
  report();
}

function report(): void {
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.env[CHILD] !== '1') {
  void runChildren();
} else {
  runChecks().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

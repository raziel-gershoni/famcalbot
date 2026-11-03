// Smoke test for today's weather in the calendar home's header: homeWeatherOf (src/services/weather/home-weather.ts),
// GET /api/home-weather (app/api/home-weather/route.ts), the header's block (HomeHeader.tsx, CSS in home-shell.ts) and
// the client's request (src/lib/calendar-view/home-weather.ts). The home's wiring (when it asks, the midnight re-ask, the
// failure) is smoke-calendar-home-render.ts's #126w and #126x.
//
// What it pins:
//   a. homeWeatherOf: whole degrees (.5 rounds up, as Math.round does), never "-0", today's code for the icon and the
//      condition (in the language of the messages given), and the one icon mapping (weatherIconName);
//   b. the route: no place saved is { weather: null } with no zone or forecast call; a forecast answers exactly the five
//      keys, in the person's language (a locale of no app is English), with no place and no coordinates in the JSON, and
//      the forecast asked at the place's own zone; a forecast that throws is 502 { error: 'no_forecast' } and no console
//      line or captured field holds the place, the coordinates or the error's own message; no auth is 401;
//   c. HomeHeader in Hebrew (and the other languages): the role="img" block with its label, 22° and 15°–24° inside
//      <bdi dir="ltr">, the ghost while it loads, nothing for null or absent, the four buttons unchanged; the CSS;
//   d. fetchHomeWeather: an answer of another shape, a 502 and a network error read as `failed` and never throw.
// No network, no database, no Redis. Run with the fake env (scripts/ci-smokes.sh shows it):
//   npx tsx scripts/smoke-home-weather.ts

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

const ROOT = path.resolve(__dirname, '..');

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

type Locale = 'en' | 'he' | 'ru';
const messages: Record<Locale, Row> = {
  en: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8')),
  he: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/he.json'), 'utf8')),
  ru: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/ru.json'), 'utf8')),
};

// ---- Fakes: Prisma (the user table), Redis, error capture, the rate limiter, the zone and the forecast ----

// A place and coordinates that must never come out of the server in a log, a report or an answer.
const PLACE = 'Zzyzx Fakeplace';
const LAT = '12.3456';
const LON = '65.4321';
const SECRETS = [PLACE, 'Zzyzx', LAT, LON, '12.35', '65.43', '12.3', '65.4'];

const users = new Map<number, Row>();
const captured: { ctx: string; extra: Row | undefined; message: string }[] = [];
const consoleLines: string[] = [];
const zoneCalls: string[] = [];
const forecastCalls: { location: string; zone: string }[] = [];
let forecastFails: (() => unknown) | null = null;
let forecast: Row = {};
const PLACE_ZONE = 'Asia/Tokyo';

const fakePrisma = {
  user: {
    findUnique: async ({ where }: { where: Row }) => {
      const all = [...users.values()];
      const hit = where.telegramId !== undefined ? all.find((u) => u.telegramId === where.telegramId) : all.find((u) => u.id === where.id);
      return hit ? { ...hit } : null;
    },
    updateMany: async () => ({ count: 0 }),
  },
};

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
  put('src/utils/redis.ts', { redis: { get: async () => null, set: async () => 'OK', del: async () => 0 } });
  put('src/lib/error-capture.ts', {
    captureError: (e: unknown, ctx: string, extra?: Row) => { captured.push({ ctx, extra, message: e instanceof Error ? e.message : String(e) }); },
    captureWarning: (message: string, ctx: string, extra?: Row) => { captured.push({ ctx, extra, message }); },
    captureInfo: () => undefined,
  });
  put('src/lib/rate-limit.ts', {
    calendarRateLimiter: { name: 'calendar' },
    checkRateLimit: async () => ({ success: true, remaining: 19, reset: 0 }),
    getRateLimitHeaders: () => ({}),
  });
  put('src/services/weather/geocoding.ts', {
    getTimezone: async (location: string) => {
      zoneCalls.push(location);
      return PLACE_ZONE;
    },
    geocodeLocation: async () => { throw new Error('the geocode was used'); },
  });
  // The real forecast module for its names (describeWeather); only the request for the forecast is the fake.
  const real = nodeRequire(path.join(ROOT, 'src/services/weather/forecast.ts')) as Row;
  put('src/services/weather/forecast.ts', {
    ...real,
    fetchWeather: async (location: string, zone: string) => {
      forecastCalls.push({ location, zone });
      if (forecastFails) throw forecastFails();
      return forecast;
    },
  });
}

/** The parts of WeatherData the header reads. */
function weatherOf(o: { now: number; min: number; max: number; code: number; currentCode?: number }): Row {
  return {
    location: PLACE,
    current: { temperature: o.now, feelsLike: o.now, humidity: 50, weatherCode: o.currentCode ?? o.code, windSpeed: 5, windDirection: 90, uvIndex: 3 },
    today: { tempMax: o.max, tempMin: o.min, precipitation: 0, rainHours: [], weatherCode: o.code, sunrise: '', sunset: '', uvIndexMax: 5 },
  };
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

const TG = { withPlace: 2001, noPlace: 2002 };

function seed(): void {
  users.clear();
  captured.length = 0;
  consoleLines.length = 0;
  zoneCalls.length = 0;
  forecastCalls.length = 0;
  forecastFails = null;
  const base = {
    name: 'x', englishName: '', gender: 'male', language: 'he', latitude: null, longitude: null, elevationM: null, zmanimCommunity: 'sephardi',
    pauseOnShabbat: false, culture: 'jewish', messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null, calendarSource: 'NATIVE',
    pairingId: null, remindersEnabled: false, suspendedAt: null, unreachableSince: null, whatsappPhone: null, whatsappBsuid: null, isAdmin: false,
    globalRules: [], voiceInputEnabled: true, textSummaryEnabled: true, voiceSummaryEnabled: false,
    createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'),
  };
  // weatherEnabled false on purpose: the summaries' switch does not matter to the header
  users.set(1, { ...base, id: 1, telegramId: BigInt(TG.withPlace), location: PLACE, weatherEnabled: false });
  users.set(2, { ...base, id: 2, telegramId: BigInt(TG.noPlace), location: '', weatherEnabled: true });
}

// ---- Rendering ----

const TZ = 'Asia/Jerusalem';
const noop = () => undefined;
function inIntl(locale: Locale, el: ReactElement): ReactElement {
  const provider = { locale, messages: messages[locale], timeZone: TZ } as ComponentProps<typeof NextIntlClientProvider>;
  return createElement(NextIntlClientProvider, provider, el);
}

async function runChecks(): Promise<void> {
  installStubs();
  seed();
  const { NextRequest } = nodeRequire('next/server');
  const { homeWeatherOf } = (await import(path.join(ROOT, 'src/services/weather/home-weather.ts'))) as Row;
  const { weatherIconName } = (await import(path.join(ROOT, 'src/services/weather/weather-icons.tsx'))) as Row;
  const route = (await import(path.join(ROOT, 'app/api/home-weather/route.ts'))) as Row;
  const { HomeHeader } = (await import(path.join(ROOT, 'app/[locale]/(app)/dashboard/HomeHeader.tsx'))) as Row;
  const { HOME_SHELL_CSS } = (await import(path.join(ROOT, 'app/[locale]/(app)/dashboard/home-shell.ts'))) as Row;
  const client = (await import(path.join(ROOT, 'src/lib/calendar-view/home-weather.ts'))) as Row;
  const bot = (l: Locale) => messages[l].bot.weatherConditions as Record<string, string>;

  // The routes log; keep the output to the results, and keep what they write.
  const quiet = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    (console as Row)[level] = (...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')); };
  }
  const restoreConsole = () => Object.assign(console, quiet);

  // ================= a. homeWeatherOf =================

  await check('a. homeWeatherOf: whole degrees (21.6, 14.5 and 24.4 are 22, 15 and 24), -0.4 and -0.5 are 0 and never -0, the icon and the condition are today\'s code (not the current step\'s), the condition in the language of the messages', async () => {
    const he = (await import(path.join(ROOT, 'src/lib/bot-messages.ts'))).getBotMessages as (l: string) => Promise<Row>;
    const tHe = await he('he');
    const tEn = await he('en');
    const out = homeWeatherOf(weatherOf({ now: 21.6, min: 14.5, max: 24.4, code: 61, currentCode: 0 }), tHe);
    assert(show(Object.keys(out)) === show(['now', 'low', 'high', 'icon', 'condition']), `keys ${show(Object.keys(out))}`);
    assert(out.now === 22 && out.low === 15 && out.high === 24, `numbers ${show(out)}`);
    assert(out.icon === 'cloudRain', `today's code 61, not the current step's 0: ${out.icon}`);
    assert(out.condition === bot('he').rainSlight && out.condition !== bot('en').rainSlight, `condition ${out.condition}`);
    assert(homeWeatherOf(weatherOf({ now: 21.6, min: 1, max: 2, code: 61 }), tEn).condition === bot('en').rainSlight, 'English words');
    for (const cold of [-0.4, -0.5]) {
      const z = homeWeatherOf(weatherOf({ now: cold, min: cold, max: cold, code: 3 }), tHe);
      assert([z.now, z.low, z.high].every((n) => n === 0 && !Object.is(n, -0)), `${cold}: ${show([z.now, z.low, z.high])} / ${[z.now, z.low, z.high].map((n) => Object.is(n, -0))}`);
    }
    assert(homeWeatherOf(weatherOf({ now: -3.4, min: -7.6, max: -0.6, code: 71 }), tEn).low === -8, 'a real negative stays');
  });

  await check('a. the one icon mapping: 0 sun, 3 cloud and sun, 61 rain, 95 lightning, 71 snow, 45 fog, 85 snowflake, -1 flame (sharav); homeWeatherOf uses it', () => {
    const want: Record<number, string> = { 0: 'sun', 3: 'cloudSun', 45: 'cloudFog', 53: 'cloudDrizzle', 61: 'cloudRain', 71: 'cloudSnow', 81: 'cloudRainWind', 85: 'snowflake', 95: 'cloudLightning', [-1]: 'flame' };
    for (const [code, icon] of Object.entries(want)) assert(weatherIconName(Number(code)) === icon, `${code}: ${weatherIconName(Number(code))}`);
  });

  // ================= b. the route =================

  type Call = { tg?: number; header?: boolean };
  type Reply = { status: number; body: Row; text: string; res: Response };
  const get = async (qs: string, o: Call = {}): Promise<Reply> => {
    const tg = o.tg ?? TG.withPlace;
    const headers: Record<string, string> = o.header === false ? {} : { 'x-telegram-init-data': initDataFor(tg) };
    const res: Response = await route.GET(new NextRequest(`http://localhost/api/home-weather?user_id=${tg}${qs ? `&${qs}` : ''}`, { headers }));
    const text = await res.clone().text();
    let body: Row = {};
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body, text, res };
  };

  await check('b. no place saved: 200 { weather: null }, private and not stored, and no zone lookup and no forecast request (the summaries\' switch is ignored either way)', async () => {
    seed();
    const r = await get('locale=en', { tg: TG.noPlace });
    assert(r.status === 200 && show(r.body) === show({ weather: null }), `${r.status} ${r.text}`);
    assert(r.res.headers.get('cache-control') === 'private, no-store', `cache-control ${r.res.headers.get('cache-control')}`);
    assert(zoneCalls.length === 0 && forecastCalls.length === 0, `zone ${zoneCalls.length}, forecast ${forecastCalls.length}`);
  });

  await check('b. a place and a forecast: 200 with exactly now, low, high, icon, condition; the forecast is asked at the place\'s own zone; the answer holds no place name, latitude or longitude', async () => {
    seed();
    forecast = weatherOf({ now: 21.6, min: 14.5, max: 24.4, code: 0 });
    const r = await get('locale=he');
    assert(r.status === 200 && show(Object.keys(r.body)) === show(['weather']), `${r.status} ${r.text}`);
    assert(show(Object.keys(r.body.weather)) === show(['now', 'low', 'high', 'icon', 'condition']), `keys ${show(Object.keys(r.body.weather))}`);
    assert(r.body.weather.now === 22 && r.body.weather.low === 15 && r.body.weather.high === 24 && r.body.weather.icon === 'sun' && r.body.weather.condition === bot('he').clear, r.text);
    assert(r.res.headers.get('cache-control') === 'private, no-store', 'private');
    assert(zoneCalls.length === 1 && zoneCalls[0] === PLACE && forecastCalls.length === 1 && forecastCalls[0].location === PLACE && forecastCalls[0].zone === PLACE_ZONE, `calls ${show({ zoneCalls, forecastCalls })}`);
    assert(SECRETS.every((s) => !r.text.includes(s)), `the answer holds the place: ${r.text}`);
  });

  await check('b. the locale: en, he and ru are worded in their language; a locale of no app, or none, is English', async () => {
    seed();
    forecast = weatherOf({ now: 20, min: 10, max: 25, code: 3 });
    for (const [asked, want] of [['en', 'en'], ['he', 'he'], ['ru', 'ru'], ['xx', 'en'], ['', 'en'], ['HE', 'en'], ['../../etc', 'en']] as const) {
      const r = await get(asked === '' ? '' : `locale=${encodeURIComponent(asked)}`);
      assert(r.status === 200 && r.body.weather.condition === bot(want as Locale).overcast, `${show(asked)}: ${r.text}`);
    }
    assert(bot('en').overcast !== bot('he').overcast && bot('en').overcast !== bot('ru').overcast, 'the three words differ');
  });

  await check('b. a forecast that fails: 502 { error: "no_forecast" }, and no console line, report or captured field holds the place, the coordinates or the error\'s message (only the user id and what kind of failure)', async () => {
    seed();
    const poison = `MET failed for ${PLACE} at lat=${LAT} lon=${LON}: https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${LAT}&lon=${LON}`;
    const failures: [string, () => unknown][] = [
      ['an error with the place in its message', () => new Error(poison)],
      ['an HttpStatusError-like with a status and a poisoned message', () => Object.assign(new Error(poison), { name: 'HttpStatusError', status: 503 })],
      ['a thrown string', () => poison],
      ['a thrown object', () => ({ message: poison, url: poison })],
    ];
    for (const [what, make] of failures) {
      seed();
      forecastFails = make;
      const r = await get('locale=en');
      assert(r.status === 502 && show(r.body) === show({ error: 'no_forecast' }), `${what}: ${r.status} ${r.text}`);
      assert(r.res.headers.get('cache-control') === 'private, no-store', `${what}: private`);
      const everything = JSON.stringify({ consoleLines, captured: captured.map((c) => ({ ctx: c.ctx, extra: c.extra, message: c.message })) });
      assert(SECRETS.every((s) => !everything.includes(s)), `${what}: the place or a coordinate got out: ${everything.slice(0, 300)}`);
      assert(captured.length === 1 && captured[0].ctx === 'home-weather' && captured[0].extra?.user_id === 1, `${what}: reported ${show(captured)}`);
    }
    // The kind of failure is still there for the log
    seed();
    forecastFails = () => Object.assign(new Error(poison), { name: 'HttpStatusError', status: 503 });
    await get('locale=en');
    assert(/HttpStatusError 503/.test(captured[0].message), `the report names the failure: ${captured[0].message}`);
  });

  await check('b. a zone that cannot be found is the same failure (502, no forecast asked), and no auth is 401 with nothing asked', async () => {
    seed();
    // getTimezone rejecting: the place has no zone
    const geo = stubs[path.join(ROOT, 'src/services/weather/geocoding.ts')];
    const keep = geo.getTimezone;
    geo.getTimezone = async () => { throw new Error(`No time zone for ${PLACE}`); };
    try {
      const r = await get('locale=en');
      assert(r.status === 502 && show(r.body) === show({ error: 'no_forecast' }) && forecastCalls.length === 0, `${r.status} ${r.text} ${forecastCalls.length}`);
      assert(SECRETS.every((s) => !JSON.stringify({ consoleLines, captured }).includes(s)), 'the place got out');
    } finally {
      geo.getTimezone = keep;
    }
    seed();
    const anon = await get('locale=en', { header: false });
    assert(anon.status === 401 && zoneCalls.length === 0 && forecastCalls.length === 0, `no init data: ${anon.status} ${zoneCalls.length} ${forecastCalls.length}`);
  });

  // ================= c. the header =================

  const header = (locale: Locale, extra: Row) =>
    renderToString(inIntl(locale, createElement(HomeHeader, { today: null, hebrewDates: true, zone: null, sendOpen: false, menuOpen: false, onSend: noop, onMenu: noop, ...extra })));
  const WEATHER = { now: 22, low: 15, high: 24, icon: 'cloudSun', condition: 'מעונן חלקית' };
  const buttonLabels = (html: string) => [...html.matchAll(/<button[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);

  await check('c. HomeHeader in Hebrew with a weather: the role="img" block with the Hebrew label, 22° and 15°–24° each inside <bdi dir="ltr">, the visible parts aria-hidden, in the side column under the buttons, not tappable', () => {
    const html = header('he', { onAdd: noop, onZmanim: noop, weather: WEATHER });
    const block = /<div class="ch-head-weather" role="img" aria-label="([^"]*)">([\s\S]*?)<\/div>/.exec(html);
    assert(block, `no weather block: ${html.slice(-700)}`);
    assert(block[1] === 'מזג האוויר היום: מעונן חלקית. עכשיו 22°, בין 15° ל־24°', `label ${block[1]}`);
    assert(/<span class="ch-head-weather-now" aria-hidden="true"><svg[^>]*aria-hidden="true"[\s\S]*?<\/svg><bdi dir="ltr">22°<\/bdi><\/span>/.test(block[2]), `line 1: ${block[2]}`);
    assert(/<span class="ch-head-weather-range" aria-hidden="true"><bdi dir="ltr">15°–24°<\/bdi><\/span>/.test(block[2]), `line 2: ${block[2]}`);
    assert(!/<button|role="button"|onclick|tabindex/i.test(block[0]), 'not tappable');
    const side = html.indexOf('<div class="ch-head-side">');
    assert(side >= 0 && side < html.indexOf('<div class="ch-head-buttons">') && html.indexOf('<div class="ch-head-buttons">') < html.indexOf('class="ch-head-weather"'), 'the side column holds the buttons, then the weather');
    assert(/<\/div><div class="ch-head-weather"/.test(html), 'the block is under the buttons row, not inside it');
  });

  await check('c. the other languages: English and Russian labels with their words, the icon names map to icons (an unknown name is a cloud), a negative reads inside the ltr bdi', () => {
    for (const locale of ['en', 'ru'] as const) {
      const html = header(locale, { weather: { now: -3, low: -7, high: 1, icon: 'snowflake', condition: bot(locale).snowSlight } });
      const label = /role="img" aria-label="([^"]*)"/.exec(html)?.[1];
      const want = locale === 'en' ? `Weather today: ${bot('en').snowSlight}. Now -3°, from -7° to 1°` : `Погода сегодня: ${bot('ru').snowSlight}. Сейчас -3°, от -7° до 1°`;
      assert(label?.replace(/[‎‏−]/g, (c) => (c === '−' ? '-' : '')) === want, `${locale}: ${label}`);
      assert(/<bdi dir="ltr">[^<]*3°<\/bdi>/.test(html) && /<bdi dir="ltr">[^<]*7°[^<]*1°<\/bdi>/.test(html), `${locale}: ${html.slice(html.indexOf('ch-head-weather'))}`);
    }
    for (const icon of ['sun', 'cloudSun', 'cloudFog', 'cloudDrizzle', 'cloudRain', 'cloudSnow', 'cloudRainWind', 'snowflake', 'cloudLightning', 'flame', 'no-such-icon']) {
      const html = header('en', { weather: { ...WEATHER, icon } });
      assert(/<span class="ch-head-weather-now" aria-hidden="true"><svg[^>]*width="22"[^>]*height="22"/.test(html), `${icon}: ${html.slice(html.indexOf('ch-head-weather'), html.indexOf('ch-head-weather') + 300)}`);
    }
  });

  await check('c. loading is the ghost (two bars, aria-hidden, no label); null and absent show no weather markup at all; the four buttons are the same with and without a weather, and only the side column wraps them', () => {
    const loading = header('he', { weather: 'loading' });
    assert(/<div class="ch-head-weather-ghost" aria-hidden="true"><span class="ch-head-weather-ghost-now"><\/span><span class="ch-head-weather-ghost-range"><\/span><\/div>/.test(loading), `ghost: ${loading.slice(loading.indexOf('ch-head-weather'))}`);
    assert(!loading.includes('role="img"'), 'a label on the ghost');
    const bare = header('he', { onAdd: noop, onZmanim: noop });
    const nulled = header('he', { onAdd: noop, onZmanim: noop, weather: null });
    assert(bare === nulled && !bare.includes('ch-head-weather'), 'null is absent');
    const labels = messages.he.calendarHome.header;
    const want = [labels.add, labels.send, labels.zmanim, labels.menu];
    for (const html of [bare, header('he', { onAdd: noop, onZmanim: noop, weather: WEATHER }), loading.length ? header('he', { onAdd: noop, onZmanim: noop, weather: 'loading' }) : '']) {
      assert(show(buttonLabels(html)) === show(want), `buttons ${show(buttonLabels(html))}`);
    }
    // Without a weather the buttons row is the same markup as with one
    const withWeather = header('en', { onAdd: noop, onZmanim: noop, weather: WEATHER });
    const without = header('en', { onAdd: noop, onZmanim: noop });
    const row = (h: string) => /<div class="ch-head-buttons">[\s\S]*?<\/div>/.exec(h)?.[0];
    assert(row(withWeather) && row(withWeather) === row(without), 'the buttons row changed');
  });

  await check('c. the CSS: the side column is flex, column, end-aligned, gap 10 px and carries the wrap (flex: none, margin-inline-start: auto) the buttons row had; the block is 22 px / 600 / 1.25 over 14 px muted, tabular figures, logical properties only, nothing under 11 px; the ghost reuses the header\'s look and pulse (the theme\'s reduced-motion rule covers it)', () => {
    const rule = (selector: string): string => {
      const at = HOME_SHELL_CSS.lastIndexOf(`\n${selector} {`);
      assert(at >= 0, `no rule ${selector}`);
      return HOME_SHELL_CSS.slice(at, HOME_SHELL_CSS.indexOf('}', at));
    };
    const side = rule('.ch-head-side');
    assert(/display: flex;/.test(side) && /flex: none;/.test(side) && /flex-direction: column;/.test(side) && /align-items: flex-end;/.test(side) && /gap: 10px;/.test(side) && /margin-inline-start: auto;/.test(side), side);
    const buttons = rule('.ch-head-buttons');
    assert(!/flex: none|margin-inline-start/.test(buttons) && /display: flex;/.test(buttons) && /gap: 8px;/.test(buttons), buttons);
    assert(/font-variant-numeric: tabular-nums/.test(HOME_SHELL_CSS) && /align-items: flex-end/.test(rule('.ch-head-weather,\n.ch-head-weather-ghost')), 'tabular, end-aligned');
    const now = rule('.ch-head-weather-now');
    assert(/font-size: 22px;/.test(now) && /font-weight: 600;/.test(now) && /line-height: 1.25;/.test(now) && /color: var\(--ch-text\);/.test(now), now);
    const range = rule('.ch-head-weather-range');
    assert(/font-size: 14px;/.test(range) && /color: var\(--ch-muted\);/.test(range), range);
    assert(/\.ch-head-weather-now svg \{[^}]*color: var\(--ch-muted\)/.test(HOME_SHELL_CSS), 'the icon is muted');
    const ghost = rule('.ch-head-weather-ghost-now,\n.ch-head-weather-ghost-range');
    assert(/background: var\(--ch-surface\);/.test(ghost) && /animation: ch-pulse 1\.4s ease-in-out infinite;/.test(ghost), ghost);
    assert(/block-size: 22px;\s*inline-size: 64px;/.test(rule('.ch-head-weather-ghost-now')) && /block-size: 14px;\s*inline-size: 48px;/.test(rule('.ch-head-weather-ghost-range')), 'the bars');
    const weatherCss = HOME_SHELL_CSS.slice(HOME_SHELL_CSS.indexOf('.ch-head-side'), HOME_SHELL_CSS.indexOf('.ch-banners'));
    assert(!/(margin|padding)-(left|right)|(?:^|[\s;{])(left|right)\s*:|text-align:\s*(left|right)/.test(weatherCss), 'a physical property');
    assert([...weatherCss.matchAll(/font-size:\s*(\d+)px/g)].every((m) => Number(m[1]) >= 11), 'text under 11 px');
    const theme = fs.readFileSync(path.join(ROOT, 'components/app-ui/theme.ts'), 'utf8');
    assert(/@media \(prefers-reduced-motion: reduce\) \{\s*\.ch-app \*,[\s\S]*?animation: none !important;/.test(theme), 'the theme\'s reduced-motion rule is gone');
  });

  await check('c. client-safe: the header, the home and the client module import nothing from src/services, and the icon names are the server\'s (every WeatherIconName has a lucide icon in the header)', () => {
    for (const rel of ['src/lib/calendar-view/home-weather.ts', 'app/[locale]/(app)/dashboard/HomeHeader.tsx', 'app/[locale]/(app)/dashboard/CalendarHome.tsx']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert(!/from '(?:@\/src|\.\.?(?:\/\.\.)*\/src)\/services\/|from '(?:\.\.\/)+services\//.test(src), `${rel} imports a service`);
    }
    const icons = fs.readFileSync(path.join(ROOT, 'src/services/weather/weather-icons.tsx'), 'utf8');
    const union = /export type WeatherIconName =([^;]*);/.exec(icons)?.[1] ?? '';
    const names = [...union.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    assert(names.length === 10, `${names.length} names`);
    const headerSrc = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/dashboard/HomeHeader.tsx'), 'utf8');
    for (const name of names) assert(new RegExp(`\\b${name}: \\w+,`).test(headerSrc), `${name} has no icon in the header`);
  });

  // ================= d. the client's request =================

  const realFetch = globalThis.fetch;
  const sent: { url: string; init: Row }[] = [];
  const answer = (status: number, body: unknown, json = true) => (async (input: unknown, init: Row = {}) => {
    sent.push({ url: String(input), init });
    return { status, ok: status >= 200 && status < 300, json: async () => { if (!json) throw new SyntaxError('not JSON'); return body; } } as unknown as Response;
  }) as typeof fetch;

  await check('d. fetchHomeWeather: the request (GET, user_id and locale in the query, same-origin, no-store), an answer in the right shape is ok, { weather: null } is ok with no weather; an answer of another shape, a 502, a body that is not JSON and a network error are `failed`, and none throws', async () => {
    try {
      globalThis.fetch = answer(200, { weather: { now: 22, low: 15, high: 24, icon: 'sun', condition: 'Clear' } });
      const ok = await client.fetchHomeWeather(77, 'he');
      assert(ok.kind === 'ok' && ok.weather?.now === 22, show(ok));
      const call = sent[0];
      assert(call.url === '/api/home-weather?user_id=77&locale=he' && call.init.method === 'GET' && call.init.credentials === 'same-origin' && call.init.cache === 'no-store', show(call));
      globalThis.fetch = answer(200, { weather: null });
      assert(show(await client.fetchHomeWeather(77, 'en')) === show({ kind: 'ok', weather: null }), 'no place');
      const failedWith = async (f: typeof fetch) => {
        globalThis.fetch = f;
        return client.fetchHomeWeather(77, 'en');
      };
      const bad: [string, typeof fetch, unknown][] = [
        ['a string for a number', answer(200, { weather: { now: 'warm', low: 1, high: 2, icon: 'sun', condition: 'x' } }), { kind: 'failed', status: 200 }],
        ['a fraction', answer(200, { weather: { now: 21.5, low: 1, high: 2, icon: 'sun', condition: 'x' } }), { kind: 'failed', status: 200 }],
        ['a missing key', answer(200, { weather: { now: 1, low: 1, high: 2, icon: 'sun' } }), { kind: 'failed', status: 200 }],
        ['no weather key', answer(200, { forecast: 1 }), { kind: 'failed', status: 200 }],
        ['an array', answer(200, []), { kind: 'failed', status: 200 }],
        ['a 502', answer(502, { error: 'no_forecast' }), { kind: 'failed', status: 502 }],
        ['a 401', answer(401, { error: 'unauthorized' }), { kind: 'failed', status: 401 }],
        ['not JSON', answer(200, null, false), { kind: 'failed', status: 200 }],
        ['a network error', (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch, { kind: 'failed', status: null }],
      ];
      for (const [what, f, want] of bad) {
        const got = await failedWith(f);
        assert(show(got) === show(want), `${what}: ${show(got)}`);
      }
      assert(client.REAL_HOME_WEATHER.load === client.fetchHomeWeather, 'REAL_HOME_WEATHER');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  restoreConsole();
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

runChecks().catch((err) => {
  console.error(err);
  process.exit(1);
});

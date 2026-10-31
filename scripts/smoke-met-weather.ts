// Smoke test for the forecast on MET Norway (src/services/weather/forecast.ts; plan
// docs/superpowers/plans/2026-10-31-open-meteo-replacement.md, Task 3): the 41 symbols, the units, a real Tel Aviv
// answer mapped onto Israel's days, UTC to the place's wall clock across both clock changes, the days in the place's own
// zone, MET's rules (User-Agent, 2 decimals, Expires, If-Modified-Since), the retries, Redis down, and the holes a real
// answer has. Faked: Redis (in memory), error capture, the geocoder, fetch (scenarios), the waits and the jitter
// (fetch-retry.ts's test seam; the loop itself is pinned by smoke-fetch-retry.ts) and the clock (forecast.ts's test
// seam). @hebcal/core runs for the sun times. No network.
//
// Run under both clocks:
//   TZ=UTC npx tsx scripts/smoke-met-weather.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-met-weather.ts

import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

type Row = Record<string, unknown>;

// A check that never settles would let Node drain its event loop and exit 0 in silence: that must read as a failure.
let reported = false;
process.on('exit', () => {
  if (!reported) {
    console.error('FAIL  the smoke ended before its checks did (a promise that never settled)');
    process.exitCode = 1;
  }
});
const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
const results: { name: string; ok: boolean; reason?: string }[] = [];
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

// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-weather-command.ts): point it at its ESM build.
const internals = Module as unknown as {
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
  _cache: Record<string, unknown>;
};
const resolveFilename = internals._resolveFilename;
internals._resolveFilename = function (request, parent, isMain) {
  if (request === '@hebcal/core') return path.join(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, parent, isMain);
};

// ---- Fakes ----

const redisStore = new Map<string, unknown>();
let redisDown = false;
const fakeRedis = {
  get: async (key: string) => {
    if (redisDown) throw new Error('redis down');
    return redisStore.has(key) ? structuredClone(redisStore.get(key)) : null;
  },
  set: async (key: string, value: unknown) => {
    if (redisDown) throw new Error('redis down');
    redisStore.set(key, structuredClone(value));
    return 'OK';
  },
};
/** What the app sent to Sentry: through captureError (an exception, with its severity) or captureWarning (a message). */
const captured: { kind: 'error' | 'warning'; severity: string; context: string; message: string; extra: string }[] = [];

const requests: { url: string; headers: Record<string, string>; signal: unknown }[] = [];
// Read through functions: TypeScript narrows a `.length` an earlier assert compared, and a later comparison to another
// number would not compile.
const nRequests = () => requests.length;
const nCaptured = () => captured.length;
const nOf = (list: readonly unknown[]) => list.length;
let answer: (n: number) => Response = () => { throw new Error('no scenario'); };
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  requests.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), signal: init?.signal });
  return answer(requests.length);
}) as typeof fetch;

const MET_TLV = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/met-tel-aviv.json'), 'utf8'));
const LAST_MODIFIED = 'Sat, 31 Oct 2026 17:17:31 GMT';
const metOk = (body: unknown, expires = 'Sat, 31 Oct 2026 18:00:00 GMT') =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', expires, 'last-modified': LAST_MODIFIED } });

/** The clock and the waits forecast.ts reads through its seam. */
let clock = Date.parse('2026-10-31T17:30:00Z');
const waits: number[] = [];

function reset(): void {
  redisStore.clear();
  redisDown = false;
  requests.length = 0;
  waits.length = 0;
  captured.length = 0;
  clock = Date.parse('2026-10-31T17:30:00Z');
}

function installStubs(): void {
  const stub = (rel: string, exports: Row) => {
    const filename = path.join(ROOT, rel);
    const mod = new (Module as unknown as new (id: string) => Row)(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    internals._cache[filename] = mod;
  };
  stub('src/utils/redis.ts', { redis: fakeRedis });
  stub('src/lib/error-capture.ts', {
    // captureError's 4th argument is the severity (default 'error'): kept, so a check can tell a warning from an error
    captureError: (e: unknown, context: string, extra?: Row, severity: string = 'error') => { captured.push({ kind: 'error', severity, context, message: e instanceof Error ? e.message : String(e), extra: JSON.stringify(extra ?? {}) }); },
    captureWarning: (message: string, context: string, extra?: Row) => { captured.push({ kind: 'warning', severity: 'warning', context, message, extra: JSON.stringify(extra ?? {}) }); },
    captureInfo: () => {},
  });
  stub('src/services/weather/geocoding.ts', {
    geocodeLocation: async () => ({ latitude: 32.0853, longitude: 34.7818, timezone: 'Asia/Jerusalem' }),
  });
}

/** A step of MET's answer: an hour of fine weather unless the scenario says otherwise. */
const step = (time: string, over: { temperature?: number; mm?: number; symbol?: string } = {}) => ({
  time,
  data: {
    instant: { details: { air_temperature: over.temperature ?? 20, apparent_air_temperature: over.temperature ?? 20, relative_humidity: 50, wind_speed: 2, wind_from_direction: 90, ultraviolet_index_clear_sky: 1 } },
    next_1_hours: { summary: { symbol_code: over.symbol ?? 'clearsky_day' }, details: { precipitation_amount: over.mm ?? 0 } },
  },
});
const body = (...steps: unknown[]) => ({ type: 'Feature', properties: { timeseries: steps } });

async function main(): Promise<void> {
  installStubs();
  const met = nodeRequire(path.join(ROOT, 'src/services/weather/forecast.ts')) as typeof import('../src/services/weather/forecast');
  const retry = nodeRequire(path.join(ROOT, 'src/utils/fetch-retry.ts')) as typeof import('../src/utils/fetch-retry');
  met.__useMetForTests({ now: () => clock });
  retry.__useRetryForTests({ now: () => clock, sleep: async (ms: number) => { waits.push(ms); }, random: () => 0.5 });
  const warnings: string[] = [];
  const map = (forecast: unknown, timezone = 'Asia/Jerusalem', now = new Date(clock)) =>
    met.mapMetForecast({ location: 'Tel Aviv', forecast: forecast as never, timezone, now, sun: met.sunFor(32.0853, 34.7818, timezone), warn: m => warnings.push(m) });

  await check('the 41 symbols of MET\'s legend each map to a WMO code FamCal draws, with their _day, _night and _polartwilight forms and MET\'s two "lightss" spellings; an unknown one is shown as overcast with one warning naming it', () => {
    const legend = Object.keys(met.MET_SYMBOLS);
    assert(legend.length === 41, `${legend.length} symbols`);
    const drawn = new Set([0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]);
    const warn: string[] = [];
    for (const symbol of legend) {
      const code = met.wmoForSymbol(symbol, m => warn.push(m));
      assert(drawn.has(code), `${symbol} -> ${code}`);
      for (const variant of ['_day', '_night', '_polartwilight']) assert(met.wmoForSymbol(symbol + variant, m => warn.push(m)) === code, `${symbol}${variant}`);
    }
    assert(met.wmoForSymbol('lightssleetshowersandthunder', m => warn.push(m)) === 95 && met.wmoForSymbol('lightssnowshowersandthunder_day', m => warn.push(m)) === 95, 'the lightss spellings');
    const spot: Record<string, number> = { clearsky_day: 0, fair_night: 1, partlycloudy_day: 2, cloudy: 3, fog: 45, lightrain: 61, rain: 63, heavyrain: 65, lightrainshowers_day: 80, rainshowers_night: 81, heavyrainshowers_day: 82, lightsleet: 66, heavysleet: 67, lightsnow: 71, snow: 73, heavysnow: 75, snowshowers_day: 85, heavysnowshowers_day: 86, rainandthunder: 95 };
    for (const [symbol, code] of Object.entries(spot)) assert(met.wmoForSymbol(symbol, m => warn.push(m)) === code, `${symbol} -> ${met.wmoForSymbol(symbol, () => {})}, want ${code}`);
    assert(nOf(warn) === 0, `warnings ${show(warn)}`);
    assert(met.wmoForSymbol('purplerain_day', m => warn.push(m)) === 3 && nOf(warn) === 1 && warn[0].includes('purplerain_day'), `unknown: ${show(warn)}`);
  });

  await check('MET\'s Tel Aviv answer at 17:30 UTC on 2026-10-31 (19:30 in Israel): the units (m/s to km/h), the current hour, nine days from today in Israel\'s days, the clear-sky UV gone after about 2.5 days, the rain of 6-hour steps', () => {
    warnings.length = 0;
    const w = map(MET_TLV);
    assert(show(w.current) === show({ temperature: 23, feelsLike: 23, humidity: 66, weatherCode: 1, windSpeed: 19, windDirection: 7, uvIndex: 0 }), `current ${show(w.current)}`);
    assert(w.hourly!.time[0] === '2026-10-31T19:00' && w.hourly!.time.length === 88, `hourly ${w.hourly!.time[0]} x${w.hourly!.time.length}`);
    assert(show(w.daily!.map(d => d.date)) === show(['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']), `days ${show(w.daily!.map(d => d.date))}`);
    const nov1 = w.daily![1];
    assert(nov1.tempMax === 25 && nov1.tempMin === 17 && nov1.uvIndexMax === 5.1 && nov1.windSpeedMax === 14 && nov1.humidity === 71 && nov1.weatherCode === 2 && nov1.precipitation === 0 && nov1.rainHours.length === 0, `1 Nov ${show(nov1)}`);
    const nov3 = w.daily![3];
    assert(nov3.tempMax === 26 && nov3.tempMin === 20 && nov3.precipitation === 0.8 && nov3.weatherCode === 80 && nov3.uvIndexMax === 1.2 && show(nov3.rainHours) === show([{ start: '20:00', end: '24:00', mm: 0.8 }]), `3 Nov ${show(nov3)}`);
    assert(w.daily!.slice(4).every(d => d.uvIndexMax === null), `UV past 2.5 days ${show(w.daily!.map(d => d.uvIndexMax))}`);
    assert(show(w.daily![5].rainHours) === show([{ start: '08:00', end: '14:00', mm: 0.2 }, { start: '20:00', end: '24:00', mm: 0.1 }]), `5 Nov ${show(w.daily![5].rainHours)}`);
    assert(w.today.tempMax === 23 && w.today.tempMin === 20 && w.today.uvIndexMax === 0 && w.tomorrow?.tempMax === 25, `today ${show(w.today)}, tomorrow ${show(w.tomorrow)}`);
    // Israel is on winter time (UTC+2) since 25 Oct: sunrise about 05:56, sunset about 16:52
    assert(/^2026-10-31T05:5\d$/.test(w.today.sunrise) && /^2026-10-31T16:[45]\d$/.test(w.today.sunset), `sun ${w.today.sunrise} ${w.today.sunset}`);
    assert(warnings.length === 0, `warnings ${show(warnings)}`);
  });

  await check('[6-hour rain] a day that rains in every 6-hour step reads 02:00–24:00 with its total, never 02:00–02:00', () => {
    const w = map(MET_TLV);
    assert(w.daily![6].precipitation === 4.5 && show(w.daily![6].rainHours) === show([{ start: '02:00', end: '24:00', mm: 4.5 }]), `6 Nov ${show(w.daily![6])}`);
    assert(w.daily![7].precipitation === 9.9 && show(w.daily![7].rainHours) === show([{ start: '02:00', end: '24:00', mm: 9.9 }]), `7 Nov ${show(w.daily![7])}`);
  });

  await check('UTC to Israel\'s wall clock across both clock changes: the autumn night repeats 01:00 (one rain spell over both, 01:00–02:00), the spring night skips 02:00', () => {
    const autumn = map(body(step('2026-10-24T21:00:00Z'), step('2026-10-24T22:00:00Z', { mm: 0.4 }), step('2026-10-24T23:00:00Z', { mm: 0.6 }), step('2026-10-25T00:00:00Z')), 'Asia/Jerusalem', new Date('2026-10-24T21:30:00Z'));
    assert(show(autumn.hourly!.time) === show(['2026-10-25T00:00', '2026-10-25T01:00', '2026-10-25T01:00', '2026-10-25T02:00']), `autumn ${show(autumn.hourly!.time)}`);
    assert(show(autumn.today.rainHours) === show([{ start: '01:00', end: '02:00', mm: 1 }]), `autumn rain ${show(autumn.today.rainHours)}`);
    const spring = map(body(step('2026-03-26T23:00:00Z'), step('2026-03-27T00:00:00Z'), step('2026-03-27T01:00:00Z')), 'Asia/Jerusalem', new Date('2026-03-26T23:10:00Z'));
    assert(show(spring.hourly!.time) === show(['2026-03-27T01:00', '2026-03-27T03:00', '2026-03-27T04:00']), `spring ${show(spring.hourly!.time)}`);
  });

  await check('the days are the place\'s own: the same ten UTC hours are 31 Oct 22:00 to 1 Nov 07:00 in Israel and 31 Oct 16:00 to 1 Nov 01:00 in New York, and each zone\'s highs follow its own midnight', () => {
    const steps = Array.from({ length: 10 }, (_, i) => step(new Date(Date.parse('2026-10-31T20:00:00Z') + i * 3_600_000).toISOString().replace('.000', ''), { temperature: i }));
    const israel = map(body(...steps), 'Asia/Jerusalem', new Date('2026-10-31T20:10:00Z'));
    const newYork = map(body(...steps), 'America/New_York', new Date('2026-10-31T20:10:00Z'));
    assert(show(israel.daily!.map(d => [d.date, d.tempMin, d.tempMax])) === show([['2026-10-31', 0, 1], ['2026-11-01', 2, 9]]), `Israel ${show(israel.daily!.map(d => [d.date, d.tempMin, d.tempMax]))}`);
    assert(show(newYork.daily!.map(d => [d.date, d.tempMin, d.tempMax])) === show([['2026-10-31', 0, 7], ['2026-11-01', 8, 9]]), `New York ${show(newYork.daily!.map(d => [d.date, d.tempMin, d.tempMax]))}`);
  });

  await check('the coordinates MET gets: 2 decimals, never "-0.00"', () => {
    assert(met.roundedCoordinate(32.0853) === '32.09' && met.roundedCoordinate(-74.006) === '-74.01' && met.roundedCoordinate(-0.004) === '0.00' && met.roundedCoordinate(51.5) === '51.50', 'rounding');
  });

  await check('MET\'s rules: one request with FamCal\'s User-Agent, the place at 2 decimals and no timeout of our own; none while the answer is fresh (Expires); after it, If-Modified-Since with its Last-Modified, and a 304 keeps the stored answer with its new Expires; one Redis key per rounded place', async () => {
    reset();
    answer = () => metOk(MET_TLV, 'Sat, 31 Oct 2026 18:00:00 GMT');
    const first = await met.fetchWeather('Tel Aviv', 'Asia/Jerusalem');
    assert(nRequests() === 1, `${nRequests()} requests`);
    const url = new URL(requests[0].url);
    assert(url.origin + url.pathname === 'https://api.met.no/weatherapi/locationforecast/2.0/complete' && url.searchParams.get('lat') === '32.09' && url.searchParams.get('lon') === '34.78' && [...url.searchParams.keys()].length === 2, `url ${requests[0].url}`);
    assert(requests[0].headers['user-agent'] === 'FamCal/1.0 (+https://famcal.bot)' && !('if-modified-since' in requests[0].headers), `headers ${show(requests[0].headers)}`);
    assert(requests[0].signal === undefined, 'the request carries a signal: a timeout of our own');
    assert(show([...redisStore.keys()]) === show(['weather:met:32.09,34.78']), `keys ${show([...redisStore.keys()])}`);
    clock = Date.parse('2026-10-31T17:59:00Z');
    await met.fetchWeather('Tel Aviv', 'Asia/Jerusalem');
    assert(nRequests() === 1, 'asked MET again before Expires');
    clock = Date.parse('2026-10-31T18:01:00Z');
    answer = () => new Response(null, { status: 304, headers: { expires: 'Sat, 31 Oct 2026 18:30:00 GMT' } });
    const again = await met.fetchWeather('Tel Aviv', 'Asia/Jerusalem');
    assert(nRequests() === 2 && requests[1].headers['if-modified-since'] === LAST_MODIFIED, `refetch headers ${show(requests[1]?.headers)}`);
    assert(again.daily!.length === first.daily!.length, 'the 304 lost the stored answer');
    clock = Date.parse('2026-10-31T18:20:00Z');
    await met.fetchWeather('Tel Aviv', 'Asia/Jerusalem');
    assert(nRequests() === 2, 'the 304\'s new Expires was not kept');
    assert(nCaptured() === 0, `captured ${show(captured)}`);
  });

  await check('retries (through the shared loop, src/utils/fetch-retry.ts): a 503 then 200 waits once (backoff) and answers; a 429 waits its Retry-After; no answer (a network error) is retried; four 503s give up after 3 retries; a 429 asking over 10 s and a 403 are not retried; each failure is logged once under weather-forecast as a warning, with its status and no place or coordinates, and fetchWeather throws', async () => {
    const run = async (answers: Array<Response | Error>): Promise<'ok' | 'threw'> => {
      reset();
      answer = n => {
        const a = answers[Math.min(n, answers.length) - 1];
        if (a instanceof Error) throw a;
        return a.clone();
      };
      try {
        await met.fetchWeather('Tel Aviv', 'Asia/Jerusalem');
        return 'ok';
      } catch {
        return 'threw';
      }
    };
    const status = (s: number, headers: Record<string, string> = {}) => new Response('busy', { status: s, headers });
    const loggedOnce = (want: { status: number; retried: number }): string | null => {
      if (nCaptured() !== 1) return `${nCaptured()} captured: ${show(captured)}`;
      const c = captured[0];
      if (c.context !== 'weather-forecast' || c.severity !== 'warning') return `context ${c.context}, severity ${c.severity}`;
      const extra = JSON.parse(c.extra) as Row;
      if (extra.status !== want.status || extra.retried !== want.retried) return `extra ${c.extra}`;
      if (/Tel Aviv|32\.0|34\.7|34\.78|32\.09/.test(c.message + c.extra)) return `a place or its coordinates reached Sentry: ${c.message} ${c.extra}`;
      return null;
    };
    assert(await run([status(503), metOk(MET_TLV)]) === 'ok' && nRequests() === 2 && show(waits) === show([250]) && nCaptured() === 0, `503 then 200: ${nRequests()} requests, waits ${show(waits)}, captured ${show(captured)}`);
    assert(await run([status(429, { 'retry-after': '2' }), metOk(MET_TLV)]) === 'ok' && show(waits) === show([2000]), `429 Retry-After 2: waits ${show(waits)}`);
    assert(await run([new TypeError('fetch failed'), metOk(MET_TLV)]) === 'ok' && nRequests() === 2, `network error: ${nRequests()} requests`);
    assert(await run([status(503), status(503), status(503), status(503)]) === 'threw' && nRequests() === 4 && show(waits) === show([250, 500, 1000]), `4 x 503: ${nRequests()} requests, waits ${show(waits)}`);
    assert(loggedOnce({ status: 503, retried: 3 }) === null, `4 x 503 logged: ${loggedOnce({ status: 503, retried: 3 })}`);
    assert(await run([status(429, { 'retry-after': '60' })]) === 'threw' && nRequests() === 1 && waits.length === 0, `429 Retry-After 60: ${nRequests()} requests, waits ${show(waits)}`);
    assert(loggedOnce({ status: 429, retried: 0 }) === null, `429 Retry-After 60 logged: ${loggedOnce({ status: 429, retried: 0 })}`);
    assert(await run([status(403)]) === 'threw' && nRequests() === 1 && waits.length === 0, `403: ${nRequests()} requests`);
    assert(loggedOnce({ status: 403, retried: 0 }) === null, `403 logged: ${loggedOnce({ status: 403, retried: 0 })}`);
    assert(await run([new TypeError('fetch failed')]) === 'threw' && nRequests() === 4, `4 x no answer: ${nRequests()} requests`);
  });

  await check('Redis down: the forecast still comes, straight from MET, and both Redis failures (the read, the write) are logged to Sentry as warnings', async () => {
    reset();
    redisDown = true;
    answer = () => metOk(MET_TLV);
    const w = await met.fetchWeather('Tel Aviv', 'Asia/Jerusalem');
    redisDown = false;
    assert(w.daily!.length === 9 && nRequests() === 1, `days ${w.daily?.length}, requests ${nRequests()}`);
    const redisFailures = captured.filter(c => c.context === 'weather-forecast' && c.kind === 'error' && c.severity === 'warning');
    assert(redisFailures.length === 2 && nCaptured() === 2, `captured ${show(captured)}`);
    assert(show(redisFailures.map(c => JSON.parse(c.extra).step)) === show(['cache-read', 'cache-write']), `steps ${show(redisFailures.map(c => c.extra))}`);
  });

  await check('[gaps] a forecast with holes (no UV after about 2.5 days, a last step with no period, a step without humidity, an unknown symbol, no apparent temperature) maps with no NaN, Infinity or undefined anywhere; the bad step is dropped with one warning', () => {
    const holes = structuredClone(MET_TLV);
    const series = holes.properties.timeseries as Array<{ data: { instant: { details: Row }; next_1_hours?: { summary: { symbol_code: string } } } }>;
    delete series[3].data.instant.details.relative_humidity;
    series[5].data.next_1_hours!.summary.symbol_code = 'purplerain_day';
    for (const s of series) delete s.data.instant.details.apparent_air_temperature;
    warnings.length = 0;
    const w = map(holes);
    const bad: string[] = [];
    const walk = (v: unknown, at: string): void => {
      if (v === undefined || (typeof v === 'number' && !Number.isFinite(v))) bad.push(at);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
    };
    walk(w, 'weather');
    assert(bad.length === 0, `not numbers: ${show(bad.slice(0, 10))}`);
    assert(w.hourly!.time.length === 87, `${w.hourly!.time.length} steps kept`);
    assert(w.current.feelsLike === w.current.temperature, 'feels like without the apparent temperature');
    assert(warnings.length === 2 && warnings.some(m => m.includes('purplerain_day')) && warnings.some(m => m.includes('1 step')), `warnings ${show(warnings)}`);
  });

  await check('[polar] where the sun does not rise that day (Murmansk, 20 Dec) sunrise and sunset are empty; Tel Aviv at midsummer has both, in Israel\'s summer time', () => {
    const polar = met.sunFor(68.97, 33.08, 'Europe/Moscow')('2026-12-20');
    assert(polar.sunrise === '' && polar.sunset === '', `Murmansk ${show(polar)}`);
    const summer = met.sunFor(32.0853, 34.7818, 'Asia/Jerusalem')('2026-06-21');
    assert(/^2026-06-21T05:[2-4]\d$/.test(summer.sunrise) && /^2026-06-21T19:[4-5]\d$/.test(summer.sunset), `Tel Aviv midsummer ${show(summer)}`);
  });

  await check('a forecast with no step for today at the place, or no timeseries, is refused (the caller logs it), never shown as today', () => {
    let refused = 0;
    for (const bad of [body(step('2026-11-05T10:00:00Z')), { properties: {} }]) {
      try { map(bad); } catch { refused++; }
    }
    assert(refused === 2, `${refused} of 2 refused`);
  });

  reported = true;
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

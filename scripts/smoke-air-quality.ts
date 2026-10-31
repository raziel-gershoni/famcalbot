// Smoke test for the dust alerts' air quality from Open-Meteo's open data on S3 (src/services/weather/air-quality.ts;
// plan docs/superpowers/plans/2026-10-31-open-meteo-replacement.md, Task 4; the dust spike's rulings R1-R8). The real
// reader (@openmeteo/file-reader and its WebAssembly) reads S3 exchanges recorded once for Tel Aviv
// (scripts/fixtures/cams-tel-aviv.json, by scripts/record-cams-fixture.ts) and replayed through a mocked fetch: the
// recorded series again, today's 00:00 first, the API's "auto" domains, the cell and run caches (also across the
// scheduler's bundle and the routes'), one read for users of a cell arriving together, a new run, a chunk rollover, a
// cams_europe that has ended or does not hold the place, a file replaced under an open reader (S3's 412), the retries of
// the shared loop, a stale run, and each failure as null with a report that names no place. Faked: fetch (the replay), the geocoder, error capture, the clock and the waits (the
// module's seam, which forwards them to the shared retry loop). No network.
//
//   TZ=UTC npx tsx scripts/smoke-air-quality.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-air-quality.ts

import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

type Row = Record<string, unknown>;
type Request = { method: string; url: string; range: string | null; ifMatch: string | null };
type Exchange = { method: string; url: string; range: string | null; status: number; headers: Record<string, string>; body: string };
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

const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/cams-tel-aviv.json'), 'utf8')) as {
  recordedAt: number; place: { latitude: number; longitude: number }; zone: string; exchanges: Exchange[];
  expected: { hourly: { time: string[]; pm10: (number | null)[]; dust: (number | null)[] } };
};

// ---- The replay ----

const asked: Request[] = [];
let served = 0;
/** A scenario's change: a Response to send in place of the recording's, or undefined for the recording. */
let override: (request: Request, n: number) => Response | Promise<Response> | undefined = () => undefined;
/** The bytes a range request asks for. */
const rangeSize = (r: Request) => { const [a, b] = (r.range ?? '').replace('bytes=', '').split('-').map(Number); return b - a + 1; };
const exchangeOf = (request: Request): Exchange => {
  const e = FIXTURE.exchanges.find(x => x.method === request.method && x.url === request.url && x.range === request.range);
  if (!e) throw new Error(`not in the recording: ${request.method} ${request.url} ${request.range ?? ''}`);
  return e;
};
/** The recording's answer, with some headers replaced. */
const recorded = (request: Request, headers: Record<string, string> = {}): Response => {
  const e = exchangeOf(request);
  const body = request.method === 'HEAD' ? null : Buffer.from(e.body, 'base64');
  served += body?.length ?? 0;
  return new Response(body, { status: e.status, headers: { ...e.headers, ...headers } });
};
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  const request = { method: init?.method ?? 'GET', url: String(input instanceof globalThis.Request ? input.url : input), range: headers.get('range'), ifMatch: headers.get('if-match') };
  asked.push(request);
  return override(request, asked.length) ?? recorded(request);
}) as typeof fetch;

const metaOf = (model: string) => JSON.parse(Buffer.from(FIXTURE.exchanges.find(x => x.url.endsWith(`/data/${model}/static/meta.json`))!.body, 'base64').toString('utf8')) as Row;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

// ---- Fakes ----

const captured: { kind: 'error' | 'warning'; context: string; message: string; extra: unknown }[] = [];
const internals = Module as unknown as { _cache: Record<string, unknown> };
const stub = (rel: string, exports: Row) => {
  const filename = path.join(ROOT, rel);
  const mod = new (Module as unknown as new (id: string) => Row)(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  internals._cache[filename] = mod;
};
stub('src/lib/error-capture.ts', {
  captureError: (e: unknown, context: string, extra?: unknown) => { captured.push({ kind: 'error', context, message: e instanceof Error ? e.message : String(e), extra }); },
  captureWarning: (message: string, context: string, extra?: unknown) => { captured.push({ kind: 'warning', context, message, extra }); },
  captureInfo: () => {},
});
stub('src/services/weather/geocoding.ts', {
  geocodeLocation: async (location: string) => {
    if (location === 'Nowhere') throw new Error('Could not geocode location: Nowhere');
    return { ...FIXTURE.place, timezone: FIXTURE.zone };
  },
});

async function main(): Promise<void> {
  const air = nodeRequire(path.join(ROOT, 'src/services/weather/air-quality.ts')) as typeof import('../src/services/weather/air-quality');
  const { instantToWallTime } = nodeRequire(path.join(ROOT, 'src/utils/wall-time.ts')) as typeof import('../src/utils/wall-time');
  const { detectDustStorm } = nodeRequire(path.join(ROOT, 'src/services/weather/dust-storm.ts')) as typeof import('../src/services/weather/dust-storm');
  const airPath = path.join(ROOT, 'src/services/weather/air-quality.ts');
  /** The series with cams_europe left out (the clamp check keeps it for the out-of-grid check). */
  let globalOnly: { time: string[]; pm10: (number | null)[]; dust: (number | null)[] } | null = null;
  // The reader's closing, seen from outside: which file each reader was opened on, and which were disposed
  const lib = nodeRequire('@openmeteo/file-reader') as { OmFileReader: { create: (backend: { url: string }) => Promise<object>; prototype: { dispose: () => void } } };
  const urlOf = new WeakMap<object, string>();
  const disposedUrls: string[] = [];
  const realCreate = lib.OmFileReader.create;
  lib.OmFileReader.create = async (backend: { url: string }) => {
    const reader = await realCreate.call(lib.OmFileReader, backend);
    urlOf.set(reader, backend.url);
    return reader;
  };
  const realDispose = lib.OmFileReader.prototype.dispose;
  lib.OmFileReader.prototype.dispose = function (this: object) {
    disposedUrls.push(urlOf.get(this) ?? '?');
    return realDispose.call(this);
  };
  /** Lets the readers' asynchronous closing run. */
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
  let clock = FIXTURE.recordedAt;
  const waits: number[] = [];
  // The module forwards the waits and the jitter to the shared retry loop (src/utils/fetch-retry.ts): none sleeps for real.
  air.__useAirForTests({ now: () => clock, sleep: async (ms: number) => { waits.push(ms); }, random: () => 0.5 });
  const logged: string[] = [];
  const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try { return await fn(); } finally { console.warn = warn; }
  };
  const fresh = () => {
    air.__resetAirForTests();
    asked.length = 0;
    waits.length = 0;
    captured.length = 0;
    logged.length = 0;
    disposedUrls.length = 0;
    served = 0;
    override = () => undefined;
    clock = FIXTURE.recordedAt;
  };
  const read = () => quietly(() => air.fetchAirQuality('Tel Aviv', FIXTURE.zone));
  const today = instantToWallTime(new Date(FIXTURE.recordedAt), FIXTURE.zone).slice(0, 10);
  /** What the place, its coordinates and its grid cell (Tel Aviv: 305, 537) would look like in a report or a log line. */
  const PLACE_TRACE = /Tel Aviv|32\.0|34\.7|\b305\b|\b537\b|latitude|longitude/i;
  const traces = () => [...captured.map(c => `${c.message} ${show(c.extra)}`), ...logged].filter(line => PLACE_TRACE.test(line));

  await check('the replay gives the recorded series: hourly from today\'s 00:00 in Israel to cams_global\'s end (about 5 days), both models read (the API\'s "auto" in Tel Aviv), dayIndex 0 is today, a few dozen small requests, nothing logged', async () => {
    fresh();
    const got = await read();
    assert(show(got) === show(FIXTURE.expected), `differs from the recording: ${show(got).slice(0, 300)}`);
    assert(got!.hourly.time[0] === `${today}T00:00`, `first hour ${got!.hourly.time[0]}`);
    assert(got!.hourly.time.length >= 96 && got!.hourly.time.length <= 144, `${got!.hourly.time.length} hours`);
    assert(got!.hourly.dust.every(v => v !== null && v >= 0) && got!.hourly.pm10.every(v => v !== null && v >= 0), 'a hole or a negative value in the series');
    assert(asked.some(r => r.url.includes('/data/cams_europe/')) && asked.some(r => r.url.includes('/data/cams_global/')), 'not both models');
    assert(asked.length <= 40 && asked.every(r => r.method === 'HEAD' || r.url.endsWith('meta.json') || r.range !== null), `requests ${asked.length}, a whole-file read among them: ${show(asked.filter(r => r.method === 'GET' && !r.range && !r.url.endsWith('meta.json')))}`);
    assert(served < 100 * 1024, `${served} bytes`);
    // The URLs hold no place: a model, a variable and a chunk number, no query
    assert(asked.every(r => /^https:\/\/openmeteo\.s3\.amazonaws\.com\/data\/cams_(europe|global)\/(dust|pm10)\/chunk_\d+\.om$|^https:\/\/openmeteo\.s3\.amazonaws\.com\/data\/cams_(europe|global)\/static\/meta\.json$/.test(r.url)), `a URL with more than a model and a chunk: ${show(asked.map(r => r.url).filter(u => /\?|#|lat|lon/.test(u)))}`);
    assert(detectDustStorm(got).every(d => d.date >= today), 'a dust day before today');
    assert(captured.length === 0 && logged.length === 0, `captured ${show(captured)}, logged ${show(logged)}`);
    console.log(`[stats] one cold point: ${asked.length} requests (${asked.filter(r => r.method === 'HEAD').length} HEAD, ${asked.filter(r => r.url.endsWith('meta.json')).length} meta, ${asked.filter(r => r.range).length} range), ${served} bytes, ${got!.hourly.time.length} hours ${got!.hourly.time[0]} to ${got!.hourly.time.at(-1)}`);
  });

  await check('the grid, from the recorded metas\' own BBOX: Tel Aviv, Jerusalem and Eilat in cams_global are cells [305,537], [304,538] and [299,537] (the API\'s nearest, as the spike found); cams_europe holds Tel Aviv and Jerusalem and not Eilat (south of 30.05 N); cams_global wraps at the antimeridian', () => {
    const global = { crs_wkt: String(metaOf('cams_global').crs_wkt) };
    const europe = { crs_wkt: String(metaOf('cams_europe').crs_wkt) };
    assert(show(air.cellOf(global, 'cams_global', [451, 900, 1], 32.0853, 34.7818)) === show({ iy: 305, ix: 537 }), 'Tel Aviv');
    assert(show(air.cellOf(global, 'cams_global', [451, 900, 1], 31.7768, 35.2358)) === show({ iy: 304, ix: 538 }), 'Jerusalem');
    assert(show(air.cellOf(global, 'cams_global', [451, 900, 1], 29.557, 34.952)) === show({ iy: 299, ix: 537 }), 'Eilat');
    assert(air.cellOf(europe, 'cams_europe', [420, 700, 1], 32.0853, 34.7818) !== null, 'Tel Aviv in Europe\'s grid');
    assert(air.cellOf(europe, 'cams_europe', [420, 700, 1], 31.7768, 35.2358) !== null, 'Jerusalem in Europe\'s grid');
    assert(air.cellOf(europe, 'cams_europe', [420, 700, 1], 29.557, 34.952) === null, 'Eilat in Europe\'s grid');
    assert(show(air.cellOf(global, 'cams_global', [451, 900, 1], 0, 179.9)) === show({ iy: 225, ix: 0 }), 'the antimeridian');
    let threw = '';
    try { air.cellOf({ crs_wkt: 'GEOGCRS[…]' }, 'cams_global', [451, 900, 1], 0, 0); } catch (error) { threw = error instanceof Error ? error.message : String(error); }
    assert(threw === 'cams_global grid failed: no grid FamCal can read', `a meta with no BBOX: ${threw}`);
  });

  await check('"auto" with no cross-fade: cams_europe\'s value where it has one, cams_global\'s after its end or outside its grid, null where neither has', () => {
    assert(show(air.mergeAuto([1, NaN, 3, NaN], [10, 20, 30, NaN])) === show([1, 20, 3, null]), 'with Europe');
    assert(show(air.mergeAuto(null, [10, NaN])) === show([10, null]), 'outside Europe');
    assert(show(air.mergeAuto([5, 6], [50, 60, 70])) === show([5, 6, 70]), 'Europe ends first');
  });

  await check('the day starts at the place: today\'s 00:00 on the whole-hour grid of the data; in a half-hour zone the first hour is 00:30 (day 0 is today, not 23:30 of yesterday), in Nepal 00:45', () => {
    const labels = (zone: string) => instantToWallTime(new Date(air.dayStartSec(FIXTURE.recordedAt, zone) * 1000), zone);
    assert(labels('Asia/Jerusalem') === `${today}T00:00:00`, labels('Asia/Jerusalem'));
    const kolkata = instantToWallTime(new Date(FIXTURE.recordedAt), 'Asia/Kolkata').slice(0, 10);
    assert(labels('Asia/Kolkata') === `${kolkata}T00:30:00`, labels('Asia/Kolkata'));
    const kathmandu = instantToWallTime(new Date(FIXTURE.recordedAt), 'Asia/Kathmandu').slice(0, 10);
    assert(labels('Asia/Kathmandu') === `${kathmandu}T00:45:00`, labels('Asia/Kathmandu'));
    assert(air.dayStartSec(FIXTURE.recordedAt, 'America/New_York') % 3600 === 0, 'not on the hour grid');
  });

  await check('the caches: a second read within 10 minutes asks S3 nothing (meta, readers and the cell\'s series all kept per run)', async () => {
    fresh();
    await read();
    asked.length = 0;
    clock += 5 * 60 * 1000;
    const again = await read();
    assert(asked.length === 0 && show(again) === show(FIXTURE.expected), `${asked.length} requests: ${show(asked.slice(0, 5))}`);
  });

  await check('a new run of cams_global (its last_run_modification_time moves): after the meta\'s 10 minutes its readers are opened again (HEAD) and its series is read again (the same range requests as the first time, the data among them: the run is in the series key); cams_europe\'s, of the same run, stay: no request to it at all', async () => {
    fresh();
    await read();
    const rangesOf = (model: string) => asked.filter(r => r.range && r.url.includes(`/data/${model}/`)).map(r => `${r.url} ${r.range}`).sort();
    const firstGlobal = rangesOf('cams_global');
    assert(firstGlobal.length > 0, 'the first read asked no range of cams_global');
    const bumped = { ...metaOf('cams_global'), last_run_modification_time: Number(metaOf('cams_global').last_run_modification_time) + 60 };
    override = request => (request.url.endsWith('/data/cams_global/static/meta.json') ? json(bumped) : undefined);
    asked.length = 0;
    clock += 11 * 60 * 1000;
    const again = await read();
    assert(show(again) === show(FIXTURE.expected), 'the series changed');
    assert(asked.some(r => r.method === 'HEAD' && r.url.includes('/data/cams_global/')), 'cams_global\'s readers were not opened again');
    assert(show(rangesOf('cams_global')) === show(firstGlobal), `cams_global\'s series was not read again: ${rangesOf('cams_global').length} range requests, ${firstGlobal.length} the first time`);
    assert(!asked.some(r => r.url.includes('/data/cams_europe/') && !r.url.endsWith('meta.json')), `cams_europe was asked: ${show(asked.filter(r => r.url.includes('/data/cams_europe/') && !r.url.endsWith('meta.json')).slice(0, 3))}`);
  });

  await check('the caches are shared across bundles: the module loaded a second time (the scheduler\'s bundle beside the routes\') keeps its readers, metas and series on globalThis, so a warm read through the second copy asks S3 nothing', async () => {
    fresh();
    await read();
    delete internals._cache[airPath];
    const air2 = nodeRequire(airPath) as typeof air;
    assert(air2 !== air && air2.fetchAirQuality !== air.fetchAirQuality, 'not a second copy of the module');
    asked.length = 0;
    clock += 5 * 60 * 1000;
    const again = await quietly(() => air2.fetchAirQuality('Tel Aviv', FIXTURE.zone));
    assert(asked.length === 0 && show(again) === show(FIXTURE.expected), `${asked.length} requests: ${show(asked.slice(0, 3))}`);
  });

  await check('users of one cell arriving together read it once: two concurrent calls make the requests of one', async () => {
    fresh();
    await read();
    const single = asked.length;
    fresh();
    const [a, b] = await Promise.all([read(), read()]);
    assert(show(a) === show(FIXTURE.expected) && show(b) === show(FIXTURE.expected), 'a series differs');
    assert(asked.length === single, `${asked.length} requests for two calls, ${single} for one`);
  });

  await check('cams_europe\'s window is clamped to its data_end_time: a Europe that ended before the day starts is never asked for a chunk, and the series is cams_global\'s alone (the spike\'s reader over the same recording: peak dust 144, pm10 136)', async () => {
    fresh();
    const fromSec = air.dayStartSec(FIXTURE.recordedAt, FIXTURE.zone);
    const ended = { ...metaOf('cams_europe'), data_end_time: fromSec - 3600 };
    override = request => (request.url.endsWith('/data/cams_europe/static/meta.json') ? json(ended) : undefined);
    const got = await read();
    assert(got !== null, 'no series');
    const europe = asked.filter(r => r.url.includes('/data/cams_europe/') && !r.url.endsWith('meta.json'));
    assert(europe.length === 0, `a Europe chunk was asked: ${show(europe.slice(0, 3))}`);
    assert(show(got.hourly.time) === show(FIXTURE.expected.hourly.time) && show(got.hourly) !== show(FIXTURE.expected.hourly), 'not the same hours, or the same values as with Europe');
    assert(Math.round(Math.max(...got.hourly.dust.map(Number))) === 144 && Math.round(Math.max(...got.hourly.pm10.map(Number))) === 136, `peaks ${Math.max(...got.hourly.dust.map(Number))} / ${Math.max(...got.hourly.pm10.map(Number))}`);
    globalOnly = got.hourly;
  });

  await check('a place outside cams_europe\'s grid, end to end (its BBOX moved north of Tel Aviv): cams_global\'s series alone, none of Europe\'s data read (only the file\'s opening), and a warm read asks nothing', async () => {
    fresh();
    const wkt = String(metaOf('cams_europe').crs_wkt);
    const north = wkt.replace('BBOX[71.95,-24.95,30.049995,44.95]', 'BBOX[71.95,-24.95,40.049995,44.95]');
    assert(north !== wkt, 'the BBOX to move is not in the recorded meta');
    override = request => (request.url.endsWith('/data/cams_europe/static/meta.json') ? json({ ...metaOf('cams_europe'), crs_wkt: north }) : undefined);
    const got = await read();
    assert(got !== null && globalOnly !== null, 'no series');
    assert(show(got.hourly) === show(globalOnly), 'not the global-only series');
    const dataReads = FIXTURE.exchanges.filter(e => e.url.includes('/data/cams_europe/') && e.range && Buffer.from(e.body, 'base64').length > 500).map(e => `${e.url} ${e.range}`);
    assert(dataReads.length >= 2, 'the recording holds no Europe data reads');
    assert(!asked.some(r => dataReads.includes(`${r.url} ${r.range}`)), 'a Europe data read was asked');
    asked.length = 0;
    clock += 5 * 60 * 1000;
    const again = await read();
    assert(asked.length === 0 && show(again) === show(got), `${asked.length} requests on the warm read`);
  });

  await check('a chunk rollover: when the day\'s window starts in the next chunk, the older chunk\'s readers are retired and closed, an idle one at once and one still reading when its read ends (the read in flight finishes, no retry); the current chunk\'s readers stay open', async () => {
    fresh();
    await settle(); // the previous check's readers close asynchronously
    disposedUrls.length = 0;
    const global = metaOf('cams_global');
    const chunkSec = Number(global.chunk_time_length) * 3600;
    const fromSec = air.dayStartSec(FIXTURE.recordedAt, FIXTURE.zone);
    const old = Math.floor(fromSec / chunkSec);
    const rollover = (old + 1) * chunkSec;
    assert(Number(global.data_end_time) > rollover + 36 * 3600, 'the recording does not reach into the next chunk');
    // A whole-hour zone whose midnight is the next chunk\'s first hour: its day then reads exactly the ranges of the recording
    const east = (24 - ((rollover / 3600) % 24)) % 24;
    const offset = east > 12 ? east - 24 : east;
    const zone = offset === 0 ? 'Etc/GMT' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
    const nextClock = (rollover + 3600) * 1000;
    assert(air.dayStartSec(nextClock, zone) === rollover, `${zone} does not start its day at the rollover`);
    const europeEnded = { ...metaOf('cams_europe'), data_end_time: rollover - 3600 };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let heldSeen!: () => void;
    const held = new Promise<void>(resolve => { heldSeen = resolve; });
    let holding = false;
    let nextDay = false;
    const oldDust = `/data/cams_global/dust/chunk_${old}.om`;
    override = request => {
      if (nextDay && request.url.endsWith('/data/cams_europe/static/meta.json')) return json(europeEnded);
      if (!holding && request.method === 'GET' && request.range && request.url.endsWith(oldDust) && rangeSize(request) > 1000) {
        holding = true; // the first data read of the older chunk's dust reader is held: that reader is in use
        heldSeen();
        return gate.then(() => recorded(request));
      }
      return undefined;
    };
    const today1 = read();
    await held;
    clock = nextClock;
    nextDay = true;
    const today2 = await quietly(() => air.fetchAirQuality('Tel Aviv', zone));
    await settle();
    assert(today2 !== null && today2.hourly.time.length === (Number(global.data_end_time) - rollover) / 3600, `the rollover day: ${today2?.hourly.time.length} hours`);
    assert(show(today2.hourly.dust.slice(-36)) === show(FIXTURE.expected.hourly.dust.slice(-36)), 'the values past Europe\'s end differ from the first read\'s');
    const open = air.__openReadersForTests();
    assert(!open.some(k => k.includes('/data/cams_global/') && k.includes(`/chunk_${old}.om@`)), `an older chunk\'s reader is still open: ${show(open.filter(k => k.includes(`chunk_${old}.`)))}`);
    assert(open.some(k => k.includes(`/data/cams_global/dust/chunk_${old + 1}.om@`)) && open.some(k => k.includes(`/data/cams_global/pm10/chunk_${old + 1}.om@`)), 'the current chunk\'s readers are not open');
    assert(!disposedUrls.some(u => u.endsWith(oldDust)), 'the reader still in use was closed under its read');
    release();
    const day1 = await today1;
    await settle();
    assert(show(day1) === show(FIXTURE.expected) && waits.length === 0, `the read in flight: ${show(day1)?.slice(0, 80)}, waits ${show(waits)}`);
    assert(!captured.some(c => c.kind === 'error'), `captured ${show(captured)}`);
    assert(disposedUrls.some(u => u.endsWith(oldDust)) && disposedUrls.some(u => u.endsWith(`/data/cams_global/pm10/chunk_${old}.om`)), `the older chunk\'s readers were not closed: ${show(disposedUrls)}`);
    assert(!disposedUrls.some(u => u.includes('/cams_global/') && u.includes(`chunk_${old + 1}.om`)), 'the current chunk\'s reader was closed');
  });

  await check('a meta.json without its run time (last_run_initialisation_time) is not one FamCal can read: three retries, then null and one placeless report, never an age of NaN', async () => {
    fresh();
    const broken: Row = { ...metaOf('cams_global') };
    delete broken.last_run_initialisation_time;
    override = request => (request.url.endsWith('/data/cams_global/static/meta.json') ? json(broken) : undefined);
    const got = await read();
    assert(got === null, `got ${show(got)?.slice(0, 80)}`);
    assert(show(waits) === show([250, 500, 1000]), `waits ${show(waits)}`);
    assert(captured.length === 1 && captured[0].message === 'cams_global meta failed: meta.json is not one FamCal can read', `captured ${show(captured)}`);
    assert(traces().length === 0, `a trace of the place: ${show(traces())}`);
  });

  await check('S3\'s 412 (a file replaced under a reader that is already open, while meta.json still names the old run): the stale reader is retired, a new one is opened (HEAD with the new etag) and the read succeeds on the retry after one backoff wait, with nothing captured', async () => {
    fresh();
    const NEW = '"replaced-by-a-new-run"';
    let replaced = false;
    let stale412 = 0;
    override = request => {
      if (!request.url.includes('/data/cams_global/dust/')) return undefined;
      if (request.method === 'HEAD') return replaced ? recorded(request, { etag: NEW }) : undefined;
      if (request.range && !replaced && rangeSize(request) > 1000) replaced = true; // the files change under the first data read of an open reader
      if (request.range && replaced && request.ifMatch !== NEW) {
        stale412++;
        return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 }); // S3's answer to a reader of the old file
      }
      return undefined;
    };
    const got = await read();
    assert(stale412 >= 1, 'the file was never replaced under a reader');
    assert(show(got) === show(FIXTURE.expected), `no recovery from the 412: ${show(got)?.slice(0, 120)}, stale answers ${stale412}, waits ${show(waits)}`);
    assert(show(waits) === show([250]), `waits ${show(waits)}`);
    assert(captured.length === 0, `captured ${show(captured)}`);
    assert(logged.length === 1 && /^\[air-quality\] cams_global (open|read) failed: OmHttpBackendError; retry 1 of 3 in 250 ms$/.test(logged[0]), `the retry line ${show(logged)}`); // a replaced file fails whichever reader (an open one's read, or one still opening) asks first
  });

  await check('S3 down (meta.json answering 503): three retries with backoff, then null, one capture under air-quality naming the model, the step and the status; no throw', async () => {
    fresh();
    override = request => (request.url.endsWith('meta.json') ? new Response('slow down', { status: 503 }) : undefined);
    const got = await read();
    assert(got === null, `got ${show(got)}`);
    assert(show(waits) === show([250, 500, 1000]), `waits ${show(waits)}`);
    assert(captured.length === 1 && captured[0].context === 'air-quality' && captured[0].kind === 'error', `captured ${show(captured)}`);
    assert(captured[0].message === 'cams_global meta failed: HTTP 503', captured[0].message);
    const extra = captured[0].extra as Row;
    assert(extra.model === 'cams_global' && extra.step === 'meta' && extra.status === 503 && extra.retried === 3, `extra ${show(extra)}`);
    assert(logged.length === 3 && logged.every(line => line.startsWith('[air-quality] cams_global meta failed: HTTP 503; retry ')), `logged ${show(logged)}`);
  });

  await check('a data file answering 503 on every range (one attempt of the library, then our retries): null, one capture with the status, and no place, coordinates or grid cell in any report or log line', async () => {
    fresh();
    override = request => (request.method === 'GET' && request.range && request.url.includes('/data/cams_global/dust/') ? new Response('slow down', { status: 503 }) : undefined);
    const got = await read();
    assert(got === null, `got ${show(got)}`);
    assert(show(waits) === show([250, 500, 1000]), `waits ${show(waits)}`);
    assert(captured.length === 1 && captured[0].message === 'cams_global open failed: HTTP 503', `captured ${show(captured)}`);
    assert(traces().length === 0, `a trace of the place: ${show(traces())}`);
  });

  await check('a chunk that is not there (404 on its HEAD): null, one capture with the status 404, nothing that names the place', async () => {
    fresh();
    override = request => (request.method === 'HEAD' && request.url.includes('/data/cams_europe/') ? new Response(null, { status: 404 }) : undefined);
    const got = await read();
    assert(got === null && captured.length === 1 && captured[0].message === 'cams_europe open failed: HTTP 404', `captured ${show(captured)}, got ${show(got)?.slice(0, 80)}`);
    assert(traces().length === 0, `a trace of the place: ${show(traces())}`);
  });

  await check('a run over 36 h old: one warning under air-quality naming its age, not repeated for the same run', async () => {
    fresh();
    const old = (model: string) => ({ ...metaOf(model), last_run_initialisation_time: Math.floor(FIXTURE.recordedAt / 1000) - 40 * 3600 });
    override = request => (request.url.endsWith('/data/cams_global/static/meta.json') ? json(old('cams_global')) : undefined);
    await read();
    clock += 11 * 60 * 1000;
    await read();
    const stale = captured.filter(c => c.context === 'air-quality' && c.message.includes('40 h old'));
    assert(stale.length === 1, `captured ${show(captured)}`);
  });

  await check('the place lookup failing: null and one warning that does not name the place; a time zone that is not one: null and one report that does not name it', async () => {
    fresh();
    const got = await quietly(() => air.fetchAirQuality('Nowhere', FIXTURE.zone));
    assert(got === null && captured.length === 1 && captured[0].kind === 'warning' && !captured[0].message.includes('Nowhere'), `captured ${show(captured)}`);
    fresh();
    const bad = await quietly(() => air.fetchAirQuality('Tel Aviv', 'Not/AZone'));
    assert(bad === null && captured.length === 1 && captured[0].context === 'air-quality' && !show(captured).includes('AZone') && asked.length === 0, `captured ${show(captured)}, asked ${asked.length}`);
  });

  await check('the dust days read an hour from the label\'s text, never through the process zone: a clearing hour of 02:00 on the day the clocks of Israel skip it (2026-03-27) is still 02, in whatever zone the process runs', () => {
    const time = Array.from({ length: 24 }, (_, h) => `2026-03-27T${String(h).padStart(2, '0')}:00`);
    const pm10 = time.map((_, h) => (h === 1 ? 300 : h === 0 ? 40 : 20));
    const days = detectDustStorm({ hourly: { time, pm10, dust: time.map(() => 0) } });
    assert(days.length === 1 && days[0].severity === 'severe' && days[0].clearingHour === 2, `days ${show(days)}`);
  });

  await check('the reader as the spike ruled: the plain HTTP backend at one attempt with the library\'s race at Node\'s own ceiling, no block cache or pool imported or used (comments aside), the retries from the shared loop and no loop of its own, and @openmeteo/file-reader pinned to 0.0.21', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/services/weather/air-quality.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    assert(/new OmHttpBackend\(\{ url, retries: 1, timeoutMs: FETCH_CEILING_MS \}\)/.test(code), 'the backend options');
    assert(!/LruBlockCache|OmHttpBackendPool|BlockCache|asCachedReader/.test(code), 'a block cache or pool in the code');
    assert(/from '\.\.\/\.\.\/utils\/fetch-retry'/.test(code) && /retryWithBackoff\(/.test(code), 'not the shared retry loop');
    assert(!/\bsetTimeout\b|\b2 \*\* |for \(let retried/.test(code), 'a wait or a retry loop of its own');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert(pkg.dependencies['@openmeteo/file-reader'] === '0.0.21', `pinned ${pkg.dependencies['@openmeteo/file-reader']}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  // The library's request races leave timers for up to FETCH_CEILING_MS: exit now
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

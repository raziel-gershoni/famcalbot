// Smoke test for the timezone after a location change (app/api/settings/route.ts and
// resolveTimezoneForLocation in src/lib/timezone.ts). A settings save wrote the new
// location but left the old zone cached under tz:user:{id} for up to 24 h, so the
// summaries, reminders and voice kept the old city's clock that long. A save that
// changes the location now looks the zone up after the response: one Nominatim request
// and one Open-Meteo request, 3 s each, no retries, no geocode cache and no
// Asia/Jerusalem fallback. Only a lookup that finds a valid zone replaces the cached one,
// and only while the stored location is still the one it looked up: two quick saves each
// schedule a lookup, and the older one can land last.
//
// The route, resolveTimezoneForLocation and REDIS_KEYS run for real. Faked: auth (a
// Telegram user), the user row (written through updateUserById, its location read back
// through prisma.user.findUnique), the reminder cache, Telegram, error capture, Redis (in
// memory), the geocoding module (its fetchWithTimeout records every request, can hold a
// Nominatim answer back, and answers from the scenario), the Google calendar service, and
// Next's after() (queued, then run by the test, since it needs a live request scope). No
// network, no DB.
//
// Run with the fake env from the plan:
//   TZ=UTC npx tsx scripts/smoke-location-timezone.ts

import path from 'path';
import { createRequire } from 'module';

type Row = Record<string, unknown>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

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

const show = (v: unknown) => JSON.stringify(v);

// ---- Fakes ----

const USER_ID = 7;
const TELEGRAM_ID = 7007;
const TZ_KEY = `tz:user:${USER_ID}`;
const OLD_ZONE = 'Europe/London';

/** The stored user row; the route reads it through verifyUserAuth and writes it through updateUserById. */
let userRow: Row = {};

/** Redis, in memory. Every set is recorded with its options. */
const redisStore = new Map<string, unknown>();
const redisSets: { key: string; value: unknown; opts: unknown }[] = [];
let redisSetError: Error | null = null;
const fakeRedis = {
  get: async (key: string) => (redisStore.has(key) ? redisStore.get(key) : null),
  set: async (key: string, value: unknown, opts?: unknown) => {
    redisSets.push({ key, value, opts });
    if (redisSetError) throw redisSetError;
    redisStore.set(key, value);
    return 'OK';
  },
  del: async (key: string) => (redisStore.delete(key) ? 1 : 0),
};

/** Every request the lookup made, with the timeout and retry count it passed. */
type LookupRequest = { url: string; options: unknown; timeoutMs: unknown; maxRetries: unknown };
const requests: LookupRequest[] = [];
/** How each host answers a request in the current scenario: a Response, or a thrown error. */
let answers: { nominatim: (url: URL) => Response; openMeteo: (url: URL) => Response } = {
  nominatim: () => { throw new Error('no scenario'); },
  openMeteo: () => { throw new Error('no scenario'); },
};
/** Nominatim queries whose answer waits for its release: a lookup still in flight. */
const held = new Map<string, Promise<void>>();
/** Holds Nominatim's answer to `query` back until the returned function is called. */
function hold(query: string): () => void {
  let release = () => {};
  held.set(query, new Promise<void>(resolve => { release = resolve; }));
  return () => release();
}
async function fakeFetchWithTimeout(url: string, options?: unknown, timeoutMs?: unknown, maxRetries?: unknown): Promise<Response> {
  requests.push({ url, options, timeoutMs, maxRetries });
  const parsed = new URL(url);
  if (parsed.host === 'nominatim.openstreetmap.org') {
    await held.get(parsed.searchParams.get('q') ?? '');
    return answers.nominatim(parsed);
  }
  if (parsed.host === 'api.open-meteo.com') return answers.openMeteo(parsed);
  throw new Error(`unexpected request: ${url}`);
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** The places the fake geocoder knows: Nominatim's coordinates, and Open-Meteo's zone for them. */
const PLACES: Record<string, { lat: string; lon: string; zone: string }> = {
  'New York': { lat: '40.7127281', lon: '-74.0060152', zone: 'America/New_York' },
  'London': { lat: '51.5074456', lon: '-0.1277653', zone: 'Europe/London' },
  'Tel Aviv': { lat: '32.0852997', lon: '34.7818064', zone: 'Asia/Jerusalem' },
  'תל אביב': { lat: '32.0852997', lon: '34.7818064', zone: 'Asia/Jerusalem' },
  'Москва': { lat: '55.7505412', lon: '37.6174782', zone: 'Europe/Moscow' },
};

/** Prisma, for the one read the route makes itself: the stored location, before the zone is written. */
const locationReads: unknown[] = [];
let userGone = false;
const fakePrisma = {
  user: {
    findUnique: async (args: { where: { id: number }; select: Record<string, boolean> }) => {
      locationReads.push(args);
      if (userGone || args.where.id !== USER_ID) return null;
      return Object.fromEntries(Object.keys(args.select).map(key => [key, userRow[key]]));
    },
  },
};

/** Calls into the geocoding module's cached path (geocodeLocation / getTimezone): there must be none. */
const cachedPathCalls: string[] = [];

/** captureError calls: context and severity. */
const captured: { context: string; severity: unknown; message: string }[] = [];

/** Next's after(): tasks queued by the route, run by drainAfter(). */
const afterQueue: (() => unknown)[] = [];
async function drainAfter() {
  while (afterQueue.length) await afterQueue.shift()!();
}

function installStubs() {
  const Module = nodeRequire('module');
  const stub = (rel: string, exports: Row) => {
    const filename = path.join(ROOT, rel);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  stub('src/utils/redis.ts', { redis: fakeRedis });
  stub('src/utils/prisma.ts', { prisma: fakePrisma });
  stub('src/lib/rate-limit.ts', { settingsRateLimiter: {} });
  stub('src/lib/api-auth.ts', {
    // A Telegram save: the proved row, as the route gets it (a copy, read before the update).
    verifyUserAuth: async () => ({ success: true, via: 'telegram', user: { ...userRow } }),
  });
  stub('src/services/user-service.ts', {
    updateUserById: async (id: number, data: Row) => {
      assert(id === USER_ID, `updateUserById(${id})`);
      for (const [key, value] of Object.entries(data)) if (value !== undefined) userRow[key] = value;
      return { ...userRow };
    },
  });
  stub('src/services/reminder-cache.ts', { updateUserInCache: async () => {}, removeUserFromCache: async () => {}, syncReminderCacheEntry: async () => {} });
  stub('src/services/telegram/index.ts', { setUserMenuButton: async () => {} });
  stub('src/lib/error-capture.ts', {
    captureError: (error: unknown, context: string, _extra?: unknown, severity: unknown = 'error') => {
      captured.push({ context, severity, message: error instanceof Error ? error.message : String(error) });
    },
    captureWarning: () => {},
    captureInfo: () => {},
  });
  stub('src/services/calendar.ts', { getUserCalendarTimezone: async () => null });
  stub('src/services/weather/geocoding.ts', {
    fetchWithTimeout: fakeFetchWithTimeout,
    geocodeLocation: async (location: string) => {
      cachedPathCalls.push(`geocodeLocation(${location})`);
      throw new Error('the cached geocode path was used');
    },
    getTimezone: async (location: string) => {
      cachedPathCalls.push(`getTimezone(${location})`);
      throw new Error('the cached geocode path was used');
    },
  });

  // Next's after() throws outside a request scope; queue the task and run it after the response.
  const nextServer = nodeRequire('next/server');
  nextServer.after = (task: unknown) => {
    afterQueue.push(typeof task === 'function' ? (task as () => unknown) : () => task);
  };
}

function seed() {
  userRow = {
    id: USER_ID, telegramId: TELEGRAM_ID, location: 'London', language: 'en',
    remindersEnabled: false, suspendedAt: null, unreachableSince: null,
    googleRefreshToken: '', calendarSource: 'NATIVE',
  };
  redisStore.clear();
  redisStore.set(TZ_KEY, OLD_ZONE); // as the summaries resolved it from London
  redisSets.length = 0;
  redisSetError = null;
  requests.length = 0;
  cachedPathCalls.length = 0;
  captured.length = 0;
  afterQueue.length = 0;
  held.clear();
  locationReads.length = 0;
  userGone = false;
  answers = {
    nominatim: url => {
      const place = PLACES[url.searchParams.get('q') ?? ''];
      return json(place ? [{ lat: place.lat, lon: place.lon }] : []);
    },
    openMeteo: url => {
      const place = Object.values(PLACES).find(p => String(parseFloat(p.lat)) === url.searchParams.get('latitude'));
      return place
        ? json({ timezone: place.zone, latitude: Number(place.lat), longitude: Number(place.lon) })
        : json({ error: true, reason: 'unknown place' }, 400);
    },
  };
}

async function main() {
  installStubs();
  const { NextRequest } = nodeRequire('next/server');
  const { POST } = (await import(path.join(ROOT, 'app/api/settings/route.ts'))) as {
    POST: (req: unknown) => Promise<Response>;
  };

  /** A settings save from the mini app, through the real route. */
  const save = async (body: Row) => {
    const log = console.log;
    console.log = () => {};
    try {
      return await POST(new NextRequest(`http://localhost/api/settings?user_id=${TELEGRAM_ID}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
    } finally {
      console.log = log;
    }
  };

  /** Each request, as "host timeout/retries". */
  const shape = () => requests.map(r => `${new URL(r.url).host} ${String(r.timeoutMs)}/${String(r.maxRetries)}`);

  await check('(a) a new location: the save answers at once, then tz:user:{id} becomes the new zone for 24 h', async () => {
    seed();
    const res = await save({ location: 'New York' });
    assert(res.status === 200, `status ${res.status}`);
    assert(userRow.location === 'New York', `stored location ${show(userRow.location)}`);
    assert(afterQueue.length === 1, `${afterQueue.length} tasks scheduled with after()`);
    assert(requests.length === 0, `the lookup ran before the response: ${show(shape())}`);
    assert(redisStore.get(TZ_KEY) === OLD_ZONE, `zone before the task ran: ${show(redisStore.get(TZ_KEY))}`);
    await drainAfter();
    assert(redisStore.get(TZ_KEY) === 'America/New_York', `cached zone ${show(redisStore.get(TZ_KEY))}`);
    assert(show(redisSets) === show([{ key: TZ_KEY, value: 'America/New_York', opts: { ex: 86400 } }]), `redis sets ${show(redisSets)}`);
    assert(captured.length === 0, `captured ${show(captured)}`);
  });

  await check('(a) the lookup: one Nominatim and one Open-Meteo request, each with a 3 s timeout and no retries, no geocode cache', async () => {
    seed();
    await save({ location: 'New York' });
    await drainAfter();
    assert(show(shape()) === show(['nominatim.openstreetmap.org 3000/0', 'api.open-meteo.com 3000/0']), `requests ${show(shape())}`);
    const search = new URL(requests[0].url);
    assert(search.pathname === '/search' && search.searchParams.get('q') === 'New York' && search.searchParams.get('format') === 'json' && search.searchParams.get('limit') === '1', `Nominatim url ${requests[0].url}`);
    const headers = (requests[0].options as { headers?: Record<string, string> } | undefined)?.headers;
    assert(headers?.['User-Agent'] === 'FamilyCalendarBot/1.0', `Nominatim headers ${show(headers)}`);
    const forecast = new URL(requests[1].url);
    assert(forecast.searchParams.get('latitude') === '40.7127281' && forecast.searchParams.get('longitude') === '-74.0060152' && forecast.searchParams.get('timezone') === 'auto', `Open-Meteo url ${requests[1].url}`);
    assert(cachedPathCalls.length === 0, `cached path used: ${show(cachedPathCalls)}`);
  });

  await check('(b) Open-Meteo fails: the cached zone stays, nothing is written, no retry', async () => {
    seed();
    answers.openMeteo = () => { throw new TypeError('fetch failed'); };
    const res = await save({ location: 'New York' });
    assert(res.status === 200, `status ${res.status}`);
    await drainAfter();
    assert(show(shape()) === show(['nominatim.openstreetmap.org 3000/0', 'api.open-meteo.com 3000/0']), `requests ${show(shape())}`);
    assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
  });

  await check('(b) Open-Meteo answers 503: the cached zone stays', async () => {
    seed();
    answers.openMeteo = () => json({ error: true, reason: 'busy' }, 503);
    await save({ location: 'New York' });
    await drainAfter();
    assert(requests.length === 2, `requests ${show(shape())}`);
    assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
  });

  await check('(c) Nominatim finds nothing: the cached zone stays, Open-Meteo is not asked', async () => {
    seed();
    answers.nominatim = () => json([]);
    await save({ location: 'Atlantis' });
    await drainAfter();
    assert(show(shape()) === show(['nominatim.openstreetmap.org 3000/0']), `requests ${show(shape())}`);
    assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
  });

  await check('(d) Open-Meteo sends a zone Intl does not know: the cached zone stays', async () => {
    seed();
    answers.openMeteo = () => json({ timezone: 'Mars/Olympus_Mons' });
    await save({ location: 'New York' });
    await drainAfter();
    assert(requests.length === 2, `requests ${show(shape())}`);
    assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
  });

  await check('(e) Open-Meteo sends no zone: the cached zone stays (no Asia/Jerusalem default)', async () => {
    seed();
    answers.openMeteo = () => json({ latitude: 40.71, longitude: -74.0 });
    await save({ location: 'New York' });
    await drainAfter();
    assert(requests.length === 2, `requests ${show(shape())}`);
    assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
  });

  await check('(f) the Redis write fails: the save still answers 200 and the failure is a warning', async () => {
    seed();
    redisSetError = new Error('redis down');
    const res = await save({ location: 'New York' });
    assert(res.status === 200, `status ${res.status}`);
    await drainAfter();
    assert(show(captured.map(c => [c.severity, c.message])) === show([['warning', 'redis down']]), `captured ${show(captured)}`);
  });

  await check('(g) [guard] the same location, or the same with spaces around it: no lookup, the zone stays', async () => {
    for (const location of ['London', '  London ']) {
      seed();
      const res = await save({ location, weatherEnabled: true });
      assert(res.status === 200, `status ${res.status}`);
      await drainAfter();
      assert(requests.length === 0, `"${location}": requests ${show(shape())}`);
      assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `"${location}": zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
    }
  });

  await check('(h) [guard] no location in the save, or an empty one: no lookup, the zone stays', async () => {
    for (const body of [{ weatherEnabled: true }, { location: '' }, { location: '   ' }]) {
      seed();
      const res = await save(body);
      assert(res.status === 200, `status ${res.status}`);
      await drainAfter();
      assert(requests.length === 0, `${show(body)}: requests ${show(shape())}`);
      assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `${show(body)}: zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
    }
  });

  await check('(i) resolveTimezoneForLocation on its own: the zone, or null on any failure', async () => {
    const { resolveTimezoneForLocation } = (await import(path.join(ROOT, 'src/lib/timezone.ts'))) as {
      resolveTimezoneForLocation: (location: string) => Promise<string | null>;
    };
    seed();
    assert(await resolveTimezoneForLocation('New York') === 'America/New_York', 'New York');
    answers.nominatim = () => { throw new Error('timeout'); };
    assert(await resolveTimezoneForLocation('New York') === null, 'Nominatim throws');
    seed();
    answers.nominatim = () => json([], 500);
    assert(await resolveTimezoneForLocation('New York') === null, 'Nominatim 500');
    seed();
    answers.openMeteo = () => json({ timezone: '' });
    assert(await resolveTimezoneForLocation('New York') === null, 'empty zone');
    assert(cachedPathCalls.length === 0, `cached path used: ${show(cachedPathCalls)}`);
  });

  await check('(j) [race] two quick saves, Tel Aviv then London: the Tel Aviv lookup lands last and writes nothing, London\'s zone stays', async () => {
    seed();
    userRow.location = 'New York';
    redisStore.set(TZ_KEY, 'America/New_York');
    const releaseTelAviv = hold('Tel Aviv');
    await save({ location: 'Tel Aviv' });
    await save({ location: 'London' });
    assert(afterQueue.length === 2, `${afterQueue.length} tasks scheduled with after()`);
    const [telAviv, london] = afterQueue.splice(0);
    const telAvivLanded = Promise.resolve(telAviv()); // asks Nominatim, then waits for the answer
    await london();
    releaseTelAviv();
    await telAvivLanded;
    const asked = requests.map(r => {
      const url = new URL(r.url);
      return url.host === 'nominatim.openstreetmap.org' ? `place ${url.searchParams.get('q')}` : `zone ${url.searchParams.get('latitude')}`;
    });
    assert(show(asked) === show(['place Tel Aviv', 'place London', 'zone 51.5074456', 'zone 32.0852997']), `asked ${show(asked)}`);
    assert(show(redisSets) === show([{ key: TZ_KEY, value: 'Europe/London', opts: { ex: 86400 } }]), `redis sets ${show(redisSets)}`);
    assert(redisStore.get(TZ_KEY) === 'Europe/London', `cached zone ${show(redisStore.get(TZ_KEY))}`);
    // Each lookup found a zone, so each read the location back before writing.
    const read = { where: { id: USER_ID }, select: { location: true } };
    assert(show(locationReads) === show([read, read]), `location reads ${show(locationReads)}`);
  });

  await check('(k) [race] the location changes before its lookup lands (saved again as spaces, or the row is gone): nothing is written', async () => {
    for (const change of ['saved as spaces', 'row gone']) {
      seed();
      await save({ location: 'New York' });
      assert(afterQueue.length === 1, `${change}: ${afterQueue.length} tasks scheduled with after()`);
      if (change === 'saved as spaces') {
        await save({ location: '   ' }); // stored as it is, with no lookup of its own
        assert(userRow.location === '   ' && afterQueue.length === 1, `${change}: stored ${show(userRow.location)}, ${afterQueue.length} tasks`);
      } else {
        userGone = true;
      }
      await drainAfter();
      assert(requests.length === 2, `${change}: requests ${show(shape())}`);
      assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `${change}: zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
      assert(locationReads.length === 1, `${change}: ${locationReads.length} location reads`);
    }
  });

  await check('(l) a Hebrew or a Russian location goes to Nominatim URL-encoded, and its zone is cached', async () => {
    const cases: [string, string][] = [['תל אביב', 'Asia/Jerusalem'], ['Москва', 'Europe/Moscow']];
    for (const [location, zone] of cases) {
      seed();
      await save({ location });
      await drainAfter();
      assert(requests.length === 2, `"${location}": requests ${show(shape())}`);
      const url = requests[0].url;
      assert(url.includes(`?q=${encodeURIComponent(location)}&`) && /^[\x21-\x7e]+$/.test(url), `"${location}": Nominatim url ${url}`);
      assert(new URL(url).searchParams.get('q') === location, `"${location}": q reads back as ${show(new URL(url).searchParams.get('q'))}`);
      assert(show(redisSets) === show([{ key: TZ_KEY, value: zone, opts: { ex: 86400 } }]), `"${location}": redis sets ${show(redisSets)}`);
    }
  });

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

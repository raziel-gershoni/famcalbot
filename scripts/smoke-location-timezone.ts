// Smoke test for the timezone after a location change (app/api/settings/route.ts, the
// lookup in src/lib/timezone.ts and the saved place in src/services/zmanim/place.ts). A
// settings save wrote the new location but left the old zone cached under tz:user:{id} for up
// to 24 h, so the summaries, reminders and voice kept the old city's clock that long. A save
// that changes the location now looks the place up after the response: one Nominatim request,
// one Open-Meteo request for the zone and one for the highest ground (zmanim), 3 s each, no
// retries, no geocode cache and no Asia/Jerusalem fallback. Only a lookup that finds a valid
// zone replaces the cached one, and only while the stored location is still the one it looked
// up: two quick saves each schedule a lookup, and the older one can land last. The same save
// clears the old place's coordinates in the same write as the location, and the lookup stores
// the new place's coordinates and highest ground (zmanim, Task 1).
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
let answers: { nominatim: (url: URL) => Response; openMeteo: (url: URL) => Response; elevation: (url: URL) => Response } = {
  nominatim: () => { throw new Error('no scenario'); },
  openMeteo: () => { throw new Error('no scenario'); },
  elevation: () => { throw new Error('no scenario'); },
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
  if (parsed.host === 'api.open-meteo.com' && parsed.pathname === '/v1/elevation') return answers.elevation(parsed);
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

/** Nominatim's boundingbox for a place: [south, north, west, east] as strings, 0.05 degrees each way. */
const boxAround = (place: { lat: string; lon: string }): string[] => {
  const lat = parseFloat(place.lat), lon = parseFloat(place.lon);
  return [String(lat - 0.05), String(lat + 0.05), String(lon - 0.05), String(lon + 0.05)];
};
/** The highest ground the fake terrain has at the 25 sampled points: rising with the point's index, 100 m for the first. */
const ELEVATION_MAX = 124;

/** Prisma, for the one read the route makes itself: the stored location, before the zone is written. */
const locationReads: unknown[] = [];
let userGone = false;
/** What the lookup wrote to the user's place: one entry per updateMany. */
const placeWrites: { where: Row; data: Row }[] = [];
const fakePrisma = {
  user: {
    findUnique: async (args: { where: { id: number }; select: Record<string, boolean> }) => {
      locationReads.push(args);
      if (userGone || args.where.id !== USER_ID) return null;
      return Object.fromEntries(Object.keys(args.select).map(key => [key, userRow[key]]));
    },
    // Compare and set: the place is written only while the stored location is still the one it was looked up for.
    updateMany: async (args: { where: { id: number; location: string }; data: Row }) => {
      placeWrites.push({ where: args.where, data: args.data });
      if (userGone || args.where.id !== USER_ID || userRow.location !== args.where.location) return { count: 0 };
      Object.assign(userRow, args.data);
      return { count: 1 };
    },
  },
};

/** Calls into the geocoding module's cached path (geocodeLocation / getTimezone): there must be none. */
const cachedPathCalls: string[] = [];

/** The settings_changed rows the route tracked: the names of the fields a save changed, never values. */
const activities: { type: string; meta: unknown }[] = [];

/** captureError calls: context and severity. */
const captured: { context: string; severity: unknown; message: string }[] = [];
/** What the reminder cache was given of the user, one entry per sync: the save's own, then the lookup's. */
const cacheSyncs: { location: unknown; latitude: unknown; longitude: unknown; elevationM: unknown }[] = [];

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
    // The row as it is when the lookup has finished
    getUserById: async (id: number) => {
      assert(id === USER_ID, `getUserById(${id})`);
      return userGone ? null : { ...userRow };
    },
  });
  stub('src/services/reminder-cache.ts', {
    updateUserInCache: async () => {},
    removeUserFromCache: async () => {},
    syncReminderCacheEntry: async (user: Row) => { cacheSyncs.push({ location: user.location, latitude: user.latitude, longitude: user.longitude, elevationM: user.elevationM }); },
  });
  stub('src/services/telegram/index.ts', { setUserMenuButton: async () => {} });
  stub('src/services/analytics-service.ts', {
    trackActivityAsync: (_userId: number, type: string, meta: unknown) => { activities.push({ type, meta }); },
  });
  stub('src/lib/error-capture.ts', {
    captureError: (error: unknown, context: string, _extra?: unknown, severity: unknown = 'error') => {
      captured.push({ context, severity, message: error instanceof Error ? error.message : String(error) });
    },
    captureWarning: (message: string, context: string) => { captured.push({ context, severity: 'warning', message }); },
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
  cacheSyncs.length = 0;
  held.clear();
  locationReads.length = 0;
  placeWrites.length = 0;
  activities.length = 0;
  userGone = false;
  answers = {
    nominatim: url => {
      const place = PLACES[url.searchParams.get('q') ?? ''];
      return json(place ? [{ lat: place.lat, lon: place.lon, boundingbox: boxAround(place) }] : []);
    },
    openMeteo: url => {
      const place = Object.values(PLACES).find(p => String(parseFloat(p.lat)) === url.searchParams.get('latitude'));
      return place
        ? json({ timezone: place.zone, latitude: Number(place.lat), longitude: Number(place.lon) })
        : json({ error: true, reason: 'unknown place' }, 400);
    },
    // 25 sampled points, rising from 100 m: the highest is the last, ELEVATION_MAX.
    elevation: url => json({ elevation: (url.searchParams.get('latitude') ?? '').split(',').map((_lat, index) => 100 + index) }),
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
  const shape = () => requests.map(r => `${new URL(r.url).host}${new URL(r.url).pathname === '/v1/elevation' ? '/elevation' : ''} ${String(r.timeoutMs)}/${String(r.maxRetries)}`);
  /** The three requests a full lookup makes: the place, its zone and its highest ground, each 3 s with no retry. */
  const FULL_LOOKUP = ['nominatim.openstreetmap.org 3000/0', 'api.open-meteo.com 3000/0', 'api.open-meteo.com/elevation 3000/0'];

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

  await check('(a) the reminder cache gets the looked-up place once the lookup has run (the pause counts Shabbat from it): the save syncs the entry with the old place cleared, the lookup syncs it again with the new coordinates and highest ground; a lookup that finds nothing syncs nothing more', async () => {
    seed();
    await save({ location: 'New York' });
    const syncs = () => cacheSyncs.length;
    assert(syncs() === 1 && cacheSyncs[0].location === 'New York' && cacheSyncs[0].latitude === null, `the save's own sync: ${show(cacheSyncs)}`);
    await drainAfter();
    assert(syncs() === 2 && cacheSyncs[1].location === 'New York' && cacheSyncs[1].latitude === 40.7127281 && cacheSyncs[1].longitude === -74.0060152 && cacheSyncs[1].elevationM === ELEVATION_MAX, `after the lookup: ${show(cacheSyncs)}`);
    seed();
    await save({ location: 'Nowhere At All' });
    await drainAfter();
    assert(syncs() === 1, `a place not found syncs nothing more: ${show(cacheSyncs)}`);
  });

  await check('(a) the lookup: one Nominatim, one Open-Meteo zone and one Open-Meteo elevation request, each with a 3 s timeout and no retries, no geocode cache', async () => {
    seed();
    await save({ location: 'New York' });
    await drainAfter();
    assert(show(shape()) === show(FULL_LOOKUP), `requests ${show(shape())}`);
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
    // The zone request fails; the place is still saved with its elevation, which is its own request (no retry of either).
    assert(show(shape()) === show(FULL_LOOKUP), `requests ${show(shape())}`);
    assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
    assert(userRow.latitude === 40.7127281 && userRow.elevationM === ELEVATION_MAX, `the place is kept: ${show([userRow.latitude, userRow.elevationM])}`);
  });

  await check('(b) Open-Meteo answers 503: the cached zone stays', async () => {
    seed();
    answers.openMeteo = () => json({ error: true, reason: 'busy' }, 503);
    await save({ location: 'New York' });
    await drainAfter();
    assert(requests.length === 3, `requests ${show(shape())}`);
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
    assert(requests.length === 3, `requests ${show(shape())}`);
    assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
  });

  await check('(e) Open-Meteo sends no zone: the cached zone stays (no Asia/Jerusalem default)', async () => {
    seed();
    answers.openMeteo = () => json({ latitude: 40.71, longitude: -74.0 });
    await save({ location: 'New York' });
    await drainAfter();
    assert(requests.length === 3, `requests ${show(shape())}`);
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
      if (url.pathname === '/v1/elevation') return 'elevation';
      return url.host === 'nominatim.openstreetmap.org' ? `place ${url.searchParams.get('q')}` : `zone ${url.searchParams.get('latitude')}`;
    });
    assert(show(asked) === show(['place Tel Aviv', 'place London', 'zone 51.5074456', 'elevation', 'zone 32.0852997', 'elevation']), `asked ${show(asked)}`);
    assert(show(redisSets) === show([{ key: TZ_KEY, value: 'Europe/London', opts: { ex: 86400 } }]), `redis sets ${show(redisSets)}`);
    assert(redisStore.get(TZ_KEY) === 'Europe/London', `cached zone ${show(redisStore.get(TZ_KEY))}`);
    // Each lookup found a zone, so each read the location back before writing.
    const read = { where: { id: USER_ID }, select: { location: true } };
    assert(show(locationReads) === show([read, read]), `location reads ${show(locationReads)}`);
    // The place follows the zone: London's coordinates are stored, the stale Tel Aviv lookup wrote none.
    assert(placeWrites.length === 1 && userRow.latitude === 51.5074456, `place writes ${show(placeWrites)}`);
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
      assert(requests.length === 3, `${change}: requests ${show(shape())}`);
      assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `${change}: zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
      assert(locationReads.length === 1 && placeWrites.length === 0, `${change}: ${locationReads.length} location reads, ${placeWrites.length} place writes`);
    }
  });

  await check('(l) a Hebrew or a Russian location goes to Nominatim URL-encoded, and its zone is cached', async () => {
    const cases: [string, string][] = [['תל אביב', 'Asia/Jerusalem'], ['Москва', 'Europe/Moscow']];
    for (const [location, zone] of cases) {
      seed();
      await save({ location });
      await drainAfter();
      assert(requests.length === 3, `"${location}": requests ${show(shape())}`);
      const url = requests[0].url;
      assert(url.includes(`?q=${encodeURIComponent(location)}&`) && /^[\x21-\x7e]+$/.test(url), `"${location}": Nominatim url ${url}`);
      assert(new URL(url).searchParams.get('q') === location, `"${location}": q reads back as ${show(new URL(url).searchParams.get('q'))}`);
      assert(show(redisSets) === show([{ key: TZ_KEY, value: zone, opts: { ex: 86400 } }]), `"${location}": redis sets ${show(redisSets)}`);
    }
  });

  await check('(m) [place] a changed location clears the old place\'s coordinates and highest ground in the same write, the lookup then stores the new place\'s coordinates and the highest of its 25 sampled points, and settings_changed names the location only', async () => {
    seed();
    Object.assign(userRow, { latitude: 51.5074456, longitude: -0.1277653, elevationM: 11 }); // London\'s, as saved before
    const res = await save({ location: 'New York' });
    assert(res.status === 200, `status ${res.status}`);
    assert(userRow.location === 'New York' && userRow.latitude === null && userRow.longitude === null && userRow.elevationM === null, `before the lookup: ${show([userRow.location, userRow.latitude, userRow.longitude, userRow.elevationM])}`);
    assert(show(activities) === show([{ type: 'settings_changed', meta: { changed_fields: ['location'] } }]), `activity ${show(activities)}`);
    await drainAfter();
    assert(show([userRow.latitude, userRow.longitude, userRow.elevationM]) === show([40.7127281, -74.0060152, ELEVATION_MAX]), `stored ${show([userRow.latitude, userRow.longitude, userRow.elevationM])}`);
    assert(show(placeWrites) === show([{ where: { id: USER_ID, location: 'New York' }, data: { latitude: 40.7127281, longitude: -74.0060152, elevationM: ELEVATION_MAX } }]), `place writes ${show(placeWrites)}`);
    // The 25 points are one request, within 3 km of the centre on each axis.
    const url = new URL(requests[2].url);
    const lats = url.searchParams.get('latitude')!.split(',').map(Number), lons = url.searchParams.get('longitude')!.split(',').map(Number);
    assert(lats.length === 25 && lons.length === 25, `${lats.length} points`);
    assert(lats.every(lat => Math.abs(lat - 40.7127281) * 111_320 <= 3000.5), 'held to 3 km north-south');
    assert(lons.every(lon => Math.abs(lon + 74.0060152) * 111_320 * Math.cos((40.7127281 * Math.PI) / 180) <= 3000.5), 'held to 3 km east-west');
  });

  await check('(n) [guard] a save that leaves the location as it is leaves the saved place alone: nothing cleared, nothing looked up, nothing written', async () => {
    for (const location of ['London', '  London ', undefined]) {
      seed();
      Object.assign(userRow, { latitude: 51.5074456, longitude: -0.1277653, elevationM: 11 });
      await save(location === undefined ? { weatherEnabled: true } : { location, weatherEnabled: true });
      await drainAfter();
      assert(show([userRow.latitude, userRow.longitude, userRow.elevationM]) === show([51.5074456, -0.1277653, 11]), `${show(location)}: cleared ${show([userRow.latitude, userRow.longitude, userRow.elevationM])}`);
      assert(requests.length === 0 && placeWrites.length === 0, `${show(location)}: ${requests.length} requests, ${placeWrites.length} writes`);
    }
  });

  await check('(o) a lookup that finds no place leaves the new location saved with its coordinates cleared (the lazy fill tries again on first need), and a location saved with spaces is compared and set as stored', async () => {
    seed();
    Object.assign(userRow, { latitude: 51.5074456, longitude: -0.1277653, elevationM: 11 });
    answers.nominatim = () => json([], 500);
    await save({ location: 'New York' });
    await drainAfter();
    assert(userRow.location === 'New York' && userRow.latitude === null && placeWrites.length === 0, `kept: ${show([userRow.location, userRow.latitude, placeWrites.length])}`);
    seed();
    await save({ location: '  New York ' });
    await drainAfter();
    assert(show(placeWrites.map(w => w.where)) === show([{ id: USER_ID, location: '  New York ' }]), `compare and set on the stored text: ${show(placeWrites)}`);
    assert(userRow.latitude === 40.7127281, 'stored');
  });

  await check('(p) [logging] every failure of the lookup is logged under location-lookup and never with the place\'s name: Nominatim throwing, answering 500 or sending bad coordinates, and the zone request failing, answering 503 or sending no zone', async () => {
    const cases: Array<[string, (a: typeof answers) => void]> = [
      ['Nominatim throws', a => { a.nominatim = () => { throw new Error('timeout'); }; }],
      ['Nominatim 500', a => { a.nominatim = () => json([], 500); }],
      ['Nominatim bad coordinates', a => { a.nominatim = () => json([{ lat: 'x', lon: 'y' }]); }],
      ['zone throws', a => { a.openMeteo = () => { throw new Error('timeout'); }; }],
      ['zone 503', a => { a.openMeteo = () => json({ error: true }, 503); }],
      ['zone not one Intl knows', a => { a.openMeteo = () => json({ timezone: 'Mars/Olympus_Mons' }); }],
    ];
    const { resolveLocation } = (await import(path.join(ROOT, 'src/lib/timezone.ts'))) as { resolveLocation: (location: string) => Promise<unknown> };
    for (const [name, change] of cases) {
      seed();
      change(answers);
      await resolveLocation('New York');
      assert(captured.length === 1 && captured[0].context === 'location-lookup' && captured[0].severity === 'warning', `${name}: captured ${show(captured)}`);
      assert(!captured[0].message.includes('New York'), `${name}: the place's name was logged: ${captured[0].message}`);
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

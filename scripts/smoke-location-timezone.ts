// Smoke test for the timezone after a location change (app/api/settings/route.ts, the
// lookup in src/lib/timezone.ts and the saved place in src/services/zmanim/place.ts). A
// settings save wrote the new location but left the old zone cached under tz:user:{id} for up
// to 24 h, so the summaries, reminders and voice kept the old city's clock that long. A save
// that changes the location now looks the place up after the response: one Nominatim request
// (3 s, no retry), the zone from our own map (zoneForCoords, geo-tz) and, for a place in Israel
// only, the highest ground from the stored height map (zmanim), no geocode cache and no Asia/Jerusalem fallback. Only a lookup that finds a valid
// zone replaces the cached one, and only while the stored location is still the one it looked
// up: two quick saves each schedule a lookup, and the older one can land last. The same save
// clears the old place's coordinates in the same write as the location, and the lookup stores
// the new place's coordinates and, in Israel, highest ground (zmanim, Tasks 1 and 2).
//
// The zone map runs for real: the spec's places (Ariel, Ma'ale Adumim, Eilat, Katzrin, Hebron,
// Gaza, Kyiv, a sea point), the West Bank rule, the bounded tile cache, and (in a child
// process) the map's data file missing.
//
// The route, resolveTimezoneForLocation and REDIS_KEYS run for real. Faked: auth (a
// Telegram user), the user row (written through updateUserById, its location read back
// through prisma.user.findUnique), the reminder cache, Telegram, error capture, Redis (in
// memory), the geocoding module (its fetchWithTimeout records every request, can hold a
// Nominatim answer back, and answers from the scenario), the stored height map (records the
// points it is asked), the Google calendar service, and
// Next's after() (queued, then run by the test, since it needs a live request scope). No
// network, no DB.
//
// Run with the fake env from the plan:
//   TZ=UTC npx tsx scripts/smoke-location-timezone.ts

import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { createRequire } from 'module';
import { spawnSync } from 'node:child_process';

type Row = Record<string, unknown>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

/** Set in the child that runs with the zone map's data folder empty (check u). */
const MISSING_DATA_CHILD = 'ZONE_SMOKE_MISSING_DATA';

/** The child: zoneForCoords with geo-tz pointed at an empty folder. Prints one JSON line: the zone and what was captured. */
function missingDataChild(): void {
  const Module = nodeRequire('module');
  const got: { context: string; severity: string; message: string }[] = [];
  const filename = path.join(ROOT, 'src/lib/error-capture.ts');
  const mod = new Module(filename);
  Object.assign(mod, {
    filename, loaded: true, exports: {
      captureError: (e: unknown, context: string, _x?: unknown, severity: string = 'error') => { got.push({ context, severity, message: e instanceof Error ? e.message : String(e) }); },
      captureWarning: (message: string, context: string) => { got.push({ context, severity: 'warning', message }); },
      captureInfo: () => {},
    },
  });
  Module._cache[filename] = mod;
  const { zoneForCoords } = nodeRequire(path.join(ROOT, 'src/lib/zone-for-coords.ts')) as { zoneForCoords: (a: number, b: number) => string | null };
  console.log(JSON.stringify({ zone: zoneForCoords(32.0853, 34.7818), captured: got }));
}

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
let answers: { nominatim: (url: URL) => Response } = {
  nominatim: () => { throw new Error('no scenario'); },
};
/** The points of each read the stored height map was asked for (stubbed: it answers ELEVATION_MAX). */
const heightReads: { latitude: number; longitude: number }[][] = [];
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
  throw new Error(`unexpected request: ${url}`);
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** The places the fake geocoder knows: Nominatim's coordinates, and the zone the real zone map gives them (null: none). */
const PLACES: Record<string, { lat: string; lon: string; zone: string | null }> = {
  'New York': { lat: '40.7127281', lon: '-74.0060152', zone: 'America/New_York' },
  'London': { lat: '51.5074456', lon: '-0.1277653', zone: 'Europe/London' },
  'Tel Aviv': { lat: '32.0852997', lon: '34.7818064', zone: 'Asia/Jerusalem' },
  'תל אביב': { lat: '32.0852997', lon: '34.7818064', zone: 'Asia/Jerusalem' },
  'Москва': { lat: '55.7505412', lon: '37.6174782', zone: 'Europe/Moscow' },
  // 35 km off Haifa: the zone map answers Etc/GMT-2, which is no one's zone
  'Out at sea': { lat: '33.0', lon: '34.5', zone: null },
};

/** Nominatim's boundingbox for a place: [south, north, west, east] as strings, 0.05 degrees each way. */
const boxAround = (place: { lat: string; lon: string }): string[] => {
  const lat = parseFloat(place.lat), lon = parseFloat(place.lon);
  return [String(lat - 0.05), String(lat + 0.05), String(lon - 0.05), String(lon + 0.05)];
};
/** The highest ground the stubbed height map answers for a place in Israel. */
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
    // The settings route asks which channels the person has (delivery-platform.ts); the row has a Telegram id and no WhatsApp
    getWhatsAppChatId: (user: { whatsappPhone?: string | null; whatsappBsuid?: string | null }) => user.whatsappPhone || user.whatsappBsuid || null,
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
  stub('src/services/zmanim/heights.ts', {
    highestHeight: (points: { latitude: number; longitude: number }[]) => { heightReads.push(points); return ELEVATION_MAX; },
  });
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
  heightReads.length = 0;
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
  /** Function reads: TypeScript would otherwise keep a length narrowed by an earlier assert across seed(). */
  const nHeightReads = () => heightReads.length;
  /** The requests a full lookup makes: the place (3 s, no retry); the zone and the height are local. */
  const FULL_LOOKUP = ['nominatim.openstreetmap.org 3000/0'];

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

  await check('(a) the reminder cache gets the looked-up place once the lookup has run (the pause counts Shabbat from it): the save syncs the entry with the old place cleared, the lookup syncs it again with the new coordinates (no height abroad); a lookup that finds nothing syncs nothing more', async () => {
    seed();
    await save({ location: 'New York' });
    const syncs = () => cacheSyncs.length;
    assert(syncs() === 1 && cacheSyncs[0].location === 'New York' && cacheSyncs[0].latitude === null, `the save's own sync: ${show(cacheSyncs)}`);
    await drainAfter();
    assert(syncs() === 2 && cacheSyncs[1].location === 'New York' && cacheSyncs[1].latitude === 40.7127281 && cacheSyncs[1].longitude === -74.0060152 && cacheSyncs[1].elevationM === null && heightReads.length === 0, `after the lookup: ${show(cacheSyncs)}`);
    seed();
    await save({ location: 'Nowhere At All' });
    await drainAfter();
    assert(syncs() === 1, `a place not found syncs nothing more: ${show(cacheSyncs)}`);
  });

  await check('(a) a changed location wakes the native reminders\' due gate once the lookup has saved the place (the gate holds the old place\'s earliest due time for up to an hour), not before, and not when the lookup finds nothing', async () => {
    const gate = nodeRequire(path.join(ROOT, 'src/services/native-reminders/due-gate.ts')) as {
      setNextDue: (next: Date | null, now: Date) => void; shouldRunPass: (now: Date) => boolean; __resetDueGateForTests: () => void;
    };
    const now = new Date();
    const closeGate = () => { gate.__resetDueGateForTests(); gate.setNextDue(new Date(now.getTime() + 60 * 60 * 1000), now); assert(!gate.shouldRunPass(now), 'the gate is closed'); };
    seed();
    closeGate();
    await save({ location: 'New York' });
    assert(!gate.shouldRunPass(now), 'woken by the save itself, before the place is known');
    closeGate();
    await save({ location: 'New York ' });
    assert(!gate.shouldRunPass(now), 'woken by a save that changed nothing');
    seed();
    closeGate();
    await save({ location: 'New York' });
    await drainAfter();
    assert(gate.shouldRunPass(now), 'the gate stayed closed after the place was saved');
    seed();
    closeGate();
    await save({ location: 'Nowhere At All' });
    await drainAfter();
    assert(!gate.shouldRunPass(now), 'a place that was not found moved nothing, yet the gate was woken');
    gate.__resetDueGateForTests();
  });

  await check('(a) the lookup: one Nominatim request (3 s, no retry), no zone request, no height request, no geocode cache', async () => {
    seed();
    await save({ location: 'New York' });
    await drainAfter();
    assert(show(shape()) === show(FULL_LOOKUP), `requests ${show(shape())}`);
    const search = new URL(requests[0].url);
    assert(search.pathname === '/search' && search.searchParams.get('q') === 'New York' && search.searchParams.get('format') === 'json' && search.searchParams.get('limit') === '1', `Nominatim url ${requests[0].url}`);
    const headers = (requests[0].options as { headers?: Record<string, string> } | undefined)?.headers;
    assert(headers?.['User-Agent'] === 'FamilyCalendarBot/1.0', `Nominatim headers ${show(headers)}`);
    assert(cachedPathCalls.length === 0, `cached path used: ${show(cachedPathCalls)}`);
  });

  await check('(b) the zone map has no zone for the place (Nominatim\'s point is at sea): the cached zone stays, nothing is written to tz:user, one warning under location-lookup without the place\'s name; the coordinates are still saved', async () => {
    seed();
    await save({ location: 'Out at sea' });
    await drainAfter();
    assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
    assert(userRow.latitude === 33 && userRow.longitude === 34.5 && heightReads.length === 0, `the place is kept, with no height read: ${show([userRow.latitude, userRow.longitude, heightReads.length])}`);
    const lookups = captured.filter(c => c.context === 'location-lookup');
    assert(lookups.length === 1 && lookups[0].severity === 'warning' && lookups[0].message.includes('Etc/GMT-2') && !lookups[0].message.includes('Out at sea'), `captured ${show(captured)}`);
  });

  await check('(c) Nominatim finds nothing: the cached zone stays, nothing else is asked', async () => {
    seed();
    answers.nominatim = () => json([]);
    await save({ location: 'Atlantis' });
    await drainAfter();
    assert(show(shape()) === show(['nominatim.openstreetmap.org 3000/0']), `requests ${show(shape())}`);
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
    assert(await resolveTimezoneForLocation('Out at sea') === null, 'a place at sea');
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
    const asked = requests.map(r => `place ${new URL(r.url).searchParams.get('q')}`);
    assert(show(asked) === show(['place Tel Aviv', 'place London']), `asked ${show(asked)}`);
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
      assert(requests.length === 1, `${change}: requests ${show(shape())}`);
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
      assert(requests.length === 1, `"${location}": requests ${show(shape())}`);
      const url = requests[0].url;
      assert(url.includes(`?q=${encodeURIComponent(location)}&`) && /^[\x21-\x7e]+$/.test(url), `"${location}": Nominatim url ${url}`);
      assert(new URL(url).searchParams.get('q') === location, `"${location}": q reads back as ${show(new URL(url).searchParams.get('q'))}`);
      assert(show(redisSets) === show([{ key: TZ_KEY, value: zone, opts: { ex: 86400 } }]), `"${location}": redis sets ${show(redisSets)}`);
    }
  });

  await check('(m) [place] a changed location clears the old place\'s coordinates and highest ground in the same write, the lookup then stores the new place\'s coordinates (abroad: no height is read and none stored; in Israel: the highest of its 25 points), and settings_changed names the location only', async () => {
    seed();
    Object.assign(userRow, { latitude: 51.5074456, longitude: -0.1277653, elevationM: 11 }); // London\'s, as saved before
    const res = await save({ location: 'New York' });
    assert(res.status === 200, `status ${res.status}`);
    assert(userRow.location === 'New York' && userRow.latitude === null && userRow.longitude === null && userRow.elevationM === null, `before the lookup: ${show([userRow.location, userRow.latitude, userRow.longitude, userRow.elevationM])}`);
    assert(show(activities) === show([{ type: 'settings_changed', meta: { changed_fields: ['location'] } }]), `activity ${show(activities)}`);
    await drainAfter();
    assert(show([userRow.latitude, userRow.longitude, userRow.elevationM]) === show([40.7127281, -74.0060152, null]), `stored ${show([userRow.latitude, userRow.longitude, userRow.elevationM])}`);
    assert(show(placeWrites) === show([{ where: { id: USER_ID, location: 'New York' }, data: { latitude: 40.7127281, longitude: -74.0060152, elevationM: null } }]), `place writes ${show(placeWrites)}`);
    assert(nHeightReads() === 0, `a height was read abroad: ${show(heightReads)}`);
    // In Israel the 25 points are one read of the map, within 3 km of the centre on each axis.
    seed();
    await save({ location: 'Tel Aviv' });
    await drainAfter();
    assert(nHeightReads() === 1 && heightReads[0].length === 25, `height reads ${show(heightReads.map(p => p.length))}`);
    assert(heightReads[0].every(p => Math.abs(p.latitude - 32.0852997) * 111_320 <= 3000.5), 'held to 3 km north-south');
    assert(heightReads[0].every(p => Math.abs(p.longitude - 34.7818064) * 111_320 * Math.cos((32.0852997 * Math.PI) / 180) <= 3000.5), 'held to 3 km east-west');
    assert(userRow.elevationM === ELEVATION_MAX, `Tel Aviv's height ${show(userRow.elevationM)}`);
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

  await check('(p) [logging] every failure of the lookup is logged under location-lookup and never with the place\'s name: Nominatim throwing, answering 500 or sending bad coordinates, and a place at sea', async () => {
    const cases: Array<[string, (a: typeof answers) => void]> = [
      ['Nominatim throws', a => { a.nominatim = () => { throw new Error('timeout'); }; }],
      ['Nominatim 500', a => { a.nominatim = () => json([], 500); }],
      ['Nominatim bad coordinates', a => { a.nominatim = () => json([{ lat: 'x', lon: 'y' }]); }],
      ['the place is at sea', a => { a.nominatim = () => json([{ lat: '33.0', lon: '34.5' }]); }],
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

  await check('(q) the zmanim community (Task 3): a known one is saved and named in settings_changed (never its value) and wakes the reminder gate (every reminder by zman is due at other times); the same one changes nothing; anything else is 400 and writes nothing', async () => {
    const gate = nodeRequire(path.join(ROOT, 'src/services/native-reminders/due-gate.ts')) as { shouldRunPass: (now: Date) => boolean; setNextDue: (next: Date | null, now: Date) => void; __resetDueGateForTests: () => void };
    const closeGate = () => {
      gate.__resetDueGateForTests();
      gate.setNextDue(new Date(Date.now() + 30 * 60_000), new Date());
      assert(!gate.shouldRunPass(new Date()), 'the gate did not close');
    };
    seed();
    userRow.zmanimCommunity = 'sephardi';
    closeGate();
    const res = await save({ zmanimCommunity: 'chabad' });
    assert(res.status === 200 && userRow.zmanimCommunity === 'chabad', `saved: ${res.status} ${show(userRow.zmanimCommunity)}`);
    const changed = activities.filter(a => a.type === 'settings_changed');
    assert(changed.length === 1 && show(changed[0].meta) === show({ changed_fields: ['zmanimCommunity'] }) && !show(activities).includes('chabad'), `analytics ${show(activities)}`);
    assert(gate.shouldRunPass(new Date()), 'the gate was not woken');
    closeGate();
    activities.length = 0;
    const same = await save({ zmanimCommunity: 'chabad' });
    assert(same.status === 200 && activities.length === 0 && !gate.shouldRunPass(new Date()), `the same community: ${same.status} ${show(activities)}`);
    for (const bad of ['karaite', 'SEPHARDI', '', 5, null, ['chabad']]) {
      const before = show(userRow);
      const r = await save({ zmanimCommunity: bad });
      assert(r.status === 400 && show(userRow) === before, `${show(bad)}: ${r.status}`);
    }
    const untouched = await save({ language: 'he' });
    assert(untouched.status === 200 && userRow.zmanimCommunity === 'chabad', 'a save without the field leaves it');
  });

  const zones = nodeRequire(path.join(ROOT, 'src/lib/zone-for-coords.ts')) as {
    zoneForCoords: (latitude: number, longitude: number) => string | null;
    pickZone: (zones: readonly string[]) => string | null;
    tileCacheStats: () => { size: number; stored: number };
    TILE_CACHE_MAX: number;
  };

  await check('(r) the zone map on the spec\'s places: Ariel, Ma\'ale Adumim, Eilat and Katzrin are Asia/Jerusalem (the first two are over the Green Line, where the map also lists Hebron), Hebron and Gaza keep their own zones, Kyiv is Europe/Kyiv (not the "now" data set\'s Europe/Athens), and the open sea is no zone', () => {
    const SPEC_PLACES: Array<[string, number, number, string | null]> = [
      ['Ariel', 32.106, 35.174, 'Asia/Jerusalem'],
      ["Ma'ale Adumim", 31.777, 35.298, 'Asia/Jerusalem'],
      ['Eilat', 29.557, 34.952, 'Asia/Jerusalem'],
      ['Katzrin', 32.993, 35.692, 'Asia/Jerusalem'],
      ['Hebron', 31.532, 35.099, 'Asia/Hebron'],
      ['Gaza', 31.5017, 34.4668, 'Asia/Gaza'],
      ['Kyiv', 50.45, 30.5236, 'Europe/Kyiv'],
      ['New York', 40.7127, -74.006, 'America/New_York'],
      ['the sea off Haifa', 33.0, 34.5, null],
    ];
    captured.length = 0;
    for (const [name, lat, lon, want] of SPEC_PLACES) {
      const got = zones.zoneForCoords(lat, lon);
      assert(got === want, `${name}: ${show(got)}, want ${show(want)}`);
    }
    assert(captured.length === 1 && captured[0].context === 'location-lookup' && captured[0].severity === 'warning', `only the sea is logged: ${show(captured)}`);
  });

  await check('(s) the West Bank rule: Asia/Jerusalem when the map lists it, wherever it is in the list; otherwise the first; nothing for no answer', () => {
    assert(zones.pickZone(['Asia/Jerusalem', 'Asia/Hebron']) === 'Asia/Jerusalem', 'Jerusalem first');
    assert(zones.pickZone(['Asia/Hebron', 'Asia/Jerusalem']) === 'Asia/Jerusalem', 'Jerusalem second');
    assert(zones.pickZone(['Asia/Hebron', 'Asia/Gaza']) === 'Asia/Hebron', 'no Jerusalem: the first');
    assert(zones.pickZone(['Asia/Gaza']) === 'Asia/Gaza', 'one zone');
    assert(zones.pickZone([]) === null, 'no zone');
  });

  await check('(t) the zone map\'s tile cache stays bounded: lookups over the whole world store more tiles than the bound, and at most TILE_CACHE_MAX stay in memory', () => {
    const before = captured.length;
    for (let lat = -60; lat <= 70; lat += 5) for (let lon = -175; lon <= 175; lon += 5) zones.zoneForCoords(lat, lon);
    captured.length = before; // the open-sea warnings are expected here
    const stats = zones.tileCacheStats();
    assert(stats.stored > zones.TILE_CACHE_MAX, `only ${stats.stored} tiles were read: the bound was never reached`);
    assert(stats.size > 0 && stats.size <= zones.TILE_CACHE_MAX, `${stats.size} tiles kept (max ${zones.TILE_CACHE_MAX})`);
  });

  await check('(u) the zone map\'s data file missing from the image (GEO_TZ_DATA_PATH at an empty folder, in a child process): the lookup answers null and reports an error under location-lookup, never a default zone', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-tz-empty-'));
    try {
      // process.execArgv carries tsx's loader flags, so the child compiles TypeScript the same way (as smoke-dst.ts does)
      const run = spawnSync(process.execPath, [...process.execArgv, process.argv[1]], {
        env: { ...process.env, [MISSING_DATA_CHILD]: '1', GEO_TZ_DATA_PATH: empty },
        encoding: 'utf8',
      });
      const last = run.stdout.trim().split('\n').pop() ?? '';
      const out = JSON.parse(last) as { zone: unknown; captured: { context: string; severity: string; message: string }[] };
      assert(out.zone === null, `zone ${show(out.zone)}`);
      assert(show(out.captured.map(c => [c.context, c.severity])) === show([['location-lookup', 'error']]), `captured ${show(out.captured)} (stderr ${run.stderr.slice(0, 300)})`);
      // The thrown message (it holds the data folder's path, and for a bad point the coordinate) never goes out: a fixed text, the error's name and its errno code
      const message = out.captured[0].message;
      assert(/^The zone map lookup threw \(Error(, ENOENT)?\)$/.test(message) && !message.includes(empty) && !message.includes('32.08') && !message.includes('34.78'), `reported message ${show(message)}`);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  await check('(v) the cached path (geocodeLocation / getTimezone, the summaries\' and /weather\'s) takes its zone from the same map with no Asia/Jerusalem fallback: Ariel is Jerusalem, a point at sea has none, and getTimezone rejects it', async () => {
    const Module = nodeRequire('module');
    const file = path.join(ROOT, 'src/services/weather/geocoding.ts');
    const stubbed = Module._cache[file];
    delete Module._cache[file];
    const realFetch = globalThis.fetch;
    let place = { lat: '32.106', lon: '35.174' };
    let fetches = 0;
    globalThis.fetch = (async () => { fetches++; return json([place]); }) as typeof fetch;
    captured.length = 0;
    const log = console.log;
    console.log = () => {};
    try {
      const real = nodeRequire(file) as {
        geocodeLocation: (location: string) => Promise<{ timezone: string | null }>;
        getTimezone: (location: string) => Promise<string>;
        clearGeocodeCache: () => void;
      };
      real.clearGeocodeCache();
      assert((await real.geocodeLocation('Ariel')).timezone === 'Asia/Jerusalem', 'Ariel');
      place = { lat: '33.0', lon: '34.5' };
      assert((await real.geocodeLocation('Out at sea')).timezone === null, 'the sea point got a zone');
      let rejected = false;
      try { await real.getTimezone('Out at sea'); } catch { rejected = true; }
      assert(rejected, 'getTimezone answered a zone for a place with none');
      // A place with no zone is not cached: the second ask went to Nominatim again and logged again; a place with a zone is cached
      assert(fetches === 3, `Ariel, the sea point and the sea point again are three requests, got ${fetches}`);
      assert(captured.filter(c => c.context === 'location-lookup').length === 2, `one log per ask: ${show(captured)}`);
      assert((await real.geocodeLocation('Ariel')).timezone === 'Asia/Jerusalem' && fetches === 3, `Ariel is cached: ${fetches} requests`);
    } finally {
      console.log = log;
      globalThis.fetch = realFetch;
      delete Module._cache[file];
      Module._cache[file] = stubbed;
    }
  });

  await check('(x) a place the lookup cannot find or reach: geocodeLocation\'s error (it reaches Sentry through the callers) never names the place, in its message or its stack, whether Nominatim finds nothing, answers 503 or is unreachable', async () => {
    const Module = nodeRequire('module');
    const file = path.join(ROOT, 'src/services/weather/geocoding.ts');
    const stubbed = Module._cache[file];
    delete Module._cache[file];
    const realFetch = globalThis.fetch;
    const PLACE = 'Qwertyland Secretville';
    let answerWith: () => Response = () => json([]);
    globalThis.fetch = (async () => answerWith()) as typeof fetch;
    const { log, error, warn } = console;
    console.log = () => {};
    console.error = () => {};
    console.warn = () => {};
    try {
      const real = nodeRequire(file) as { geocodeLocation: (location: string) => Promise<unknown>; getTimezone: (location: string) => Promise<string>; clearGeocodeCache: () => void };
      real.clearGeocodeCache();
      const failures: Array<[string, () => Response]> = [['finds nothing', () => json([])], ['answers 503', () => new Response('busy', { status: 503 })], ['is unreachable', () => { throw new TypeError('fetch failed'); }]];
      for (const [why, how] of failures) {
        answerWith = how;
        for (const ask of [() => real.geocodeLocation(PLACE), () => real.getTimezone(PLACE)]) {
          let thrown: unknown;
          await ask().catch(e => { thrown = e; });
          assert(thrown instanceof Error, `${why}: nothing thrown`);
          const text = `${thrown.message}\n${thrown.stack}\n${JSON.stringify(thrown)}`;
          assert(!/Qwerty|Secretville/i.test(text) && !text.includes(encodeURIComponent(PLACE)), `${why}: the error names the place: ${thrown.message}`);
        }
      }
    } finally {
      Object.assign(console, { log, error, warn });
      globalThis.fetch = realFetch;
      delete Module._cache[file];
      Module._cache[file] = stubbed;
    }
  });

  await check('(w) zoneForCoords never trusts or leaks its input: NaN, Infinity and out-of-range coordinates answer null with one fixed warning that holds no coordinate; a throw from the map is reported by its name only, never its message (which can hold the coordinate)', () => {
    captured.length = 0;
    const BAD: Array<[number, number]> = [[NaN, 35.1], [32.1, NaN], [Infinity, 35.1], [32.1, -Infinity], [95.123456, 35.1], [-90.5, 35.1], [32.1, 200.654321], [32.1, -180.5]];
    for (const [lat, lon] of BAD) assert(zones.zoneForCoords(lat, lon) === null, `${lat},${lon} got a zone`);
    assert(captured.length === BAD.length && captured.every(c => c.context === 'location-lookup' && c.severity === 'warning'), `captured ${show(captured)}`);
    assert(captured.every(c => !/\d{2}\.\d|NaN|Infinity/.test(c.message)), `a coordinate in a message: ${show(captured)}`);
    captured.length = 0;
    zones.zoneForCoords(90, 0); zones.zoneForCoords(-90, 180); // the limits themselves are asked of the map, not refused
    assert(!captured.some(c => c.message.includes('not valid')), `a limit was refused: ${show(captured)}`);
    captured.length = 0;
    // A map that throws with the coordinate in its message (geo-tz's own "Invalid latitude: 32.123456"): swap geo-tz for a stub, load a fresh copy of the leaf module
    const Module = nodeRequire('module');
    const geoFile = nodeRequire.resolve('geo-tz');
    const leaf = path.join(ROOT, 'src/lib/zone-for-coords.ts');
    const savedGeo = Module._cache[geoFile], savedLeaf = Module._cache[leaf];
    const geoStub = new Module(geoFile);
    Object.assign(geoStub, { filename: geoFile, loaded: true, exports: {
      setCache: () => {},
      find: (lat: number) => { throw Object.assign(new RangeError(`Invalid latitude: ${lat} at /secret/path`), { code: 'ERR_BAD' }); },
    } });
    Module._cache[geoFile] = geoStub;
    delete Module._cache[leaf];
    try {
      const fresh = nodeRequire(leaf) as { zoneForCoords: (a: number, b: number) => string | null };
      assert(fresh.zoneForCoords(32.123456, 35.654321) === null, 'a throwing map gave a zone');
    } finally {
      Module._cache[geoFile] = savedGeo;
      Module._cache[leaf] = savedLeaf;
    }
    assert(captured.length === 1 && captured[0].context === 'location-lookup' && captured[0].severity === 'error', `captured ${show(captured)}`);
    assert(captured[0].message === 'The zone map lookup threw (RangeError, ERR_BAD)', `reported ${show(captured[0].message)}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

if (process.env[MISSING_DATA_CHILD] === '1') {
  missingDataChild();
} else {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

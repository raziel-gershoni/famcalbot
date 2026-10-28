// Smoke test for the shared timezone lookup (resolveUserTimezone in src/lib/timezone.ts;
// Plan E, from Plan D's deferred list). The range route waits at most 2 s for a user's
// timezone, and the lookup carries on after that. The Month opens several windows at
// once, so without a shared lookup every further open started another Nominatim lookup
// for the same user. Now a lookup is shared per user (and location, and whether a
// Google token is there), on globalThis.__tzInflight: every caller within 1.5 s of its
// start gets its answer, a rejection reaches every one of them, and the entry goes when
// the lookup settles. A later caller starts its own, so a lookup stuck on a call with no
// time limit (a Redis read, Google's settings call) holds nobody after that. The map is
// on globalThis because Next 16 gives the scheduler and the routes separate module
// instances (two instances here share it).
//
// timezone.ts and REDIS_KEYS run for real. Faked: Redis (in memory, each read can be
// held), the geocoding module (geocodeLocation answers when a check releases it), the
// Google calendar service and error capture. No network, no DB.
//
// Run with the fake env from the plan:
//   TZ=UTC npx tsx scripts/smoke-timezone-inflight.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-timezone-inflight.ts

import path from 'path';
import { createRequire } from 'module';

type Row = Record<string, unknown>;
type Resolve = (user: { id: number; location?: string; googleRefreshToken?: string }) => Promise<string>;

const ROOT = path.resolve(__dirname, '..');
const TIMEZONE_TS = path.join(ROOT, 'src/lib/timezone.ts');
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

/** Redis, in memory. While `holdReads` is set, each read waits for releaseReads(). */
const redisStore = new Map<string, unknown>();
let redisReads = 0;
let redisSets = 0;
let holdReads: { release: (error?: Error) => void; wait: Promise<void> } | null = null;
function holdRedisReads() {
  let release: (error?: Error) => void = () => {};
  const wait = new Promise<void>((resolve, reject) => {
    release = (error) => (error ? reject(error) : resolve());
  });
  wait.catch(() => undefined); // each read rethrows it below
  holdReads = { release, wait };
  return (error?: Error) => {
    holdReads = null;
    release(error);
  };
}
const fakeRedis = {
  get: async (key: string) => {
    redisReads++;
    if (holdReads) await holdReads.wait;
    return redisStore.has(key) ? redisStore.get(key) : null;
  },
  set: async (key: string, value: unknown) => {
    redisSets++;
    redisStore.set(key, value);
    return 'OK';
  },
};

/** geocodeLocation's calls, each waiting until the check answers it. */
type Geocode = { location: string; answer: (timezone: string) => void; fail: () => void };
const geocodes: Geocode[] = [];
const fakeGeocoding = {
  geocodeLocation: (location: string) =>
    new Promise((resolve, reject) => {
      geocodes.push({
        location,
        answer: (timezone) => resolve({ latitude: 0, longitude: 0, timezone }),
        fail: () => reject(new Error('geocoding is down')),
      });
    }),
  fetchWithTimeout: async () => {
    throw new Error('the lookup asked the network');
  },
};

/** Google Calendar's timezone lookup (getUserCalendarTimezone): the calls it got, and what it answers (null: it found none). */
const googleZoneCalls: string[] = [];
let googleZone: () => Promise<string | null> = async () => null;

/** Every console line written while the checks ran. */
const consoleLines: string[] = [];
/** What error capture was asked to send (a Sentry event's message, context and extra). */
const captures: { level: string; message: string; context: unknown; extra: unknown }[] = [];

function installStubs() {
  const Module = nodeRequire('module');
  const stub = (rel: string, exports: Row) => {
    const filename = path.join(ROOT, rel);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  stub('src/utils/redis.ts', { redis: fakeRedis });
  stub('src/services/weather/geocoding.ts', fakeGeocoding);
  stub('src/services/calendar.ts', {
    getUserCalendarTimezone: async (token: string) => {
      googleZoneCalls.push(token);
      return googleZone();
    },
  });
  const record = (level: string) => (message: string, context: unknown, extra: unknown) => {
    captures.push({ level, message, context, extra });
  };
  stub('src/lib/error-capture.ts', { captureError: record('error'), captureWarning: record('warning'), captureInfo: record('info') });
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => void consoleLines.push(args.map(String).join(' '));
  }
}

/** A fresh copy of src/lib/timezone.ts: its own module instance, as another Next bundle has. */
function loadTimezone(): Resolve {
  delete nodeRequire.cache[TIMEZONE_TS];
  return (nodeRequire(TIMEZONE_TS) as { resolveUserTimezone: Resolve }).resolveUserTimezone;
}

const inflight = () => (globalThis as { __tzInflight?: Map<string, unknown> }).__tzInflight;

async function flush() {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
}

function seed() {
  redisStore.clear();
  redisReads = 0;
  redisSets = 0;
  holdReads = null;
  geocodes.length = 0;
  googleZoneCalls.length = 0;
  googleZone = async () => null;
}

/** The one geocode call still waiting for `location`. */
function geocodeFor(location: string): Geocode {
  const found = geocodes.filter((g) => g.location === location);
  assert(found.length === 1, `${found.length} geocode calls for one of the fixtures' locations (of ${geocodes.length})`);
  return found[0];
}

async function main() {
  installStubs();
  const resolveUserTimezone = loadTimezone();

  await check('two calls for one user while the lookup is in flight make one Redis read and one geocode call, and both get its answer', async () => {
    seed();
    const a = resolveUserTimezone({ id: 7, location: 'London' });
    const b = resolveUserTimezone({ id: 7, location: 'London' });
    await flush();
    assert(geocodes.length === 1 && redisReads === 1, `${geocodes.length} geocode calls, ${redisReads} Redis reads`);
    assert(inflight()?.size === 1, `in flight: ${inflight()?.size}`);
    geocodeFor('London').answer('Europe/London');
    assert(show(await Promise.all([a, b])) === show(['Europe/London', 'Europe/London']), 'the answers');
    assert(redisSets === 1 && redisStore.get('tz:user:7') === 'Europe/London', `${redisSets} Redis writes`);
  });

  await check('once the lookup settles its entry is gone, and the next call looks up afresh', async () => {
    seed();
    const first = resolveUserTimezone({ id: 7, location: 'London' });
    await flush();
    geocodeFor('London').answer('Europe/London');
    await first;
    assert(inflight()?.size === 0, `entries left: ${inflight()?.size}`);
    redisStore.clear(); // the cached zone ran out
    const again = resolveUserTimezone({ id: 7, location: 'London' });
    await flush();
    assert(geocodes.length === 2 && redisReads === 2, `${geocodes.length} geocode calls, ${redisReads} Redis reads`);
    geocodes[1].answer('Europe/London');
    assert((await again) === 'Europe/London', 'the second answer');
    const cached = await resolveUserTimezone({ id: 7, location: 'London' });
    assert(cached === 'Europe/London' && geocodes.length === 2, `a cached zone: ${geocodes.length} geocode calls`);
    assert(inflight()?.size === 0, `entries left: ${inflight()?.size}`);
  });

  await check('a lookup that rejects (Redis down) rejects for every caller with the same error, and its entry goes', async () => {
    seed();
    const release = holdRedisReads();
    const a = resolveUserTimezone({ id: 7, location: 'London' });
    const b = resolveUserTimezone({ id: 7, location: 'London' });
    await flush();
    assert(redisReads === 1, `${redisReads} Redis reads`);
    const down = new Error('redis down');
    release(down);
    const outcomes = await Promise.allSettled([a, b]);
    assert(outcomes.every((o) => o.status === 'rejected' && o.reason === down), `outcomes: ${show(outcomes.map((o) => o.status))}`);
    assert(inflight()?.size === 0, `entries left: ${inflight()?.size}`);
    redisStore.set('tz:user:7', 'Europe/London');
    assert((await resolveUserTimezone({ id: 7, location: 'London' })) === 'Europe/London', 'the next call');
  });

  await check('another user, a changed location or a Google token (or none) make a lookup of their own; two token values share one', async () => {
    seed();
    const calls = [
      resolveUserTimezone({ id: 7, location: 'London' }),
      resolveUserTimezone({ id: 8, location: 'London' }),
      resolveUserTimezone({ id: 7, location: 'Paris' }),
      resolveUserTimezone({ id: 7, location: 'London', googleRefreshToken: 'token-a' }),
      resolveUserTimezone({ id: 7, location: 'London', googleRefreshToken: 'token-b' }),
    ];
    await flush();
    assert(geocodes.length === 4 && redisReads === 4 && inflight()?.size === 4, `${geocodes.length} geocode calls, ${redisReads} Redis reads, ${inflight()?.size} in flight`);
    const zones = ['Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Lisbon'];
    geocodes.forEach((g, i) => g.answer(zones[i]));
    assert(show(await Promise.all(calls)) === show([...zones, 'Europe/Lisbon']), 'each caller got its own lookup\'s answer');
    assert(inflight()?.size === 0, `entries left: ${inflight()?.size}`);
  });

  await check('two module instances (the scheduler\'s and a route\'s) share the in-flight map', async () => {
    seed();
    const other = loadTimezone();
    assert(other !== resolveUserTimezone, 'the same module instance');
    const a = resolveUserTimezone({ id: 9, location: 'London' });
    const b = other({ id: 9, location: 'London' });
    await flush();
    assert(geocodes.length === 1 && redisReads === 1, `${geocodes.length} geocode calls, ${redisReads} Redis reads`);
    geocodeFor('London').answer('Europe/London');
    assert(show(await Promise.all([a, b])) === show(['Europe/London', 'Europe/London']), 'the answers');
    assert(inflight()?.size === 0, `entries left: ${inflight()?.size}`);
  });

  await check('a lookup stuck 1.5 s or more (a Redis read or a Google call that never answers) holds no later caller: a call within 1.5 s joins it, a later one makes a lookup of its own and gets its answer, and the stuck one settling meanwhile leaves the later one\'s entry alone', async () => {
    seed();
    // timezone.ts times its lookups with performance.now(): this check moves it by hand.
    const realNow = performance.now.bind(performance);
    let now = realNow();
    performance.now = () => now;
    try {
      const release = holdRedisReads();
      const stuck = resolveUserTimezone({ id: 7, location: 'London' });
      await flush();
      holdReads = null; // the reads after this one answer at once; the first stays stuck
      now += 1000;
      const joined = resolveUserTimezone({ id: 7, location: 'London' });
      await flush();
      const reads = () => redisReads;
      assert(reads() === 1 && inflight()?.size === 1, `a call 1 s in: ${reads()} Redis reads, ${inflight()?.size} in flight`);
      now += 500;
      const fresh = resolveUserTimezone({ id: 7, location: 'London' });
      await flush();
      assert(reads() === 2 && geocodes.length === 1, `a call 1.5 s in joined the stuck lookup: ${reads()} Redis reads, ${geocodes.length} geocode calls`);
      const late = new Error('the stuck read fails at last');
      release(late);
      const outcomes = await Promise.allSettled([stuck, joined]);
      assert(outcomes.every((o) => o.status === 'rejected' && o.reason === late), `the stuck lookup and the call that joined it: ${show(outcomes.map((o) => o.status))}`);
      assert(inflight()?.size === 1, `the stuck lookup took the later one's entry with it: ${inflight()?.size} in flight`);
      geocodeFor('London').answer('Europe/London');
      const answer = await Promise.race([fresh, new Promise((resolve) => setTimeout(() => resolve('no answer'), 200))]);
      assert(answer === 'Europe/London', `the call 1.5 s in: ${show(answer)}`);
      assert(inflight()?.size === 0, `entries left: ${inflight()?.size}`);
    } finally {
      performance.now = realNow;
    }
  });

  await check('the default-zone warning and info carry no location: the user_id and hasToken stay, the free text never reaches error capture', async () => {
    seed();
    captures.length = 0;
    const SECRET = 'Springfield, Secret Street 5';
    // A location whose geocoding fails twice (the retry waits 2 s), then no source at all.
    const failing = resolveUserTimezone({ id: 31, location: SECRET });
    await flush();
    geocodeFor(SECRET).fail();
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert(geocodes.length === 2, `${geocodes.length} geocode calls`);
    geocodes[1].fail();
    const none = resolveUserTimezone({ id: 32 });
    const zones = [await failing, await none];
    assert(zones.every((z) => z === 'UTC' || typeof z === 'string'), `zones ${show(zones)}`);
    const levels = captures.map((c) => c.level).join();
    assert(levels === 'warning,info' || levels === 'info,warning', `captures ${levels}`);
    for (const c of captures) {
      const ctx = c.extra as Row;
      assert(!('location' in ctx), `a location key in ${show(ctx)}`);
      assert(typeof ctx.user_id === 'number' && 'hasToken' in ctx, `context ${show(ctx)}`);
    }
    assert(!JSON.stringify(captures).includes('Secret Street') && !JSON.stringify(captures).includes('Springfield'), 'the location reached error capture');
  });

  await check('the Google Calendar step is one call: it finds the zone and caches it, or finds none and the default is used; a failure in the step is logged (warning, with the user id) and never waited out or tried twice', async () => {
    seed();
    googleZone = async () => 'Europe/Paris';
    assert(await resolveUserTimezone({ id: 41, googleRefreshToken: 'tok-41' }) === 'Europe/Paris' && googleZoneCalls.length === 1 && redisStore.get('tz:user:41') === 'Europe/Paris', `found: ${googleZoneCalls.length} calls, cached ${show(redisStore.get('tz:user:41'))}`);
    seed();
    captures.length = 0;
    const fallback = await resolveUserTimezone({ id: 42, googleRefreshToken: 'tok-42' });
    assert(googleZoneCalls.length === 1 && typeof fallback === 'string' && redisStore.get('tz:user:42') === fallback, `none found: ${googleZoneCalls.length} calls, zone ${show(fallback)}`);
    // A step that throws (getUserCalendarTimezone catches everything itself, so only the cache write can): logged once, one call, no 2 s wait.
    seed();
    captures.length = 0;
    googleZone = async () => {
      throw new Error('the step failed');
    };
    const started = Date.now();
    const zone = await resolveUserTimezone({ id: 43, googleRefreshToken: 'tok-43' });
    const took = Date.now() - started;
    assert(googleZoneCalls.length === 1, `a failing step was called ${googleZoneCalls.length} times`);
    assert(took < 1000, `a failing step took ${took} ms (a fixed wait?)`);
    assert(typeof zone === 'string', `zone ${show(zone)}`);
    const step = captures.filter((c) => (c.extra as Row | undefined)?.step === 'google');
    assert(step.length === 1 && step[0].context === 'timezone-resolution' && (step[0].extra as Row).user_id === 43 && String(step[0].message).includes('the step failed'), `captures ${show(captures.map((c) => [c.level, c.context, c.extra]))}`);
    assert(consoleLines.some((l) => l.includes('[timezone] user 43')), 'no console line for the failed step');
  });

  await check('the shared lookup prints nothing: no console line names a location', () => {
    const named = consoleLines.filter((l) => /London|Paris/.test(l)).length;
    assert(named === 0, `${named} console lines name a location`);
  });

  let failed = 0;
  for (const r of results) {
    process.stdout.write(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}\n`);
    if (!r.ok) failed++;
  }
  process.stdout.write(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

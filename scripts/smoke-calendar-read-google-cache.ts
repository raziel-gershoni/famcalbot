// Smoke test for the calendar home's Google cache and its stamp (spec §2.6):
// readGoogle's googleCache 'use' and 'refresh' (src/services/calendar-read/google.ts),
// stampGoogleCache, and the stamp after every bot write to Google
// (calendar-provider/google-provider.ts) and after a reconnect (google-connect.ts).
//
// Only the range route reads through the cache; the summaries pass 'bypass' and never
// touch it. The range route's reads also ask calendarList for the calendars' live
// colours (spec 2026-10-19 §3.1), and an entry keeps the colours its read got. An entry is { startedAt, items, goneIds } under
// gcal:range:v1:{userId}:{setHash}:{tz}:{from}:{to}. It is served for 3 minutes, then
// served stale with one background refresh until 30 minutes, and only while its startedAt
// is later than the user's stamp. The stamp moves after each bot write to Google, a
// reconnect, and a cached read that finds a dead token or no chosen calendar left; it never holds
// up or changes the write. Reads in flight are shared through globalThis, so two requests
// make one Google read, and only the newest read writes.
//
// The real google.ts (with B6's live read underneath), google-provider.ts and
// google-connect.ts run. Faked: Google (@googleapis/calendar and getGoogleAuth), the
// shared Redis client (in memory, TTLs on the smoke's clock), the HTTP under the stamp's
// own Upstash client (fetch answers as Upstash's REST API, into the same memory), the
// clock, error capture, the weekly recurrence cache, and google-connect's database, user
// service, reminder cache, messaging and admin notifier. No network, no DB.
//
// Checks named [guard] already pass before the cache lands and must keep passing.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-calendar-read-google-cache.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-read-google-cache.ts

import Module from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { CalendarAssignment, UserConfig } from '../src/types';

// The stamp's own Upstash client reads these when it is first used. The fake fetch below
// is the only thing that answers them.
process.env.UPSTASH_REDIS_REST_URL = 'https://stamp-redis.smoke.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'smoke-token';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

/**
 * Lets the previous check's background work finish, then runs this one. A check still
 * waiting after 5 s fails: otherwise a promise that never settles would end the process
 * quietly, with nothing printed.
 */
async function check(name: string, fn: () => Promise<void>) {
  await flush();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('still waiting after 5 s')), 5000);
  });
  try {
    await Promise.race([fn(), stuck]);
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  } finally {
    clearTimeout(timer);
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (v: unknown) => JSON.stringify(v);
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

const unhandled: unknown[] = [];
process.on('unhandledRejection', reason => {
  unhandled.push(reason);
});

// ---- Clock: every argument-less new Date() and Date.now() reads `clock` ----

const T0 = Date.UTC(2026, 9, 17, 6, 0, 0); // 09:00 in Israel, Saturday 17 October 2026
let clock = T0;
const RealDate = Date;
class ClockDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(clock);
    else super(...(args as [number, number, number, number, number, number, number]));
  }
  static now() {
    return clock;
  }
}
globalThis.Date = ClockDate as unknown as DateConstructor;

/** Everything that happened, in order: Google writes, stamps, Redis commands, DB steps. */
const events: string[] = [];

// ---- The shared Redis client (src/utils/redis.ts): values round-trip through JSON, as Upstash's do ----

type Stored = { value: string; expiresAt: number | null };
const store = new Map<string, Stored>();
/** Every command the shared client got, with its keys. */
const redisLog: { cmd: string; key: string }[] = [];
/** Commands that throw while listed, as an Upstash outage does. */
const redisFaults = new Set<string>();
/** Commands that are sent and never answered, as a Redis the shared client keeps retrying looks to its caller. */
const redisHangs = new Set<string>();
const hangs = (cmd: string) => (redisHangs.has(cmd) ? new Promise<never>(() => {}) : undefined);

function live(key: string): Stored | undefined {
  const s = store.get(key);
  if (s && s.expiresAt !== null && s.expiresAt <= clock) {
    store.delete(key);
    return undefined;
  }
  return s;
}
function decode(raw: string | undefined): unknown {
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
function put(key: string, value: unknown, ex?: number) {
  store.set(key, { value: typeof value === 'string' ? value : JSON.stringify(value), expiresAt: ex ? clock + ex * 1000 : null });
}
function command(cmd: string, key: string) {
  redisLog.push({ cmd, key });
  events.push(`redis.${cmd} ${key}`);
  if (redisFaults.has(cmd)) throw new Error(`redis ${cmd} failed (smoke)`);
}
const fakeRedis = {
  mget: async (...keys: (string | string[])[]) => {
    const flat = keys.flat();
    command('mget', flat.join(' '));
    await hangs('mget');
    return flat.map(k => decode(live(k)?.value));
  },
  get: async (key: string) => {
    command('get', key);
    return decode(live(key)?.value);
  },
  set: async (key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
    command('set', key);
    await hangs(opts?.nx ? 'set-nx' : 'set');
    if (opts?.nx && live(key)) return null;
    put(key, value, opts?.ex);
    return 'OK';
  },
  del: async (...keys: string[]) => {
    command('del', keys.join(' '));
    return keys.filter(k => store.delete(k)).length;
  },
};

// ---- The stamp's own Upstash client: its HTTP, answered as Upstash's REST API ----

/** ok: the command lands; throw: the network refuses; stuck: no answer ever, abort signal or not. */
let stampMode: 'ok' | 'throw' | 'stuck' = 'ok';
/** Each request the stamp's client sent: its commands, and whether it could be aborted. */
const stampRequests: { commands: unknown[][]; abortable: boolean }[] = [];
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(process.env.UPSTASH_REDIS_REST_URL!)) throw new Error(`network blocked in smoke: ${url}`);
  // One command, or a list of them on /pipeline (the client batches commands of one tick)
  const body = JSON.parse(String(init?.body)) as unknown[];
  const pipeline = Array.isArray(body[0]);
  const commands = (pipeline ? body : [body]) as unknown[][];
  stampRequests.push({ commands, abortable: init?.signal instanceof AbortSignal });
  for (const c of commands) events.push(`stamp ${String(c[1])}`);
  if (stampMode === 'throw') throw new TypeError('fetch failed (smoke)');
  if (stampMode === 'stuck') return new Promise<Response>(() => {});
  for (const [name, key, value, ...rest] of commands as [string, string, unknown, ...unknown[]][]) {
    if (name.toLowerCase() !== 'set') throw new Error(`the stamp's client sent ${name}`);
    const ex = rest.findIndex(x => String(x).toLowerCase() === 'ex');
    put(key, String(value), ex >= 0 ? Number(rest[ex + 1]) : undefined);
  }
  const answer = pipeline ? commands.map(() => ({ result: 'OK' })) : { result: 'OK' };
  return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

// ---- Google: getGoogleAuth's client and events.list ----

type RawEvent = Record<string, unknown>;
/**
 * Each Google calendar: its title and events, its title and pages (page n + 1 is asked for
 * with pageToken `p<n>`), or the error its list throws. A missing one is a 404.
 */
let google: Record<string, { summary: string; items: RawEvent[] } | { summary: string; pages: RawEvent[][] } | { error: unknown }> = {};
/** What the token step throws, when set. */
let tokenFailure: unknown = null;
/** While set, the token step never answers, as a stuck token server. */
let tokenHangs = false;
/** How many token steps the reads made. */
let tokenSteps = 0;
/** While set, getGoogleAuth throws, as a bug in the read would: the read then rejects. */
let authThrows = false;
/** Each events.list call: the calendar, and the request timeout the read gave it. */
const listCalls: { calendarId: string; timeout?: number }[] = [];
/** While set, each list call waits until the smoke releases it (`held`, in call order). */
let holdLists = false;
const held: (() => void)[] = [];

/** An HTTP error as gaxios 6 throws it after google-auth-library's processError. */
function httpError(status: number, message: string, reason: string): Error {
  return Object.assign(new Error(message), {
    code: status,
    status,
    errors: [{ domain: 'global', reason, message }],
    response: { status, data: { error: { code: status, message, errors: [{ domain: 'global', reason, message }] } } },
  });
}
/** The token endpoint's answer for a revoked refresh token. */
function invalidGrant(): Error {
  return Object.assign(new Error('invalid_grant'), {
    status: 400,
    response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } },
  });
}

const fakeAuth = {
  getAccessToken: async () => {
    tokenSteps++;
    if (tokenHangs) return new Promise<never>(() => {});
    if (tokenFailure) throw tokenFailure;
    return { token: 'access-token' };
  },
};
const fakeCalendarApi = {
  events: {
    list: async (params: { calendarId: string; pageToken?: string }, options?: { timeout?: number }) => {
      listCalls.push({ calendarId: params.calendarId, timeout: options?.timeout });
      if (holdLists) await new Promise<void>(resolve => held.push(resolve));
      const cal = google[params.calendarId];
      if (!cal) throw httpError(404, 'Not Found', 'notFound');
      if ('error' in cal) throw cal.error;
      if ('pages' in cal) {
        const page = params.pageToken ? Number(params.pageToken.slice(1)) : 0;
        const nextPageToken = page + 1 < cal.pages.length ? `p${page + 1}` : undefined;
        return { data: { summary: cal.summary, items: cal.pages[page] ?? [], nextPageToken } };
      }
      return { data: { summary: cal.summary, items: cal.items } };
    },
  },
};

/** calendarList's items (an unchosen calendar's too); 'error' throws a 500; 'hang' never answers. */
let colourList: { id: string; backgroundColor?: unknown }[] | 'error' | 'hang' = [];
/** Each calendarList call: its parameters and the request timeout the read gave it. */
const colourCalls: Record<string, unknown>[] = [];
/** How many calendarList calls Google got (a function, as listed()). */
const asked = () => colourCalls.length;
(fakeCalendarApi as Record<string, unknown>).calendarList = {
  list: async (params: Record<string, unknown>, options?: { timeout?: number }) => {
    colourCalls.push({ ...params, timeout: options?.timeout });
    if (colourList === 'hang') return new Promise<never>(() => {});
    if (colourList === 'error') throw httpError(500, 'Backend Error', 'backendError');
    return { data: { items: colourList } };
  },
};

/** How many list calls Google got (a function, so an assert on one count doesn't narrow the next). */
const listed = () => listCalls.length;

/** Lets the first n held list calls answer (all by default). */
function release(n = held.length) {
  for (const answer of held.splice(0, n)) answer();
}

// ---- Google writes (calendar.ts under google-provider.ts) ----

let writeOutcome: { kind: 'result'; value: unknown } | { kind: 'throw'; error: unknown } = { kind: 'result', value: { success: true } };
const fakeWrite = (kind: string) => async () => {
  events.push(`write ${kind}`);
  if (writeOutcome.kind === 'throw') throw writeOutcome.error;
  return writeOutcome.value;
};
const notInThisSmoke = (name: string) => async () => {
  throw new Error(`${name} is not part of this smoke`);
};

// ---- Error capture, the recurrence cache, google-connect's boundaries ----

const captured: { context: string; severity: string; message: string }[] = [];
const clearedRecurrence: number[] = [];

/** The user google-connect commits a token for: NATIVE with event reminders on. */
const CONNECT_USER = {
  id: 7, telegramId: 1007, name: 'Noa', calendarSource: 'NATIVE', remindersEnabled: true, calendarAssignments: undefined,
  pairingId: null, defaultReminderMinutes: 15, language: 'he', pickupRemindersEnabled: true, location: 'Tel Aviv',
};

// ---- Stubs: static imports go through Module._load, import() through the ES module hooks ----

const SRC = path.resolve(__dirname, '../src');
const stubs: Record<string, object> = {
  '@googleapis/calendar': { calendar: () => fakeCalendarApi },
  [`${SRC}/services/calendar.ts`]: {
    getGoogleAuth: () => {
      if (authThrows) throw new Error('auth exploded (smoke)');
      return fakeAuth;
    },
    createEvent: fakeWrite('create'),
    updateEvent: fakeWrite('update'),
    deleteEvent: fakeWrite('delete'),
    fetchEventsInRange: notInThisSmoke('fetchEventsInRange'),
    listUserCalendars: notInThisSmoke('listUserCalendars'),
  },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (error: unknown, context: string, _extra?: unknown, severity = 'error') => {
      captured.push({ context, severity, message: error instanceof Error ? error.message : String(error) });
    },
    captureWarning: (message: string, context: string) => {
      captured.push({ context, severity: 'warning', message });
    },
    captureInfo: () => {},
  },
  [`${SRC}/services/recurrence-cache.ts`]: {
    clearRecurrenceCacheForUser: (userId: number) => {
      clearedRecurrence.push(userId);
    },
    clearRecurrenceCache: () => {},
  },
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async () => 'Asia/Jerusalem' },
  [`${SRC}/utils/prisma.ts`]: {
    prisma: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        events.push('db.$transaction');
        return fn({ user: { update: async () => ({}) }, nativeCalendar: { updateMany: async () => ({ count: 1 }) } });
      },
    },
    withRetry: (fn: () => unknown) => fn(),
  },
  [`${SRC}/services/user-service.ts`]: {
    getUserById: async () => ({ ...CONNECT_USER }),
    getUserByTelegramId: async () => null,
    updateUserById: async () => {
      events.push('db.updateUserById');
    },
  },
  [`${SRC}/services/reminder-cache.ts`]: {
    updateUserInCache: async () => {
      events.push('reminderCache.update');
    },
  },
  [`${SRC}/services/messaging/index.ts`]: { getWhatsAppService: () => ({}), MessageFormat: { TEXT: 'text', HTML: 'html' } },
  [`${SRC}/utils/error-notifier.ts`]: {
    notifyAdminWarning: async () => {
      events.push('admin.notify');
    },
    notifyAdminError: async () => {},
  },
};

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  const stub = stubs[request in stubs ? request : resolved];
  return stub ?? realLoad.call(this, request, parent, isMain);
};
(globalThis as { smokeStubs?: typeof stubs }).smokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    const stub = stubs[file];
    if (!stub) return nextLoad(url, context);
    const names = Object.keys(stub).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.smokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

// ---- Fixtures ----

const TZ = 'Asia/Jerusalem';
/** The home's default window for 17 October in Israel: [17 Oct, 24 Oct). */
const WEEK = { from: new RealDate('2026-10-16T21:00:00.000Z'), to: new RealDate('2026-10-23T21:00:00.000Z') };
const NEXT_WEEK = { from: WEEK.to, to: new RealDate('2026-10-30T22:00:00.000Z') };
const KIDS: CalendarAssignment = { calendarId: 'family.kids@group.calendar.google.com', labels: ['kids'], name: 'Kids', color: '#33b679' };
const SPOUSE: CalendarAssignment = { calendarId: 'dana.levi@gmail.com', labels: ['spouse'], name: 'Dana', color: '#f4511e', personName: 'Dana' };

function googleUser(o: Partial<UserConfig> = {}): UserConfig {
  return {
    id: 7, telegramId: 1007, name: 'Noa', calendarSource: 'GOOGLE', googleRefreshToken: 'refresh-token',
    calendarAssignments: [{ ...KIDS }, { ...SPOUSE }], ...o,
  } as unknown as UserConfig;
}

const event = (id: string, day: string, extra: RawEvent = {}): RawEvent => ({
  id, status: 'confirmed', summary: `Event ${id}`,
  start: { dateTime: `${day}T09:00:00+03:00` }, end: { dateTime: `${day}T10:00:00+03:00` },
  htmlLink: `https://www.google.com/calendar/event?eid=${id}`, ...extra,
});

/** The key the spec gives: the first 16 hex of sha256 over the sorted ids, joined by newlines. */
function keyFor(ids: string[], window: { from: Date; to: Date }, tz = TZ): string {
  const setHash = crypto.createHash('sha256').update([...ids].sort().join('\n')).digest('hex').slice(0, 16);
  return `gcal:range:v1:7:${setHash}:${tz}:${window.from.toISOString()}:${window.to.toISOString()}`;
}
const KEY = keyFor([KIDS.calendarId, SPOUSE.calendarId], WEEK);
const STAMP = 'gcal:stamp:7';

type Entry = { startedAt: number; items: Record<string, unknown>[]; goneIds: string[]; colours?: Record<string, string> };
const entryAt = (key: string) => decode(live(key)?.value) as Entry | null;
const rangeKeys = () => [...store.keys()].filter(k => k.startsWith('gcal:range:'));
const cacheWarned = () => captured.some(c => c.context === 'calendar-read-google-cache' && c.severity === 'warning');
const stampWarned = () => captured.some(c => c.context === 'calendar-read-google-stamp' && c.severity === 'warning');
const shared = () => globalThis as { __gcalInflight?: Map<string, unknown>; __gcalWritten?: Map<string, number> };

/** The tasks a route would hand to after(). */
const deferred: (() => Promise<void>)[] = [];
const recordDefer = (task: () => Promise<void>) => {
  deferred.push(task);
};

function reset() {
  clock = T0;
  events.length = 0;
  store.clear();
  redisLog.length = 0;
  redisFaults.clear();
  redisHangs.clear();
  stampMode = 'ok';
  stampRequests.length = 0;
  google = {
    [KIDS.calendarId]: { summary: 'Family (kids)', items: [event('k1', '2026-10-18'), event('k2', '2026-10-20')] },
    [SPOUSE.calendarId]: { summary: 'dana.levi@gmail.com', items: [event('s1', '2026-10-19')] },
  };
  tokenFailure = null;
  tokenHangs = false;
  tokenSteps = 0;
  authThrows = false;
  listCalls.length = 0;
  colourList = [];
  colourCalls.length = 0;
  holdLists = false;
  held.length = 0;
  writeOutcome = { kind: 'result', value: { success: true, eventId: 'g1' } };
  captured.length = 0;
  clearedRecurrence.length = 0;
  deferred.length = 0;
  shared().__gcalInflight?.clear();
  shared().__gcalWritten?.clear();
}

async function main() {
  const { readGoogle, stampGoogleCache } = await import('../src/services/calendar-read/google');
  const { googleProvider } = await import('../src/services/calendar-provider/google-provider');
  const { commitGoogleToken } = await import('../src/services/google-connect');

  type Options = Parameters<typeof readGoogle>[2];
  /** The range route's options: the cache, its 6,000 ms deadline and after(). */
  const route = (o: Partial<Options> = {}): Options => ({ tz: TZ, deadlineMs: 6000, googleCache: 'use', defer: recordDefer, ...o });
  const read = (user = googleUser(), o: Partial<Options> = {}, window = WEEK) => readGoogle(user, window, route(o));

  // ---- The modes ----

  await check('[guard] bypass, the default: Google on every read, and no Redis at all', async () => {
    reset();
    const a = await readGoogle(googleUser(), WEEK, { tz: TZ, deadlineMs: 6000 });
    const b = await readGoogle(googleUser(), WEEK, { tz: TZ, deadlineMs: 6000, googleCache: 'bypass', defer: recordDefer });
    assert(a.read.status === 'ok' && b.read.status === 'ok' && a.items.length === 3, `reads: ${show([a.read, b.read])}`);
    assert(listed() === 4, `${listed()} list calls for two reads of two calendars`);
    assert(redisLog.length === 0 && stampRequests.length === 0 && deferred.length === 0, `Redis: ${show(redisLog)} stamps: ${stampRequests.length}`);
  });

  await check('[guard] an empty token: reconnect, with no Redis and no Google', async () => {
    reset();
    const r = await read(googleUser({ googleRefreshToken: '' }));
    assert(r.read.status === 'reconnect' && r.read.reason === 'token', show(r.read));
    assert(redisLog.length === 0 && listed() === 0 && stampRequests.length === 0, `Redis: ${show(redisLog)}`);
  });

  await check('[guard] no chosen calendar: ok and empty, with no Redis', async () => {
    reset();
    const r = await read(googleUser({ calendarAssignments: [] }));
    assert(r.read.status === 'ok' && r.items.length === 0 && r.read.calendars.length === 0, show(r.read));
    assert(redisLog.length === 0 && listed() === 0, `Redis: ${show(redisLog)}`);
  });

  // ---- Misses, hits, stale ----

  await check('a miss lists each calendar once and writes one entry, EX 1800, without calendar refs', async () => {
    reset();
    const r = await read();
    assert(r.read.status === 'ok' && r.items.length === 3 && !r.read.stale, show(r.read));
    assert(listed() === 2 && listCalls.every(c => c.timeout === 5500), `list calls: ${show(listCalls)}`);
    assert(show(redisLog.map(c => c.cmd)) === '["mget","set"]' && redisLog[0].key === `${STAMP} ${KEY}`, `commands: ${show(redisLog)}`);
    assert(show(rangeKeys()) === show([KEY]), `keys: ${show(rangeKeys())}`);
    const e = entryAt(KEY)!;
    assert(e.startedAt === T0 && show(e.goneIds) === '[]', `entry: ${show({ startedAt: e.startedAt, goneIds: e.goneIds })}`);
    assert(e.items.length === 3 && e.items.every(i => !('calendar' in i)), 'items kept their calendar refs');
    assert(!live(KEY)!.value.includes('"Kids"'), 'the entry holds an assignment name');
    assert(store.get(KEY)!.expiresAt === T0 + 1_800_000, `expires at ${store.get(KEY)!.expiresAt}`);
  });

  await check('the key: 16 hex digits of sha256 over the sorted ids, in any order, naming no calendar', async () => {
    reset();
    await read(googleUser({ calendarAssignments: [{ ...SPOUSE }, { ...KIDS }] }));
    const [key] = rangeKeys();
    assert(key === KEY, `key ${key}, expected ${KEY}`);
    assert(/^gcal:range:v1:7:[0-9a-f]{16}:Asia\/Jerusalem:2026-10-16T21:00:00\.000Z:2026-10-23T21:00:00\.000Z$/.test(key), key);
    assert(!key.includes('@') && !key.includes('dana'), `a calendar id in the key: ${key}`);
  });

  await check('a hit under 3 minutes: no Google call, with the calendars joined from today\'s choices', async () => {
    reset();
    await read();
    clock += 3 * 60_000 - 1;
    const r = await read(googleUser({ calendarAssignments: [{ ...KIDS, name: 'School run' }, { ...SPOUSE }] }));
    assert(listed() === 2, `${listed()} list calls`);
    assert(r.read.status === 'ok' && !r.read.stale && r.read.partial === null && deferred.length === 0, show(r.read));
    assert(r.read.calendars.map(c => c.name).join() === 'School run,Dana', `legend: ${show(r.read.calendars)}`);
    const kids = r.items.filter(i => i.calendar.id === KIDS.calendarId);
    const spouse = r.items.find(i => i.calendar.id === SPOUSE.calendarId);
    assert(kids.length === 2 && kids.every(i => i.calendar.name === 'School run' && i.calendar.mine), `kids: ${show(kids.map(i => i.calendar))}`);
    assert(spouse?.calendar.mine === false && spouse.calendar.ownerName === 'Dana', `spouse: ${show(spouse?.calendar)}`);
    assert(r.items.map(i => i.event.eventId).join() === 'k1,s1,k2', `order: ${r.items.map(i => i.event.eventId).join()}`);
  });

  await check('one invite on two chosen calendars: both copies, each with its own calendar, also from a hit', async () => {
    reset();
    const invite = event('evt1', '2026-10-19', { summary: 'Parent-teacher meeting' });
    google[KIDS.calendarId] = { summary: 'Family (kids)', items: [{ ...invite }] };
    google[SPOUSE.calendarId] = { summary: 'dana.levi@gmail.com', items: [{ ...invite }] };
    const copies = (r: Awaited<ReturnType<typeof read>>) => r.items.map(i => [i.key, i.calendar.id, i.calendar.mine, i.calendar.ownerName ?? null]);
    const want = [
      [`google|${KIDS.calendarId}|evt1`, KIDS.calendarId, true, null],
      [`google|${SPOUSE.calendarId}|evt1`, SPOUSE.calendarId, false, 'Dana'],
    ];
    const miss = await read();
    assert(show(copies(miss)) === show(want), `miss: ${show(copies(miss))}`);
    assert(entryAt(KEY)?.items.length === 2, `entry: ${show(entryAt(KEY)?.items.map(i => i.key))}`);
    clock += 60_000;
    const hit = await read();
    assert(listed() === 2, `${listed()} list calls: not a hit`);
    assert(show(copies(hit)) === show(want), `hit: ${show(copies(hit))}`);
  });

  await check('3 to 30 minutes: stale, plus one background refresh handed to defer, with a 6,000 ms deadline', async () => {
    reset();
    await read();
    clock += 3 * 60_000;
    const r = await read(undefined, { deadlineMs: 10_000 });
    assert(r.read.status === 'ok' && r.read.stale === true && r.items.length === 3, show(r.read));
    assert(listed() === 2 && deferred.length === 1, `${listed()} list calls, ${deferred.length} deferred`);
    await deferred[0]();
    assert(listed() === 4 && listCalls.slice(2).every(c => c.timeout === 5500), `refresh calls: ${show(listCalls.slice(2))}`);
    assert(entryAt(KEY)?.startedAt === clock, `entry startedAt ${entryAt(KEY)?.startedAt}`);
    const again = await read();
    assert(again.read.status === 'ok' && !again.read.stale && listed() === 4, show(again.read));
  });

  await check('two stale hits before the refresh runs: one Google read', async () => {
    reset();
    await read();
    clock += 5 * 60_000;
    await read();
    await read();
    assert(deferred.length === 2, `${deferred.length} deferred`);
    await Promise.all(deferred.map(task => task()));
    assert(listed() === 4, `${listed()} list calls`);
  });

  await check('without defer the refresh runs on its own; one that fails keeps the entry and leaves nothing behind', async () => {
    reset();
    await read();
    clock += 5 * 60_000;
    const stale = await read(undefined, { defer: undefined });
    assert(stale.read.status === 'ok' && stale.read.stale, show(stale.read));
    await flush();
    assert(listed() === 4 && entryAt(KEY)?.startedAt === clock, `${listed()} list calls`);
    const refreshedAt = clock;
    clock += 5 * 60_000;
    authThrows = true;
    const again = await read(undefined, { defer: undefined });
    assert(again.read.status === 'ok' && again.read.stale, show(again.read));
    await flush();
    await flush();
    assert(captured.some(c => /auth exploded/.test(c.message)), `captured: ${show(captured)}`);
    assert(entryAt(KEY)?.startedAt === refreshedAt && !store.has(STAMP), 'the failed refresh changed the entry or stamped');
    assert(unhandled.length === 0, `unhandled: ${show(unhandled.map(String))}`);
    assert(shared().__gcalInflight?.size === 0, 'the failed refresh is still in flight');
  });

  await check('a defer that throws (after() outside a request): the refresh still runs, with a warning', async () => {
    reset();
    await read();
    clock += 5 * 60_000;
    const stale = await read(undefined, {
      defer: () => {
        throw new Error('after() was called outside a request scope (smoke)');
      },
    });
    assert(stale.read.status === 'ok' && stale.read.stale, show(stale.read));
    await flush();
    assert(listed() === 4 && entryAt(KEY)?.startedAt === clock, `${listed()} list calls`);
    assert(captured.some(c => c.context === 'calendar-read-google-cache' && /outside a request/.test(c.message)), `captured: ${show(captured)}`);
  });

  await check('30 minutes old is a miss, even while Redis still holds it', async () => {
    reset();
    await read();
    store.get(KEY)!.expiresAt = null;
    clock += 30 * 60_000;
    const r = await read();
    assert(r.read.status === 'ok' && !r.read.stale && listed() === 4 && deferred.length === 0, `${listed()} list calls`);
  });

  // ---- The stamp and reads in flight ----

  await check('a stamp after startedAt invalidates the entry', async () => {
    reset();
    await read();
    clock += 10_000;
    await stampGoogleCache(7);
    clock += 10_000;
    const r = await read();
    assert(r.read.status === 'ok' && !r.read.stale && listed() === 4, `${listed()} list calls`);
    assert(entryAt(KEY)?.startedAt === T0 + 20_000, `entry startedAt ${entryAt(KEY)?.startedAt}`);
  });

  await check('a stamp during a read in flight: later requests don\'t join it, and it writes nothing', async () => {
    reset();
    holdLists = true;
    const first = read();
    await flush();
    clock += 1000;
    await stampGoogleCache(7);
    clock += 1000;
    const second = read();
    await flush();
    assert(listed() === 4, `the second request joined the first: ${listed()} list calls`);
    release(2);
    await first;
    assert(rangeKeys().length === 0, 'the first read wrote although a newer one is in flight');
    release();
    await second;
    assert(entryAt(KEY)?.startedAt === T0 + 2000, `entry startedAt ${entryAt(KEY)?.startedAt}`);
  });

  await check('an older read never overwrites a newer one that already wrote', async () => {
    reset();
    holdLists = true;
    const first = read();
    await flush();
    clock += 1000;
    await stampGoogleCache(7);
    clock += 1000;
    holdLists = false;
    await read();
    assert(entryAt(KEY)?.startedAt === T0 + 2000, 'the newer read did not write');
    release();
    await first;
    assert(entryAt(KEY)?.startedAt === T0 + 2000, `the older read overwrote it: ${entryAt(KEY)?.startedAt}`);
  });

  await check('an older read\'s finally leaves a newer read\'s flight in place', async () => {
    reset();
    holdLists = true;
    const first = read();
    await flush();
    clock += 1000;
    await stampGoogleCache(7);
    clock += 1000;
    const second = read();
    await flush();
    release(2);
    await first;
    const third = read();
    await flush();
    assert(listed() === 4, `the third request started its own read: ${listed()} list calls`);
    release();
    const [two, three] = await Promise.all([second, third]);
    assert(three === two, 'the third request did not get the second read\'s result');
  });

  await check('two concurrent reads: one list call per calendar', async () => {
    reset();
    holdLists = true;
    const a = read();
    const b = read();
    await flush();
    assert(listed() === 2, `${listed()} list calls`);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert(ra.read.status === 'ok' && rb === ra, 'the two requests got different reads');
  });

  // ---- Outcomes ----

  await check('a stale entry whose refresh finds a dead token: the next request says reconnect', async () => {
    reset();
    await read();
    clock += 5 * 60_000;
    const stale = await read();
    assert(stale.read.status === 'ok' && stale.read.stale && deferred.length === 1, show(stale.read));
    tokenFailure = invalidGrant();
    await deferred[0]();
    assert(Number(store.get(STAMP)?.value) === clock, `stamp: ${show(store.get(STAMP))}`);
    clock += 1000;
    const next = await read();
    assert(next.read.status === 'reconnect' && next.read.reason === 'token', `served: ${show(next.read)}`);
  });

  await check('a dead token on a miss: reconnect, the user\'s entries stamped for an hour, nothing written', async () => {
    reset();
    tokenFailure = invalidGrant();
    const r = await read();
    assert(r.read.status === 'reconnect' && r.read.reason === 'token', show(r.read));
    assert(rangeKeys().length === 0, `written: ${show(rangeKeys())}`);
    const stamp = store.get(STAMP);
    assert(Number(stamp?.value) === T0 && stamp?.expiresAt === T0 + 3_600_000, `stamp: ${show(stamp)}`);
  });

  await check('every chosen calendar gone: calendars_gone, stamped, nothing written', async () => {
    reset();
    google = {};
    const r = await read();
    assert(r.read.status === 'error' && r.read.reason === 'calendars_gone', show(r.read));
    assert(store.has(STAMP) && rangeKeys().length === 0, `stamp: ${store.has(STAMP)}, keys: ${show(rangeKeys())}`);
  });

  await check('one gone calendar: ok with goneIds, cached, and a hit marks that calendar unavailable', async () => {
    reset();
    delete google[SPOUSE.calendarId];
    const r = await read();
    assert(r.read.status === 'ok' && show(r.read.goneIds) === show([SPOUSE.calendarId]) && r.read.partial === null, show(r.read));
    assert(show(entryAt(KEY)?.goneIds) === show([SPOUSE.calendarId]) && !store.has(STAMP), `entry: ${show(entryAt(KEY)?.goneIds)}`);
    clock += 60_000;
    const hit = await read();
    assert(listed() === 2 && hit.read.status === 'ok', `${listed()} list calls`);
    assert(show(hit.read.goneIds) === show([SPOUSE.calendarId]), show(hit.read));
    const legend = Object.fromEntries(hit.read.calendars.map(c => [c.id, c.unavailable ?? false]));
    assert(legend[SPOUSE.calendarId] === true && legend[KIDS.calendarId] === false, `legend: ${show(legend)}`);
  });

  await check('a partial read (one calendar failing) is not cached', async () => {
    reset();
    google[SPOUSE.calendarId] = { error: httpError(500, 'Backend Error', 'backendError') };
    const r = await read();
    assert(r.read.status === 'ok' && r.read.partial?.failed === 1 && r.items.length === 2, show(r.read));
    assert(redisLog.some(c => c.cmd === 'mget'), 'the cache was never read');
    assert(rangeKeys().length === 0 && !store.has(STAMP), `keys: ${show(rangeKeys())}`);
  });

  await check('a truncated read (5,001 items over three pages) is not cached, and the next read lists again', async () => {
    reset();
    // Nearly all cancelled, so the entry would be small: only the truncation keeps it out.
    const cancelled = (from: number, n: number) => Array.from({ length: n }, (_, i) => event(`x${from + i}`, '2026-10-18', { status: 'cancelled' }));
    const pages = [[event('k1', '2026-10-18'), ...cancelled(0, 2499)], cancelled(2499, 2500), [event('k3', '2026-10-21')]];
    google[KIDS.calendarId] = { summary: 'Family (kids)', pages };
    const r = await read();
    assert(r.read.status === 'ok' && show(r.read.partial) === show({ failed: 0, truncated: 1 }), show(r.read));
    assert(r.items.map(i => i.event.eventId).join() === 'k1,s1', `items: ${r.items.map(i => i.event.eventId).join()}`);
    assert(listCalls.filter(c => c.calendarId === KIDS.calendarId).length === 2, `the cap did not stop the paging: ${show(listCalls)}`);
    assert(redisLog.some(c => c.cmd === 'mget'), 'the cache was never read');
    assert(rangeKeys().length === 0 && !store.has(STAMP), `keys: ${show(rangeKeys())}`);
    clock += 60_000;
    const again = await read();
    assert(again.read.status === 'ok' && listed() === 6, `the next read made ${listed() - 3} list calls`);
    // The first 5,000 with nothing after them are a whole read, and that one is written.
    reset();
    google[KIDS.calendarId] = { summary: 'Family (kids)', pages: pages.slice(0, 2) };
    const whole = await read();
    assert(whole.read.status === 'ok' && whole.read.partial === null, show(whole.read));
    assert(show(rangeKeys()) === show([KEY]), `keys: ${show(rangeKeys())}`);
  });

  await check('a failed read is neither cached nor stamped', async () => {
    reset();
    google[KIDS.calendarId] = { error: httpError(500, 'Backend Error', 'backendError') };
    google[SPOUSE.calendarId] = { error: httpError(503, 'Service Unavailable', 'backendError') };
    const r = await read();
    assert(r.read.status === 'error' && r.read.reason === 'transient', show(r.read));
    assert(redisLog.some(c => c.cmd === 'mget'), 'the cache was never read');
    assert(rangeKeys().length === 0 && !store.has(STAMP), `keys: ${show(rangeKeys())}`);
  });

  await check('an entry over 512 KB is not written', async () => {
    reset();
    const long = 'x'.repeat(500);
    google[KIDS.calendarId] = {
      summary: 'Kids',
      items: Array.from({ length: 1200 }, (_, i) => event(`big${i}`, '2026-10-18', { description: long, location: 'Community centre, hall B' })),
    };
    const r = await read();
    assert(r.read.status === 'ok' && r.items.length === 1201, `${r.items.length} items`);
    assert(redisLog.some(c => c.cmd === 'mget'), 'the cache was never read');
    assert(rangeKeys().length === 0, 'a value over 512 KB was written');
  });

  // ---- fresh=1 ----

  await check('fresh=1 twice within 30 s on one window: the second reads as use; another window is honoured', async () => {
    reset();
    await read();
    clock += 10_000;
    await read(undefined, { googleCache: 'refresh' });
    const freshKey = `gcal:fresh:7:${WEEK.from.toISOString()}:${WEEK.to.toISOString()}`;
    assert(listed() === 4, `the first refresh made ${listed() - 2} list calls`);
    assert(store.get(freshKey)?.expiresAt === clock + 30_000, `limit key: ${show(store.get(freshKey))}`);
    assert(entryAt(KEY)?.startedAt === clock, 'the refresh did not write');
    clock += 10_000;
    const second = await read(undefined, { googleCache: 'refresh' });
    assert(listed() === 4 && second.read.status === 'ok' && !second.read.stale, `the second refresh made ${listed() - 4} list calls`);
    await read(undefined, { googleCache: 'refresh' }, NEXT_WEEK);
    assert(listed() === 6, `another window: ${listed() - 4} list calls`);
    clock += 21_000;
    await read(undefined, { googleCache: 'refresh' });
    assert(listed() === 8, `31 s after the first: ${listed() - 6} list calls`);
  });

  await check('fresh=1 joins only a read that started after it arrived; later requests join the newest', async () => {
    reset();
    holdLists = true;
    const before = read();
    await flush();
    clock += 1000;
    const refresh = read(undefined, { googleCache: 'refresh' });
    await flush();
    assert(listed() === 4, `the refresh joined a read from before it arrived: ${listed()} list calls`);
    const after = read();
    await flush();
    assert(listed() === 4, `a later request started a third read: ${listed()} list calls`);
    release();
    const [, fresh, later] = await Promise.all([before, refresh, after]);
    assert(later === fresh, 'the later request did not join the refresh');
    assert(entryAt(KEY)?.startedAt === T0 + 1000, `entry startedAt ${entryAt(KEY)?.startedAt}`);
  });

  // ---- Redis failing ----

  await check('Redis down: an MGET error is a miss with no write, and a warning', async () => {
    reset();
    redisFaults.add('mget');
    const r = await read();
    assert(r.read.status === 'ok' && r.items.length === 3 && listed() === 2, show(r.read));
    assert(!redisLog.some(c => c.cmd === 'set'), `commands: ${show(redisLog)}`);
    assert(cacheWarned(), `captured: ${show(captured)}`);
  });

  await check('a failed write still answers with Google\'s read', async () => {
    reset();
    redisFaults.add('set');
    const r = await read();
    assert(r.read.status === 'ok' && r.items.length === 3, show(r.read));
    assert(cacheWarned(), `captured: ${show(captured)}`);
  });

  await check('a Redis that never answers the cache read: the live answer after about 750 ms, one warning, one Google read', async () => {
    reset();
    redisHangs.add('mget');
    const started = performance.now();
    const r = await read();
    const took = performance.now() - started;
    assert(r.read.status === 'ok' && r.items.length === 3 && listed() === 2, `${show(r.read)}, ${listed()} lists`);
    assert(took >= 700 && took < 2000, `took ${Math.round(took)} ms`);
    assert(captured.filter(c => c.context === 'calendar-read-google-cache' && c.severity === 'warning' && /750 ms/.test(c.message)).length === 1, `captured: ${show(captured)}`);
    assert(!redisLog.some(c => c.cmd === 'set'), `an entry was written after a cache miss by timeout: ${show(redisLog)}`);
  });

  await check('a fresh-limit set that never answers (refresh): the same, 750 ms then the live read', async () => {
    reset();
    redisHangs.add('set-nx');
    const started = performance.now();
    const r = await read(googleUser(), { googleCache: 'refresh' });
    const took = performance.now() - started;
    assert(r.read.status === 'ok' && r.items.length === 3 && listed() === 2, `${show(r.read)}, ${listed()} lists`);
    assert(took >= 700 && took < 2000 && cacheWarned(), `took ${Math.round(took)} ms, captured: ${show(captured)}`);
  });

  await check('an entry write that never answers: the read still returns, within about 750 ms, with a warning', async () => {
    reset();
    redisHangs.add('set');
    const started = performance.now();
    const r = await read();
    const took = performance.now() - started;
    assert(r.read.status === 'ok' && r.items.length === 3 && listed() === 2, show(r.read));
    assert(took >= 700 && took < 2000, `took ${Math.round(took)} ms`);
    assert(cacheWarned(), `captured: ${show(captured)}`);
  });

  // ---- Shared state ----

  await check('reads in flight and last writes live on globalThis; a last write is forgotten after 30 minutes', async () => {
    reset();
    holdLists = true;
    const r = read();
    await flush();
    const state = shared();
    assert(state.__gcalInflight instanceof Map && state.__gcalInflight.has(KEY), 'no flight on globalThis');
    release();
    await r;
    assert(state.__gcalInflight.size === 0, 'the flight outlived its read');
    assert(state.__gcalWritten?.get(KEY) === T0, `last write: ${show([...(state.__gcalWritten ?? new Map()).entries()])}`);
    clock += 30 * 60_000 + 1;
    holdLists = false;
    await read(undefined, {}, NEXT_WEEK);
    assert(!state.__gcalWritten.has(KEY) && state.__gcalWritten.size === 1, `last writes: ${show([...state.__gcalWritten.keys()])}`);
  });

  await check('a read that fails unexpectedly leaves no flight and no entry behind', async () => {
    reset();
    authThrows = true;
    // The live read reports a throw as error('unknown'); a rejection must leave the same state.
    const outcome = await read().then(r => r.read.status, () => 'rejected');
    assert(outcome === 'error' || outcome === 'rejected', `outcome ${outcome}`);
    assert(shared().__gcalInflight?.size === 0, 'the failed read is still in flight');
    assert(rangeKeys().length === 0 && !store.has(STAMP), `keys: ${show(rangeKeys())}`);
    authThrows = false;
    const r = await read();
    assert(r.read.status === 'ok' && listed() === 2, `${listed()} list calls`);
  });

  await check('a token server that never answers: timeout within the deadline, no flight left, and the next read runs its own token step', async () => {
    reset();
    tokenHangs = true;
    const started = performance.now();
    const r = await read(undefined, { deadlineMs: 600 });
    const ms = performance.now() - started;
    assert(r.read.status === 'error' && r.read.reason === 'timeout', show(r.read));
    assert(ms >= 550 && ms < 900, `took ${Math.round(ms)} ms`);
    assert(shared().__gcalInflight?.size === 0 && !shared().__gcalInflight?.has(KEY), 'the timed-out read is still in flight');
    assert(rangeKeys().length === 0 && !store.has(STAMP) && listed() === 0, `keys: ${show(rangeKeys())}, ${listed()} list calls`);
    tokenHangs = false;
    const next = await read();
    assert(tokenSteps === 2, `${tokenSteps} token steps: the next read joined the hung one`);
    assert(next.read.status === 'ok' && listed() === 2, `${show(next.read)}, ${listed()} list calls`);
  });

  // ---- Calendar colours (spec 2026-10-19 §3.1) ----

  /** The legend's and the items' colours by calendar id; the two must agree. */
  const coloursOf = (r: Awaited<ReturnType<typeof read>>) => {
    assert(r.read.status === 'ok', show(r.read));
    const legend = Object.fromEntries(r.read.calendars.map(c => [c.id, c.color]));
    for (const i of r.items) assert(i.calendar.color === legend[i.calendar.id ?? ''], `${i.key}: ${i.calendar.color}, the legend says ${legend[i.calendar.id ?? '']}`);
    return legend;
  };
  const LIVE = [{ id: KIDS.calendarId, backgroundColor: '#7BD148' }, { id: 'boss@corp.example', backgroundColor: '#ff0000' }];

  await check('colours: a cached read asks calendarList once (one page of 250, ids and colours only, hidden calendars included, the lists\' timeout); Google\'s live colour wins over the saved one, a calendar it gives none keeps its saved colour, one with neither has none; the entry keeps the set\'s live colours only', async () => {
    reset();
    colourList = LIVE;
    const r = await read();
    assert(show(colourCalls) === show([{ maxResults: 250, showHidden: true, fields: 'items(id,backgroundColor)', timeout: 5500 }]), `calls: ${show(colourCalls)}`);
    assert(show(coloursOf(r)) === show({ [KIDS.calendarId]: '#7bd148', [SPOUSE.calendarId]: '#f4511e' }), `colours: ${show(coloursOf(r))}`);
    assert(show(entryAt(KEY)?.colours) === show({ [KIDS.calendarId]: '#7bd148' }), `entry colours: ${show(entryAt(KEY)?.colours)}`);
    assert(!live(KEY)!.value.includes('boss@corp.example'), 'an unchosen calendar\'s id reached the cache');
    reset();
    colourList = LIVE;
    const bare = await read(googleUser({ calendarAssignments: [{ ...KIDS, color: '' }, { ...SPOUSE, color: '' }] }));
    assert(show(coloursOf(bare)) === show({ [KIDS.calendarId]: '#7bd148', [SPOUSE.calendarId]: null }), `no saved colours: ${show(coloursOf(bare))}`);
  });

  await check('colours: a hit joins its entry\'s colours with no calendarList call; a stale hit\'s refresh asks again and writes the new ones', async () => {
    reset();
    colourList = LIVE;
    await read();
    clock += 60_000;
    colourList = [{ id: KIDS.calendarId, backgroundColor: '#4986e7' }];
    const hit = await read();
    assert(asked() === 1 && coloursOf(hit)[KIDS.calendarId] === '#7bd148', `${asked()} calls, ${show(coloursOf(hit))}`);
    clock += 3 * 60_000;
    const stale = await read();
    assert(stale.read.status === 'ok' && stale.read.stale && coloursOf(stale)[KIDS.calendarId] === '#7bd148', show(coloursOf(stale)));
    await Promise.all(deferred.splice(0).map(task => task()));
    assert(asked() === 2 && show(entryAt(KEY)?.colours) === show({ [KIDS.calendarId]: '#4986e7' }), `${asked()} calls, entry ${show(entryAt(KEY)?.colours)}`);
    const next = await read();
    assert(coloursOf(next)[KIDS.calendarId] === '#4986e7', `after the refresh: ${show(coloursOf(next))}`);
  });

  await check('colours: ⋯ → Refresh (fresh=1, \'refresh\') over a fresh entry asks calendarList again, answers with the new colour and writes it into the entry', async () => {
    reset();
    colourList = LIVE;
    await read();
    clock += 60_000;
    colourList = [{ id: KIDS.calendarId, backgroundColor: '#4986e7' }];
    const fresh = await read(undefined, { googleCache: 'refresh' });
    assert(asked() === 2 && listed() === 4, `${asked()} calendarList calls, ${listed()} list calls`);
    assert(coloursOf(fresh)[KIDS.calendarId] === '#4986e7', show(coloursOf(fresh)));
    assert(show(entryAt(KEY)?.colours) === show({ [KIDS.calendarId]: '#4986e7' }), `entry colours: ${show(entryAt(KEY)?.colours)}`);
  });

  await check('colours: a failed calendarList, or colours that aren\'t #rrggbb, keep the saved colours and the read: ok, cached (the entry with no colours, so its hits join the saved ones), no Sentry event', async () => {
    reset();
    colourList = 'error';
    const failed = await read();
    assert(failed.read.status === 'ok' && failed.read.partial === null && failed.items.length === 3, show(failed.read));
    assert(show(coloursOf(failed)) === show({ [KIDS.calendarId]: '#33b679', [SPOUSE.calendarId]: '#f4511e' }), show(coloursOf(failed)));
    assert(entryAt(KEY) !== null && entryAt(KEY)?.colours === undefined, `entry: ${show(entryAt(KEY))}`);
    assert(captured.length === 0, `captured: ${show(captured)}`);
    clock += 60_000;
    colourList = LIVE;
    const hit = await read();
    assert(asked() === 1 && coloursOf(hit)[KIDS.calendarId] === '#33b679', `an entry without colours: ${show(coloursOf(hit))}`);
    reset();
    colourList = [{ id: KIDS.calendarId, backgroundColor: 'red' }, { id: SPOUSE.calendarId, backgroundColor: 123 }, { id: SPOUSE.calendarId }];
    const odd = await read();
    assert(show(coloursOf(odd)) === show({ [KIDS.calendarId]: '#33b679', [SPOUSE.calendarId]: '#f4511e' }), `odd colours: ${show(coloursOf(odd))}`);
  });

  await check('colours: an entry whose colours are unreadable is still a hit, with the saved colours; a colour in it that isn\'t #rrggbb is ignored', async () => {
    reset();
    await read();
    for (const colours of ['#7bd148', ['#7bd148'], { [KIDS.calendarId]: 'url(x)' }]) {
      const entry = { ...entryAt(KEY)!, colours };
      store.get(KEY)!.value = JSON.stringify(entry);
      clock += 1000;
      const r = await read();
      assert(listed() === 2 && coloursOf(r)[KIDS.calendarId] === '#33b679', `${show(colours)}: ${listed()} list calls, ${show(coloursOf(r))}`);
    }
  });

  await check('colours: a calendarList that never answers holds the read to its deadline at most; the read is ok with every list\'s items and the saved colours, and leaves nothing in flight', async () => {
    reset();
    colourList = 'hang';
    const started = performance.now();
    const r = await read(undefined, { deadlineMs: 600 });
    const ms = performance.now() - started;
    assert(ms >= 550 && ms < 900, `took ${Math.round(ms)} ms`);
    assert(r.read.status === 'ok' && r.read.partial === null && r.items.length === 3, show(r.read));
    assert(coloursOf(r)[KIDS.calendarId] === '#33b679', show(coloursOf(r)));
    assert(shared().__gcalInflight?.size === 0, 'a read left in flight');
  });

  await check('colours: the summaries (bypass) never ask calendarList, and keep the saved colours; Redis down, the range route\'s live read still asks', async () => {
    reset();
    colourList = LIVE;
    const summary = await readGoogle(googleUser(), WEEK, { tz: TZ, deadlineMs: 6000 });
    assert(asked() === 0 && summary.read.status === 'ok', `${asked()} calls`);
    assert(summary.read.calendars.find(c => c.id === KIDS.calendarId)?.color === '#33b679' && summary.colours === undefined, show(summary.read.calendars));
    redisFaults.add('mget');
    const down = await read();
    assert(asked() === 1 && coloursOf(down)[KIDS.calendarId] === '#7bd148', `Redis down: ${asked()} calls, ${show(coloursOf(down))}`);
  });

  // ---- stampGoogleCache ----

  await check('stampGoogleCache sets gcal:stamp:<id> to now, EX 3600, through its own client', async () => {
    reset();
    clock = T0 + 5;
    await stampGoogleCache(7);
    assert(stampRequests.length === 1, `${stampRequests.length} requests`);
    assert(show(stampRequests[0].commands) === show([['set', STAMP, T0 + 5, 'ex', 3600]]), `sent ${show(stampRequests[0].commands)}`);
    assert(stampRequests[0].abortable, 'the request carries no abort signal');
    assert(redisLog.length === 0, `it went through the shared client: ${show(redisLog)}`);
    assert(store.get(STAMP)?.expiresAt === T0 + 5 + 3_600_000, `stamp: ${show(store.get(STAMP))}`);
  });

  await check('it drops that user\'s weekly recurrence answers', async () => {
    reset();
    await stampGoogleCache(7);
    assert(show(clearedRecurrence) === '[7]', `cleared: ${show(clearedRecurrence)}`);
  });

  await check('Redis refusing: one attempt, no throw, and a warning', async () => {
    reset();
    stampMode = 'throw';
    await stampGoogleCache(7);
    assert(stampRequests.length === 1, `${stampRequests.length} attempts`);
    assert(stampWarned(), `captured: ${show(captured)}`);
  });

  await check('Redis stuck: back within 750 ms, with a warning', async () => {
    reset();
    stampMode = 'stuck';
    const started = performance.now();
    await stampGoogleCache(7);
    const ms = performance.now() - started;
    assert(ms >= 700 && ms < 1000, `took ${Math.round(ms)} ms`);
    assert(stampWarned(), `captured: ${show(captured)}`);
  });

  // ---- The stamp after every bot write to Google ----

  const writer = googleUser();
  const startTime = new RealDate('2026-10-18T07:00:00.000Z');
  const endTime = new RealDate('2026-10-18T08:00:00.000Z');
  const writes: [string, () => Promise<unknown>][] = [
    ['create', () => googleProvider.createEvent(writer, 'primary', { title: 'Dentist', startTime, endTime })],
    ['update', () => googleProvider.updateEvent(writer, 'primary', 'g1', { title: 'Dentist, room 4' })],
    ['delete', () => googleProvider.deleteEvent(writer, 'primary', 'g1')],
  ];

  await check('create, update and delete stamp after the write, and return its result unchanged', async () => {
    for (const [kind, write] of writes) {
      reset();
      const value = { success: true, eventId: `g-${kind}` };
      writeOutcome = { kind: 'result', value };
      const got = await write();
      assert(got === value, `${kind} returned ${show(got)}`);
      assert(show(events) === show([`write ${kind}`, `stamp ${STAMP}`]), `${kind}: ${show(events)}`);
    }
  });

  await check('a failed write (TOKEN_EXPIRED) still stamps, and comes back as it was', async () => {
    for (const [kind, write] of writes) {
      reset();
      const value = { success: false, error: 'TOKEN_EXPIRED', errorMessage: 'Google Calendar token expired' };
      writeOutcome = { kind: 'result', value };
      const got = await write();
      assert(got === value, `${kind} returned ${show(got)}`);
      assert(show(events) === show([`write ${kind}`, `stamp ${STAMP}`]), `${kind}: ${show(events)}`);
    }
  });

  await check('a write that throws still stamps, and the same error is rethrown', async () => {
    for (const [kind, write] of writes) {
      reset();
      const error = new Error(`${kind} blew up (smoke)`);
      writeOutcome = { kind: 'throw', error };
      let thrown: unknown;
      try {
        await write();
      } catch (err) {
        thrown = err;
      }
      assert(thrown === error, `${kind} threw ${String(thrown)}`);
      assert(show(events) === show([`write ${kind}`, `stamp ${STAMP}`]), `${kind}: ${show(events)}`);
    }
  });

  await check('the stamp\'s Redis refusing or stuck: the write\'s result within 750 ms, nothing unhandled', async () => {
    for (const mode of ['throw', 'stuck'] as const) {
      reset();
      stampMode = mode;
      const value = { success: true, eventId: `g-${mode}` };
      writeOutcome = { kind: 'result', value };
      const started = performance.now();
      const got = await googleProvider.createEvent(writer, 'primary', { title: 'Dentist', startTime, endTime });
      const ms = performance.now() - started;
      assert(got === value, `${mode}: returned ${show(got)}`);
      assert(stampRequests.length === 1, `${mode}: ${stampRequests.length} stamp requests`);
      // Awaited, and bounded: a stuck Redis holds the write's answer for the stamp's 750 ms, no longer
      assert(ms < 1000 && (mode === 'throw' || ms >= 700), `${mode}: took ${Math.round(ms)} ms`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    assert(unhandled.length === 0, `unhandled: ${show(unhandled.map(String))}`);
  });

  await check('[guard] no Google token: not connected, with no write and no stamp', async () => {
    reset();
    const got = await googleProvider.createEvent(googleUser({ googleRefreshToken: '' }), 'primary', { title: 'Dentist', startTime, endTime });
    assert(got.success === false && got.error === 'NOT_CONNECTED', show(got));
    assert(events.length === 0, show(events));
  });

  // ---- The stamp after a reconnect ----

  await check('commitGoogleToken stamps after the token save (no transaction: Google as a connection flips nothing) and the reminder-cache update', async () => {
    reset();
    await commitGoogleToken(7, 'new-refresh-token');
    const at = (e: string) => events.indexOf(e);
    assert(at(`stamp ${STAMP}`) >= 0, `no stamp: ${show(events)}`);
    assert(at('db.$transaction') < 0, `a transaction: ${show(events)}`);
    assert(at('db.updateUserById') >= 0 && at(`stamp ${STAMP}`) > at('db.updateUserById'), `order: ${show(events)}`);
    assert(at('reminderCache.update') >= 0 && at(`stamp ${STAMP}`) > at('reminderCache.update'), `order: ${show(events)}`);
  });

  // Free the loop of any read a failed check left waiting on Google
  release();
  await flush();

  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log(`OK    ${r.name}`);
    else {
      failed++;
      console.log(`FAIL  ${r.name}\n      ${r.reason}`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

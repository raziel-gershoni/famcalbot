// Smoke test for the calendar home's Google half without its cache (spec §2.5, §10):
// src/services/calendar-read/google.ts. Today a Google read refreshes the token inside
// the first request, so a dead token, a stuck token server and a rate limit all look
// alike; it asks calendars.get for every calendar's name; it takes Google's first 250
// items and no more; it has no timeout; and it lets working-location blocks, declined
// invites and cancelled items through. The reader runs the token step first inside one
// deadline, lists each chosen calendar in parallel with a trimmed field mask, the user's
// timezone, a request timeout and one retry, pages up to 5,000 items, filters and maps
// each item, joins the calendar legend from the user's choices, and turns every outcome
// into one status for the half.
//
// The reader's events are held to what calendar.ts's fetchTodayEvents (the summaries'
// Google read before the shared reader) made of the same list.
//
// Faked: @googleapis/calendar (its OAuth2 client, calendars.get and events.list), Redis
// (in memory, expiring on a stepped clock), error capture and the admin notifier
// (recorders). Error shapes are built with the installed gaxios and google-auth-library.
// No network. The route's cache, the stamps and the single-flight are checked in
// smoke-calendar-read-google-cache.ts.
//
// Run with the fake env from the task brief; the output must not depend on the server's
// timezone:
//   TZ=UTC npx tsx scripts/smoke-calendar-read-google.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-read-google.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-calendar-read-google.ts

import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { calendar_v3 } from '@googleapis/calendar';
import { nextDate, startOfLocalDay } from '../src/utils/day-events';
import { toRangeDays } from '../src/services/calendar-read/dto';
import { REDIS_KEYS } from '../src/config/redis-keys';
import type { CalendarAssignment, UserConfig } from '../src/types';
import type { GoogleReadOptions, GoogleReadResult } from '../src/services/calendar-read/google';
import type { CalendarRef } from '../src/services/calendar-read/types';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** JSON with sorted keys and no undefined fields, so two shapes compare by content. */
function canon(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

function assertSame(got: unknown, want: unknown, what: string) {
  assert(canon(got) === canon(want), `${what}\n     got  ${canon(got)}\n     want ${canon(want)}`);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** A list's length read afresh: an assert on `.length` would narrow it for the checks after it. */
const count = (list: readonly unknown[]): number => list.length;

/** Waits until cond holds (background reporting is fire-and-forget), at most `ms`. */
async function until(cond: () => boolean, ms = 1000) {
  const start = performance.now();
  while (!cond() && performance.now() - start < ms) await sleep(5);
}

// ---- Clock: every argument-less new Date() and Date.now() reads `clock` ----

const BASE_CLOCK = Date.parse('2026-10-14T13:00:00Z'); // 09:00 in New York
let clock = BASE_CLOCK;
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

// ---- Fake Google ----

type Page = calendar_v3.Schema$Events;
type ListParams = calendar_v3.Params$Resource$Events$List;
type ListOptions = { timeout?: number; retryConfig?: { retry?: number; noResponseRetries?: number } };

/** A reply that comes after a delay (real time; the deadline runs on real timers). */
class Later {
  constructor(readonly afterMs: number, readonly reply: Page | Error) {}
}
/** What one events.list request does: answer with a page, fail, never answer, or answer later. */
type Reply = Page | Error | 'hang' | Later;
/** A calendar's replies by page (page n is asked for with pageToken `p<n>`); the last one repeats. */
type Script = Reply[] | ((pageIndex: number) => Reply);

const google = {
  /** The token step: what getAccessToken answers. */
  token: (): Promise<unknown> => Promise.resolve({ token: 'access-token' }),
  pages: {} as Record<string, Script>,
  calls: [] as { params: ListParams; options?: ListOptions }[],
  /** Requests in call order: 'token', 'get:<id>', 'list:<id>'. */
  log: [] as string[],
  clients: 0,
  credentials: [] as unknown[],
  factory: [] as { version?: string; auth?: unknown }[],
  inFlight: 0,
  maxInFlight: 0,
};

function answer(reply: Reply): Promise<{ data: Page }> {
  if (reply === 'hang') return new Promise(() => {});
  if (reply instanceof Error) return Promise.reject(reply);
  if (reply instanceof Later) {
    const later = reply;
    return new Promise((resolve, reject) =>
      setTimeout(() => (later.reply instanceof Error ? reject(later.reply) : resolve({ data: later.reply })), later.afterMs),
    );
  }
  return Promise.resolve({ data: reply });
}

function track<T>(promise: Promise<T>): Promise<T> {
  google.inFlight++;
  google.maxInFlight = Math.max(google.maxInFlight, google.inFlight);
  promise.then(() => { google.inFlight--; }, () => { google.inFlight--; });
  return promise;
}

class FakeOAuth2 {
  constructor(readonly clientId?: string, readonly clientSecret?: string) {
    google.clients++;
  }
  setCredentials(credentials: unknown) {
    google.credentials.push(credentials);
  }
  getAccessToken() {
    google.log.push('token');
    return google.token();
  }
}

/** calendarList.list's answer (listUserCalendars). */
let calendarListItems: calendar_v3.Schema$CalendarListEntry[] = [];
/** The sync links the fake DB holds (listUserCalendars hides their Google calendars). */
let syncLinks: { id?: string; userId: number; googleCalendarId: string | null; enabled: boolean }[] = [];

const fakeGoogleModule = {
  __esModule: true,
  auth: { OAuth2: FakeOAuth2 },
  calendar: (options: { version?: string; auth?: unknown }) => {
    google.factory.push(options);
    return {
      calendarList: {
        list: async () => {
          google.log.push('calendarList');
          return { data: { items: calendarListItems } };
        },
      },
      calendars: {
        get: async ({ calendarId }: { calendarId: string }) => {
          google.log.push(`get:${calendarId}`);
          return { data: { summary: TITLES[calendarId] ?? calendarId } };
        },
      },
      events: {
        list: (params: ListParams, options?: ListOptions) => {
          google.calls.push({ params: { ...params }, options });
          google.log.push(`list:${params.calendarId}`);
          const script = google.pages[params.calendarId ?? ''] ?? [{ items: [] }];
          const index = params.pageToken ? Number(params.pageToken.slice(1)) - 1 : 0;
          const reply = typeof script === 'function' ? script(index) : script[Math.min(index, script.length - 1)];
          return track(answer(reply));
        },
      },
    };
  },
};

// ---- Real error shapes: gaxios's error, run through google-auth-library's processError ----

const calendarRequire = createRequire(require.resolve('@googleapis/calendar'));
const { GaxiosError } = calendarRequire('gaxios') as {
  GaxiosError: new (message: string, config: object, response?: object, error?: Error) => Error;
};
const { DefaultTransporter } = calendarRequire('google-auth-library') as {
  DefaultTransporter: new () => { processError(e: Error): Error };
};

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function googleError(url: string, method: 'GET' | 'POST', status: number, data: unknown): Error {
  const config = { url, method };
  const response = { config, data, status, statusText: '', headers: {} };
  return new DefaultTransporter().processError(new GaxiosError(`Request failed with status code ${status}`, config, response));
}

/** The token step's failure: refreshAccessTokenAsync prefixes a 403 or 404 (oauth2client.js:336-342). */
function tokenError(status: number, data: unknown): Error {
  const err = googleError(TOKEN_URL, 'POST', status, data);
  if (status === 403 || status === 404) err.message = `Could not refresh access token: ${err.message}`;
  return err;
}

/** An events.list failure with Google's JSON error body. */
function apiError(calendarId: string, status: number, reason: string, message: string): Error {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  return googleError(url, 'GET', status, { error: { code: status, message, errors: [{ domain: 'global', reason, message }] } });
}

// ---- Fake Redis (Upstash round-trips values through JSON), recorders ----

let redisDown = false;
const redisStore = new Map<string, { value: unknown; expiresAt: number | null }>();
const redisSets: { key: string; opts?: { nx?: boolean; ex?: number } }[] = [];
function liveEntry(key: string) {
  const entry = redisStore.get(key);
  if (entry && entry.expiresAt !== null && entry.expiresAt <= clock) {
    redisStore.delete(key);
    return undefined;
  }
  return entry;
}
const fakeRedis = {
  set: async (key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
    if (redisDown) throw new Error('Upstash unreachable');
    redisSets.push({ key, opts });
    if (opts?.nx && liveEntry(key)) return null;
    redisStore.set(key, { value: JSON.parse(JSON.stringify(value)), expiresAt: opts?.ex ? clock + opts.ex * 1000 : null });
    return 'OK';
  },
  get: async (key: string) => {
    if (redisDown) throw new Error('Upstash unreachable');
    return liveEntry(key)?.value ?? null;
  },
  del: async (key: string) => {
    if (redisDown) throw new Error('Upstash unreachable');
    return redisStore.delete(key) ? 1 : 0;
  },
};

let captures: { error: unknown; context: string; extra?: Record<string, unknown>; severity: string }[] = [];
let warnings: { message: string; context: string; extra?: Record<string, unknown> }[] = [];
let adminAlerts: { context: string; error: unknown; info?: string }[] = [];
const unhandled: unknown[] = [];
process.on('unhandledRejection', reason => { unhandled.push(reason); });

const SRC = path.resolve(__dirname, '../src');
const stubs: Record<string, object> = {
  '@googleapis/calendar': fakeGoogleModule,
  [`${SRC}/utils/redis.ts`]: { __esModule: true, redis: fakeRedis },
  // Only the copy links are read here (listUserCalendars); the fake answers that query alone.
  [`${SRC}/utils/prisma.ts`]: {
    __esModule: true,
    prisma: {
      googleSyncLink: {
        // Every link of the user, on or off, with or without a stored Google calendar
        // (S4: a calendar made but whose id was never stored is found by its token).
        findMany: async ({ where, select }: { where: { userId: number }; select: Record<string, boolean> }) => {
          google.log.push('db:googleSyncLink');
          assert(Object.keys(where).join(',') === 'userId', `unexpected link query ${JSON.stringify(where)}`);
          assert(Object.keys(select).sort().join(',') === 'googleCalendarId,id', `unexpected link select ${JSON.stringify(select)}`);
          return syncLinks.filter(l => l.userId === where.userId).map((l, i) => ({ id: l.id ?? `link-${l.userId}-${i}`, googleCalendarId: l.googleCalendarId }));
        },
      },
    },
    withRetry: (fn: () => unknown) => fn(),
  },
  [`${SRC}/lib/error-capture.ts`]: {
    __esModule: true,
    captureError: (error: unknown, context: string, extra?: Record<string, unknown>, severity = 'error') => {
      captures.push({ error, context, extra, severity });
    },
    captureWarning: (message: string, context: string, extra?: Record<string, unknown>) => {
      warnings.push({ message, context, extra });
    },
    captureInfo: () => {},
  },
  // google.ts loads the notifier with import(); __esModule lets that see the named export.
  [`${SRC}/utils/error-notifier.ts`]: {
    __esModule: true,
    notifyAdminError: async (context: string, error: unknown, info?: string) => {
      adminAlerts.push({ context, error, info });
    },
    notifyAdminWarning: async () => {},
  },
};

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  if (request in stubs) return stubs[request];
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  return stubs[resolved] ?? realLoad.call(this, request, parent, isMain);
};
// google.ts loads the notifier with import(). On Node 22 that import goes past
// Module._load and sees no named export, so an ES module hook serves the same stub
// objects to import() (as smoke-calendar-read-google-cache does).
(globalThis as { smokeStubs?: typeof stubs }).smokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    const stub = stubs[file];
    if (!stub) return nextLoad(url, context);
    const names = Object.keys(stub).filter(name => name !== '__esModule').map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.smokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

// ---- Fixtures ----

const NY = 'America/New_York';
const DAY = '2026-10-14';
const DAY_WINDOW = { from: startOfLocalDay(DAY, NY), to: startOfLocalDay(nextDate(DAY), NY) };
const FIELDS =
  'summary,nextPageToken,items(id,status,summary,description,location,start,end,recurringEventId,originalStartTime,eventType,attendees(self,responseStatus),htmlLink,extendedProperties(private))';

const DANA = 'dana@example.com';
const AVI = 'avi.cohen@example.com';
const KIDS = 'family0123@group.calendar.google.com';
/** Each calendar's title in Google (events.list's top-level summary, calendars.get's summary). */
const TITLES: Record<string, string> = { [DANA]: 'dana@example.com', [AVI]: 'Avi Cohen', [KIDS]: 'Family' };
/** The user's choices, as select-calendars saved them: their own names and colours. */
const ASSIGNMENTS: CalendarAssignment[] = [
  { calendarId: DANA, labels: ['primary', 'yours'], name: 'Dana', color: '#7986cb' },
  { calendarId: AVI, labels: ['spouse'], name: 'Avi (work)', color: '#33b679', personName: 'Avi' },
  { calendarId: KIDS, labels: ['kids'], name: 'Kids', color: '' },
];
const LEGEND: CalendarRef[] = [
  { id: DANA, source: 'google', name: 'Dana', color: '#7986cb', mine: true, inLegend: true },
  { id: AVI, source: 'google', name: 'Avi (work)', color: '#33b679', mine: false, ownerName: 'Avi', inLegend: true },
  { id: KIDS, source: 'google', name: 'Kids', color: null, mine: true, inLegend: true },
];

const user = (extra: Partial<UserConfig> = {}): UserConfig =>
  ({
    id: 7,
    telegramId: 7007,
    name: 'Dana',
    language: 'en',
    calendarSource: 'GOOGLE',
    googleRefreshToken: 'refresh-7',
    pairingId: null,
    calendarAssignments: ASSIGNMENTS,
    ...extra,
  }) as unknown as UserConfig;

type Raw = calendar_v3.Schema$Event;
const timed = (id: string, summary: string | undefined, start: string, end: string, extra: Raw = {}): Raw =>
  ({ id, status: 'confirmed', summary, start: { dateTime: start, timeZone: NY }, end: { dateTime: end, timeZone: NY }, ...extra });
const allDay = (id: string, summary: string, start: string, end: string, extra: Raw = {}): Raw =>
  ({ id, status: 'confirmed', summary, start: { date: start }, end: { date: end }, ...extra });

/** One New York day, plain-text descriptions only (spec §10: the mapping parity fixtures). */
const DAY_EVENTS: Record<string, Raw[]> = {
  [DANA]: [
    timed('school-run', 'School run', '2026-10-14T07:30:00-04:00', '2026-10-14T08:00:00-04:00', {
      location: 'Oak Street School',
      description: 'Bring the permission slip',
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
    }),
    timed('dentist', 'Dentist', '2026-10-14T09:00:00-04:00', '2026-10-14T10:00:00-04:00', { reminders: { useDefault: true } }),
    timed('untitled', undefined, '2026-10-14T12:00:00-04:00', '2026-10-14T12:30:00-04:00', {
      htmlLink: 'https://www.google.com/calendar/event?eid=dW50aXRsZWQ',
    }),
    timed('gym_20261014T220000Z', 'Gym', '2026-10-14T18:00:00-04:00', '2026-10-14T19:00:00-04:00', {
      recurringEventId: 'gym',
      originalStartTime: { dateTime: '2026-10-14T18:00:00-04:00' },
    }),
  ],
  [AVI]: [
    allDay('mom-birthday', "Mom's birthday", '2026-10-14', '2026-10-15', { eventType: 'birthday' }),
    timed('standup', 'Standup', '2026-10-14T09:00:00-04:00', '2026-10-14T09:15:00-04:00', { eventType: 'default' }),
    timed('flight', 'Flight to Boston', '2026-10-14T21:00:00-04:00', '2026-10-15T01:30:00-04:00', { eventType: 'fromGmail' }),
  ],
  [KIDS]: [timed('pickup', 'Pickup', '2026-10-14T15:00:00-04:00', '2026-10-14T15:30:00-04:00')],
};
const dayPage = (calendarId: string): Page => ({ summary: TITLES[calendarId], items: DAY_EVENTS[calendarId] });
const dayPages = (): Record<string, Script> => Object.fromEntries(Object.keys(DAY_EVENTS).map(id => [id, [dayPage(id)]]));

const bulk = (prefix: string, count: number): Raw[] =>
  Array.from({ length: count }, (_, k) => timed(`${prefix}-${k}`, 'Busy', '2026-10-14T10:00:00-04:00', '2026-10-14T10:30:00-04:00'));

function reset() {
  clock = BASE_CLOCK;
  google.token = () => Promise.resolve({ token: 'access-token' });
  google.pages = dayPages();
  google.calls = [];
  google.log = [];
  google.clients = 0;
  google.credentials = [];
  google.factory = [];
  google.inFlight = 0;
  google.maxInFlight = 0;
  redisDown = false;
  calendarListItems = [];
  syncLinks = [];
  redisStore.clear();
  redisSets.length = 0;
  captures = [];
  warnings = [];
  adminAlerts = [];
}

async function check(name: string, fn: () => Promise<void>) {
  reset();
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
  // Let the read's fire-and-forget reporting finish before the next check resets the fakes.
  await sleep(30);
}

/** The read's status without its cause and legend (those are checked on their own). */
function statusOf(r: GoogleReadResult): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...r.read };
  delete copy.cause;
  delete copy.calendars;
  return copy;
}
const OK = { status: 'ok', goneIds: [], partial: null, stale: false };
const ids = (r: GoogleReadResult) => r.items.map(i => i.event.eventId);
const listedCalendars = () => google.calls.map(c => c.params.calendarId);
/**
 * What calendar.ts's fetchTodayEvents made of the day's list in New York, plus provider,
 * minus reminders: taken from it before it was removed.
 */
const DAY_READ = [
  { summary: "Mom's birthday", start: '2026-10-14', end: '2026-10-15', calendarName: TITLES[AVI], calendarId: AVI, eventType: 'birthday', eventId: 'mom-birthday', provider: 'google' },
  { summary: 'School run', start: '2026-10-14T07:30:00-04:00', end: '2026-10-14T08:00:00-04:00', description: 'Bring the permission slip', location: 'Oak Street School', calendarName: TITLES[DANA], calendarId: DANA, eventId: 'school-run', provider: 'google' },
  { summary: 'Dentist', start: '2026-10-14T09:00:00-04:00', end: '2026-10-14T10:00:00-04:00', calendarName: TITLES[DANA], calendarId: DANA, eventId: 'dentist', provider: 'google' },
  { summary: 'Standup', start: '2026-10-14T09:00:00-04:00', end: '2026-10-14T09:15:00-04:00', calendarName: TITLES[AVI], calendarId: AVI, eventType: 'default', eventId: 'standup', provider: 'google' },
  { summary: 'No title', start: '2026-10-14T12:00:00-04:00', end: '2026-10-14T12:30:00-04:00', calendarName: TITLES[DANA], calendarId: DANA, eventId: 'untitled', provider: 'google' },
  { summary: 'Pickup', start: '2026-10-14T15:00:00-04:00', end: '2026-10-14T15:30:00-04:00', calendarName: TITLES[KIDS], calendarId: KIDS, eventId: 'pickup', provider: 'google' },
  { summary: 'Gym', start: '2026-10-14T18:00:00-04:00', end: '2026-10-14T19:00:00-04:00', calendarName: TITLES[DANA], calendarId: DANA, recurringEventId: 'gym', eventId: 'gym_20261014T220000Z', provider: 'google' },
  { summary: 'Flight to Boston', start: '2026-10-14T21:00:00-04:00', end: '2026-10-15T01:30:00-04:00', calendarName: TITLES[AVI], calendarId: AVI, eventType: 'fromGmail', eventId: 'flight', provider: 'google' },
];

async function main() {
  // A read that never settles would end the process with nothing printed; fail loudly instead.
  setTimeout(() => {
    console.error('FAIL  the smoke did not finish within 60 s (a read never settled)');
    process.exit(1);
  }, 60_000);
  const calendar = await import('../src/services/calendar');
  const reader = await import('../src/services/calendar-read/google');
  const readGoogle: (u: UserConfig, w: { from: Date; to: Date }, o: GoogleReadOptions) => Promise<GoogleReadResult> = reader.readGoogle;
  const read = (u: UserConfig = user(), o: Partial<GoogleReadOptions> = {}) =>
    readGoogle(u, DAY_WINDOW, { tz: NY, deadlineMs: 6000, ...o });

  // ---- calendar.ts and the keys ----

  await check('getGoogleAuth builds the OAuth2 client getCalendarClient used to build inline; getCalendarClient wraps it', async () => {
    const auth = calendar.getGoogleAuth('refresh-a') as unknown as FakeOAuth2;
    assert(auth instanceof FakeOAuth2, 'getGoogleAuth did not return the OAuth2 client');
    assert(auth.clientId === process.env.GOOGLE_CLIENT_ID && auth.clientSecret === process.env.GOOGLE_CLIENT_SECRET, 'not built from the client env');
    assertSame(google.credentials, [{ refresh_token: 'refresh-a' }], 'credentials');
    assert(count(google.factory) === 0, 'getGoogleAuth built a calendar client');
    calendar.getCalendarClient('refresh-b');
    assertSame(google.credentials, [{ refresh_token: 'refresh-a' }, { refresh_token: 'refresh-b' }], 'credentials after getCalendarClient');
    assert(count(google.factory) === 1 && google.factory[0].version === 'v3', 'getCalendarClient did not build a v3 client');
    assert(google.factory[0].auth instanceof FakeOAuth2 && google.clients === 2, 'getCalendarClient did not use a fresh OAuth2 client');
  });

  await check('the gcal Redis keys have the spec formats', async () => {
    assert(REDIS_KEYS.gcalRange(7, '0123456789abcdef', 'Asia/Jerusalem', '2026-10-14', '2026-10-21') === 'gcal:range:v1:7:0123456789abcdef:Asia/Jerusalem:2026-10-14:2026-10-21', 'gcalRange');
    assert(REDIS_KEYS.gcalStamp(7) === 'gcal:stamp:7', 'gcalStamp');
    assert(REDIS_KEYS.gcalGoneWarned(7) === 'gcal:gone_warned:7', 'gcalGoneWarned');
    assert(REDIS_KEYS.gcalFresh(7, '2026-10-14', '2026-10-21') === 'gcal:fresh:7:2026-10-14:2026-10-21', 'gcalFresh');
    assert(REDIS_KEYS.gcalConfigAlert() === 'gcal:config_alert', 'gcalConfigAlert');
  });

  // ---- Request shape ----

  await check('request: token step first, then one events.list with the spec params and options, no calendars.get', async () => {
    const r = await read(user(), { calendarIds: [DANA] });
    assertSame(statusOf(r), OK, 'status');
    assertSame(google.log, ['token', `list:${DANA}`], 'request order');
    assertSame(google.credentials, [{ refresh_token: 'refresh-7' }], 'credentials');
    assertSame(google.calls[0].params, {
      calendarId: DANA,
      timeMin: '2026-10-14T04:00:00.000Z',
      timeMax: '2026-10-15T04:00:00.000Z',
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: NY,
      maxResults: 2500,
      maxAttendees: 1,
      fields: FIELDS,
    }, 'params');
    assert(!('eventTypes' in google.calls[0].params), 'eventTypes was sent');
    assertSame(google.calls[0].options, { timeout: 5500, retryConfig: { retry: 1, noResponseRetries: 0 } }, 'options');
  });

  await check('request: the timeout is min(10 s, deadline - 500 ms)', async () => {
    await read(user(), { calendarIds: [DANA], deadlineMs: 30000 });
    assert(google.calls[0].options?.timeout === 10000, `timeout ${google.calls[0].options?.timeout} at a 30 s deadline`);
    google.calls = [];
    await read(user(), { calendarIds: [DANA], deadlineMs: 8000 });
    assert(google.calls[0].options?.timeout === 7500, `timeout ${google.calls[0].options?.timeout} at an 8 s deadline`);
  });

  await check('request: the calendars are listed in parallel, in the order of the choices', async () => {
    google.pages = Object.fromEntries(Object.keys(DAY_EVENTS).map(id => [id, [new Later(40, dayPage(id))]]));
    const r = await read();
    assertSame(statusOf(r), OK, 'status');
    assertSame(listedCalendars(), [DANA, AVI, KIDS], 'listed');
    assert(google.maxInFlight === 3, `${google.maxInFlight} lists in flight at once`);
  });

  await check('calendarIds narrows the choices and keeps their order; an id the user did not choose is not read', async () => {
    const r = await read(user(), { calendarIds: [KIDS, 'stranger@example.com', DANA] });
    assertSame(listedCalendars(), [DANA, KIDS], 'listed');
    assertSame(r.read.status === 'ok' ? r.read.calendars.map(c => c.id) : null, [DANA, KIDS], 'legend');
  });

  // ---- Mapping ----

  await check("mapping: the reader's events are what the summaries' old day read (calendar.ts fetchTodayEvents) made of the same list, plus provider, minus reminders", async () => {
    const r = await read();
    assertSame(statusOf(r), OK, 'status');
    assertSame(r.items.map(i => i.event), DAY_READ, 'events');
    assert(!google.log.some(entry => entry.startsWith('get:')), 'the reader asked calendars.get');
  });

  await check('mapping: the legend and each item come from the choices; calendarName stays the Google title', async () => {
    const r = await read();
    assert(r.read.status === 'ok', `status ${r.read.status}`);
    assertSame(r.read.calendars, LEGEND, 'legend');
    const byId = new Map(r.items.map(i => [i.event.eventId, i]));
    for (const item of r.items) {
      const ref = LEGEND.find(c => c.id === item.event.calendarId);
      assertSame(item.calendar, ref, `calendar of ${item.event.eventId}`);
      assert(item.event.calendarName === TITLES[item.event.calendarId], `calendarName of ${item.event.eventId}: ${item.event.calendarName}`);
      assert(item.key === `google|${item.event.calendarId}|${item.event.eventId}`, `key ${item.key}`);
    }
    const untitled = byId.get('untitled');
    assert(untitled?.title === null && untitled.event.summary === 'No title', 'untitled item');
    assert(untitled.google?.htmlLink === 'https://www.google.com/calendar/event?eid=dW50aXRsZWQ', 'htmlLink');
    const gym = byId.get('gym_20261014T220000Z');
    assert(gym?.seriesId === 'gym' && gym.originalStart === '2026-10-14T18:00:00-04:00' && gym.recurring && gym.rrule === null, 'recurring instance');
    assert(byId.get('mom-birthday')?.google?.birthday === true && byId.get('standup')?.google?.birthday === false, 'birthday flag');
    assertSame(ids(r), ['mom-birthday', 'school-run', 'dentist', 'standup', 'untitled', 'pickup', 'gym_20261014T220000Z', 'flight'], 'order');
  });

  await check('filter: non-events, declined, cancelled and start-less items are dropped; unknown types kept', async () => {
    const at = (h: string) => `2026-10-14T${h}:00-04:00`;
    google.pages[DANA] = [{
      summary: TITLES[DANA],
      items: [
        timed('office', 'Office', at('08:00'), at('17:00'), { eventType: 'workingLocation' }),
        timed('away', 'Out of office', at('08:00'), at('17:00'), { eventType: 'outOfOffice' }),
        timed('focus', 'Focus time', at('10:00'), at('11:00'), { eventType: 'focusTime' }),
        timed('declined', 'Team dinner', at('19:00'), at('21:00'), { attendees: [{ self: true, responseStatus: 'declined' }] }),
        timed('cancelled', 'Cancelled call', at('11:00'), at('11:30'), { status: 'cancelled' }),
        { id: 'no-start', status: 'confirmed', summary: 'No start' },
        timed('accepted', 'Lunch', at('12:00'), at('13:00'), { attendees: [{ self: true, responseStatus: 'accepted' }] }),
        timed('future-type', 'Something new', at('14:00'), at('15:00'), { eventType: 'someFutureType' }),
      ],
    }];
    const r = await read(user(), { calendarIds: [DANA] });
    assertSame(ids(r), ['accepted', 'future-type'], 'kept');
  });

  await check('one invite on two chosen calendars: an item per calendar, each with its own calendar, both on the day; a decline drops only that copy', async () => {
    // Both parents are invited, so the event (one id) is on Dana's calendar and on Avi's, labelled spouse.
    const invite = (extra: Raw = {}) => timed('evt1', 'Parent-teacher meeting', '2026-10-14T17:00:00-04:00', '2026-10-14T18:00:00-04:00', extra);
    google.pages[DANA] = [{ summary: TITLES[DANA], items: [invite()] }];
    google.pages[AVI] = [{ summary: TITLES[AVI], items: [invite()] }];
    const r = await read(user(), { calendarIds: [DANA, AVI] });
    assertSame(statusOf(r), OK, 'status');
    const copies = (items: GoogleReadResult['items']) => items.map(i => [i.key, i.event.calendarId, i.calendar.mine, i.calendar.ownerName ?? null]);
    assertSame(copies(r.items), [
      [`google|${DANA}|evt1`, DANA, true, null],
      [`google|${AVI}|evt1`, AVI, false, 'Avi'],
    ], 'the two copies');
    // A cache hit joins each item's calendar again from the choices, by event.calendarId (B7).
    const rejoined = reader.attachGoogleCalendars(r.items.map(({ calendar: _calendar, ...item }) => item), ASSIGNMENTS, []);
    assertSame(copies(rejoined), copies(r.items), 'joined again from the choices');
    // The home lists both on the day, in compareItems order: same times and title, so by key.
    const [day] = toRangeDays(r.items, DAY, nextDate(DAY), NY, new Date(), DAY);
    assertSame(day.items.map(i => [i.key, i.calendar.mine, i.calendar.ownerName ?? null]), [
      [`google|${AVI}|evt1`, false, 'Avi'],
      [`google|${DANA}|evt1`, true, null],
    ], 'the day');
    // Avi declined on his calendar: only his copy goes (Ruling R2), Dana's stays.
    google.pages[AVI] = [{ summary: TITLES[AVI], items: [invite({ attendees: [{ self: true, responseStatus: 'declined' }] })] }];
    const declined = await read(user(), { calendarIds: [DANA, AVI] });
    assertSame(copies(declined.items), [[`google|${DANA}|evt1`, DANA, true, null]], 'after the spouse declined');
  });

  await check('a javascript: link in a description is plain text in the DTO (never a link)', async () => {
    google.pages[DANA] = [{ summary: TITLES[DANA], items: [timed('evil', 'Evil', '2026-10-14T09:00:00-04:00', '2026-10-14T10:00:00-04:00', { description: '<a href="javascript:alert(1)">click</a>' })] }];
    const r = await read(user(), { calendarIds: [DANA] });
    const [day] = toRangeDays(r.items, DAY, nextDate(DAY), NY, new Date(), DAY);
    assertSame(day.items.map(i => i.description), ['click (javascript:alert(1))'], 'the description');
  });

  // ---- Paging ----

  await check('paging: follows nextPageToken through an empty page to the end', async () => {
    const at = (h: string) => `2026-10-14T${h}:00-04:00`;
    google.pages[DANA] = [
      { summary: TITLES[DANA], items: [timed('a', 'A', at('08:00'), at('09:00'))], nextPageToken: 'p2' },
      { summary: TITLES[DANA], items: [], nextPageToken: 'p3' },
      { summary: TITLES[DANA], items: [timed('b', 'B', at('10:00'), at('11:00')), timed('c', 'C', at('12:00'), at('13:00'))] },
    ];
    const r = await read(user(), { calendarIds: [DANA] });
    assertSame(statusOf(r), OK, 'status');
    assertSame(google.calls.map(c => c.params.pageToken), [undefined, 'p2', 'p3'], 'page tokens');
    assertSame(ids(r), ['a', 'b', 'c'], 'items');
    assert(google.calls.every(c => c.params.timeMin === google.calls[0].params.timeMin && c.params.fields === FIELDS), 'pages changed the query');
  });

  await check('paging: 5,000 items is the cap; more marks the calendar truncated', async () => {
    google.pages[DANA] = (index: number) => ({ summary: TITLES[DANA], items: bulk(`p${index}`, 2000), nextPageToken: `p${index + 2}` });
    const r = await read(user(), { calendarIds: [DANA] });
    assertSame(statusOf(r), { ...OK, partial: { failed: 0, truncated: 1 } }, 'status');
    assert(google.calls.length === 3, `${google.calls.length} pages asked for`);
    assert(r.items.length === 5000, `${r.items.length} items`);
  });

  await check('paging: exactly 5,000 items with nothing after them is complete', async () => {
    google.pages[DANA] = [
      { summary: TITLES[DANA], items: bulk('first', 2500), nextPageToken: 'p2' },
      { summary: TITLES[DANA], items: bulk('second', 2500) },
    ];
    const r = await read(user(), { calendarIds: [DANA] });
    assertSame(statusOf(r), OK, 'status');
    assert(r.items.length === 5000 && google.calls.length === 2, `${r.items.length} items, ${google.calls.length} pages`);
  });

  // ---- Outcomes ----

  await check('one calendar gone (404) and one ok: ok, with goneIds and the gone calendar marked unavailable', async () => {
    google.pages[AVI] = [apiError(AVI, 404, 'notFound', 'Not Found')];
    const r = await read(user(), { calendarIds: [DANA, AVI] });
    assertSame(statusOf(r), { ...OK, goneIds: [AVI] }, 'status');
    assertSame(r.read.status === 'ok' ? r.read.calendars : null, [LEGEND[0], { ...LEGEND[1], unavailable: true }], 'legend');
    assertSame(ids(r), ['school-run', 'dentist', 'untitled', 'gym_20261014T220000Z'], 'items');
  });

  await check('every chosen calendar gone: error calendars_gone', async () => {
    for (const id of [DANA, AVI, KIDS]) google.pages[id] = [apiError(id, 404, 'notFound', 'Not Found')];
    const r = await read();
    assertSame(statusOf(r), { status: 'error', reason: 'calendars_gone' }, 'status');
    assert(r.items.length === 0, 'items');
  });

  await check('gone calendars: one Sentry warning per user per day (gcalGoneWarned, NX, EX 86400)', async () => {
    google.pages[AVI] = [apiError(AVI, 404, 'notFound', 'Not Found')];
    await read();
    await until(() => warnings.length === 1);
    assert(count(warnings) === 1 && warnings[0].context === 'calendar-read-google' && warnings[0].extra?.user_id === 7, `warnings ${canon(warnings)}`);
    await read();
    await sleep(30);
    assert(count(warnings) === 1, `${warnings.length} warnings after the second read`);
    assert(redisSets.some(s => s.key === 'gcal:gone_warned:7' && s.opts?.nx === true && s.opts.ex === 86400), `sets ${canon(redisSets)}`);
    clock += 86_400_000 + 1000;
    await read();
    await until(() => warnings.length === 2);
    assert(count(warnings) === 2, `${warnings.length} warnings a day later`);
    assert(!captures.some(c => c.severity !== 'warning'), 'a gone calendar was reported as an error');
  });

  await check('missing scopes on one calendar: reconnect scopes, also over another calendar\'s 401', async () => {
    google.pages[AVI] = [apiError(AVI, 403, 'insufficientPermissions', 'Insufficient Permission')];
    google.pages[KIDS] = [apiError(KIDS, 401, 'authError', 'Invalid Credentials')];
    const r = await read();
    assertSame(statusOf(r), { status: 'reconnect', reason: 'scopes' }, 'status');
    assert(r.items.length === 0, 'items on reconnect');
  });

  await check('a 401 on one calendar after the token step: reconnect token', async () => {
    google.pages[KIDS] = [apiError(KIDS, 401, 'authError', 'Invalid Credentials')];
    const r = await read();
    assertSame(statusOf(r), { status: 'reconnect', reason: 'token' }, 'status');
  });

  await check('invalid_grant on the token step: reconnect token, no calendar listed', async () => {
    google.token = () => Promise.reject(tokenError(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
    const r = await read();
    assertSame(statusOf(r), { status: 'reconnect', reason: 'token' }, 'status');
    assert(google.calls.length === 0, `${google.calls.length} lists`);
  });

  await check('invalid_client (HTTP 401) on the token step: error config, an error capture, one admin notice per hour', async () => {
    google.token = () => Promise.reject(tokenError(401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' }));
    const r = await read();
    assertSame(statusOf(r), { status: 'error', reason: 'config' }, 'status');
    assert(google.calls.length === 0, `${google.calls.length} lists`);
    assert(captures.some(c => c.context === 'calendar-read-google' && c.severity === 'error'), `captures ${canon(captures.map(c => c.severity))}`);
    await until(() => adminAlerts.length === 1);
    assert(count(adminAlerts) === 1, 'no admin notice');
    await read();
    await sleep(30);
    assert(count(adminAlerts) === 1, `${adminAlerts.length} admin notices within the hour`);
    assert(redisSets.some(s => s.key === 'gcal:config_alert' && s.opts?.nx === true && s.opts.ex === 3600), `sets ${canon(redisSets)}`);
    clock += 3_600_000 + 1000;
    await read();
    await until(() => adminAlerts.length === 2);
    assert(count(adminAlerts) === 2, `${adminAlerts.length} admin notices an hour later`);
  });

  await check('a 404 on the token step: error unknown, not calendars_gone', async () => {
    google.token = () => Promise.reject(tokenError(404, 'Not Found'));
    const r = await read();
    assertSame(statusOf(r), { status: 'error', reason: 'unknown' }, 'status');
    assert(google.calls.length === 0, `${google.calls.length} lists`);
  });

  await check('a network failure on the token URL: error transient, not "token expired"', async () => {
    const socketError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    google.token = () =>
      Promise.reject(new GaxiosError(`request to ${TOKEN_URL} failed, reason: socket hang up`, { url: TOKEN_URL, method: 'POST' }, undefined, socketError));
    const r = await read();
    assertSame(statusOf(r), { status: 'error', reason: 'transient' }, 'status');
  });

  await check('500 on every calendar: error transient, with the first calendar\'s error as the cause', async () => {
    const errors = [DANA, AVI, KIDS].map(id => apiError(id, 500, 'backendError', 'Backend Error'));
    [DANA, AVI, KIDS].forEach((id, i) => { google.pages[id] = [errors[i]]; });
    const r = await read();
    assertSame(statusOf(r), { status: 'error', reason: 'transient' }, 'status');
    assert(r.read.status === 'error' && r.read.cause === errors[0], 'cause');
  });

  await check('a 403 rate limit on every calendar: error transient, not reconnect', async () => {
    for (const id of [DANA, AVI, KIDS]) google.pages[id] = [apiError(id, 403, 'rateLimitExceeded', 'Rate Limit Exceeded')];
    const r = await read();
    assertSame(statusOf(r), { status: 'error', reason: 'transient' }, 'status');
  });

  await check('500 on one calendar: ok with partial.failed 1, and a warning capture with the user id', async () => {
    google.pages[KIDS] = [apiError(KIDS, 500, 'backendError', 'Backend Error')];
    const r = await read();
    assertSame(statusOf(r), { ...OK, partial: { failed: 1, truncated: 0 } }, 'status');
    assert(!ids(r).includes('pickup') && r.items.length === 7, 'items');
    const capture = captures.find(c => c.context === 'calendar-read-google');
    assert(capture?.severity === 'warning' && capture.extra?.user_id === 7, `captures ${canon(captures.map(c => [c.context, c.severity, c.extra]))}`);
  });

  await check('an empty token: reconnect token with no Google call', async () => {
    const r = await read(user({ googleRefreshToken: '' }));
    assertSame(statusOf(r), { status: 'reconnect', reason: 'token' }, 'status');
    assert(google.clients === 0 && google.log.length === 0, 'Google was called');
  });

  await check('no chosen calendars: ok and empty, with no Google call', async () => {
    const r = await read(user({ calendarAssignments: undefined }));
    assertSame(statusOf(r), OK, 'status');
    assertSame(r.read.status === 'ok' ? r.read.calendars : null, [], 'legend');
    assert(r.items.length === 0 && google.clients === 0 && google.log.length === 0, 'Google was called');
  });

  await check('an unexpected throw inside the client: error unknown, an error capture, never a rejection', async () => {
    google.token = () => {
      throw new TypeError('client bug');
    };
    const r = await read();
    assertSame(statusOf(r), { status: 'error', reason: 'unknown' }, 'status');
    assert(captures.some(c => c.context === 'calendar-read-google' && c.severity === 'error'), 'not captured');
  });

  // ---- Deadline ----

  await check('deadline: a token server that never answers gives error timeout within the deadline', async () => {
    google.token = () => new Promise(() => {});
    const start = performance.now();
    const r = await read(user(), { deadlineMs: 600 });
    const took = performance.now() - start;
    assertSame(statusOf(r), { status: 'error', reason: 'timeout' }, 'status');
    assert(took >= 550 && took < 800, `took ${Math.round(took)} ms`);
    assert(google.calls.length === 0, 'listed after the token step timed out');
  });

  await check('deadline: one calendar stalls while another answers: ok with partial.failed 1', async () => {
    google.pages[DANA] = ['hang'];
    const start = performance.now();
    const r = await read(user(), { calendarIds: [DANA, AVI], deadlineMs: 600 });
    assert(performance.now() - start < 800, 'waited past the deadline');
    assertSame(statusOf(r), { ...OK, partial: { failed: 1, truncated: 0 } }, 'status');
    assertSame(ids(r), ['mom-birthday', 'standup', 'flight'], 'items');
    assert(captures.some(c => c.context === 'calendar-read-google' && c.severity === 'warning'), 'the stalled calendar was not reported');
  });

  await check('deadline: the only calendar mid-paging is truncated (ok, not timeout); a late page changes nothing', async () => {
    const at = (h: string) => `2026-10-14T${h}:00-04:00`;
    google.pages[DANA] = [
      { summary: TITLES[DANA], items: [timed('a', 'A', at('08:00'), at('09:00')), timed('b', 'B', at('10:00'), at('11:00'))], nextPageToken: 'p2' },
      new Later(900, { summary: TITLES[DANA], items: [timed('c', 'C', at('12:00'), at('13:00'))] }),
    ];
    const r = await read(user(), { calendarIds: [DANA], deadlineMs: 600 });
    assertSame(statusOf(r), { ...OK, partial: { failed: 0, truncated: 1 } }, 'status');
    assertSame(ids(r), ['a', 'b'], 'items');
    await sleep(450);
    assertSame(ids(r), ['a', 'b'], 'items after the late page');
  });

  await check('deadline: several calendars, none with a page: error timeout', async () => {
    for (const id of [DANA, AVI, KIDS]) google.pages[id] = ['hang'];
    const start = performance.now();
    const r = await read(user(), { deadlineMs: 600 });
    assert(performance.now() - start < 800, 'waited past the deadline');
    assertSame(statusOf(r), { status: 'error', reason: 'timeout' }, 'status');
  });

  // ---- Redis ----

  await check('Redis down: the read is unchanged; the gone warning still goes out, the admin notice does not', async () => {
    redisDown = true;
    google.pages[AVI] = [apiError(AVI, 404, 'notFound', 'Not Found')];
    const r = await read();
    assertSame(statusOf(r), { ...OK, goneIds: [AVI] }, 'status');
    await until(() => warnings.length === 1);
    assert(warnings.length === 1, 'the gone warning was lost');
    google.token = () => Promise.reject(tokenError(401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' }));
    const config = await read();
    assertSame(statusOf(config), { status: 'error', reason: 'config' }, 'config status');
    await sleep(50);
    assert(adminAlerts.length === 0, 'paged the admin with no once-an-hour gate');
  });

  // ---- google-sync S2: FamCal's own copies never show back ----

  const copyOf = (id: string, at: string, extra: Raw = {}) =>
    timed(id, 'Copied', `2026-10-14T${at}:00-04:00`, `2026-10-14T${at.replace(/^(\d+)/, (h) => String(Number(h) + 1).padStart(2, '0'))}:00-04:00`, extra);
  const MARKED_PAGE = (): Page => ({
    summary: TITLES[DANA],
    items: [
      copyOf('copy', '08', { extendedProperties: { private: { famcalSync: 'link-1', famcalSeries: 'series-1' } } }),
      copyOf('moved', '09', { extendedProperties: { private: { famcalMovedFrom: 'series-2' } } }),
      copyOf('shared-prop', '10', { extendedProperties: { shared: { famcalSync: 'link-1' } } }),
      copyOf('plain', '11'),
    ],
  });

  await check('S2 home and digest (readGoogle): an event FamCal copied to Google (private famcalSync) is dropped; a moved one (famcalMovedFrom) and the rest are kept', async () => {
    google.pages[DANA] = [MARKED_PAGE()];
    const r = await read(user(), { calendarIds: [DANA] });
    assertSame(statusOf(r), OK, 'status');
    assertSame(ids(r), ['moved', 'shared-prop', 'plain'], 'kept');
  });

  await check('S2 voice and alerts (calendar.ts fetchEventsInRange, and the Google provider over it): a FamCal copy is dropped; a moved one and the rest are kept', async () => {
    google.pages[DANA] = [MARKED_PAGE()];
    const events = await calendar.fetchEventsInRange('refresh-7', [DANA], DAY_WINDOW.from, DAY_WINDOW.to);
    assertSame(events.map((e: { eventId?: string }) => e.eventId), ['moved', 'shared-prop', 'plain'], 'fetchEventsInRange');
    const { googleProvider } = await import('../src/services/calendar-provider/google-provider');
    const viaProvider = await googleProvider.fetchEventsInRange(user(), [DANA], DAY_WINDOW.from, DAY_WINDOW.to);
    assertSame(viaProvider.map(e => e.eventId), ['moved', 'shared-prop', 'plain'], 'googleProvider.fetchEventsInRange');
  });

  await check('S2 listUserCalendars hides every Google calendar a copy link of this user holds (on or off), in select-calendars and the editor\'s list; others and another user\'s copies stay', async () => {
    calendarListItems = [
      { id: DANA, summary: 'Dana', primary: true, accessRole: 'owner', backgroundColor: '#7986cb' },
      { id: 'copy-on@group.calendar.google.com', summary: 'FamCal · Home', accessRole: 'owner', backgroundColor: '#000000' },
      { id: 'copy-off@group.calendar.google.com', summary: 'FamCal · Work', accessRole: 'owner', backgroundColor: '#000000' },
      { id: 'noa-copy@group.calendar.google.com', summary: 'FamCal · Noa', accessRole: 'reader', backgroundColor: '#000000' },
      { id: KIDS, summary: 'Family', accessRole: 'writer', backgroundColor: '#33b679' },
    ];
    syncLinks = [
      { userId: 7, googleCalendarId: 'copy-on@group.calendar.google.com', enabled: true },
      { userId: 7, googleCalendarId: 'copy-off@group.calendar.google.com', enabled: false },
      { userId: 7, googleCalendarId: null, enabled: true },
      { userId: 8, googleCalendarId: 'noa-copy@group.calendar.google.com', enabled: true },
    ];
    const listed = await calendar.listUserCalendars('refresh-7', 7);
    assertSame(listed.map((c: { id: string }) => c.id), [DANA, 'noa-copy@group.calendar.google.com', KIDS], 'listUserCalendars');
    const { googleProvider } = await import('../src/services/calendar-provider/google-provider');
    const viaProvider = await googleProvider.listCalendars(user());
    assertSame(viaProvider.map(c => c.id), [DANA, 'noa-copy@group.calendar.google.com', KIDS], 'googleProvider.listCalendars');
  });

  await check('S4 listUserCalendars also hides a copy calendar whose id was never stored (a crash mid-creating) by the [famcal:<linkId>] token of one of this user\'s links; another user\'s token, a look-alike or no description stay', async () => {
    calendarListItems = [
      { id: DANA, summary: 'Dana', primary: true, accessRole: 'owner', backgroundColor: '#7986cb' },
      { id: 'orphan@group.calendar.google.com', summary: 'FamCal · Home', description: 'FamCal keeps this calendar in step.\n\n[famcal:cl-own-1]', accessRole: 'owner' },
      { id: 'stored@group.calendar.google.com', summary: 'FamCal · Work', description: '[famcal:cl-own-2]', accessRole: 'owner' },
      { id: 'other-user@group.calendar.google.com', summary: 'FamCal · Noa', description: '[famcal:cl-noa-1]', accessRole: 'reader' },
      { id: 'lookalike@group.calendar.google.com', summary: 'Notes', description: 'see [famcal:cl-own-10] and famcal:cl-own-1', accessRole: 'owner' },
      { id: KIDS, summary: 'Family', accessRole: 'writer', backgroundColor: '#33b679' },
    ];
    syncLinks = [
      { id: 'cl-own-1', userId: 7, googleCalendarId: null, enabled: true },
      { id: 'cl-own-2', userId: 7, googleCalendarId: 'stored@group.calendar.google.com', enabled: false },
      { id: 'cl-noa-1', userId: 8, googleCalendarId: null, enabled: true },
    ];
    const listed = await calendar.listUserCalendars('refresh-7', 7);
    assertSame(listed.map((c: { id: string }) => c.id), [DANA, 'other-user@group.calendar.google.com', 'lookalike@group.calendar.google.com', KIDS], 'listUserCalendars');
    syncLinks = [];
  });

  await check('S2 listUserCalendars: a user with no copies gets the list as before (one link lookup, nothing hidden)', async () => {
    calendarListItems = [{ id: DANA, summary: 'Dana', primary: true, accessRole: 'owner', backgroundColor: '#7986cb' }];
    const listed = await calendar.listUserCalendars('refresh-7', 7);
    assertSame(listed, [{ id: DANA, name: 'Dana', description: '', primary: true, accessRole: 'owner', backgroundColor: '#7986cb' }], 'list');
    assert(google.log.filter(l => l === 'db:googleSyncLink').length === 1, `lookups ${JSON.stringify(google.log)}`);
  });

  await check('no unhandled rejection anywhere above', async () => {
    assert(unhandled.length === 0, `unhandled: ${unhandled.map(String).join('; ')}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

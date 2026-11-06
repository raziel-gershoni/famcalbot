// Smoke test for event reminders: the real cron handlers (cache sync and the 5-minute run),
// reminder cache, reminders service, timezone resolver and Google calendar fetch, with
// Google's API, Redis, Prisma, geocoding and Telegram faked and the clock stepped by hand.
// The cron run rebuilt each user from the cache without their pickup toggle or location,
// fetched "today" as Israel's day whatever the user's timezone, and keyed "already sent"
// by the server's date. Fetching only the user's today also dropped any reminder whose
// event lay past their midnight, and a settings save (the real app/api/settings route)
// took a NATIVE user out of the cache and wrote everyone else's entry without a location.
// The fetch that replaced it reached a day ahead, which sent Google's "1 day before" as a
// reminder that read as starting now (a pickup too), dropped the 30-minute popup next to
// it, and fetched calendars one after another, slowing the 5-minute run past its window.
// Capping every lead at two hours then dropped the "3 hours before" sent on the event's
// own day while the run fetched today. A built-in calendar reminder got an alert as well
// as its own ping, a "<" or "&" in a title made Telegram refuse the alert, and a user who
// blocked the bot was retried every five minutes. The cache also held every Google token in
// plain form under reminders:users; v2 holds them sealed, the run opens each one per user,
// and the old key is only ever deleted (at boot and by the hourly sync). No network.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-reminders.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-reminders.ts

import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { REDIS_KEYS } from '../src/config/redis-keys';
import { generateVAPIDKeys } from 'web-push';

// No decrypt-only fallback key here (Prisma would load .env for an unset name).
process.env.ENCRYPTION_KEY_PREVIOUS = '';
// Browser notifications on (src/services/web-push/config.ts reads both keys); the sender and the device store are faked below.
const vapid = generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.VAPID_PRIVATE_KEY = vapid.privateKey;

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ---- Clock: every argument-less new Date() and Date.now() reads `clock` ----

let clock = 0;
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

// ---- Fakes ----

/** Redis as Upstash behaves: values round-trip through JSON. */
const store = new Map<string, string>();
/** Called once, right after the next read of the reminder cache returns (a write landing just then). */
let afterCacheRead: (() => void) | null = null;
const fakeRedis = {
  get: async (key: string) => {
    const value = store.has(key) ? JSON.parse(store.get(key)!) : null;
    if (key === 'reminders:users:v2' && afterCacheRead) {
      const hook = afterCacheRead;
      afterCacheRead = null;
      hook();
    }
    return value;
  },
  set: async (key: string, value: unknown) => {
    store.set(key, JSON.stringify(value));
    return 'OK';
  },
  exists: async (key: string) => (store.has(key) ? 1 : 0),
  del: async (key: string) => (store.delete(key) ? 1 : 0),
};

type UserRow = Record<string, unknown> & { id: number };
let userRows: UserRow[] = [];
/**
 * Prisma returns only the selected columns, so a column the sync forgets to select is
 * missing. Of the filter, only the columns it requires to be null are applied.
 */
/** The where and select of the last user.findMany (the hourly rebuild's read), for the checks on what it asks. */
let lastUserRead: { where: Record<string, unknown>; select: Record<string, unknown> } | null = null;
const fakePrisma = {
  user: {
    findMany: async ({ where = {}, select }: { where?: Record<string, unknown>; select: Record<string, boolean> }) => {
      lastUserRead = { where, select };
      return userRows
        .filter(row => Object.keys(where).every(k => where[k] !== null || row[k] == null))
        .map(row => Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]])));
    },
    // markUserUnreachable: the id, and the columns it requires to be null.
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const rows = userRows.filter(row => Object.keys(where).every(k => (where[k] === null ? row[k] == null : row[k] === where[k])));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
    // The event store's writes read the actor (its id and pairing), and the partner lookup reads the partner.
    findUnique: async ({ where }: { where: { id: number } }) => {
      const row = userRows.find(r => r.id === where.id);
      return row ? { id: row.id, name: row.name, pairingId: row.pairingId ?? null, telegramId: row.telegramId ?? null } : null;
    },
  },
  adminSettings: { findUnique: async () => ({ remindersEnabled: true }) },
  oAuthState: { deleteMany: async () => ({ count: 0 }) },
  // ---- What the real event store's writes (createNativeEvent, updateNativeEvent, deleteNativeEvent) touch ----
  nativeCalendar: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const c = nativeCalendars.find(x => x.id === where.id);
      return c ? { id: c.id, name: c.name, labels: c.labels, ownerUserId: c.ownerUserId ?? 0, privacy: c.privacy ?? 'PRIVATE', isDeleted: false } : null;
    },
  },
  nativeEvent: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row: NativeRow = {
        calendarId: data.calendarId as string, id: `new${nativeEvents.length + 1}`, title: data.title as string,
        startsAt: data.startsAt as Date, endsAt: data.endsAt as Date, timeZone: data.timeZone as string,
        kind: (data.kind as NativeRow['kind']) ?? 'EVENT', allDay: data.allDay as boolean,
        ownAlerts: data.ownAlerts as boolean, alertMinutes: data.alertMinutes as number[],
      };
      nativeEvents.push(row);
      return seriesRow(row);
    },
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = nativeEvents.find(e => e.id === where.id);
      return row ? seriesRow(row) : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = nativeEvents.find(e => e.id === where.id)!;
      for (const key of ['title', 'startsAt', 'endsAt', 'allDay', 'ownAlerts', 'alertMinutes', 'isDeleted', 'calendarId'] as const) {
        if (data[key] !== undefined) (row as Record<string, unknown>)[key] = data[key];
      }
      return seriesRow(row);
    },
  },
  nativeEventInstance: {
    findUnique: async () => null,
    deleteMany: async () => ({ count: 0 }),
    updateMany: async () => ({ count: 0 }),
  },
  // No calendar here is copied to Google: markSyncDirty finds no link and marks nothing.
  googleSyncLink: { findMany: async () => [] },
  pairing: { findUnique: async ({ where }: { where: { id: string } }) => pairings.find(p => p.id === where.id) ?? null },
  $transaction: async (write: (tx: unknown) => Promise<unknown>) => write(recordingPrisma),
};
/** The pairings the store's partner lookups read. */
let pairings: { id: string; status: string; inviterUserId: number; inviteeUserId: number }[] = [];
/** A NativeRow as the store reads a series row (prisma.nativeEvent.findUnique). */
function seriesRow(row: NativeRow) {
  return {
    id: row.id, calendarId: row.calendarId, kind: row.kind ?? 'EVENT', creatorUserId: 0, forUserId: null, forBoth: false, eachMarksDone: false,
    title: row.title, description: null, location: null, startsAt: row.startsAt, endsAt: row.endsAt, allDay: row.allDay ?? false,
    timeZone: row.timeZone, rrule: null, hebrewRule: null, hebrewAnchor: null, exdates: [], ownAlerts: row.ownAlerts ?? false,
    alertMinutes: row.alertMinutes ?? [], zmanSpec: null, isDeleted: row.isDeleted ?? false,
  };
}
/** Every Prisma call the code under test made, as "model.method" (the recording proxy below). */
const prismaCalls: string[] = [];
/** fakePrisma as the code sees it: each call is recorded, then answered by the fake (or fails as a missing fake did). */
const recordingPrisma = new Proxy(fakePrisma as Record<string, unknown>, {
  get(target, model) {
    const delegate = Reflect.get(target, model);
    if (typeof model !== 'string') return delegate;
    if (typeof delegate === 'function') return (...args: unknown[]) => { prismaCalls.push(model); return (delegate as (...a: unknown[]) => unknown)(...args); };
    if (!delegate || typeof delegate !== 'object') { prismaCalls.push(model); return delegate; }
    return new Proxy(delegate as Record<string, unknown>, {
      get(methods, method) {
        const fn = Reflect.get(methods, method);
        if (typeof method !== 'string' || typeof fn !== 'function') return fn;
        return (...args: unknown[]) => { prismaCalls.push(`${model}.${method}`); return (fn as (...a: unknown[]) => unknown)(...args); };
      },
    });
  },
});
/** The faked store reads the alert pass made (listVisibleCalendars, fetchEventsInCalendars, fetchReminderStates, loadViewerContext). */
const storeCalls: string[] = [];
/** When set, the FamCal events read fails with it (the FamCal half of the split fetch fails). */
let storeFailure: Error | null = null;
/** Makes calendar-provider's fetchEventsInRange itself throw (the providers' own failures are caught inside it). */
let fetchThrows: Error | null = null;
/** The FamCal calendars whose events read fails (one user's FamCal half fails, the others' do not). */
let failingCalendars: string[] = [];
/** The users whose calendar list read fails (the store's first query: listVisibleCalendars). */
let listFailingFor: number[] = [];
/** When set, the access check throws with it (a missed feature-access key recomputed while the database is down). */
let accessFailure: Error | null = null;
/** The users whose access check throws (their cached answer ended, and the recompute can't reach the database). */
let accessFailingFor: number[] = [];
/** The users the plan denies reminders to, beside remindersAllowedByPlan for everyone. */
let deniedUsers: number[] = [];

/** A Google calendar event, as events.list returns it with singleEvents; `reminder` is its own popup lead(s). */
type GoogleEvent = { calendarId: string; id: string; summary: string; start: Date; end: Date; location?: string; reminder?: number | number[] };
let googleEvents: GoogleEvent[] = [];
/** Whether the user's plan allows reminders (checkFeatureAccess). */
let remindersAllowedByPlan = true;
/** Real milliseconds each Google request takes, the requests in flight, and calendars whose requests fail. */
const googleCalls = { latencyMs: 0, inFlight: 0, maxInFlight: 0, requests: 0, failing: {} as Record<string, Error> };
async function googleRequest<T>(calendarId: string, respond: () => T): Promise<T> {
  googleCalls.requests++;
  googleCalls.inFlight++;
  googleCalls.maxInFlight = Math.max(googleCalls.maxInFlight, googleCalls.inFlight);
  try {
    if (googleCalls.latencyMs) await new Promise(resolve => setTimeout(resolve, googleCalls.latencyMs));
    if (googleCalls.failing[calendarId]) throw googleCalls.failing[calendarId];
    return respond();
  } finally {
    googleCalls.inFlight--;
  }
}
/** The refresh tokens Google's OAuth clients were given, in order. */
let googleTokens: string[] = [];
const fakeGoogle = {
  calendar: () => ({
    calendars: {
      get: ({ calendarId }: { calendarId: string }) => googleRequest(calendarId, () => ({ data: { summary: calendarId } })),
    },
    // Google returns every event that overlaps [timeMin, timeMax): an overnight event comes
    // back on both of its days.
    events: {
      list: ({ calendarId, timeMin, timeMax }: { calendarId: string; timeMin: string; timeMax: string }) => googleRequest(calendarId, () => ({
        data: {
          items: googleEvents
            .filter(e => e.calendarId === calendarId && e.end > new RealDate(timeMin) && e.start < new RealDate(timeMax))
            .map(e => ({
              id: e.id, summary: e.summary, start: { dateTime: e.start.toISOString() }, end: { dateTime: e.end.toISOString() }, location: e.location,
              reminders: e.reminder === undefined ? undefined : {
                useDefault: false,
                overrides: [e.reminder].flat().map(minutes => ({ method: 'popup', minutes })),
              },
            })),
        },
      })),
    },
    // The calendar's own timezone setting is unreadable, so the resolver has to use the location.
    settings: { get: async () => ({ data: {} }) },
  }),
  // Records the refresh token each client is given: Google must get it in plain form.
  auth: { OAuth2: class { setCredentials(credentials: { refresh_token?: string }) { googleTokens.push(credentials.refresh_token ?? ''); } } },
};

/** A native calendar event (one-off), as the event store hands it to the native provider; a REMINDER has no length. */
type NativeRow = { calendarId: string; id: string; title: string; startsAt: Date; endsAt: Date; timeZone: string; kind?: 'EVENT' | 'REMINDER'; allDay?: boolean; ownAlerts?: boolean; alertMinutes?: number[]; recurring?: boolean; isDeleted?: boolean };
/** A FamCal calendar; `visibleTo` lists who sees it (everyone when unset), `ownerUserId` its owner. */
let nativeCalendars: { id: string; name: string; labels: string[]; ownerUserId?: number; visibleTo?: number[]; privacy?: string }[] = [];
let nativeEvents: NativeRow[] = [];

const geocodedTimezones: Record<string, string> = { 'Tel Aviv': 'Asia/Jerusalem', 'New York': 'America/New_York' };

type Sent = { at: number; chatId: number; text: string };
let sent: Sent[] = [];
/** When set, every Telegram send fails with it, as for a user who blocked the bot. */
let sendError: Error | null = null;
let sendAttempts = 0;
const recorder = {
  sendMessage: async (chatId: number, text: string) => {
    sendAttempts++;
    if (sendError) throw sendError;
    sent.push({ at: clock, chatId, text });
  },
};
/** How many "your reminders are paused, upgrade" notices were sent (the plan downgrade). */
let downgradeNotices = 0;
/** Every sendWebPush call (src/services/web-push/send.ts, faked): who, when, and what. */
type Pushed = { at: number; userId: number; kind: string; title: string; body: string; url: string; tag: string; lang: string; until?: Date };
let pushes: Pushed[] = [];
/** What sendWebPush answers. */
let pushAnswer = { sent: 1, total: 1, retriable: false };
/** Every console.log and console.warn line of the runs (runTicks), to prove none holds a title or a place. */
let logLines: string[] = [];
/** The "[pause] skipped ..." lines the runs logged. */
let pauseLines: string[] = [];
/** The contexts captureError was called with. */
let captured: string[] = [];
/** The message and extra of each capture, to prove no token or ciphertext reaches Sentry. */
let capturedDetail: string[] = [];

const SRC = path.resolve(__dirname, '../src');

/**
 * The settings route's verifyUserAuth, as a Telegram save proves the user: the row whose
 * telegramId is user_id, through the real convertPrismaUserToConfig.
 */
async function fakeVerifyUserAuth(_request: unknown, userId: string) {
  const { convertPrismaUserToConfig } = await import('../src/types');
  const row = userRows.find(r => Number(r.telegramId) === Number(userId))!;
  return { success: true, via: 'telegram', user: convertPrismaUserToConfig(row as never) };
}

/**
 * The settings route's updateUserById: applies the given fields to the row and returns it
 * through the real convertPrismaUserToConfig, as the route gets it.
 */
async function fakeUpdateUserById(id: number, data: Record<string, unknown>) {
  const { convertPrismaUserToConfig } = await import('../src/types');
  const row = userRows.find(r => r.id === id)!;
  for (const [key, value] of Object.entries(data)) if (value !== undefined) row[key] = value;
  return convertPrismaUserToConfig(row as never);
}

/**
 * Part of a module faked, the rest read through to the real one. A proxy, not a copy:
 * it reads the real module lazily, so it survives import cycles.
 */
const fakeOver = (real: Record<string, unknown>, fakes: Record<string, unknown>) =>
  new Proxy(real, { get: (target, key) => (typeof key === 'string' && key in fakes ? fakes[key] : Reflect.get(target, key)) });

/** Modules replaced by fakes, by package name or file path; a function fakes part of the real module. */
const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  '@googleapis/calendar': fakeGoogle,
  // startScheduler's jobs never run here; only its boot step does.
  'node-cron': { schedule: () => ({ stop: () => {} }) },
  'next/server': {
    NextRequest: class {},
    NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) },
  },
  [`${SRC}/lib/api-auth.ts`]: { verifyUserAuth: fakeVerifyUserAuth },
  [`${SRC}/lib/rate-limit.ts`]: { settingsRateLimiter: {} },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/utils/prisma.ts`]: { prisma: recordingPrisma, withRetry: (fn: () => unknown) => fn() },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (error: unknown, context: string, extra?: unknown) => { captured.push(context); capturedDetail.push(`${error instanceof Error ? error.message : String(error)} ${JSON.stringify(extra ?? {})}`); },
    captureWarning: () => {},
    captureInfo: () => {},
  },
  [`${SRC}/services/weather/geocoding.ts`]: {
    geocodeLocation: async (location: string) => ({ timezone: geocodedTimezones[location] }),
  },
  [`${SRC}/services/telegram/index.ts`]: {
    getBot: () => ({}),
    sendDailySummaryToAll: async () => ({ processed: 0, skippedHour: 0, skippedDay: 0, skippedDedup: 0 }),
    sendReminderDowngradeNotification: async () => { downgradeNotices++; },
    setUserMenuButton: async () => {},
  },
  [`${SRC}/services/messaging/factory.ts`]: {
    getTelegramService: () => recorder,
    getWhatsAppService: () => ({ sendMessage: async () => { throw new Error('reminders went to WhatsApp'); } }),
  },
  // The sender reads the devices when an alert is due (one query, recorded as the real one would be).
  [`${SRC}/services/web-push/send.ts`]: {
    sendWebPush: async (user: { id: number }, input: Omit<Pushed, 'at' | 'userId'>) => {
      prismaCalls.push('pushDevice.findMany');
      pushes.push({ at: clock, userId: user.id, ...input });
      return pushAnswer;
    },
  },
  // The cache entry sync's count of a no-chat account's devices: _count.pushDevices on the fake row.
  [`${SRC}/services/web-push/devices.ts`]: {
    countDevices: async (userId: number) => {
      prismaCalls.push('pushDevice.count');
      return ((userRows.find(r => r.id === userId)?._count as { pushDevices?: number } | undefined)?.pushDevices) ?? 0;
    },
  },
  [`${SRC}/services/user-service.ts`]: { getWhatsAppChatId: () => null, updateUserById: fakeUpdateUserById },
  [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => {} },
  // The rest is real: invalidateFeatureAccessCache (a plan regained) opens the event alerts gate.
  [`${SRC}/services/subscription-service.ts`]: real => fakeOver(real, {
    checkFeatureAccess: async (userId: number) => {
      if (accessFailure) throw accessFailure;
      if (accessFailingFor.includes(userId)) throw new Error('database down (smoke): computeFeatureAccess');
      return { allowed: remindersAllowedByPlan && !deniedUsers.includes(userId) };
    },
    incrementUsage: async () => {},
  }),
  [`${SRC}/services/native-calendar/event-store.ts`]: real => fakeOver(real, {
    listVisibleCalendars: async (userId: number) => {
      storeCalls.push('listVisibleCalendars');
      if (listFailingFor.includes(userId)) throw new Error('database down (smoke): listVisibleCalendars');
      return nativeCalendars
        .filter(c => !c.visibleTo || c.visibleTo.includes(userId))
        .map(({ visibleTo: _visibleTo, privacy: _privacy, ...c }) => ({ ...c, color: '#000000', personName: null, personEnglishName: null, personGender: null, rules: [] }));
    },
    // One-off events overlapping the range, as the real store takes them.
    fetchEventsInCalendars: async (cuids: string[], range: { from: Date; to: Date }) => {
      storeCalls.push('fetchEventsInCalendars');
      if (storeFailure) throw storeFailure;
      if (cuids.some(c => failingCalendars.includes(c))) throw new Error('database down (smoke): fetchEventsInCalendars');
      return nativeEvents
        .filter(e => !e.isDeleted && cuids.includes(e.calendarId) && e.startsAt < range.to && (e.startsAt >= range.from || e.endsAt > range.from))
        .map(e => ({
          calendar: nativeCalendars.find(c => c.id === e.calendarId)!,
          series: { id: e.id, kind: e.kind ?? 'EVENT', creatorUserId: 0, forUserId: null, ownAlerts: e.ownAlerts ?? false, alertMinutes: e.alertMinutes ?? [] },
          instance: {
            title: e.title, startsAt: e.startsAt, endsAt: e.endsAt, allDay: e.allDay ?? false, timeZone: e.timeZone,
            seriesEventId: e.id, instanceStartsAt: e.startsAt, isRecurringInstance: e.recurring ?? false,
          },
        }));
    },
    // Nothing done or snoozed.
    fetchReminderStates: async () => { storeCalls.push('fetchReminderStates'); return []; },
    // The partner's reminders for the viewer (paired users): none.
    fetchRemindersForUserInRange: async () => { storeCalls.push('fetchRemindersForUserInRange'); return []; },
  }),
  [`${SRC}/services/calendar-provider/index.ts`]: real => fakeOver(real, {
    fetchEventsInRange: (...args: unknown[]) => (fetchThrows ? Promise.reject(fetchThrows) : (real.fetchEventsInRange as (...a: unknown[]) => unknown)(...args)),
  }),
  // The real one, counted.
  [`${SRC}/services/native-reminders/ownership.ts`]: real => fakeOver(real, {
    loadViewerContext: (...args: unknown[]) => { storeCalls.push('loadViewerContext'); return (real.loadViewerContext as (...a: unknown[]) => unknown)(...args); },
  }),
};

// Static imports compile to require() and pass through Module._load.
const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
// @hebcal/core is ESM-only and tsx loads src/ as CommonJS: the pause (src/services/zmanim) reads its ESM build.
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request, parent, isMain) {
  if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, parent, isMain);
};
const realLoad = ModuleInternals._load;
const partialFakes = new Map<string, object>();
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  const key = request in stubs ? request : resolved;
  const stub = stubs[key];
  if (!stub) return realLoad.call(this, request, parent, isMain);
  if (typeof stub !== 'function') return stub;
  if (!partialFakes.has(key)) partialFakes.set(key, stub(realLoad.call(this, request, parent, isMain) as Record<string, unknown>));
  return partialFakes.get(key);
};

// handlers.ts loads some services with import(), which goes through the ES module loader
// instead; it gets the same fake, served as an ES module.
(globalThis as { smokeStubs?: typeof stubs }).smokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url) : '';
    const stub = stubs[file];
    if (!stub || typeof stub === 'function') return nextLoad(url, context);
    const names = Object.keys(stub).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.smokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

// ---- Scenario helpers ----

const at = (local: string, tz: string) => fromZonedTime(local, tz);

/** The event alerts gate, as the code under test shares it (on globalThis). */
let alertsGate: typeof import('../src/services/event-alerts-gate');

function reset(row: Partial<UserRow> & { id: number }) {
  // A fresh process: each check sets its data directly, not through a writer that opens the gate.
  alertsGate.__resetEventAlertsGateForTests();
  remindersAllowedByPlan = true;
  store.clear();
  downgradeNotices = 0;
  pauseLines = [];
  sent = [];
  sendError = null;
  sendAttempts = 0;
  captured = [];
  capturedDetail = [];
  googleEvents = [];
  nativeCalendars = [];
  nativeEvents = [];
  pairings = [];
  failingCalendars = [];
  listFailingFor = [];
  accessFailure = null;
  accessFailingFor = [];
  deniedUsers = [];
  afterCacheRead = null;
  pushes = [];
  pushAnswer = { sent: 1, total: 1, retriable: false };
  logLines = [];
  userRows = [{
    telegramId: BigInt(1000 + row.id),
    googleRefreshToken: 'refresh-token',
    calendarAssignments: [{ calendarId: 'kids@group.calendar.google.com', labels: ['kids'], name: 'Noa', color: '#f00' }],
    calendarSource: 'GOOGLE',
    pairingId: null,
    defaultReminderMinutes: 15,
    pickupRemindersEnabled: true,
    remindersEnabled: true,
    language: 'en',
    name: 'Dana',
    location: 'Tel Aviv',
    ...row,
  }];
}

/** Steps the clock through 5-minute cron ticks over [from, to), silencing the services' logs. */
async function runTicks(handlers: typeof import('../src/cron/handlers'), from: Date, to: Date) {
  const log = console.log;
  const warn = console.warn;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    logLines.push(line);
    if (line.startsWith('[pause]')) pauseLines.push(line);
  };
  console.warn = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };
  try {
    for (let t = from.getTime(); t < to.getTime(); t += 5 * 60_000) {
      clock = t;
      await handlers.handleReminders(5);
    }
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

/** The hourly summary run, which syncs the reminder cache from the database. */
async function syncCache(handlers: typeof import('../src/cron/handlers'), when: Date) {
  const log = console.log;
  console.log = () => {};
  try {
    clock = when.getTime();
    await handlers.handleDailySummary();
  } finally {
    console.log = log;
  }
}

/** A settings save from the mini app, through the real route. */
async function saveSettings(when: Date, telegramId: number, body: Record<string, unknown>) {
  const route = await import('../app/api/settings/route');
  const log = console.log;
  console.log = () => {};
  try {
    clock = when.getTime();
    const request = { url: `https://famcal.bot/api/settings?user_id=${telegramId}`, json: async () => body };
    const response = (await route.POST(request as never)) as unknown as { status: number };
    assert(response.status === 200, `settings save returned ${response.status}`);
  } finally {
    console.log = log;
  }
}

/** What was sent, as "HH:mm <first line>" in `tz`. */
function sentLines(tz: string): string[] {
  return sent.map(s => `${formatInTimeZone(new RealDate(s.at), tz, 'HH:mm')} ${s.text.split('\n')[0].replace(/<\/?b>/g, '')}`);
}

type CacheEntry = { id: number; googleToken?: string; [key: string]: unknown };
/** The reminder cache as stored under v2: its raw JSON ('' when missing) and its entries. */
function cacheV2(): { raw: string; entries: CacheEntry[] } {
  const raw = store.get('reminders:users:v2') ?? '';
  return { raw, entries: raw ? (JSON.parse(raw) as CacheEntry[]) : [] };
}

/** `text` encrypted under a key this deployment has neither as ENCRYPTION_KEY nor as PREVIOUS. */
async function foreignCipher(text: string): Promise<string> {
  const { encrypt } = await import('../src/utils/encryption');
  const key = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = key === 'f0'.repeat(32) ? '0f'.repeat(32) : 'f0'.repeat(32);
  try {
    return encrypt(text);
  } finally {
    if (key === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = key;
  }
}

async function main() {
  const handlers = await import('../src/cron/handlers');
  alertsGate = await import('../src/services/event-alerts-gate');
  const IL = 'Asia/Jerusalem';
  const NY = 'America/New_York';
  const kidsCal = 'kids@group.calendar.google.com';

  await check('pickup reminders turned off: the cron run sends the start reminder only', async () => {
    reset({ id: 1, pickupRemindersEnabled: false });
    googleEvents = [{ calendarId: kidsCal, id: 'k1', summary: 'Kindergarten', start: at('2026-10-13 08:00', IL), end: at('2026-10-13 16:00', IL) }];
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    await runTicks(handlers, at('2026-10-13 07:00', IL), at('2026-10-13 17:00', IL));
    const lines = sentLines(IL);
    assert(lines.join(' | ') === '07:45 🤖 Auto-Reminder: Kindergarten', `got ${lines.join(' | ') || '(nothing)'}`);
  });

  await check('pickup reminders on: start and pickup', async () => {
    reset({ id: 2 });
    googleEvents = [{ calendarId: kidsCal, id: 'k2', summary: 'Kindergarten', start: at('2026-10-13 08:00', IL), end: at('2026-10-13 16:00', IL) }];
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    await runTicks(handlers, at('2026-10-13 07:00', IL), at('2026-10-13 17:00', IL));
    const lines = sentLines(IL);
    assert(lines.join(' | ') === '07:45 🤖 Auto-Reminder: Kindergarten | 15:45 🤖🚗 Auto-Pickup Reminder: Noa', `got ${lines.join(' | ') || '(nothing)'}`);
  });

  await check("a user in New York: today is their day, not Israel's (an evening event after Israel's midnight)", async () => {
    reset({ id: 3, location: 'New York' });
    await fakeRedis.set(REDIS_KEYS.userTimezone(3), NY); // as the summaries resolved it
    // 17:00 in New York is 00:00 in Israel, so Israel's "today" ended a minute before the start.
    googleEvents = [{ calendarId: kidsCal, id: 'k3', summary: 'Soccer', start: at('2026-10-13 17:00', NY), end: at('2026-10-13 18:00', NY) }];
    await syncCache(handlers, at('2026-10-13 15:00', NY));
    await runTicks(handlers, at('2026-10-13 16:00', NY), at('2026-10-13 19:00', NY));
    const lines = sentLines(NY);
    assert(lines.join(' | ') === '16:45 🤖 Auto-Reminder: Soccer | 17:45 🤖🚗 Auto-Pickup Reminder: Noa', `got ${lines.join(' | ') || '(nothing)'}`);
    assert(sent.every(s => s.text.includes('at 17:00') || s.text.includes('at 18:00')), 'times not in New York time');
  });

  await check("the cron run resolves a native user's timezone from their location, as the summaries do", async () => {
    reset({ id: 4, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null, location: 'New York' });
    nativeCalendars = [{ id: 'cal4', name: 'Leo', labels: ['kids'] }];
    nativeEvents = [{ calendarId: 'cal4', id: 'n4', title: 'Swim', startsAt: at('2026-10-13 17:00', NY), endsAt: at('2026-10-13 18:00', NY), timeZone: NY }];
    await syncCache(handlers, at('2026-10-13 15:00', NY));
    await runTicks(handlers, at('2026-10-13 16:00', NY), at('2026-10-13 19:00', NY));
    const cachedTz = await fakeRedis.get(REDIS_KEYS.userTimezone(4));
    assert(cachedTz === NY, `timezone resolved and cached as ${cachedTz}`);
    const lines = sentLines(NY);
    assert(lines.join(' | ') === '16:45 🤖 Auto-Reminder: Swim | 17:45 🤖🚗 Auto-Pickup Reminder: Leo', `got ${lines.join(' | ') || '(nothing)'}`);
  });

  await check('an overnight pickup (Google returns the event on both days) fires once, after midnight', async () => {
    reset({ id: 5, location: 'New York' });
    await fakeRedis.set(REDIS_KEYS.userTimezone(5), NY);
    googleEvents = [{ calendarId: kidsCal, id: 'k5', summary: 'Sleepover', start: at('2026-10-12 20:00', NY), end: at('2026-10-13 01:00', NY) }];
    await syncCache(handlers, at('2026-10-12 12:00', NY));
    await runTicks(handlers, at('2026-10-12 12:00', NY), at('2026-10-13 12:00', NY));
    const lines = sentLines(NY);
    assert(lines.join(' | ') === '19:45 🤖 Auto-Reminder: Sleepover | 00:45 🤖🚗 Auto-Pickup Reminder: Noa', `got ${lines.join(' | ') || '(nothing)'}`);
  });

  await check("overlapping run windows across the server's midnight: a reminder is not sent twice", async () => {
    // A run that starts late, or a manual trigger, covers part of the next run's window, and
    // the "already sent" mark has to be found by the next run even when the server's date
    // has turned in between. Midnight on the process clock, whatever TZ the test runs under:
    const serverMidnight = new RealDate(2026, 9, 14).getTime();
    reset({ id: 6, location: 'New York' });
    await fakeRedis.set(REDIS_KEYS.userTimezone(6), NY);
    // Pickup reminder due a minute after the server's midnight.
    googleEvents = [{ calendarId: kidsCal, id: 'k6', summary: 'Practice', start: new RealDate(serverMidnight - 44 * 60_000), end: new RealDate(serverMidnight + 16 * 60_000) }];
    await syncCache(handlers, new RealDate(serverMidnight - 60 * 60_000));
    await runTicks(handlers, new RealDate(serverMidnight - 3 * 60_000), new RealDate(serverMidnight - 2 * 60_000)); // window [-3, +2)
    await runTicks(handlers, new RealDate(serverMidnight), new RealDate(serverMidnight + 60_000)); // window [0, +5)
    const pickups = sent.filter(s => s.text.includes('Pickup'));
    assert(pickups.length === 1, `sent ${pickups.length} pickup reminders: ${sentLines(NY).join(' | ')}`);
  });

  // The fetch has to reach every event a reminder in the window belongs to, which is not
  // the user's today once the lead time crosses their midnight.
  for (const [label, tz, location] of [['New York', NY, 'New York'], ['Israel', IL, 'Tel Aviv']]) {
    await check(`${label}: a 00:10 start is reminded at 23:55 the evening before`, async () => {
      reset({ id: 7, location });
      await fakeRedis.set(REDIS_KEYS.userTimezone(7), tz);
      googleEvents = [{ calendarId: kidsCal, id: 'k7', summary: 'Night hike', start: at('2026-10-14 00:10', tz), end: at('2026-10-14 03:00', tz) }];
      await syncCache(handlers, at('2026-10-13 22:00', tz));
      await runTicks(handlers, at('2026-10-13 23:00', tz), at('2026-10-14 04:00', tz));
      const lines = sentLines(tz);
      assert(lines.join(' | ') === '23:55 🤖 Auto-Reminder: Night hike | 02:45 🤖🚗 Auto-Pickup Reminder: Noa', `got ${lines.join(' | ') || '(nothing)'}`);
      assert(sent[0].text.split('\n')[2] === '⏰ Starting tomorrow at 00:10', `evening before: ${JSON.stringify(sent[0].text)}`);
      assert(sent[1].text.split('\n')[1] === '⏰ Pickup at 03:00', `same-day pickup: ${JSON.stringify(sent[1].text)}`);
    });
  }

  await check('a pickup "at time of event" when the event ends at midnight is sent at midnight', async () => {
    reset({ id: 8, location: 'New York' });
    await fakeRedis.set(REDIS_KEYS.userTimezone(8), NY);
    googleEvents = [{ calendarId: kidsCal, id: 'k8', summary: 'Concert', start: at('2026-10-13 20:00', NY), end: at('2026-10-14 00:00', NY), reminder: 0 }];
    await syncCache(handlers, at('2026-10-13 19:00', NY));
    await runTicks(handlers, at('2026-10-13 19:00', NY), at('2026-10-14 01:00', NY));
    const lines = sentLines(NY);
    assert(lines.join(' | ') === '20:00 🔔 Reminder: Concert | 00:00 🚗 Pickup Reminder: Noa', `got ${lines.join(' | ') || '(nothing)'}`);
  });

  // Google's "1 day before" is sent (MAX_LEAD_MINUTES is a day), and a ping for an event on a
  // later calendar day than the ping says so, so it never reads as starting now.
  await check('a "1 day before" reminder goes out the day before and says "tomorrow at" the time, for the start and the pickup, once', async () => {
    reset({ id: 9 });
    await fakeRedis.set(REDIS_KEYS.userTimezone(9), IL);
    googleEvents = [{ calendarId: kidsCal, id: 'k9', summary: 'Piano', start: at('2026-10-14 17:00', IL), end: at('2026-10-14 18:00', IL), reminder: 1440 }];
    await syncCache(handlers, at('2026-10-13 08:00', IL));
    await runTicks(handlers, at('2026-10-13 08:00', IL), at('2026-10-14 19:00', IL));
    assert(sentLines(IL).join(' | ') === '17:00 🔔 Reminder: Piano | 18:00 🚗 Pickup Reminder: Noa', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
    assert(sent[0].text.split('\n')[2] === '⏰ Starting tomorrow at 17:00', `start: ${JSON.stringify(sent[0].text)}`);
    assert(sent[1].text.split('\n')[1] === '⏰ Pickup tomorrow at 18:00', `pickup: ${JSON.stringify(sent[1].text)}`);
  });

  await check('a lead over a day stays skipped; a same-day ping keeps its wording', async () => {
    reset({ id: 9 });
    await fakeRedis.set(REDIS_KEYS.userTimezone(9), IL);
    googleEvents = [
      { calendarId: kidsCal, id: 'k9a', summary: 'Piano', start: at('2026-10-14 17:00', IL), end: at('2026-10-14 18:00', IL), reminder: 1441 },
      { calendarId: kidsCal, id: 'k9b', summary: 'Chess', start: at('2026-10-14 12:00', IL), end: at('2026-10-14 13:00', IL), reminder: 2880 },
    ];
    await syncCache(handlers, at('2026-10-12 08:00', IL));
    await runTicks(handlers, at('2026-10-12 08:00', IL), at('2026-10-14 19:00', IL));
    assert(sent.length === 0, `got ${sentLines(IL).join(' | ')}`);
    reset({ id: 9 });
    await fakeRedis.set(REDIS_KEYS.userTimezone(9), IL);
    googleEvents = [{ calendarId: kidsCal, id: 'k9c', summary: 'Chess', start: at('2026-10-14 12:00', IL), end: at('2026-10-14 13:00', IL), reminder: 60 }];
    await syncCache(handlers, at('2026-10-14 08:00', IL));
    await runTicks(handlers, at('2026-10-14 08:00', IL), at('2026-10-14 14:00', IL));
    assert(sent[0].text.split('\n')[2] === '⏰ Starting at 12:00', `same day: ${JSON.stringify(sent[0].text)}`);
  });

  for (const [language, start, pickup] of [
    ['he', '⏰ מתחיל מחר ב-17:00', '⏰ איסוף מחר ב-18:00'],
    ['ru', '⏰ Начало завтра в 17:00', '⏰ Забрать завтра в 18:00'],
  ]) {
    await check(`a "1 day before" ping reads naturally in ${language}`, async () => {
      reset({ id: 9, language });
      await fakeRedis.set(REDIS_KEYS.userTimezone(9), IL);
      googleEvents = [{ calendarId: kidsCal, id: 'k9d', summary: 'Piano', start: at('2026-10-14 17:00', IL), end: at('2026-10-14 18:00', IL), reminder: 1440 }];
      await syncCache(handlers, at('2026-10-13 08:00', IL));
      await runTicks(handlers, at('2026-10-13 08:00', IL), at('2026-10-14 19:00', IL));
      assert(sent[0].text.split('\n')[2] === start && sent[1].text.split('\n')[1] === pickup, `got ${JSON.stringify(sent.map(x => x.text))}`);
    });
  }

  // Leads stop at a day, so no scheduled ping reaches further; the wording still handles it.
  for (const [language, want] of [['en', '⏰ Starting Sat 17 Oct at 17:00'], ['he', 'מתחיל ב-17:00, שבת, 17 באוק׳'], ['ru', 'сб, 17 окт.']] as const) {
    await check(`an event two or more days ahead is named by its weekday and date (${language})`, async () => {
      const { sendReminder } = await import('../src/services/reminders');
      reset({ id: 9, language });
      const eventTime = at('2026-10-17 17:00', IL);
      clock = at('2026-10-14 16:00', IL).getTime();
      const user = { id: 9, telegramId: 1009, language, messagingPlatform: 'telegram' } as never;
      const ok = await sendReminder(user, { event: { eventId: 'far', summary: 'Piano', start: '', end: '', calendarName: 'Dana', calendarId: kidsCal }, type: 'start', reminderTime: at('2026-10-14 17:00', IL), eventTime, isAutoReminder: false, sentKeyDate: '2026-10-14' }, IL);
      assert(ok && sent.length === 1, 'not sent');
      assert(sent[0].text.includes(want) && sent[0].text.includes('17:00'), JSON.stringify(sent[0].text));
    });
  }

  await check('all the alert timing wording (same day, tomorrow, further) is read from bot.eventAlertWhen in the messages files, none inline', async () => {
    const { readFileSync } = await import('node:fs');
    const code = readFileSync(path.resolve(__dirname, '../src/services/reminders.ts'), 'utf8');
    assert(!/Starting at|מתחיל ב|Начало в|Pickup at|איסוף ב|Забрать в/.test(code), 'inline timing wording in reminders.ts');
    for (const lang of ['en', 'he', 'ru']) {
      const keys = Object.keys((JSON.parse(readFileSync(path.resolve(__dirname, `../messages/${lang}.json`), 'utf8')) as { bot: { eventAlertWhen: object } }).bot.eventAlertWhen).sort().join();
      assert(keys === 'pickupAt,pickupOn,pickupTomorrow,startsAt,startsOn,startsTomorrow', `${lang}: ${keys}`);
    }
  });

  await check('a 00:10 start with a 1-day lead is sent at 00:10 the day before, once, as "tomorrow at 00:10"', async () => {
    reset({ id: 9 });
    await fakeRedis.set(REDIS_KEYS.userTimezone(9), IL);
    googleEvents = [{ calendarId: kidsCal, id: 'k9e', summary: 'Sunrise run', start: at('2026-10-14 00:10', IL), end: at('2026-10-14 01:00', IL), reminder: 1440 }];
    await syncCache(handlers, at('2026-10-12 22:00', IL));
    await runTicks(handlers, at('2026-10-12 23:00', IL), at('2026-10-14 02:00', IL));
    assert(sentLines(IL).join(' | ') === '00:10 🔔 Reminder: Sunrise run | 01:00 🚗 Pickup Reminder: Noa', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
    assert(sent[0].text.split('\n')[2] === '⏰ Starting tomorrow at 00:10', JSON.stringify(sent[0].text));
  });

  for (const leads of [[1440, 30], [30, 1440]]) {
    await check(`popups of ${leads.join(' and ')} minutes: the 30-minute one, for the start and the pickup`, async () => {
      reset({ id: 12 });
      await fakeRedis.set(REDIS_KEYS.userTimezone(12), IL);
      googleEvents = [{ calendarId: kidsCal, id: 'k12', summary: 'Piano', start: at('2026-10-14 17:00', IL), end: at('2026-10-14 18:00', IL), reminder: leads }];
      await syncCache(handlers, at('2026-10-13 08:00', IL));
      await runTicks(handlers, at('2026-10-13 08:00', IL), at('2026-10-14 19:00', IL));
      assert(sentLines(IL).join(' | ') === '16:30 🔔 Reminder: Piano | 17:30 🚗 Pickup Reminder: Noa', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
      assert(sent[0].at === at('2026-10-14 16:30', IL).getTime(), `sent ${new RealDate(sent[0].at).toISOString()}`);
    });
  }

  for (const [label, tz, location] of [['New York', NY, 'New York'], ['Israel', IL, 'Tel Aviv']]) {
    await check(`${label}: a lead past two hours is sent on the event's own day, a pickup too, and the evening before for an event past midnight`, async () => {
      const meCal = 'me@group.calendar.google.com';
      reset({
        id: 16,
        location,
        calendarAssignments: [
          { calendarId: kidsCal, labels: ['kids'], name: 'Noa', color: '#f00' },
          { calendarId: meCal, labels: [], name: 'Me', color: '#00f' },
        ],
      });
      await fakeRedis.set(REDIS_KEYS.userTimezone(16), tz);
      googleEvents = [
        { calendarId: kidsCal, id: 'k16', summary: 'Kindergarten', start: at('2026-10-14 08:00', tz), end: at('2026-10-14 16:00', tz), reminder: 180 },
        { calendarId: meCal, id: 'm16a', summary: 'Three hours', start: at('2026-10-14 15:00', tz), end: at('2026-10-14 15:30', tz), reminder: 180 },
        { calendarId: meCal, id: 'm16b', summary: 'Concert', start: at('2026-10-14 20:00', tz), end: at('2026-10-14 22:00', tz), reminder: 900 },
        { calendarId: meCal, id: 'm16c', summary: 'Late show', start: at('2026-10-14 21:00', tz), end: at('2026-10-14 23:00', tz), reminder: 121 },
        // 22:00 the evening before (the 14th), for a start on the 15th
        { calendarId: meCal, id: 'm16d', summary: 'Night flight', start: at('2026-10-15 01:00', tz), end: at('2026-10-15 03:00', tz), reminder: 180 },
      ];
      await syncCache(handlers, at('2026-10-13 23:00', tz));
      await runTicks(handlers, at('2026-10-14 00:00', tz), at('2026-10-15 04:00', tz));
      const lines = sentLines(tz).join(' | ');
      assert(sent[sent.length - 1].text.split('\n')[2] === '⏰ Starting tomorrow at 01:00', `night flight: ${JSON.stringify(sent[sent.length - 1].text)}`);
      assert(lines === '05:00 🔔 Reminder: Kindergarten | 05:00 🔔 Reminder: Concert | 12:00 🔔 Reminder: Three hours | 13:00 🚗 Pickup Reminder: Noa | 18:55 🔔 Reminder: Late show | 22:00 🔔 Reminder: Night flight', `got ${lines || '(nothing)'}`);
    });
  }

  await check('a 2-hour reminder, the longest sent, reaches past midnight: 22:30 for a 00:30 start', async () => {
    reset({ id: 13, location: 'New York' });
    await fakeRedis.set(REDIS_KEYS.userTimezone(13), NY);
    googleEvents = [{ calendarId: kidsCal, id: 'k13', summary: 'Night flight', start: at('2026-10-14 00:30', NY), end: at('2026-10-14 03:00', NY), reminder: 120 }];
    await syncCache(handlers, at('2026-10-13 20:00', NY));
    await runTicks(handlers, at('2026-10-13 20:00', NY), at('2026-10-14 04:00', NY));
    assert(sentLines(NY).join(' | ') === '22:30 🔔 Reminder: Night flight | 01:00 🚗 Pickup Reminder: Noa', `got ${sentLines(NY).join(' | ') || '(nothing)'}`);
    assert(sent[0].at === at('2026-10-13 22:30', NY).getTime(), `sent ${new RealDate(sent[0].at).toISOString()}`);
  });

  // The range fetch serves the reminder run, the week lookahead and voice; one calendar
  // after another it took the run past its 5-minute window for a few dozen users.
  await check('the range fetch asks for every calendar at once, with the same events and errors as one by one; every calendar down fails it', async () => {
    const { fetchEventsInRange } = await import('../src/services/calendar');
    reset({ id: 14 });
    const cals = ['a@group.calendar.google.com', 'b@group.calendar.google.com', 'c@group.calendar.google.com', 'd@group.calendar.google.com'];
    googleEvents = [
      { calendarId: cals[2], id: 'c1', summary: 'Gym', start: at('2026-10-13 18:00', IL), end: at('2026-10-13 19:00', IL) },
      { calendarId: cals[0], id: 'a1', summary: 'Meeting', start: at('2026-10-13 10:00', IL), end: at('2026-10-13 11:00', IL) },
      { calendarId: cals[3], id: 'd1', summary: 'Dentist', start: at('2026-10-13 14:00', IL), end: at('2026-10-13 15:00', IL) },
    ];
    const range = [at('2026-10-13 00:00', IL), at('2026-10-14 00:00', IL)] as const;
    const error = console.error;
    console.error = () => {};
    Object.assign(googleCalls, { latencyMs: 100, maxInFlight: 0, failing: { [cals[1]]: new Error('Not Found') } });
    try {
      const started = RealDate.now();
      const events = await fetchEventsInRange('refresh-token', cals, ...range);
      const elapsed = RealDate.now() - started;
      // Each calendar's name and events in parallel too: 8 requests, one round trip.
      assert(googleCalls.maxInFlight === 2 * cals.length, `at most ${googleCalls.maxInFlight} requests in flight`);
      assert(elapsed < 300, `took ${elapsed} ms for 100 ms requests`);
      // A calendar that fails is skipped, the rest sorted by start
      assert(events.map(e => `${e.summary}@${e.calendarName}`).join(', ') === `Meeting@${cals[0]}, Dentist@${cals[3]}, Gym@${cals[2]}`, `got ${events.map(e => e.summary).join(', ')}`);
      // and one whose token is refused fails the whole fetch. The error is the token endpoint's own
      // shape (the message and the OAuth error in the body: classifyGoogleError reads the body, no
      // longer the bare message), and a 403 rate limit is not a token error.
      googleCalls.failing = { [cals[3]]: Object.assign(new Error('invalid_grant'), { code: 400, response: { status: 400, data: { error: 'invalid_grant' } } }) };
      const failed = await fetchEventsInRange('refresh-token', cals, ...range).then(() => 'resolved', (err: Error) => err.message);
      assert(failed === 'GOOGLE_TOKEN_EXPIRED', `token error: ${failed}`);
      googleCalls.failing = { [cals[3]]: Object.assign(new Error('Rate Limit Exceeded'), { code: 403, response: { status: 403, data: { error: { code: 403, errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded' }] } } } }) };
      const limited = await fetchEventsInRange('refresh-token', cals, ...range).then(e => `resolved ${e.length}`, (err: Error) => err.message);
      assert(limited === 'resolved 2', `one calendar rate limited: ${limited}`);
      // When not one calendar answers, Google couldn't be read at all: the fetch fails, so the
      // split fetch knows its Google half failed (G2), not a day with no events.
      googleCalls.failing = Object.fromEntries(cals.map(c => [c, Object.assign(new Error('Backend Error'), { code: 503 })]));
      const down = await fetchEventsInRange('refresh-token', cals, ...range).then(() => 'resolved', (err: Error) => err.message);
      assert(down === 'GOOGLE_FETCH_FAILED', `every calendar down: ${down}`);
      // Calendars that are gone (404, 410: deleted, unshared) are no events, not an outage,
      // as the reader's calendars_gone; one gone and the rest down is still an outage.
      const gone = (code: number) => Object.assign(new Error('Not Found'), { code });
      googleCalls.failing = Object.fromEntries(cals.map((c, i) => [c, gone(i % 2 ? 410 : 404)]));
      const allGone = await fetchEventsInRange('refresh-token', cals, ...range).then(e => `resolved ${e.length}`, (err: Error) => err.message);
      assert(allGone === 'resolved 0', `every calendar gone: ${allGone}`);
      googleCalls.failing = Object.fromEntries(cals.map((c, i) => [c, i === 0 ? gone(404) : Object.assign(new Error('Backend Error'), { code: 503 })]));
      const goneAndDown = await fetchEventsInRange('refresh-token', cals, ...range).then(() => 'resolved', (err: Error) => err.message);
      assert(goneAndDown === 'GOOGLE_FETCH_FAILED', `one gone, the rest down: ${goneAndDown}`);
    } finally {
      console.error = error;
      Object.assign(googleCalls, { latencyMs: 0, failing: {} });
    }
  });

  // The settings route writes the cache entry too, and it must carry what the run needs.
  await check('a NATIVE user who saves settings keeps their reminders, with the new toggle', async () => {
    reset({ id: 10, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null });
    nativeCalendars = [{ id: 'cal10', name: 'Leo', labels: ['kids'] }];
    nativeEvents = [{ calendarId: 'cal10', id: 'n10', title: 'Kindergarten', startsAt: at('2026-10-13 08:00', IL), endsAt: at('2026-10-13 16:00', IL), timeZone: IL }];
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    await saveSettings(at('2026-10-13 07:05', IL), 1010, { pickupRemindersEnabled: false });
    await runTicks(handlers, at('2026-10-13 07:05', IL), at('2026-10-13 17:00', IL));
    const lines = sentLines(IL);
    assert(lines.join(' | ') === '07:45 🤖 Auto-Reminder: Kindergarten', `got ${lines.join(' | ') || '(nothing)'}`);
  });

  // FamCal reminders' own setting: not behind the Google event-alerts switch, but behind the plan.
  await check('the reminder time saves for a user with event alerts off when the plan allows reminders, and is dropped (the rest of the save kept) when it does not', async () => {
    reset({ id: 30, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null, remindersEnabled: false });
    const route = await import('../app/api/settings/route');
    const post = async (body: Record<string, unknown>) => {
      const log = console.log;
      console.log = () => {};
      try {
        const request = { url: 'https://famcal.bot/api/settings?user_id=1030', json: async () => body };
        return ((await route.POST(request as never)) as unknown as { status: number }).status;
      } finally {
        console.log = log;
      }
    };
    assert(await post({ reminderTime: '07:30' }) === 200 && userRows[0].reminderTime === '07:30', `allowed: ${userRows[0].reminderTime}`);
    assert(await post({ reminderTime: '07:10' }) === 400, 'a step off 15 minutes');
    // M1(b): an unallowed time drops only that field; the rest of the save goes through.
    remindersAllowedByPlan = false;
    assert(await post({ reminderTime: '08:00', defaultReminderMinutes: 30 }) === 200, 'the save is not thrown away');
    assert(userRows[0].reminderTime === '07:30' && userRows[0].defaultReminderMinutes === 30, `dropped field only: ${userRows[0].reminderTime} / ${userRows[0].defaultReminderMinutes}`);
  });

  await check("a settings save keeps the location, so an expired timezone resolves to the user's", async () => {
    reset({ id: 11, location: 'New York' });
    googleEvents = [{ calendarId: kidsCal, id: 'k11', summary: 'Soccer', start: at('2026-10-13 17:00', NY), end: at('2026-10-13 18:00', NY) }];
    await syncCache(handlers, at('2026-10-13 15:00', NY));
    await saveSettings(at('2026-10-13 15:05', NY), 1011, { weatherEnabled: true });
    const entry = ((await fakeRedis.get(REDIS_KEYS.REMINDER_USERS)) as Array<Record<string, unknown>>).find(u => u.id === 11);
    assert(entry?.location === 'New York' && entry?.calendarSource === 'GOOGLE' && entry?.pairingId === null, `cached ${JSON.stringify(entry)}`);
    await fakeRedis.del(REDIS_KEYS.userTimezone(11)); // expired
    await runTicks(handlers, at('2026-10-13 16:00', NY), at('2026-10-13 19:00', NY));
    const lines = sentLines(NY);
    assert(lines.join(' | ') === '16:45 🤖 Auto-Reminder: Soccer | 17:45 🤖🚗 Auto-Pickup Reminder: Noa', `got ${lines.join(' | ') || '(nothing)'}`);
  });

  for (const column of ['suspendedAt', 'unreachableSince']) {
    await check(`a settings save does not put back a user the sync leaves out (${column})`, async () => {
      reset({ id: 15, [column]: at('2026-10-01 12:00', IL) });
      googleEvents = [{ calendarId: kidsCal, id: 'k15', summary: 'Kindergarten', start: at('2026-10-13 08:00', IL), end: at('2026-10-13 16:00', IL) }];
      await syncCache(handlers, at('2026-10-13 07:00', IL));
      await saveSettings(at('2026-10-13 07:05', IL), 1015, { pickupRemindersEnabled: false });
      const cached = (await fakeRedis.get(REDIS_KEYS.REMINDER_USERS)) as Array<{ id: number }>;
      assert(!cached.some(u => u.id === 15), `cached ${JSON.stringify(cached)}`);
      await runTicks(handlers, at('2026-10-13 07:05', IL), at('2026-10-13 17:00', IL));
      assert(sent.length === 0, `got ${sentLines(IL).join(' | ')}`);
    });
  }

  await check('a built-in calendar reminder gets no event alert, neither a start nor a pickup one', async () => {
    reset({ id: 17, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null });
    nativeCalendars = [{ id: 'cal17', name: 'Leo', labels: ['kids'] }];
    nativeEvents = [
      // It pings through its own pass; here it would get a start alert and, on a kids calendar, a pickup one.
      { calendarId: 'cal17', id: 'r17', kind: 'REMINDER', title: 'Call the plumber', startsAt: at('2026-10-13 08:00', IL), endsAt: at('2026-10-13 08:00', IL), timeZone: IL },
      { calendarId: 'cal17', id: 'n17', title: 'Swim', startsAt: at('2026-10-13 10:00', IL), endsAt: at('2026-10-13 11:00', IL), timeZone: IL },
    ];
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    await runTicks(handlers, at('2026-10-13 07:00', IL), at('2026-10-13 12:00', IL));
    const lines = sentLines(IL);
    assert(lines.join(' | ') === '09:45 🤖 Auto-Reminder: Swim | 10:45 🤖🚗 Auto-Pickup Reminder: Leo', `got ${lines.join(' | ') || '(nothing)'}`);
  });

  // Editor upgrades spec §2: a FamCal event's own alert (the editor's Alert row) is read before the user's default.
  await check('a FamCal event with its own lead pings at that lead as "Reminder:" (not Auto), the pickup at the same lead', async () => {
    reset({ id: 40, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null });
    await fakeRedis.set(REDIS_KEYS.userTimezone(40), IL);
    nativeCalendars = [{ id: 'cal40', name: 'Leo', labels: ['kids'] }];
    nativeEvents = [{ calendarId: 'cal40', id: 'n40', title: 'Swim', startsAt: at('2026-10-13 10:00', IL), endsAt: at('2026-10-13 11:00', IL), timeZone: IL, ownAlerts: true, alertMinutes: [30] }];
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    await runTicks(handlers, at('2026-10-13 07:00', IL), at('2026-10-13 12:00', IL));
    const lines = sentLines(IL);
    assert(lines.join(' | ') === '09:30 🔔 Reminder: Swim | 10:30 🚗 Pickup Reminder: Leo', `got ${lines.join(' | ') || '(nothing)'}`);
  });

  await check('a FamCal event set to None pings nothing: no start alert and no pickup (the default would have sent both)', async () => {
    reset({ id: 41, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null });
    await fakeRedis.set(REDIS_KEYS.userTimezone(41), IL);
    nativeCalendars = [{ id: 'cal41', name: 'Leo', labels: ['kids'] }];
    nativeEvents = [
      { calendarId: 'cal41', id: 'n41', title: 'Swim', startsAt: at('2026-10-13 10:00', IL), endsAt: at('2026-10-13 11:00', IL), timeZone: IL, ownAlerts: true, alertMinutes: [] },
      { calendarId: 'cal41', id: 'n41b', title: 'Piano', startsAt: at('2026-10-13 12:00', IL), endsAt: at('2026-10-13 13:00', IL), timeZone: IL },
    ];
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    await runTicks(handlers, at('2026-10-13 07:00', IL), at('2026-10-13 14:00', IL));
    const lines = sentLines(IL);
    assert(lines.join(' | ') === '11:45 🤖 Auto-Reminder: Piano | 12:45 🤖🚗 Auto-Pickup Reminder: Leo', `got ${lines.join(' | ') || '(nothing)'}`);
  });

  await check('a recurring FamCal series with an own lead pings each occurrence at that lead, once each (the series\' alert reaches every occurrence)', async () => {
    reset({ id: 44, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null });
    await fakeRedis.set(REDIS_KEYS.userTimezone(44), IL);
    nativeCalendars = [{ id: 'cal44', name: 'Dana', labels: ['primary', 'yours'] }];
    nativeEvents = ['2026-10-13', '2026-10-14'].map((day) => ({ calendarId: 'cal44', id: 'n44', recurring: true, title: 'Swim', startsAt: at(`${day} 10:00`, IL), endsAt: at(`${day} 11:00`, IL), timeZone: IL, ownAlerts: true, alertMinutes: [5] }));
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    await runTicks(handlers, at('2026-10-13 07:00', IL), at('2026-10-14 12:00', IL));
    assert(sentLines(IL).join(' | ') === '09:55 🔔 Reminder: Swim | 09:55 🔔 Reminder: Swim', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
  });

  await check('an event on the default (ownAlerts false) still pings at the user\'s lead; an all-day event with an own alert is skipped', async () => {
    reset({ id: 42, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null });
    await fakeRedis.set(REDIS_KEYS.userTimezone(42), IL);
    nativeCalendars = [{ id: 'cal42', name: 'Dana', labels: ['primary', 'yours'] }];
    nativeEvents = [
      { calendarId: 'cal42', id: 'n42', title: 'Swim', startsAt: at('2026-10-13 10:00', IL), endsAt: at('2026-10-13 11:00', IL), timeZone: IL, ownAlerts: false, alertMinutes: [] },
      { calendarId: 'cal42', id: 'n42d', title: 'Holiday', startsAt: at('2026-10-13 00:00', IL), endsAt: at('2026-10-13 23:59', IL), timeZone: IL, allDay: true, ownAlerts: true, alertMinutes: [30] },
    ];
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    await runTicks(handlers, at('2026-10-13 07:00', IL), at('2026-10-13 12:00', IL));
    assert(sentLines(IL).join(' | ') === '09:45 🤖 Auto-Reminder: Swim', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
  });

  await check('a Google event\'s nearest popup still wins, and two overlapping runs send it once under the unchanged key', async () => {
    reset({ id: 43 });
    await fakeRedis.set(REDIS_KEYS.userTimezone(43), IL);
    googleEvents = [{ calendarId: kidsCal, id: 'k43', summary: 'Piano', start: at('2026-10-13 17:00', IL), end: at('2026-10-13 18:00', IL), reminder: [1440, 30] }];
    await syncCache(handlers, at('2026-10-13 15:00', IL));
    await runTicks(handlers, at('2026-10-13 16:25', IL), at('2026-10-13 16:35', IL));
    await runTicks(handlers, at('2026-10-13 16:30', IL), at('2026-10-13 16:40', IL));
    assert(sentLines(IL).join(' | ') === '16:30 🔔 Reminder: Piano', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
    assert(store.has(REDIS_KEYS.reminder(43, 'k43', 'start', '2026-10-13')), `the key: ${[...store.keys()].join(', ')}`);
  });

  await check('titles, calendar names and places are escaped for Telegram\'s HTML', async () => {
    reset({ id: 18, calendarAssignments: [{ calendarId: kidsCal, labels: ['kids'], name: 'Noa & Leo', color: '#f00' }] });
    await fakeRedis.set(REDIS_KEYS.userTimezone(18), IL);
    googleEvents = [{
      calendarId: kidsCal, id: 'k18', summary: 'Tom & Jerry <live>', location: 'Hall <B>',
      start: at('2026-10-13 10:00', IL), end: at('2026-10-13 11:00', IL),
    }];
    await syncCache(handlers, at('2026-10-13 09:00', IL));
    await runTicks(handlers, at('2026-10-13 09:00', IL), at('2026-10-13 12:00', IL));
    assert(sent.length === 2, `sent ${sent.length}: ${sentLines(IL).join(' | ')}`);
    assert(sent[0].text === '🤖 <b>Auto-Reminder: Tom &amp; Jerry &lt;live&gt;</b>\n📅 Noa &amp; Leo\n⏰ Starting at 10:00\n📍 Hall &lt;B&gt;', `start ${JSON.stringify(sent[0].text)}`);
    assert(sent[1].text.startsWith('🤖🚗 <b>Auto-Pickup Reminder: Noa &amp; Leo</b>'), `pickup ${JSON.stringify(sent[1].text)}`);
  });

  await check('a user who blocked the bot is marked unreachable, quietly, and the next sync leaves them out', async () => {
    reset({ id: 19 });
    await fakeRedis.set(REDIS_KEYS.userTimezone(19), IL);
    googleEvents = [{ calendarId: kidsCal, id: 'k19', summary: 'Kindergarten', start: at('2026-10-13 08:00', IL), end: at('2026-10-13 16:00', IL) }];
    sendError = Object.assign(new Error('ETELEGRAM: 403 Forbidden: bot was blocked by the user'), {
      code: 'ETELEGRAM',
      response: { body: { error_code: 403, description: 'Forbidden: bot was blocked by the user' } },
    });
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    await runTicks(handlers, at('2026-10-13 07:40', IL), at('2026-10-13 07:50', IL));
    assert(sendAttempts === 1, `${sendAttempts} send attempts`);
    assert(userRows[0].unreachableSince instanceof RealDate, `unreachableSince ${String(userRows[0].unreachableSince)}`);
    assert(!captured.includes('reminders-send'), `captured ${captured.join(', ')}`);
    await syncCache(handlers, at('2026-10-13 08:00', IL));
    await runTicks(handlers, at('2026-10-13 08:00', IL), at('2026-10-13 17:00', IL));
    assert(sendAttempts === 1, `tried again: ${sendAttempts} send attempts`);
  });

  // "Google as a connection" (G2): the fetch is split by calendar id, and a failed half is logged, never thrown.
  await check('a FamCal user who connected Google gets alerts from both: the FamCal event and the Google one', async () => {
    reset({ id: 20, calendarSource: 'NATIVE' });
    await fakeRedis.set(REDIS_KEYS.userTimezone(20), IL);
    nativeCalendars = [{ id: 'cal20', name: 'Dana', labels: ['primary', 'yours'] }];
    nativeEvents = [{ calendarId: 'cal20', id: 'n20', title: 'Swim', startsAt: at('2026-10-13 10:00', IL), endsAt: at('2026-10-13 11:00', IL), timeZone: IL }];
    googleEvents = [{ calendarId: kidsCal, id: 'k20', summary: 'Kindergarten', start: at('2026-10-13 08:00', IL), end: at('2026-10-13 16:00', IL) }];
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    await runTicks(handlers, at('2026-10-13 07:00', IL), at('2026-10-13 17:00', IL));
    const lines = sentLines(IL);
    assert(lines.join(' | ') === '07:45 🤖 Auto-Reminder: Kindergarten | 09:45 🤖 Auto-Reminder: Swim | 15:45 🤖🚗 Auto-Pickup Reminder: Noa', `got ${lines.join(' | ') || '(nothing)'}`);
  });

  // Google's range fetch reports a failed calendar and goes on (the 'calendar-fetch-range' warning);
  // only a dead token fails the whole Google half, which then threw away the FamCal alerts too.
  await check('a dead Google token: a Google user\'s FamCal alert still goes out, and the failed Google half is reported', async () => {
    reset({ id: 21 });
    await fakeRedis.set(REDIS_KEYS.userTimezone(21), IL);
    nativeCalendars = [{ id: 'cal21', name: 'Dana', labels: ['yours'] }];
    nativeEvents = [{ calendarId: 'cal21', id: 'n21', title: 'Swim', startsAt: at('2026-10-13 10:00', IL), endsAt: at('2026-10-13 11:00', IL), timeZone: IL }];
    googleEvents = [{ calendarId: kidsCal, id: 'k21', summary: 'Kindergarten', start: at('2026-10-13 08:00', IL), end: at('2026-10-13 16:00', IL) }];
    googleCalls.failing[kidsCal] = Object.assign(new Error('invalid_grant'), { code: 400, response: { status: 400, data: { error: 'invalid_grant' } } });
    try {
      await syncCache(handlers, at('2026-10-13 07:00', IL));
      await runTicks(handlers, at('2026-10-13 09:40', IL), at('2026-10-13 09:50', IL));
    } finally {
      delete googleCalls.failing[kidsCal];
    }
    const lines = sentLines(IL);
    assert(lines.join(' | ') === '09:45 🤖 Auto-Reminder: Swim', `got ${lines.join(' | ') || '(nothing)'}`);
    assert(captured.includes('calendar-provider-fetch'), `captured ${captured.join(', ') || '(nothing)'}`);
  });

  // ---- Secret rotation (spec section c): the cache holds each Google token sealed ----

  await check('the cache (reminders:users:v2) holds the Google token sealed after the sync and after a settings save, and Google still gets it in plain form', async () => {
    const { isEncrypted, openSecret } = await import('../src/utils/encryption');
    reset({ id: 22 });
    await fakeRedis.set(REDIS_KEYS.userTimezone(22), IL);
    googleEvents = [{ calendarId: kidsCal, id: 'k22', summary: 'Kindergarten', start: at('2026-10-13 08:00', IL), end: at('2026-10-13 16:00', IL) }];
    googleTokens = [];
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    const synced = cacheV2();
    assert(synced.raw !== '' && !synced.raw.includes('refresh-token'), `v2 after the sync: ${synced.raw || '(missing)'}`);
    const fromSync = synced.entries.find(u => u.id === 22);
    const syncToken = fromSync?.googleToken ?? '';
    assert(!!fromSync && isEncrypted(syncToken) && openSecret(syncToken) === 'refresh-token' && !('googleRefreshToken' in fromSync),
      `entry after the sync ${JSON.stringify(fromSync)}`);
    await saveSettings(at('2026-10-13 07:05', IL), 1022, { weatherEnabled: true });
    const saved = cacheV2();
    assert(saved.raw !== '' && !saved.raw.includes('refresh-token'), `v2 after a settings save: ${saved.raw || '(missing)'}`);
    const fromSave = saved.entries.find(u => u.id === 22);
    const saveToken = fromSave?.googleToken ?? '';
    assert(!!fromSave && isEncrypted(saveToken) && openSecret(saveToken) === 'refresh-token' && !('googleRefreshToken' in fromSave),
      `entry after the save ${JSON.stringify(fromSave)}`);
    await runTicks(handlers, at('2026-10-13 07:05', IL), at('2026-10-13 08:00', IL));
    assert(sentLines(IL).join(' | ') === '07:45 🤖 Auto-Reminder: Kindergarten', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
    assert(googleTokens.length > 0 && googleTokens.every(token => token === 'refresh-token'),
      `Google was given ${googleTokens.length} token(s), ${googleTokens.filter(token => token === 'refresh-token').length} of them the plain one`);
  });

  await check('a row whose token no key opens: the sync still caches both users; that user keeps every FamCal reminder, makes no Google call, and is reported once per process', async () => {
    reset({ id: 23 });
    const cipher = await foreignCipher('another-deployments-token');
    userRows.push({ ...userRows[0], id: 27, telegramId: BigInt(1027), googleRefreshToken: cipher });
    for (const id of [23, 27]) await fakeRedis.set(REDIS_KEYS.userTimezone(id), IL);
    googleEvents = [{ calendarId: kidsCal, id: 'k23', summary: 'Kindergarten', start: at('2026-10-13 08:00', IL), end: at('2026-10-13 16:00', IL) }];
    nativeCalendars = [{ id: 'cal27', name: 'Dana', labels: ['yours'] }];
    nativeEvents = [{ calendarId: 'cal27', id: 'n27', title: 'Swim', startsAt: at('2026-10-13 08:00', IL), endsAt: at('2026-10-13 09:00', IL), timeZone: IL }];
    googleTokens = [];
    const output: string[] = [];
    const error = console.error;
    const warn = console.warn;
    console.error = (...args: unknown[]) => { output.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
    console.warn = console.error;
    try {
      await syncCache(handlers, at('2026-10-13 07:00', IL));
      const ids = cacheV2().entries.map(u => u.id).sort((a, b) => a - b);
      assert(ids.join(',') === '23,27', `cached ${ids.join(',') || '(nothing)'}; captured ${captured.join(', ') || '(nothing)'}`);
      await runTicks(handlers, at('2026-10-13 07:40', IL), at('2026-10-13 07:50', IL));
    } finally {
      console.error = error;
      console.warn = warn;
    }
    const to27 = sent.filter(s => s.chatId === 1027);
    assert(to27.length === 1 && to27[0].text.includes('Swim') && !to27[0].text.includes('Kindergarten'), `user 27 got ${JSON.stringify(to27.map(s => s.text))}`);
    assert(sent.some(s => s.chatId === 1023 && s.text.includes('Kindergarten')), `user 23 got ${JSON.stringify(sent.filter(s => s.chatId === 1023).map(s => s.text))}`);
    // Google's OAuth client is only ever given user 23's plain token; user 27 never reaches Google
    assert(googleTokens.length > 0 && googleTokens.every(token => token === 'refresh-token'), `Google was given ${JSON.stringify(googleTokens.map(t => t.slice(0, 6)))}`);
    // Once per process across the two runs, and the user is not failed
    assert(captured.filter(c => c === 'token-undecryptable').length === 1, `captured ${captured.join(', ')}`);
    assert(!captured.includes('cron-reminders-process-user'), `captured ${captured.join(', ')}`);
    const leaked = [...output, ...capturedDetail].filter(line => line.includes(cipher) || line.includes('another-deployments-token'));
    assert(leaked.length === 0, `a token or its ciphertext reached a log or capture: ${leaked.length} line(s)`);
    assert(output.some(line => line.includes('undecryptable') && line.includes('27')), `output ${JSON.stringify(output)}`);
  });

  await check('no usable ENCRYPTION_KEY at tick time: a Google user keeps every FamCal alert, Google is never called, and the fault is reported once (not per tick, not as a failed user)', async () => {
    reset({ id: 30 });
    await fakeRedis.set(REDIS_KEYS.userTimezone(30), IL);
    nativeCalendars = [{ id: 'cal30', name: 'Dana', labels: ['yours'] }];
    nativeEvents = [{ calendarId: 'cal30', id: 'n30', title: 'Swim', startsAt: at('2026-10-13 10:00', IL), endsAt: at('2026-10-13 11:00', IL), timeZone: IL }];
    googleEvents = [{ calendarId: kidsCal, id: 'k30', summary: 'Kindergarten', start: at('2026-10-13 08:00', IL), end: at('2026-10-13 16:00', IL) }];
    googleTokens = [];
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    const savedKey = process.env.ENCRYPTION_KEY;
    delete (globalThis as Record<string, unknown>).__famcalEncryptionReports;
    process.env.ENCRYPTION_KEY = '';
    const callsBefore = googleTokens.length;
    const output: string[] = [];
    const error = console.error;
    const warn = console.warn;
    console.error = (...args: unknown[]) => { output.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
    console.warn = console.error;
    try {
      await runTicks(handlers, at('2026-10-13 09:40', IL), at('2026-10-13 09:50', IL));
    } finally {
      console.error = error;
      console.warn = warn;
      if (savedKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = savedKey;
      delete (globalThis as Record<string, unknown>).__famcalEncryptionReports;
    }
    assert(sentLines(IL).join(' | ') === '09:45 🤖 Auto-Reminder: Swim', `got ${sentLines(IL).join(' | ') || '(nothing)'}; captured ${captured.join(', ') || '(nothing)'}`);
    assert(googleTokens.length === callsBefore, `Google was called with ${googleTokens.length - callsBefore} token(s)`);
    assert(!captured.includes('cron-reminders-process-user'), `captured ${captured.join(', ')}`);
    assert(captured.filter(c => c === 'token-undecryptable').length === 1, `captured ${captured.join(', ') || '(nothing)'}`);
  });

  await check('a plaintext row is cached sealed, and an empty-cipher row (iv:tag: with no token) as no token: no capture, and nothing written to the row', async () => {
    const { isEncrypted, openSecret } = await import('../src/utils/encryption');
    const emptyCipher = `${'0'.repeat(32)}:${'a'.repeat(32)}:`;
    reset({ id: 28 });
    userRows.push({ ...userRows[0], id: 29, telegramId: BigInt(1029), googleRefreshToken: emptyCipher, calendarSource: 'NATIVE', calendarAssignments: null });
    for (const id of [28, 29]) await fakeRedis.set(REDIS_KEYS.userTimezone(id), IL);
    googleEvents = [{ calendarId: kidsCal, id: 'k28', summary: 'Kindergarten', start: at('2026-10-13 08:00', IL), end: at('2026-10-13 16:00', IL) }];
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    const { entries } = cacheV2();
    const plain = entries.find(u => u.id === 28)?.googleToken ?? '';
    assert(isEncrypted(plain) && openSecret(plain) === 'refresh-token', `plaintext row cached as ${JSON.stringify(entries.find(u => u.id === 28))}`);
    const empty = entries.find(u => u.id === 29);
    assert(empty?.googleToken === '', `empty-cipher row cached as ${JSON.stringify(empty)}`);
    await runTicks(handlers, at('2026-10-13 07:40', IL), at('2026-10-13 07:50', IL));
    assert(sent.length === 1 && sent[0].chatId === 1028, `sent to ${JSON.stringify(sent.map(s => s.chatId))}`);
    assert(!captured.includes('cron-reminders-process-user') && !captured.includes('token-undecryptable'), `captured ${captured.join(', ')}`);
    assert(userRows.find(r => r.id === 29)?.googleRefreshToken === emptyCipher, 'the empty-cipher row was written');
  });

  await check('the legacy reminders:users key is never read: alone in Redis the run waits for a sync; bootReminderCache() deletes it and builds v2', async () => {
    reset({ id: 24 });
    await fakeRedis.set(REDIS_KEYS.userTimezone(24), IL);
    googleEvents = [{ calendarId: kidsCal, id: 'k24', summary: 'Kindergarten', start: at('2026-10-13 08:00', IL), end: at('2026-10-13 16:00', IL) }];
    store.set('reminders:users', JSON.stringify([{
      id: 24, telegramId: '1024', googleRefreshToken: 'refresh-token', calendarAssignments: userRows[0].calendarAssignments,
      calendarSource: 'GOOGLE', pairingId: null, defaultReminderMinutes: 15, language: 'en', name: 'Dana', pickupRemindersEnabled: true, location: 'Tel Aviv',
    }]));
    clock = at('2026-10-13 07:45', IL).getTime();
    const log = console.log;
    console.log = () => {};
    try {
      const waited = await handlers.handleReminders(5);
      assert(waited.message === 'No cached users - waiting for daily sync' && sent.length === 0, `run ${JSON.stringify(waited)}; sent ${sent.length}`);
      await handlers.bootReminderCache();
    } finally {
      console.log = log;
    }
    assert(!store.has('reminders:users'), 'the legacy key is still there');
    assert(cacheV2().entries.some(u => u.id === 24), `v2 ${cacheV2().raw || '(missing)'}`);
    await runTicks(handlers, at('2026-10-13 07:40', IL), at('2026-10-13 07:50', IL));
    assert(sentLines(IL).join(' | ') === '07:45 🤖 Auto-Reminder: Kindergarten', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
  });

  await check('the hourly sync deletes the legacy key too', async () => {
    reset({ id: 25 });
    store.set('reminders:users', JSON.stringify([{ id: 25, telegramId: '1025', googleRefreshToken: 'refresh-token' }]));
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    assert(!store.has('reminders:users'), 'the legacy key is still there');
    assert(cacheV2().entries.some(u => u.id === 25), `v2 ${cacheV2().raw || '(missing)'}`);
  });

  await check('bootReminderCache never throws: a database failure at boot is logged and captured as boot-reminder-cache', async () => {
    reset({ id: 30 });
    const findMany = fakePrisma.user.findMany;
    fakePrisma.user.findMany = async () => { throw new Error('database down (smoke)'); };
    const error = console.error;
    console.error = () => {};
    try {
      await handlers.bootReminderCache();
    } finally {
      fakePrisma.user.findMany = findMany;
      console.error = error;
    }
    assert(captured.includes('boot-reminder-cache'), `captured ${captured.join(', ') || '(nothing)'}`);
  });

  await check('a failed delete of the legacy key is logged and captured as reminder-cache-purge, and bootReminderCache still builds v2', async () => {
    reset({ id: 31 });
    store.set('reminders:users', JSON.stringify([{ id: 31, telegramId: '1031', googleRefreshToken: 'refresh-token' }]));
    const del = fakeRedis.del;
    fakeRedis.del = async (key: string) => {
      if (key === 'reminders:users') throw new Error('redis down (smoke)');
      return del(key);
    };
    const error = console.error;
    const log = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      await handlers.bootReminderCache();
    } finally {
      fakeRedis.del = del;
      console.error = error;
      console.log = log;
    }
    assert(captured.includes('reminder-cache-purge') && !captured.includes('boot-reminder-cache'), `captured ${captured.join(', ') || '(nothing)'}`);
    assert(cacheV2().entries.some(u => u.id === 31), `v2 ${cacheV2().raw || '(missing)'}`);
  });

  await check('startScheduler rebuilds the cache at boot, not at the next hourly sync: the legacy key goes and v2 holds the users', async () => {
    reset({ id: 26 });
    store.set('reminders:users', JSON.stringify([{ id: 26, telegramId: '1026', googleRefreshToken: 'refresh-token' }]));
    const { startScheduler } = await import('../src/cron/scheduler');
    const log = console.log;
    console.log = () => {};
    try {
      startScheduler();
      // The boot step is fire-and-forget: give it up to a second of real time.
      for (let i = 0; i < 100 && !store.has('reminders:users:v2'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    } finally {
      console.log = log;
    }
    assert(!store.has('reminders:users'), 'the legacy key is still there');
    const entry = cacheV2().entries.find(u => u.id === 26);
    assert(!!entry && entry.googleToken !== 'refresh-token', `v2 ${cacheV2().raw || '(missing)'}`);
  });

  // ---- The event alerts gate (spec docs/superpowers/specs/2026-10-31-event-alerts-gate-design.md) ----
  // Neon suspends the database after 5 minutes without a query. The 5-minute pass read the FamCal store for every
  // cached user on every run, so it never slept; now the FamCal half is read only while the gate is open.

  const meCal = 'me@group.calendar.google.com';
  /** Passes every 5 minutes over [from, to): "HH:mm calls" for each that made a Prisma or store call. */
  async function readingPasses(from: Date, to: Date): Promise<string[]> {
    const out: string[] = [];
    for (let t = from.getTime(); t < to.getTime(); t += 5 * 60_000) {
      const calls = await passAt(new RealDate(t));
      if (calls.length > 0) out.push(`${formatInTimeZone(new RealDate(t), IL, 'HH:mm')} ${[...new Set(calls)].join(', ')}`);
    }
    return out;
  }
  /** One 5-minute pass at `when`, and the Prisma and store calls it made. */
  async function passAt(when: Date): Promise<string[]> {
    const p = prismaCalls.length;
    const s = storeCalls.length;
    await runTicks(handlers, when, new RealDate(when.getTime() + 1));
    return [...prismaCalls.slice(p), ...storeCalls.slice(s)];
  }
  /** Two users cached, feature access and timezones cached: 50 on FamCal only, 51 with Google too. */
  function twoUsers() {
    reset({ id: 50, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null });
    userRows.push({ ...userRows[0], id: 51, telegramId: BigInt(1051), googleRefreshToken: 'refresh-token', calendarSource: 'GOOGLE', calendarAssignments: [{ calendarId: meCal, labels: [], name: 'Me', color: '#00f' }] });
    nativeCalendars = [
      { id: 'cal50', name: 'Dana', labels: ['yours'], ownerUserId: 50, visibleTo: [50] },
      { id: 'cal51', name: 'Ron', labels: ['yours'], ownerUserId: 51, visibleTo: [51] },
    ];
  }

  await check('gate: after the 12:00 pass, the 12:05 ... 12:55 passes make no Prisma or store call; Google is still asked on each and its 12:30 alert goes out; the FamCal alert at 13:20 goes out on time', async () => {
    twoUsers();
    for (const id of [50, 51]) await fakeRedis.set(REDIS_KEYS.userTimezone(id), IL);
    // The next FamCal alert: 13:20 (the default 15 minutes before 13:35).
    nativeEvents = [{ calendarId: 'cal50', id: 'n50', title: 'Dentist', startsAt: at('2026-10-13 13:35', IL), endsAt: at('2026-10-13 14:00', IL), timeZone: IL }];
    googleEvents = [{ calendarId: meCal, id: 'g51', summary: 'Soccer', start: at('2026-10-13 12:45', IL), end: at('2026-10-13 13:30', IL) }];
    await syncCache(handlers, at('2026-10-13 11:00', IL));
    await passAt(at('2026-10-13 12:00', IL)); // may read
    let googleAsked = 0;
    const reads: string[] = [];
    for (let t = at('2026-10-13 12:05', IL).getTime(); t < at('2026-10-13 13:00', IL).getTime(); t += 5 * 60_000) {
      const before = googleCalls.requests;
      const calls = await passAt(new RealDate(t));
      if (calls.length > 0) reads.push(`${formatInTimeZone(new RealDate(t), IL, 'HH:mm')} ${calls.join(', ')}`);
      if (googleCalls.requests > before) googleAsked++;
    }
    assert(reads.length === 0, `idle passes that read: ${reads.join(' | ')}`);
    assert(googleAsked === 11, `Google asked in ${googleAsked} of the 11 idle passes`);
    // 13:00, the hour's ceiling, reads; then only the pass whose window holds 13:20 reads (13:20), not the one before it (13:15).
    assert((await passAt(at('2026-10-13 13:00', IL))).includes('listVisibleCalendars'), 'the 13:00 pass did not read');
    const before = await readingPasses(at('2026-10-13 13:05', IL), at('2026-10-13 13:20', IL));
    assert(before.length === 0, `passes before the 13:20 alert read: ${before.join(' | ')}`);
    assert((await passAt(at('2026-10-13 13:20', IL))).includes('fetchEventsInCalendars'), 'the 13:20 pass did not read');
    assert(sentLines(IL).join(' | ') === '12:30 🤖 Auto-Reminder: Soccer | 13:20 🤖 Auto-Reminder: Dentist', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
  });

  /** A store write at `when`, through the real event store (its fakes are the Prisma calls above). */
  async function storeWrite<T>(when: Date, write: (store: typeof import('../src/services/native-calendar/event-store')) => Promise<T>): Promise<T> {
    const store = await import('../src/services/native-calendar/event-store');
    clock = when.getTime();
    const log = console.log;
    console.log = () => {};
    try {
      return await write(store);
    } finally {
      console.log = log;
    }
  }
  /** User 50 alone, cached, its timezone cached, with its own calendar cal50; the 12:00 pass has read and closed the gate. */
  async function closedAtNoon(row: Partial<UserRow> = {}, labels: string[] = ['yours']) {
    reset({ id: 50, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null, ...row });
    await fakeRedis.set(REDIS_KEYS.userTimezone(50), IL);
    nativeCalendars = [{ id: 'cal50', name: 'Dana', labels, ownerUserId: 50 }];
    await syncCache(handlers, at('2026-10-13 11:00', IL));
    await passAt(at('2026-10-13 12:00', IL));
    const idle = await passAt(at('2026-10-13 12:05', IL));
    assert(idle.length === 0, `the gate did not close after 12:00: ${idle.join(', ')}`);
  }

  /** The 12:00 and 12:05 passes again, with the events the check put in place: the gate reads them at 12:00 and closes. */
  async function closedAtNoonAgain() {
    alertsGate.__resetEventAlertsGateForTests();
    await passAt(at('2026-10-13 12:00', IL));
    const idle = await passAt(at('2026-10-13 12:05', IL));
    assert(idle.length === 0, `the gate did not close after 12:00: ${idle.join(', ')}`);
  }

  await check('gate: an alert between two ticks (12:22) opens the tick whose window holds it (12:20), not the next one', async () => {
    await closedAtNoon();
    nativeEvents = [{ calendarId: 'cal50', id: 'b50', title: 'Between', startsAt: at('2026-10-13 12:37', IL), endsAt: at('2026-10-13 13:00', IL), timeZone: IL }];
    await closedAtNoonAgain();
    await runTicks(handlers, at('2026-10-13 12:10', IL), at('2026-10-13 13:00', IL));
    assert(sentLines(IL).join(' | ') === '12:20 🤖 Auto-Reminder: Between', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
  });

  await check('gate: the 12:00 pass sees an alert due before 13:00 whose event is past the day\'s reach (tomorrow 12:30, a day before: today 12:30)', async () => {
    await closedAtNoon();
    nativeEvents = [{ calendarId: 'cal50', id: 'f50', title: 'Far', startsAt: at('2026-10-14 12:30', IL), endsAt: at('2026-10-14 13:00', IL), timeZone: IL, ownAlerts: true, alertMinutes: [1440] }];
    await closedAtNoonAgain();
    await runTicks(handlers, at('2026-10-13 12:10', IL), at('2026-10-13 13:00', IL));
    assert(sentLines(IL).join(' | ') === '12:30 🔔 Reminder: Far', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
  });

  await check('gate: an event created at 12:07 for 12:20 with a 10-minute alert is sent by the 12:10 pass', async () => {
    await closedAtNoon();
    await storeWrite(at('2026-10-13 12:07', IL), store => store.createNativeEvent({
      calendarCuid: 'cal50', creatorUserId: 50, title: 'Call', startsAt: at('2026-10-13 12:20', IL), endsAt: at('2026-10-13 12:40', IL), timeZone: IL, alert: 10,
    }));
    await runTicks(handlers, at('2026-10-13 12:10', IL), at('2026-10-13 12:30', IL));
    assert(sentLines(IL).join(' | ') === '12:10 🔔 Reminder: Call', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
  });

  await check('gate: an event moved earlier is sent at its new time; a deleted one is never sent', async () => {
    await closedAtNoon();
    // 13:00 with the default 15 minutes: due at 12:45 (the 12:00 pass already saw it: the gate opens at 12:40).
    nativeEvents = [
      { calendarId: 'cal50', id: 'm50', title: 'Moved', startsAt: at('2026-10-13 13:00', IL), endsAt: at('2026-10-13 13:30', IL), timeZone: IL },
      { calendarId: 'cal50', id: 'd50', title: 'Deleted', startsAt: at('2026-10-13 13:00', IL), endsAt: at('2026-10-13 13:30', IL), timeZone: IL },
    ];
    await closedAtNoonAgain();
    await storeWrite(at('2026-10-13 12:07', IL), store => store.updateNativeEvent({
      seriesCuid: 'm50', scope: 'all', actingUserId: 50, startsAt: at('2026-10-13 12:25', IL), endsAt: at('2026-10-13 12:55', IL),
    }));
    await storeWrite(at('2026-10-13 12:08', IL), store => store.deleteNativeEvent({ seriesCuid: 'd50', scope: 'all', actingUserId: 50 }));
    await runTicks(handlers, at('2026-10-13 12:10', IL), at('2026-10-13 13:30', IL));
    assert(sentLines(IL).join(' | ') === '12:10 🤖 Auto-Reminder: Moved', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
  });

  await check('gate: the partner creates on their shared calendar at 12:07, and the viewer is alerted at 12:15', async () => {
    reset({ id: 52, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null, pairingId: 'p52' });
    userRows.push({ ...userRows[0], id: 53, telegramId: BigInt(1053), name: 'Ron' });
    pairings = [{ id: 'p52', status: 'ACTIVE', inviterUserId: 52, inviteeUserId: 53 }];
    for (const id of [52, 53]) await fakeRedis.set(REDIS_KEYS.userTimezone(id), IL);
    nativeCalendars = [
      { id: 'cal52', name: 'Dana', labels: ['yours'], ownerUserId: 52, visibleTo: [52] },
      { id: 'cal53', name: 'Ron', labels: ['kids'], ownerUserId: 53, visibleTo: [52, 53], privacy: 'SHARED_EDITOR' },
    ];
    await syncCache(handlers, at('2026-10-13 11:00', IL));
    await passAt(at('2026-10-13 12:00', IL));
    assert((await passAt(at('2026-10-13 12:05', IL))).length === 0, 'the gate did not close after 12:00');
    await storeWrite(at('2026-10-13 12:07', IL), store => store.createNativeEvent({
      calendarCuid: 'cal53', creatorUserId: 53, title: 'Swim', startsAt: at('2026-10-13 12:30', IL), endsAt: at('2026-10-13 13:30', IL), timeZone: IL,
    }));
    await runTicks(handlers, at('2026-10-13 12:10', IL), at('2026-10-13 12:20', IL));
    const toViewer = sent.filter(x => x.chatId === 1052).map(x => `${formatInTimeZone(new RealDate(x.at), IL, 'HH:mm')} ${x.text.split('\n')[0].replace(/<\/?b>/g, '')}`);
    assert(toViewer.join(' | ') === '12:15 🤖 Auto-Reminder: Swim', `the viewer got ${toViewer.join(' | ') || '(nothing)'}; all: ${sentLines(IL).join(' | ')}`);
  });

  await check('gate: a settings save that moves the default lead earlier is honoured at once (12:40 with 30 minutes: 12:10, not 12:25)', async () => {
    await closedAtNoon();
    nativeEvents = [{ calendarId: 'cal50', id: 'l50', title: 'Lesson', startsAt: at('2026-10-13 12:40', IL), endsAt: at('2026-10-13 13:00', IL), timeZone: IL }];
    await closedAtNoonAgain();
    await saveSettings(at('2026-10-13 12:07', IL), 1050, { defaultReminderMinutes: 30 });
    await runTicks(handlers, at('2026-10-13 12:10', IL), at('2026-10-13 13:00', IL));
    assert(sentLines(IL).join(' | ') === '12:10 🤖 Auto-Reminder: Lesson', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
  });

  await check('gate: a settings save that turns pickups on is honoured at once (a 12:30 end: the pickup at 12:15)', async () => {
    await closedAtNoon({ pickupRemindersEnabled: false }, ['kids']);
    nativeEvents = [{ calendarId: 'cal50', id: 'p50', title: 'Kindergarten', startsAt: at('2026-10-13 08:00', IL), endsAt: at('2026-10-13 12:30', IL), timeZone: IL }];
    await closedAtNoonAgain();
    await saveSettings(at('2026-10-13 12:07', IL), 1050, { pickupRemindersEnabled: true });
    await runTicks(handlers, at('2026-10-13 12:10', IL), at('2026-10-13 13:00', IL));
    assert(sentLines(IL).join(' | ') === '12:15 🤖🚗 Auto-Pickup Reminder: Dana', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
  });

  await check('gate: a plan regained at 12:07 (invalidateFeatureAccessCache) brings the 12:10 alert back', async () => {
    reset({ id: 50, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null });
    await fakeRedis.set(REDIS_KEYS.userTimezone(50), IL);
    nativeCalendars = [{ id: 'cal50', name: 'Dana', labels: ['yours'], ownerUserId: 50 }];
    nativeEvents = [{ calendarId: 'cal50', id: 'r50', title: 'Dentist', startsAt: at('2026-10-13 12:25', IL), endsAt: at('2026-10-13 13:00', IL), timeZone: IL }];
    remindersAllowedByPlan = false;
    await syncCache(handlers, at('2026-10-13 11:00', IL));
    await passAt(at('2026-10-13 12:00', IL));
    assert((await passAt(at('2026-10-13 12:05', IL))).length === 0, 'the gate did not close after 12:00');
    remindersAllowedByPlan = true;
    const { invalidateFeatureAccessCache } = await import('../src/services/subscription-service');
    clock = at('2026-10-13 12:07', IL).getTime();
    const log = console.log;
    console.log = () => {};
    try {
      await invalidateFeatureAccessCache(50);
    } finally {
      console.log = log;
    }
    await runTicks(handlers, at('2026-10-13 12:10', IL), at('2026-10-13 12:30', IL));
    assert(sentLines(IL).join(' | ') === '12:10 🤖 Auto-Reminder: Dentist', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
  });

  await check('gate: a failed FamCal half leaves it open and is captured (event-alerts-gate-held); the next pass reads, and one that succeeds closes it', async () => {
    reset({ id: 50, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null });
    await fakeRedis.set(REDIS_KEYS.userTimezone(50), IL);
    nativeCalendars = [{ id: 'cal50', name: 'Dana', labels: ['yours'], ownerUserId: 50 }];
    await syncCache(handlers, at('2026-10-13 11:00', IL));
    storeFailure = new Error('database down (smoke)');
    const error = console.error;
    console.error = () => {};
    try {
      await passAt(at('2026-10-13 12:00', IL));
    } finally {
      console.error = error;
      storeFailure = null;
    }
    assert(captured.includes('calendar-provider-fetch') && captured.includes('event-alerts-gate-held'), `captured ${captured.join(', ') || '(nothing)'}`);
    assert((await passAt(at('2026-10-13 12:05', IL))).includes('fetchEventsInCalendars'), 'the pass after the failure did not read FamCal');
    assert(captured.filter(c => c === 'event-alerts-gate-held').length === 1, `captured ${captured.join(', ')}`);
    assert((await passAt(at('2026-10-13 12:10', IL))).length === 0, 'a pass that read without a failure did not close the gate');
  });

  await check('gate: a pass that throws for a user (the access check, recomputed while the database is down) holds it through the handler\'s catch alone; the next pass reads, a clean one closes it', async () => {
    reset({ id: 50, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null });
    await fakeRedis.set(REDIS_KEYS.userTimezone(50), IL);
    nativeCalendars = [{ id: 'cal50', name: 'Dana', labels: ['yours'], ownerUserId: 50 }];
    await syncCache(handlers, at('2026-10-13 11:00', IL));
    accessFailure = new Error('database down (smoke): computeFeatureAccess');
    const error = console.error;
    console.error = () => {};
    try {
      await passAt(at('2026-10-13 12:00', IL));
    } finally {
      console.error = error;
      accessFailure = null;
    }
    assert(captured.includes('cron-reminders-process-user') && captured.includes('event-alerts-gate-held'), `captured ${captured.join(', ') || '(nothing)'}`);
    // The capture names the user by id (a push entry has no Telegram id to name it by)
    assert(capturedDetail.some(d => d.includes('"user_id":50')), `the capture has no user_id: ${capturedDetail.join(' | ')}`);
    assert((await passAt(at('2026-10-13 12:05', IL))).includes('listVisibleCalendars'), 'the pass after the throw did not read FamCal');
    assert((await passAt(at('2026-10-13 12:10', IL))).length === 0, 'a pass that read without a failure did not close the gate');
  });

  await check('alerts: a fetch that throws is logged and captured with the account\'s id: a Telegram account\'s line is as before (its Telegram id), a push account (no Telegram id) is named #<id>, never "null"', async () => {
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      for (const [row, who] of [[{ id: 50 }, '1050'], [{ id: 62, telegramId: null, _count: { pushDevices: 1 } }, '#62']] as const) {
        reset({ ...row, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null });
        await fakeRedis.set(REDIS_KEYS.userTimezone(row.id), IL);
        nativeCalendars = [{ id: `cal${row.id}`, name: 'Dana', labels: ['yours'], ownerUserId: row.id }];
        await syncCache(handlers, at('2026-10-13 11:00', IL));
        lines.length = 0;
        fetchThrows = new Error('provider blew up (smoke)');
        try {
          await passAt(at('2026-10-13 12:00', IL));
        } finally {
          fetchThrows = null;
        }
        const named = lines.filter(l => l.startsWith('[Reminders] Error fetching events for user'));
        assert(named.length === 1 && named[0] === `[Reminders] Error fetching events for user ${who}: Error: provider blew up (smoke)`, `the line for ${who}: ${JSON.stringify(named)}`);
        assert(captured.includes('reminders-fetch-events') && capturedDetail.some(d => d.includes(`"user_id":${row.id}`)), `the capture for ${who}: ${capturedDetail.join(' | ')}`);
      }
    } finally {
      console.error = error;
    }
  });

  await check('gate: the calendars of a Google user can\'t be read (the store\'s first query fails): captured, the gate stays open, and their Google alert still goes out', async () => {
    reset({ id: 51, googleRefreshToken: 'refresh-token', calendarSource: 'GOOGLE', calendarAssignments: [{ calendarId: meCal, labels: [], name: 'Me', color: '#00f' }] });
    await fakeRedis.set(REDIS_KEYS.userTimezone(51), IL);
    nativeCalendars = [{ id: 'cal51', name: 'Ron', labels: ['yours'], ownerUserId: 51 }];
    googleEvents = [{ calendarId: meCal, id: 'g51', summary: 'Soccer', start: at('2026-10-13 12:15', IL), end: at('2026-10-13 13:00', IL) }];
    await syncCache(handlers, at('2026-10-13 11:00', IL));
    listFailingFor = [51];
    const error = console.error;
    console.error = () => {};
    try {
      await passAt(at('2026-10-13 12:00', IL));
    } finally {
      console.error = error;
      listFailingFor = [];
    }
    assert(sentLines(IL).join(' | ') === '12:00 🤖 Auto-Reminder: Soccer', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
    assert(captured.includes('reminders-calendars-read') && captured.includes('event-alerts-gate-held') && !captured.includes('cron-reminders-process-user'), `captured ${captured.join(', ') || '(nothing)'}`);
    assert((await passAt(at('2026-10-13 12:05', IL))).includes('listVisibleCalendars'), 'the pass after the failure did not read FamCal');
    assert((await passAt(at('2026-10-13 12:10', IL))).length === 0, 'a pass that read without a failure did not close the gate');
  });

  await check('gate: one user whose FamCal read fails on every pass holds it 15 minutes while another reads cleanly, then not; reported once each, not every pass', async () => {
    twoUsers();
    for (const id of [50, 51]) await fakeRedis.set(REDIS_KEYS.userTimezone(id), IL);
    await syncCache(handlers, at('2026-10-13 11:00', IL));
    failingCalendars = ['cal50'];
    const error = console.error;
    const warn = console.warn;
    console.error = () => {};
    console.warn = () => {};
    let held: string[];
    let after: string[];
    try {
      held = await readingPasses(at('2026-10-13 12:00', IL), at('2026-10-13 12:20', IL));
      after = await readingPasses(at('2026-10-13 12:20', IL), at('2026-10-13 12:45', IL));
    } finally {
      console.error = error;
      console.warn = warn;
    }
    // 12:00, 12:05 and 12:10 hold it; 12:15 (15 minutes failing) reads, then closes: nothing reads before 13:00.
    assert(held.length === 4, `passes that read from 12:00: ${held.join(' | ')}`);
    assert(after.length === 0, `the gate stayed open for the failing user: ${after.join(' | ')}`);
    assert(captured.filter(c => c === 'event-alerts-gate-held').length === 1 && captured.filter(c => c === 'event-alerts-gate-hold-dropped').length === 1, `captured ${captured.join(', ')}`);
    // The user reads cleanly again: their clock is cleared, so a later failure holds the gate again.
    failingCalendars = [];
    alertsGate.openEventAlertsGate();
    assert((await passAt(at('2026-10-13 12:50', IL))).includes('fetchEventsInCalendars'), 'the opened gate did not read');
    failingCalendars = ['cal50'];
    console.error = () => {};
    console.warn = () => {};
    try {
      // 12:55 is closed (the clean 12:50 pass closed it until 13:00); 13:00 fails afresh, so 13:05 reads again.
      const again = await readingPasses(at('2026-10-13 12:55', IL), at('2026-10-13 13:10', IL));
      assert(again.length === 2 && again[0].startsWith('13:00') && again[1].startsWith('13:05'), `a new failure after a clean read: ${again.join(' | ')}`);
    } finally {
      console.error = error;
      console.warn = warn;
    }
  });

  /** Passes from `from` to `to` with the console quiet (the failures log every pass); "HH:mm calls" for each that read. */
  async function quietReadingPasses(from: Date, to: Date): Promise<string[]> {
    const error = console.error;
    const warn = console.warn;
    console.error = () => {};
    console.warn = () => {};
    try {
      return await readingPasses(from, to);
    } finally {
      console.error = error;
      console.warn = warn;
    }
  }

  await check('gate: one cached user whose FamCal read fails on every pass: it holds through the first hour, then the pass after the hour closes it to the next :00, one read an hour; a write still opens it at once', async () => {
    reset({ id: 50, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null });
    await fakeRedis.set(REDIS_KEYS.userTimezone(50), IL);
    nativeCalendars = [{ id: 'cal50', name: 'Dana', labels: ['yours'], ownerUserId: 50 }];
    await syncCache(handlers, at('2026-10-13 11:00', IL));
    storeFailure = new Error('database down (smoke)');
    try {
      const firstHour = await quietReadingPasses(at('2026-10-13 12:00', IL), at('2026-10-13 13:00', IL));
      assert(firstHour.length === 12, `of the 12 passes from 12:00 to 12:55, ${firstHour.length} read`);
      assert((await quietReadingPasses(at('2026-10-13 13:00', IL), at('2026-10-13 13:05', IL))).length === 1, 'the 13:00 pass did not read');
      const closed = await quietReadingPasses(at('2026-10-13 13:05', IL), at('2026-10-13 14:00', IL));
      assert(closed.length === 0, `the gate kept holding after the hour: ${closed.join(' | ')}`);
      assert((await quietReadingPasses(at('2026-10-13 14:00', IL), at('2026-10-13 14:05', IL))).length === 1, 'the next :00 pass did not retry');
      assert((await quietReadingPasses(at('2026-10-13 14:05', IL), at('2026-10-13 14:35', IL))).length === 0, 'the retry at 14:00 held the gate again');
    } finally {
      storeFailure = null;
    }
    const held = capturedDetail.filter((_d, i) => captured[i] === 'event-alerts-gate-held');
    assert(held.length === 1 && held[0].includes(`"stopsHoldingAt":"${at('2026-10-13 13:00', IL).toISOString()}"`), `held reports: ${JSON.stringify(held)}`);
    assert(captured.filter(c => c === 'event-alerts-gate-hold-dropped').length === 2, `captured ${captured.join(', ')}`);
    // The database answers again; a write opens the gate at once, and the clean pass closes it.
    alertsGate.openEventAlertsGate();
    assert((await passAt(at('2026-10-13 14:35', IL))).includes('fetchEventsInCalendars'), 'the write did not open the gate');
    assert((await passAt(at('2026-10-13 14:40', IL))).length === 0, 'the clean pass did not close the gate');
  });

  await check('gate: when every user\'s read fails (the database is down) it holds for an hour, reported once, then retries at each :00; once the database answers, that pass reads cleanly and closes it', async () => {
    twoUsers();
    for (const id of [50, 51]) await fakeRedis.set(REDIS_KEYS.userTimezone(id), IL);
    await syncCache(handlers, at('2026-10-13 11:00', IL));
    storeFailure = new Error('database down (smoke)');
    let reads: string[];
    try {
      reads = await quietReadingPasses(at('2026-10-13 12:00', IL), at('2026-10-13 14:00', IL));
    } finally {
      storeFailure = null;
    }
    assert(reads.length === 13 && reads[12].startsWith('13:00'), `of the passes from 12:00 to 13:55, these read: ${reads.map(r => r.slice(0, 5)).join(' ')}`);
    assert(captured.filter(c => c === 'event-alerts-gate-held').length === 1 && captured.filter(c => c === 'event-alerts-gate-hold-dropped').length === 1, `captured ${captured.join(', ')}`);
    assert((await passAt(at('2026-10-13 14:00', IL))).includes('fetchEventsInCalendars'), 'the :00 pass after the outage did not read');
    assert((await passAt(at('2026-10-13 14:05', IL))).length === 0, 'the clean pass did not close the gate');
  });

  await check('gate: the hour of an outage is counted from its start, not per user: a denied user whose recompute starts throwing at 13:00 does not keep it open past 13:00', async () => {
    twoUsers();
    for (const id of [50, 51]) await fakeRedis.set(REDIS_KEYS.userTimezone(id), IL);
    await syncCache(handlers, at('2026-10-13 11:00', IL));
    // The database is down from 12:00: user 50's FamCal read fails; user 51 is denied by a cached answer (no read, no failure).
    storeFailure = new Error('database down (smoke)');
    deniedUsers = [51];
    try {
      const firstHour = await quietReadingPasses(at('2026-10-13 12:00', IL), at('2026-10-13 13:00', IL));
      assert(firstHour.length === 12, `of the 12 passes from 12:00 to 12:55, ${firstHour.length} read`);
      // 51's cached denial ended at 12:59: its recompute throws from the 13:00 pass on.
      accessFailingFor = [51];
      assert((await quietReadingPasses(at('2026-10-13 13:00', IL), at('2026-10-13 13:05', IL))).length === 1, 'the 13:00 pass did not read');
      const after = await quietReadingPasses(at('2026-10-13 13:05', IL), at('2026-10-13 14:00', IL));
      assert(after.length === 0, `the gate kept holding past the outage's hour for a user who failed later: ${after.map(r => r.slice(0, 5)).join(' ')}`);
    } finally {
      storeFailure = null;
    }
  });

  await check('gate: a user who is neither failing nor read (denied) keeps no stale failure clock: failing again later, they hold the gate their full 15 minutes', async () => {
    twoUsers();
    for (const id of [50, 51]) await fakeRedis.set(REDIS_KEYS.userTimezone(id), IL);
    await syncCache(handlers, at('2026-10-13 11:00', IL));
    failingCalendars = ['cal50'];
    assert((await quietReadingPasses(at('2026-10-13 12:00', IL), at('2026-10-13 12:05', IL))).length === 1, 'the 12:00 pass did not read');
    // 50 is denied from 12:05 (no read, no failure); the 12:05 pass still reads (the 12:00 failure held the gate), then closes it.
    failingCalendars = [];
    deniedUsers = [50];
    assert((await quietReadingPasses(at('2026-10-13 12:05', IL), at('2026-10-13 12:10', IL))).length === 1, 'the 12:05 pass did not read');
    // Allowed again at 13:00 (the ceiling read), and its read fails once: a fresh clock, so 13:05 still reads.
    deniedUsers = [];
    failingCalendars = ['cal50'];
    const again = await quietReadingPasses(at('2026-10-13 12:10', IL), at('2026-10-13 13:10', IL));
    assert(again.length === 2 && again[0].startsWith('13:00') && again[1].startsWith('13:05'), `passes that read: ${again.map(r => r.slice(0, 5)).join(' ') || '(none)'}`);
  });

  await check('gate: a pass where every cached user is denied (no failure, no read) ends the outage\'s clock: a later one-off failure holds the gate, so the next pass retries and the alert goes out', async () => {
    reset({ id: 50, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null });
    await fakeRedis.set(REDIS_KEYS.userTimezone(50), IL);
    nativeCalendars = [{ id: 'cal50', name: 'Dana', labels: ['yours'], ownerUserId: 50 }];
    // Due at 13:07 (the default 15 minutes before 13:22): the 13:05 pass's window.
    nativeEvents = [{ calendarId: 'cal50', id: 'o50', title: 'Dentist', startsAt: at('2026-10-13 13:22', IL), endsAt: at('2026-10-13 14:00', IL), timeZone: IL }];
    await syncCache(handlers, at('2026-10-13 11:00', IL));
    // 1. The outage starts at 12:00: the only user's read fails.
    storeFailure = new Error('database down (smoke)');
    try {
      assert((await quietReadingPasses(at('2026-10-13 12:00', IL), at('2026-10-13 12:05', IL))).length === 1, 'the 12:00 pass did not read');
    } finally {
      storeFailure = null;
    }
    // 2. 12:05: the user's plan has lapsed (their recompute now answers "denied"): no failure, no read; the gate closes.
    deniedUsers = [50];
    await quietReadingPasses(at('2026-10-13 12:05', IL), at('2026-10-13 12:10', IL));
    assert((await quietReadingPasses(at('2026-10-13 12:10', IL), at('2026-10-13 13:00', IL))).length === 0, 'the gate did not close after the pass with nobody to read');
    // 3. Allowed again, the 13:00 read fails once: it holds the gate, so 13:05 retries and sends the 13:07 alert.
    deniedUsers = [];
    storeFailure = new Error('database blip (smoke)');
    try {
      assert((await quietReadingPasses(at('2026-10-13 13:00', IL), at('2026-10-13 13:05', IL))).length === 1, 'the 13:00 pass did not read');
    } finally {
      storeFailure = null;
    }
    assert((await quietReadingPasses(at('2026-10-13 13:05', IL), at('2026-10-13 13:10', IL))).length === 1, 'the one-off failure did not hold the gate: the 13:05 pass did not retry');
    assert(sentLines(IL).join(' | ') === '13:05 🤖 Auto-Reminder: Dentist', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
  });

  await check('gate: a cache write that lands right after the pass read the cached users (a settings save) keeps that pass from closing the gate', async () => {
    reset({ id: 50, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null });
    await fakeRedis.set(REDIS_KEYS.userTimezone(50), IL);
    nativeCalendars = [{ id: 'cal50', name: 'Dana', labels: ['yours'], ownerUserId: 50 }];
    await syncCache(handlers, at('2026-10-13 11:00', IL));
    afterCacheRead = () => alertsGate.openEventAlertsGate();
    await passAt(at('2026-10-13 12:00', IL));
    assert((await passAt(at('2026-10-13 12:05', IL))).includes('listVisibleCalendars'), 'the pass closed the gate over a write that landed after its cache read');
    assert((await passAt(at('2026-10-13 12:10', IL))).length === 0, 'the gate did not close again');
  });

  await check('gate: a reset gate (a fresh process) reads at once; a pass with no users cached leaves it as it was', async () => {
    await closedAtNoon();
    alertsGate.__resetEventAlertsGateForTests();
    assert((await passAt(at('2026-10-13 12:10', IL))).includes('listVisibleCalendars'), 'a fresh gate did not read');
    assert((await passAt(at('2026-10-13 12:15', IL))).length === 0, 'the gate did not close again');
    alertsGate.__resetEventAlertsGateForTests();
    store.set(REDIS_KEYS.REMINDER_USERS, JSON.stringify([]));
    await passAt(at('2026-10-13 12:20', IL));
    assert(alertsGate.shouldReadFamcal(at('2026-10-13 12:20', IL)), 'a pass with nobody cached closed the gate');
  });

  await check('gate: the hourly sync opens it only when a user is added or their pairing, default lead or pickup switch changed', async () => {
    const { syncAddsAlerts } = await import('../src/services/reminder-cache');
    const entry = (over: Record<string, unknown> = {}) => ({ id: 1, telegramId: '1', googleToken: '', calendarAssignments: null, defaultReminderMinutes: 15, language: 'en', name: 'D', pickupRemindersEnabled: true, pairingId: null, ...over });
    assert(!syncAddsAlerts([entry()], [entry({ name: 'Other', language: 'he', location: 'Haifa' })]), 'a change that adds no alert opened it');
    assert(!syncAddsAlerts([entry(), entry({ id: 2 })], [entry()]), 'a user who left opened it');
    for (const [label, over] of [['pairing', { pairingId: 'p' }], ['default lead', { defaultReminderMinutes: 30 }], ['pickup switch', { pickupRemindersEnabled: false }], ['added user', { id: 3 }]] as const) {
      assert(syncAddsAlerts([entry()], [entry(over)]), `${label} did not open it`);
    }
    assert(syncAddsAlerts(null, [entry()]), 'no previous list did not open it');
    // Through the real sync: an unchanged hourly sync leaves the gate closed.
    await closedAtNoon();
    await syncCache(handlers, at('2026-10-13 12:06', IL));
    assert((await passAt(at('2026-10-13 12:10', IL))).length === 0, 'an unchanged hourly sync opened the gate');
    userRows[0].defaultReminderMinutes = 30;
    await syncCache(handlers, at('2026-10-13 12:11', IL));
    assert((await passAt(at('2026-10-13 12:15', IL))).includes('listVisibleCalendars'), 'a sync that changed the default lead did not open the gate');
  });

  // ---- The Shabbat and Yom Tov pause (plan 2026-10-28-zmanim-reminders, Task 2) ----
  // Jerusalem, Sephardi: Shabbat runs from Friday 17:50 to Saturday 18:39 (Israel time, 2026-10-16/17).
  // The 5-minute run starts at :00, :05, ...; what it sends goes out at its start, so the pause is read at the run's start.
  const JERUSALEM_ON = { pauseOnShabbat: true, latitude: 31.778, longitude: 35.235, elevationM: 754, zmanimCommunity: 'sephardi' };
  const shabbatEvent = (id: string, summary: string, start: string, end: string) => ({ calendarId: kidsCal, id, summary, start: at(start, IL), end: at(end, IL) });

  await check('pause: an event alert due in Shabbat is not sent, start or pickup, and each skipped alert is logged; the same event with the switch off is sent', async () => {
    reset({ id: 40, ...JERUSALEM_ON });
    googleEvents = [shabbatEvent('s40', 'Kiddush', '2026-10-17 10:00', '2026-10-17 11:00')];
    await syncCache(handlers, at('2026-10-17 07:00', IL));
    await runTicks(handlers, at('2026-10-17 09:00', IL), at('2026-10-17 11:00', IL));
    assert(sent.length === 0, `sent in Shabbat: ${sentLines(IL).join(' | ')}`);
    assert(pauseLines.join('|') === '[pause] skipped event alert for 40|[pause] skipped event alert for 40', `logged: ${pauseLines.join('|') || '(nothing)'}`);

    reset({ id: 41, ...JERUSALEM_ON, pauseOnShabbat: false });
    googleEvents = [shabbatEvent('s41', 'Kiddush', '2026-10-17 10:00', '2026-10-17 11:00')];
    await syncCache(handlers, at('2026-10-17 07:00', IL));
    await runTicks(handlers, at('2026-10-17 09:00', IL), at('2026-10-17 11:00', IL));
    assert(sentLines(IL).join(' | ') === '09:45 🤖 Auto-Reminder: Kiddush | 10:45 🤖🚗 Auto-Pickup Reminder: Noa' && pauseLines.length === 0, `switch off: ${sentLines(IL).join(' | ') || '(nothing)'} ${pauseLines.join('|')}`);
  });

  await check('pause: the run either side of the window: Friday 17:45, 17:50 (candle lighting) and 18:05 send and 18:10 (the sunset, where the pause begins) does not; Saturday 18:35 does not and 18:40 (after Shabbat ends at 18:39) does; an alert due in the last minutes of Shabbat goes with a run that starts inside it, so it is not sent', async () => {
    reset({ id: 42, ...JERUSALEM_ON, pickupRemindersEnabled: false });
    googleEvents = [
      shabbatEvent('f1', 'Friday 18:00', '2026-10-16 18:00', '2026-10-16 19:00'),
      shabbatEvent('f2', 'Friday 18:05', '2026-10-16 18:05', '2026-10-16 19:00'),
      shabbatEvent('f3', 'Friday 18:24', '2026-10-16 18:24', '2026-10-16 19:00'),
      shabbatEvent('f4', 'Friday 18:25', '2026-10-16 18:25', '2026-10-16 19:00'),
      shabbatEvent('s1', 'Saturday 18:50', '2026-10-17 18:50', '2026-10-17 19:30'),
      shabbatEvent('s2', 'Saturday 18:54', '2026-10-17 18:54', '2026-10-17 19:30'),
      shabbatEvent('s3', 'Saturday 18:55', '2026-10-17 18:55', '2026-10-17 19:30'),
    ];
    await syncCache(handlers, at('2026-10-16 07:00', IL));
    await runTicks(handlers, at('2026-10-16 17:40', IL), at('2026-10-16 18:15', IL));
    await runTicks(handlers, at('2026-10-17 18:30', IL), at('2026-10-17 18:50', IL));
    assert(sentLines(IL).join(' | ') === '17:45 🤖 Auto-Reminder: Friday 18:00 | 17:50 🤖 Auto-Reminder: Friday 18:05 | 18:05 🤖 Auto-Reminder: Friday 18:24 | 18:40 🤖 Auto-Reminder: Saturday 18:55', `got ${sentLines(IL).join(' | ') || '(nothing)'}`);
    assert(pauseLines.length === 3, `three skipped (the 18:10 run's, 18:35, and 18:39's run at 18:35): ${pauseLines.join('|')}`);
  });

  await check('pause: the switch in a settings save reaches the cache at once, both ways: off sends the next run, on pauses it', async () => {
    reset({ id: 43, ...JERUSALEM_ON });
    googleEvents = [shabbatEvent('s43', 'Kiddush', '2026-10-17 10:00', '2026-10-17 11:00')];
    await syncCache(handlers, at('2026-10-17 07:00', IL));
    assert(cacheV2().entries.find(u => u.id === 43)?.pauseOnShabbat === true, `cached ${cacheV2().raw}`);
    await saveSettings(at('2026-10-17 08:00', IL), 1043, { pauseOnShabbat: false });
    const storedSwitch = () => userRows[0].pauseOnShabbat;
    assert(storedSwitch() === false && cacheV2().entries.find(u => u.id === 43)?.pauseOnShabbat === false, `saved ${storedSwitch()}, cached ${cacheV2().raw}`);
    await runTicks(handlers, at('2026-10-17 09:00', IL), at('2026-10-17 10:00', IL));
    assert(sentLines(IL).join(' | ') === '09:45 🤖 Auto-Reminder: Kiddush', `switched off: ${sentLines(IL).join(' | ') || '(nothing)'}`);

    reset({ id: 44, ...JERUSALEM_ON, pauseOnShabbat: false });
    googleEvents = [shabbatEvent('s44', 'Kiddush', '2026-10-17 10:00', '2026-10-17 11:00')];
    await syncCache(handlers, at('2026-10-17 07:00', IL));
    await saveSettings(at('2026-10-17 08:00', IL), 1044, { pauseOnShabbat: true });
    await runTicks(handlers, at('2026-10-17 09:00', IL), at('2026-10-17 10:00', IL));
    assert(sent.length === 0, `switched on: ${sentLines(IL).join(' | ')}`);
    // Only a boolean is a setting: anything else leaves it as it was.
    await saveSettings(at('2026-10-17 08:30', IL), 1044, { pauseOnShabbat: 'no' });
    assert(storedSwitch() === true, `kept ${String(storedSwitch())}`);
  });

  await check('pause: the "reminders paused, upgrade" notice (a plan that lost reminders) waits for after Shabbat, and is not marked sent meanwhile', async () => {
    reset({ id: 45, ...JERUSALEM_ON });
    remindersAllowedByPlan = false;
    await syncCache(handlers, at('2026-10-17 07:00', IL));
    await runTicks(handlers, at('2026-10-17 09:00', IL), at('2026-10-17 09:10', IL));
    const notices = () => downgradeNotices;
    assert(notices() === 0 && pauseLines.length > 0, `in Shabbat: ${notices()} notices, ${pauseLines.join('|')}`);
    assert(!store.has(REDIS_KEYS.reminderDowngradeNotified(45)), 'marked sent while paused');
    await runTicks(handlers, at('2026-10-18 09:00', IL), at('2026-10-18 09:05', IL));
    assert(notices() === 1 && store.has(REDIS_KEYS.reminderDowngradeNotified(45)), `after Shabbat: ${notices()} notices`);
  });

  await check('pause: a user told already of the downgrade is not asked about the pause (it may read the database to fill their place); one not told yet still waits for after Shabbat', async () => {
    reset({ id: 46, ...JERUSALEM_ON });
    remindersAllowedByPlan = false;
    await fakeRedis.set(REDIS_KEYS.reminderDowngradeNotified(46), '1');
    await syncCache(handlers, at('2026-10-17 07:00', IL));
    // Read through functions: the checks narrow the module-level counters.
    const notices = () => downgradeNotices;
    const skipped = () => pauseLines.length;
    await runTicks(handlers, at('2026-10-17 09:00', IL), at('2026-10-17 09:10', IL));
    assert(skipped() === 0 && notices() === 0, `told already: ${notices()} notices, ${pauseLines.join('|') || 'no pause lines'}`);
    await fakeRedis.del(REDIS_KEYS.reminderDowngradeNotified(46));
    await runTicks(handlers, at('2026-10-17 09:10', IL), at('2026-10-17 09:15', IL));
    assert(skipped() === 1 && notices() === 0, `not told yet, in Shabbat: ${notices()} notices, ${pauseLines.join('|')}`);
  });

  // ---- Browser notifications (web push spec §3.5): event alerts for an account with no chat ----

  const pushLines = (tz: string) => pushes.map(p => `${formatInTimeZone(new RealDate(p.at), tz, 'HH:mm')} ${p.userId} ${p.title} / ${p.body.replace(/\n/g, ' / ')}`);
  const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
    const log = console.log;
    console.log = () => {};
    try { return await fn(); } finally { console.log = log; }
  };

  await check('push: alertChannelOf, the one admission rule: Telegram, else no chat and a device; never with alerts off, suspended, unreachable or a WhatsApp id', async () => {
    const { alertChannelOf } = await import('../src/services/reminder-cache');
    const base = { remindersEnabled: true, telegramId: null, suspendedAt: null, unreachableSince: null };
    const got = [
      alertChannelOf({ ...base, telegramId: BigInt(5) }, 0),
      alertChannelOf(base, 1),
      alertChannelOf(base, 0),
      alertChannelOf({ ...base, whatsappPhone: '+972500000001' }, 1),
      alertChannelOf({ ...base, whatsappBsuid: 'IL.123' }, 1),
      alertChannelOf({ ...base, remindersEnabled: false }, 1),
      alertChannelOf({ ...base, suspendedAt: new RealDate(0) }, 1),
      alertChannelOf({ ...base, unreachableSince: new RealDate(0) }, 1),
      alertChannelOf({ ...base, telegramId: BigInt(5), suspendedAt: new RealDate(0) }, 0),
    ];
    assert(JSON.stringify(got) === JSON.stringify(['telegram', 'push', null, null, null, null, null, null, null]), `got ${JSON.stringify(got)}`);
  });

  await check('push: the hourly sync caches a no-chat account with a device as a push entry (no Telegram id, the flag, never the devices); one with no device, a WhatsApp one, and every no-chat one while push is off stay out; a Telegram entry has no flag', async () => {
    reset({ id: 62, telegramId: null, _count: { pushDevices: 1 } });
    userRows.push({ ...userRows[0], id: 63, _count: { pushDevices: 0 } });
    userRows.push({ ...userRows[0], id: 64, whatsappPhone: '+972500000064' });
    userRows.push({ ...userRows[0], id: 65, telegramId: BigInt(1065), _count: undefined });
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    let { entries, raw } = cacheV2();
    assert(JSON.stringify(entries.map(e => e.id).sort()) === '[62,65]', `cached ${JSON.stringify(entries.map(e => e.id))}`);
    const push = entries.find(e => e.id === 62)!;
    const chat = entries.find(e => e.id === 65)!;
    assert(push.telegramId === '' && push.pushDevice === true, `push entry ${JSON.stringify(push)}`);
    assert(chat.telegramId === '1065' && !('pushDevice' in chat), `Telegram entry ${JSON.stringify(chat)}`);
    assert(!/endpoint|p256dh|auth"/.test(raw), 'the cache holds no device');
    // Push on: the read takes the Telegram accounts and the no-chat ones, and counts their devices in the same statement
    const onRead = lastUserRead as { where: Record<string, unknown>; select: Record<string, unknown> } | null;
    assert(JSON.stringify(onRead?.where.OR) === JSON.stringify([{ telegramId: { not: null } }, { whatsappPhone: null, whatsappBsuid: null }]) && !('telegramId' in onRead!.where), `push on, the where: ${JSON.stringify(onRead?.where)}`);
    assert('_count' in onRead!.select, `push on, the select: ${JSON.stringify(onRead?.select)}`);

    const keys = { pub: process.env.VAPID_PUBLIC_KEY, priv: process.env.VAPID_PRIVATE_KEY };
    process.env.VAPID_PRIVATE_KEY = '';
    try {
      await syncCache(handlers, at('2026-10-13 07:10', IL));
      ({ entries, raw } = cacheV2());
      assert(JSON.stringify(entries.map(e => e.id)) === '[65]', `push off: ${JSON.stringify(entries.map(e => e.id))}`);
      // Push off (today's production): the read is the Telegram accounts alone, as before browser notifications, and counts no devices
      const offRead = lastUserRead as { where: Record<string, unknown>; select: Record<string, unknown> } | null;
      assert(JSON.stringify(offRead?.where.telegramId) === JSON.stringify({ not: null }) && !('OR' in offRead!.where) && !JSON.stringify(offRead!.where).includes('whatsapp'), `push off, the where has a no-chat branch: ${JSON.stringify(offRead?.where)}`);
      assert(!('_count' in offRead!.select), `push off, the select counts devices: ${JSON.stringify(offRead?.select)}`);
    } finally {
      process.env.VAPID_PUBLIC_KEY = keys.pub;
      process.env.VAPID_PRIVATE_KEY = keys.priv;
    }

    // The entry sync (a settings save, a device added or deleted: afterDevicesChanged) reads the same rule, counting the devices itself.
    const { syncReminderCacheEntry } = await import('../src/services/reminder-cache');
    const { convertPrismaUserToConfig } = await import('../src/types');
    const counts = () => prismaCalls.filter(c => c === 'pushDevice.count').length;
    const before = counts();
    await quietly(() => syncReminderCacheEntry(convertPrismaUserToConfig(userRows[0] as never)));
    assert(cacheV2().entries.some(e => e.id === 62 && e.pushDevice === true), `a device on: ${cacheV2().raw}`);
    assert(counts() === before + 1, 'the devices were not counted');
    userRows[0]._count = { pushDevices: 0 };
    await quietly(() => syncReminderCacheEntry(convertPrismaUserToConfig(userRows[0] as never)));
    assert(!cacheV2().entries.some(e => e.id === 62), `the last device gone: ${cacheV2().raw}`);
    const forChat = counts();
    await quietly(() => syncReminderCacheEntry(convertPrismaUserToConfig(userRows[3] as never)));
    assert(counts() === forChat && cacheV2().entries.some(e => e.id === 65), 'a Telegram account cost a count');
  });

  await check('push: a cached push account\'s alerts come as notifications: the event\'s title, Telegram\'s time line and the place, until the event, tagged per event and type, the home in its language; nothing on Telegram; marked sent once; no log line holds the title or the place', async () => {
    reset({ id: 60, telegramId: null, _count: { pushDevices: 1 } });
    await fakeRedis.set(REDIS_KEYS.userTimezone(60), IL);
    googleEvents = [{ calendarId: kidsCal, id: 'k60', summary: 'Kindergarten', location: 'Hall B', start: at('2026-10-13 08:00', IL), end: at('2026-10-13 16:00', IL) }];
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    await runTicks(handlers, at('2026-10-13 07:00', IL), at('2026-10-13 17:00', IL));
    assert(sent.length === 0 && sendAttempts === 0, `Telegram: ${sentLines(IL).join(' | ')}`);
    const view = pushes.map(p => ({ kind: p.kind, title: p.title, body: p.body, tag: p.tag, lang: p.lang, until: p.until?.toISOString() }));
    const want = [
      { kind: 'alert', title: 'Kindergarten', body: 'Starting at 08:00\nHall B', tag: 'alert-k60-start', lang: 'en', until: at('2026-10-13 08:00', IL).toISOString() },
      { kind: 'alert', title: 'Kindergarten', body: 'Pickup at 16:00\nHall B', tag: 'alert-k60-pickup', lang: 'en', until: at('2026-10-13 16:00', IL).toISOString() },
    ];
    assert(JSON.stringify(view) === JSON.stringify(want), `pushed ${JSON.stringify(view)}`);
    assert(pushLines(IL).map(l => l.slice(0, 5)).join(',') === '07:45,15:45', `at ${pushLines(IL).join(' | ')}`);
    assert(pushes.every(p => p.url.endsWith('/en/dashboard?user_id=60')), `urls ${pushes.map(p => p.url).join(', ')}`);
    assert(store.has(REDIS_KEYS.reminder(60, 'k60', 'start', '2026-10-13')) && store.has(REDIS_KEYS.reminder(60, 'k60', 'pickup', '2026-10-13')), 'not marked sent');
    assert(!logLines.some(l => l.includes('Kindergarten') || l.includes('Hall B')), `a line holds the title or the place: ${logLines.filter(l => l.includes('Kindergarten') || l.includes('Hall B')).join(' | ')}`);
  });

  await check('push: an alert no device took is not marked sent, and says so in one line with no title', async () => {
    reset({ id: 66, telegramId: null, _count: { pushDevices: 1 }, pickupRemindersEnabled: false });
    await fakeRedis.set(REDIS_KEYS.userTimezone(66), IL);
    googleEvents = [{ calendarId: kidsCal, id: 'k66', summary: 'Kindergarten', start: at('2026-10-13 08:00', IL), end: at('2026-10-13 16:00', IL) }];
    pushAnswer = { sent: 0, total: 1, retriable: true };
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    await runTicks(handlers, at('2026-10-13 07:40', IL), at('2026-10-13 07:50', IL));
    assert(pushes.length === 1, `${pushes.length} pushes`);
    assert(!store.has(REDIS_KEYS.reminder(66, 'k66', 'start', '2026-10-13')), 'marked sent though no device took it');
    assert(logLines.some(l => l.startsWith('[Reminders] start alert to user 66 not delivered by push (0 of 1 devices')), `lines ${logLines.join(' | ')}`);
    assert(!logLines.some(l => l.includes('Kindergarten')), 'a line holds the title');
  });

  await check('push: an idle pass makes no Prisma or store call with push accounts cached; only a pass that sends reads (the devices); their Google alert (12:30) and FamCal alert (13:20) go out as notifications', async () => {
    twoUsers();
    for (const row of userRows) Object.assign(row, { telegramId: null, _count: { pushDevices: 1 } });
    for (const id of [50, 51]) await fakeRedis.set(REDIS_KEYS.userTimezone(id), IL);
    nativeEvents = [{ calendarId: 'cal50', id: 'n50', title: 'Dentist', startsAt: at('2026-10-13 13:35', IL), endsAt: at('2026-10-13 14:00', IL), timeZone: IL }];
    googleEvents = [{ calendarId: meCal, id: 'g51', summary: 'Soccer', start: at('2026-10-13 12:45', IL), end: at('2026-10-13 13:30', IL) }];
    await syncCache(handlers, at('2026-10-13 11:00', IL));
    assert(cacheV2().entries.length === 2 && cacheV2().entries.every(e => e.pushDevice === true), `cached ${cacheV2().raw}`);
    await passAt(at('2026-10-13 12:00', IL)); // may read
    const reads = await readingPasses(at('2026-10-13 12:05', IL), at('2026-10-13 13:00', IL));
    assert(reads.join(' | ') === '12:30 pushDevice.findMany', `passes that read: ${reads.join(' | ') || '(none)'}`);
    assert((await passAt(at('2026-10-13 13:00', IL))).includes('listVisibleCalendars'), 'the 13:00 pass did not read');
    const quiet = await readingPasses(at('2026-10-13 13:05', IL), at('2026-10-13 13:20', IL));
    assert(quiet.length === 0, `passes before the 13:20 alert read: ${quiet.join(' | ')}`);
    assert((await passAt(at('2026-10-13 13:20', IL))).includes('fetchEventsInCalendars'), 'the 13:20 pass did not read');
    assert(sent.length === 0, `Telegram: ${sentLines(IL).join(' | ')}`);
    assert(pushLines(IL).join(' | ') === '12:30 51 Soccer / Starting at 12:45 | 13:20 50 Dentist / Starting at 13:35', `pushed ${pushLines(IL).join(' | ') || '(nothing)'}`);
  });

  await check('push: Shabbat holds a push account\'s alerts as it holds a chat\'s: nothing is pushed, each skip is logged', async () => {
    reset({ id: 67, telegramId: null, _count: { pushDevices: 1 }, ...JERUSALEM_ON });
    googleEvents = [shabbatEvent('s67', 'Kiddush', '2026-10-17 10:00', '2026-10-17 11:00')];
    await syncCache(handlers, at('2026-10-17 07:00', IL));
    await runTicks(handlers, at('2026-10-17 09:00', IL), at('2026-10-17 11:00', IL));
    assert(pushes.length === 0 && sent.length === 0, `sent in Shabbat: ${pushLines(IL).join(' | ')}`);
    assert(pauseLines.join('|') === '[pause] skipped event alert for 67|[pause] skipped event alert for 67', `logged: ${pauseLines.join('|') || '(nothing)'}`);
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

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

// No decrypt-only fallback key here (Prisma would load .env for an unset name).
process.env.ENCRYPTION_KEY_PREVIOUS = '';

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
const fakeRedis = {
  get: async (key: string) => (store.has(key) ? JSON.parse(store.get(key)!) : null),
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
const fakePrisma = {
  user: {
    findMany: async ({ where = {}, select }: { where?: Record<string, unknown>; select: Record<string, boolean> }) =>
      userRows
        .filter(row => Object.keys(where).every(k => where[k] !== null || row[k] == null))
        .map(row => Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]]))),
    // markUserUnreachable: the id, and the columns it requires to be null.
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const rows = userRows.filter(row => Object.keys(where).every(k => (where[k] === null ? row[k] == null : row[k] === where[k])));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
  },
  adminSettings: { findUnique: async () => ({ remindersEnabled: true }) },
  oAuthState: { deleteMany: async () => ({ count: 0 }) },
};

/** A Google calendar event, as events.list returns it with singleEvents; `reminder` is its own popup lead(s). */
type GoogleEvent = { calendarId: string; id: string; summary: string; start: Date; end: Date; location?: string; reminder?: number | number[] };
let googleEvents: GoogleEvent[] = [];
/** Whether the user's plan allows reminders (checkFeatureAccess). */
let remindersAllowedByPlan = true;
/** Real milliseconds each Google request takes, the requests in flight, and calendars whose requests fail. */
const googleCalls = { latencyMs: 0, inFlight: 0, maxInFlight: 0, failing: {} as Record<string, Error> };
async function googleRequest<T>(calendarId: string, respond: () => T): Promise<T> {
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
type NativeRow = { calendarId: string; id: string; title: string; startsAt: Date; endsAt: Date; timeZone: string; kind?: 'EVENT' | 'REMINDER' };
let nativeCalendars: { id: string; name: string; labels: string[] }[] = [];
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
  [`${SRC}/utils/prisma.ts`]: { prisma: fakePrisma },
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
    sendReminderDowngradeNotification: async () => {},
    setUserMenuButton: async () => {},
  },
  [`${SRC}/services/messaging/factory.ts`]: {
    getTelegramService: () => recorder,
    getWhatsAppService: () => ({ sendMessage: async () => { throw new Error('reminders went to WhatsApp'); } }),
  },
  [`${SRC}/services/user-service.ts`]: { getWhatsAppChatId: () => null, updateUserById: fakeUpdateUserById },
  [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => {} },
  [`${SRC}/services/subscription-service.ts`]: {
    checkFeatureAccess: async () => ({ allowed: remindersAllowedByPlan }),
    incrementUsage: async () => {},
  },
  [`${SRC}/services/native-calendar/event-store.ts`]: real => fakeOver(real, {
    listVisibleCalendars: async () => nativeCalendars.map(c => ({ ...c, color: '#000000', personName: null, personEnglishName: null, personGender: null, rules: [] })),
    // One-off events overlapping the range, as the real store takes them.
    fetchEventsInCalendars: async (cuids: string[], range: { from: Date; to: Date }) =>
      nativeEvents
        .filter(e => cuids.includes(e.calendarId) && e.startsAt < range.to && (e.startsAt >= range.from || e.endsAt > range.from))
        .map(e => ({
          calendar: nativeCalendars.find(c => c.id === e.calendarId)!,
          series: { id: e.id, kind: e.kind ?? 'EVENT', creatorUserId: 0, forUserId: null },
          instance: {
            title: e.title, startsAt: e.startsAt, endsAt: e.endsAt, allDay: false, timeZone: e.timeZone,
            seriesEventId: e.id, instanceStartsAt: e.startsAt, isRecurringInstance: false,
          },
        })),
    // Nothing done or snoozed.
    fetchReminderStates: async () => [],
  }),
};

// Static imports compile to require() and pass through Module._load.
const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
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

function reset(row: Partial<UserRow> & { id: number }) {
  remindersAllowedByPlan = true;
  store.clear();
  sent = [];
  sendError = null;
  sendAttempts = 0;
  captured = [];
  capturedDetail = [];
  googleEvents = [];
  nativeCalendars = [];
  nativeEvents = [];
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
  console.log = () => {};
  console.warn = () => {};
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
      // and one whose token is refused fails the whole fetch.
      googleCalls.failing = { [cals[3]]: Object.assign(new Error('invalid_grant'), { code: 400 }) };
      const failed = await fetchEventsInRange('refresh-token', cals, ...range).then(() => 'resolved', (err: Error) => err.message);
      assert(failed === 'GOOGLE_TOKEN_EXPIRED', `token error: ${failed}`);
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
  await check('the reminder time saves for a user with event alerts off when the plan allows reminders, and is refused (403) when it does not', async () => {
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
    remindersAllowedByPlan = false;
    assert(await post({ reminderTime: '08:00' }) === 403 && userRows[0].reminderTime === '07:30', `refused: ${userRows[0].reminderTime}`);
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
    googleCalls.failing[kidsCal] = Object.assign(new Error('invalid_grant'), { code: 400 });
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

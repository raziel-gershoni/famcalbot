// Smoke test for the calendar home's range route, GET /api/calendar/range (calendar home
// spec §4), and the reader's entry point readRange (src/services/calendar-read/index.ts,
// §2.2-§2.3). The route works its facts out on the server (timezone, today, week start, Hebrew dates), validates the window,
// reads each applicable source, and answers the days with each source's status. The
// JSON never carries the user row or a masked calendar's real name or id.
//
// The route, readRange, the DTO code, the carry-overs' masking (carryOverReadItems),
// api-auth, telegram-auth, user-service, the timezone resolver and the locale rules run
// for real. Faked at the boundaries: Prisma and Redis (in memory, every Prisma call
// recorded), the rate limiter (records each key), the reader's two halves readFamcal and readGoogle (recording fakes; their
// own smokes cover them), the carry-over query fetchOpenReminderItems, error capture,
// Next's after() (queued), and fetch (blocked and recorded; #24 answers or stalls
// Nominatim and Open-Meteo for the timezone resolver). No network, no DB.
//
// Until the route and readRange exist, the smoke stops at their import
// (ERR_MODULE_NOT_FOUND).
//
// Run with the fake env from the task brief (no dotenv), under three clocks (Kiritimati,
// UTC+14, for the day bucketing):
//   TZ=UTC npx tsx scripts/smoke-calendar-range.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-range.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-calendar-range.ts

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

// Test values, used only when the fake env left them unset.
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.CRON_SECRET ||= 'test-cron';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

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

const show = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));

function assertSame(got: unknown, want: unknown, label: string) {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

// ---- Clock: every argument-less new Date() and Date.now() reads `clock` ----

const RealDate = Date;
let clock = RealDate.parse('2026-10-16T06:00:00Z'); // 09:00 in Israel, 02:00 in New York
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

// ---- Fake Prisma: in-memory rows, equality lookups, every call recorded ----

const DB: Record<string, Row[]> = {};
const prismaCalls: string[] = [];
const same = (a: unknown, b: unknown) =>
  typeof a === 'bigint' || typeof b === 'bigint' ? a != null && b != null && String(a) === String(b) : a === b;
const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => v === undefined || same(row[k] ?? null, v));

function model(name: string): Row {
  const rows = () => (DB[name] ??= []);
  const record = <T>(method: string, fn: (a: Row) => T) => async (a: Row = {}) => {
    prismaCalls.push(`${name}.${method}`);
    return fn(a);
  };
  return new Proxy(
    {
      findUnique: record('findUnique', (a) => rows().find((r) => matches(r, a.where)) ?? null),
      findFirst: record('findFirst', (a) => rows().find((r) => matches(r, a.where)) ?? null),
      findMany: record('findMany', (a) => rows().filter((r) => matches(r, a.where))),
      count: record('count', (a) => rows().filter((r) => matches(r, a.where)).length),
    } as Row,
    { get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? record(p, () => null)) }
  );
}
const models: Record<string, Row> = {};
const fakePrisma: Row = new Proxy({} as Row, {
  get(_t, prop) {
    if (typeof prop !== 'string' || prop === 'then') return undefined;
    if (prop.startsWith('$')) return async () => [];
    return (models[prop] ??= model(prop));
  },
});

// ---- Fake Redis (Upstash parses JSON on read) ----

const redisStore = new Map<string, string>();
const decode = (raw: string | undefined) => {
  if (raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return raw; }
};
const encode = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
const redisImpl: Row = {
  get: async (k: string) => decode(redisStore.get(k)),
  set: async (k: string, v: unknown, o?: Row) => {
    if (o?.nx && redisStore.has(k)) return null;
    redisStore.set(k, encode(v));
    return 'OK';
  },
  del: async (...ks: unknown[]) => ks.flat().reduce((n: number, k) => n + (redisStore.delete(String(k)) ? 1 : 0), 0),
  mget: async (...ks: unknown[]) => ks.flat().map((k) => decode(redisStore.get(String(k)))),
  expire: async () => 1,
};
const fakeRedis = new Proxy(redisImpl, {
  get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? (async () => null)),
});

// ---- Recorders ----

/** Every limiter key, as "<limiter>:<identifier>". */
const rateChecks: string[] = [];
let rateAllow = true;
/** Every captureError / captureWarning: the context, the severity and the extras. */
const captured: { ctx: string; severity: string; extra: Row | undefined; message: string }[] = [];
/** The reader halves' and the carry-over query's calls. */
const famcalCalls: { user: Row; window: { from: Date; to: Date }; opts: Row }[] = [];
const googleCalls: { user: Row; window: { from: Date; to: Date }; opts: Row }[] = [];
const carryCalls: { userId: number; ctx: Row; cutoff: Date; summaryDay: string; tz: string; cap: number }[] = [];
let famcalMode: 'ok' | 'error' | 'reject' | 'broken' = 'ok';
let googleMode: 'ok' | 'partialStale' | 'gone' | 'unsorted' | 'reject' = 'ok';
let carryMode: 'ok' | 'throw' = 'ok';
/** What readRange's caller handed after(). */
const afterQueue: (() => unknown)[] = [];
const fetched: string[] = [];

// ---- Boundaries: stubs in require's cache, served to import() by a load hook ----

const Module = nodeRequire('module');
const stubs: Record<string, Row> = {};
(globalThis as Row).__smokeStubs = stubs;
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs)) return nextLoad(url, context);
    const names = Object.keys(stubs[file]).filter((n) => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
    const source = [
      `const s = globalThis.__smokeStubs[${JSON.stringify(file)}];`,
      ...names.map((n) => `export const ${n} = s[${JSON.stringify(n)}];`),
      'export default (s.__esModule ? s.default : s);',
    ].join('\n');
    return { format: 'module', source, shortCircuit: true };
  },
});

function stub(rel: string, exports: Row) {
  const filename = path.join(ROOT, rel);
  stubs[filename] = exports;
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  Module._cache[filename] = mod;
}

const recorder = (): Row =>
  new Proxy({} as Row, { get: (_t, p) => (typeof p !== 'string' || p === 'then' ? undefined : async () => ({ message_id: 1 })) });

// ---- Fixtures ----

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const TG = { tal: 111111111, gil: 222222222, dana: 555555555, omer: 515151515, sus: 606060606, ny: 707070707 };
const PHONE = '+972501234567';
const PAIRING = 'pairing-9-42';
const TOKEN = 'refresh-SECRET-50';
/** The partner's PRIVATE calendar: neither its name nor its id may reach the JSON. */
const PRIVATE_NAME = 'Noa secret plans';
const PRIVATE_ID = 'native:cal-noa-private';
const TITLES = ['Dentist', 'Call the plumber', 'Family dinner', 'Return the library books', 'Water the plants', 'School pickup'];

const OWN = { id: 'native:cal-own', source: 'famcal', name: 'Tal', color: '#039BE5', mine: true, inLegend: true };
const NOA_SHARED = { id: 'native:cal-noa', source: 'famcal', name: 'Noa family', color: '#E67C73', mine: false, ownerName: 'Noa', inLegend: true };
const MASKED = { id: null, source: 'famcal', name: 'Noa', color: null, mine: false, inLegend: false };
const FAMILY = { id: 'family@group.calendar.google.com', source: 'google', name: 'Family', color: '#7986CB', mine: true, inLegend: true };
const SPOUSE = { id: 'dan@example.com', source: 'google', name: 'Dan', color: '#33B679', mine: false, ownerName: 'Dan', inLegend: true };

const PARTNER = { id: 42, name: 'Noa', englishName: '', gender: 'female', calendarSource: 'NATIVE', telegramId: BigInt(TG.gil), language: 'he' };

function baseUser(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', culture: 'default',
    messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null, calendarSource: 'NATIVE',
    pairingId: null, remindersEnabled: false, suspendedAt: null, unreachableSince: null, whatsappPhone: null,
    whatsappBsuid: null, telegramId: null, isAdmin: false, globalRules: [], voiceInputEnabled: true,
    textSummaryEnabled: true, voiceSummaryEnabled: false, weatherEnabled: true, locationForced: false,
    createdAt: new RealDate('2026-09-01T00:00:00Z'), updatedAt: new RealDate('2026-10-01T00:00:00Z'),
    ...o,
  };
}

/** A FamCal ReadItem as readFamcal builds one. */
function famcalItem(eventId: string, title: string, start: string, end: string, ref: Row, extra: Row = {}): Row {
  const kind = extra.kind ?? 'event';
  return {
    source: 'famcal',
    key: `famcal|${eventId}`,
    event: {
      summary: title, start, end, calendarName: extra.calendarName ?? ref.name, calendarId: extra.calendarId ?? ref.id,
      eventId, provider: 'native', timeZone: IL,
      ...(kind === 'reminder' ? { eventType: 'reminder', reminder: extra.reminder ?? { ownerIsViewer: true, creatorIsViewer: true } } : {}),
    },
    calendar: ref, title, kind, seriesId: eventId.split('#')[0], originalStart: start, recurring: false, rrule: null,
    ...(kind === 'reminder' ? { state: { doneAt: null, snoozedUntil: null } } : {}),
  };
}

/** Tal (9): today's dentist, the partner's reminder for Tal on her PRIVATE calendar (masked), tomorrow's dinner. */
function talFamcal(): Row[] {
  return [
    famcalItem('ev-dentist', 'Dentist', '2026-10-16T07:00:00.000Z', '2026-10-16T08:00:00.000Z', OWN),
    famcalItem('rem-plumber', 'Call the plumber', '2026-10-16T05:00:00.000Z', '2026-10-16T05:00:00.000Z', MASKED, {
      kind: 'reminder', calendarName: PRIVATE_NAME, calendarId: PRIVATE_ID,
      reminder: { ownerIsViewer: true, creatorIsViewer: false, creatorName: 'Noa' },
    }),
    famcalItem('ev-dinner', 'Family dinner', '2026-10-17T16:00:00.000Z', '2026-10-17T18:00:00.000Z', NOA_SHARED),
  ];
}

/** Tal's carry-overs as fetchOpenReminderItems answers them: newest first. */
function talCarryOvers(): Row[] {
  return [
    {
      event: {
        summary: 'Return the library books', start: '2026-10-15T06:00:00.000Z', end: '2026-10-15T06:00:00.000Z',
        calendarName: PRIVATE_NAME, calendarId: PRIVATE_ID, eventType: 'reminder', eventId: 'ser-lib', provider: 'native', timeZone: IL,
        reminder: { ownerIsViewer: true, creatorIsViewer: false, creatorName: 'Noa', openSince: '2026-10-15' },
      },
      series: { id: 'ser-lib', kind: 'REMINDER', rrule: null, creatorUserId: 42, forUserId: 9, forBoth: false },
      calendar: { id: 'cal-noa-private', name: PRIVATE_NAME },
      instanceStartsAt: new RealDate('2026-10-15T06:00:00.000Z'),
    },
    {
      event: {
        summary: 'Water the plants', start: '2026-10-14T05:00:00.000Z', end: '2026-10-14T05:00:00.000Z',
        calendarName: 'Tal', calendarId: 'native:cal-own', eventType: 'reminder', eventId: 'ser-water#2026-10-14T05:00:00.000Z',
        recurringEventId: 'ser-water', instanceStartsAt: '2026-10-14T05:00:00.000Z', provider: 'native', timeZone: IL,
        reminder: { ownerIsViewer: true, creatorIsViewer: true, snoozed: true, openSince: '2026-10-14' },
      },
      series: { id: 'ser-water', kind: 'REMINDER', rrule: 'FREQ=DAILY', creatorUserId: 9, forUserId: null, forBoth: false },
      calendar: { id: 'cal-own', name: 'Tal' },
      instanceStartsAt: new RealDate('2026-10-14T05:00:00.000Z'),
      state: { originalStartsAt: new RealDate('2026-10-14T05:00:00.000Z'), doneAt: null, pings: [{ userId: 9, snoozedUntil: new RealDate('2026-10-16T12:00:00.000Z') }] },
    },
  ];
}

function googleItem(calendar: Row, id: string, title: string, start: string, end: string): Row {
  return {
    source: 'google', key: `google|${calendar.id}|${id}`,
    event: { summary: title, start, end, calendarName: calendar.name, calendarId: calendar.id, eventType: 'default', eventId: id, provider: 'google' },
    calendar, title, kind: 'event', seriesId: null, originalStart: null, recurring: false, rrule: null,
    google: { birthday: false, htmlLink: null },
  };
}

function seed() {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  for (const list of [prismaCalls, rateChecks, captured, famcalCalls, googleCalls, carryCalls, afterQueue, fetched] as unknown[][]) list.length = 0;
  clock = RealDate.parse('2026-10-16T06:00:00Z');
  rateAllow = true;
  famcalMode = 'ok';
  googleMode = 'ok';
  carryMode = 'ok';
  const { encrypt } = nodeRequire(path.join(ROOT, 'src/utils/encryption.ts'));
  DB.user = [
    baseUser({ id: 9, name: 'Tal', telegramId: BigInt(TG.tal), isAdmin: true, language: 'he', pairingId: PAIRING, whatsappPhone: PHONE }),
    baseUser({ id: 42, name: 'Noa', telegramId: BigInt(TG.gil), language: 'ru', location: 'Moscow', pairingId: PAIRING }),
    baseUser({
      id: 50, name: 'Dana', telegramId: BigInt(TG.dana), isAdmin: true, location: '', calendarSource: 'GOOGLE',
      googleRefreshToken: encrypt(TOKEN),
      calendarAssignments: [
        { calendarId: FAMILY.id, labels: ['yours'], name: 'Family', color: '#7986CB' },
        { calendarId: SPOUSE.id, labels: ['spouse'], name: 'Dan', color: '#33B679', personName: 'Dan' },
      ],
    }),
    baseUser({ id: 51, name: 'Omer', telegramId: BigInt(TG.omer), isAdmin: true, calendarSource: 'GOOGLE' }),
    baseUser({ id: 60, name: 'Sus', telegramId: BigInt(TG.sus), isAdmin: true, suspendedAt: new RealDate('2026-10-10T00:00:00Z') }),
    baseUser({ id: 70, name: 'Ny', telegramId: BigInt(TG.ny), isAdmin: true, location: 'New York' }),
  ];
  for (const [id, tz] of [[9, IL], [42, 'Europe/Moscow'], [50, NY], [51, IL], [60, IL], [70, NY]] as const) {
    redisStore.set(`tz:user:${id}`, tz);
  }
}

function installStubs() {
  stub('src/utils/prisma.ts', { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() });
  stub('src/utils/redis.ts', { redis: fakeRedis });
  const capture = (severityOf: (args: unknown[]) => string) => (e: unknown, ctx: string, extra?: Row, ...rest: unknown[]) => {
    captured.push({ ctx, severity: severityOf(rest), extra, message: e instanceof Error ? e.message : String(e) });
  };
  stub('src/lib/error-capture.ts', {
    captureError: capture((rest) => String(rest[0] ?? 'error')),
    captureWarning: capture(() => 'warning'),
    captureInfo: () => undefined,
  });
  const telegram = { getBot: () => recorder(), initBot: () => recorder(), getMessagingService: () => recorder(), setUserMenuButton: async () => undefined };
  stub('src/services/telegram/index.ts', telegram);
  stub('src/services/telegram/bot.ts', telegram);
  const messaging = {
    ...nodeRequire(path.join(ROOT, 'src/services/messaging/types.ts')),
    getMessagingService: () => recorder(), getTelegramService: () => recorder(), getWhatsAppService: () => recorder(),
    detectPlatform: () => 'telegram',
  };
  stub('src/services/messaging/index.ts', messaging);
  stub('src/services/messaging/factory.ts', messaging);

  stub('src/lib/rate-limit.ts', {
    calendarRateLimiter: { name: 'calendar' },
    commandRateLimiter: { name: 'command' },
    settingsRateLimiter: { name: 'settings' },
    generalRateLimiter: { name: 'general' },
    tokenPollRateLimiter: { name: 'token-poll' },
    // The real checkRateLimit hands String(identifier) to limiter.limit(): record that key.
    checkRateLimit: async (limiter: Row, identifier: string | number) => {
      rateChecks.push(`${limiter?.name}:${String(identifier)}`);
      return rateAllow ? { success: true, remaining: 59, reset: 0 } : { success: false, remaining: 0, reset: 0 };
    },
    getRateLimitHeaders: () => ({}),
  });

  // readFamcal is faked; carryOverReadItems (the carry-overs' masking) is the real one.
  const famcalHalf = nodeRequire(path.join(ROOT, 'src/services/calendar-read/famcal.ts'));
  stub('src/services/calendar-read/famcal.ts', {
    ...famcalHalf,
    readFamcal: async (user: Row, window: { from: Date; to: Date }, opts: Row) => {
      famcalCalls.push({ user, window, opts });
      if (famcalMode === 'reject') throw new Error('famcal half rejected');
      // An answer the route cannot build its legend from: its own unexpected error (#17).
      if (famcalMode === 'broken') return { read: { status: 'ok', ctx: { viewerId: user.id, partner: null }, calendars: null, partner: null }, items: [] };
      if (famcalMode === 'error') return { read: { status: 'error', cause: new Error('db down') }, items: [] };
      const tal = user.id === 9;
      return {
        read: {
          status: 'ok',
          ctx: { viewerId: user.id, partner: tal ? PARTNER : null },
          calendars: tal ? [OWN, NOA_SHARED] : [{ ...OWN, name: user.name }],
          partner: tal ? { name: 'Noa' } : null,
        },
        items: tal ? talFamcal() : [famcalItem('ev-solo', 'Dentist', '2026-10-16T07:00:00.000Z', '2026-10-16T08:00:00.000Z', OWN), { ...famcalItem('ev-nostart', 'Dentist', '', '', OWN) }],
      };
    },
  });

  stub('src/services/calendar-read/google.ts', {
    readGoogle: async (user: Row, window: { from: Date; to: Date }, opts: Row) => {
      googleCalls.push({ user, window, opts });
      // B6's first rule: an empty token is reconnect('token'), with no Google call.
      if (!user.googleRefreshToken) return { read: { status: 'reconnect', reason: 'token' }, items: [] };
      if (googleMode === 'reject') throw new Error('google half rejected');
      if (googleMode === 'gone') return { read: { status: 'error', reason: 'calendars_gone' }, items: [] };
      if (googleMode === 'partialStale') {
        opts.defer?.(async () => { fetched.push('background refresh ran'); });
        return {
          read: { status: 'ok', calendars: [FAMILY, { ...SPOUSE, unavailable: true }], goneIds: [SPOUSE.id], partial: { failed: 1, truncated: 0 }, stale: true },
          items: [googleItem(FAMILY, 'g-pickup', 'School pickup', '2026-10-16T15:00:00-04:00', '2026-10-16T15:30:00-04:00')],
        };
      }
      const items =
        googleMode === 'unsorted'
          ? [
              googleItem(FAMILY, 'g-late', 'Late', '2026-10-16T18:00:00-04:00', '2026-10-16T19:00:00-04:00'),
              googleItem(FAMILY, 'g-a', 'Same A', '2026-10-16T09:00:00-04:00', '2026-10-16T10:00:00-04:00'),
              googleItem(SPOUSE, 'g-b', 'Same B', '2026-10-16T13:00:00Z', '2026-10-16T14:00:00Z'),
              { ...googleItem(SPOUSE, 'g-nostart', 'No start', '', '') },
              googleItem(SPOUSE, 'g-allday', 'All day', '2026-10-16', '2026-10-17'),
            ]
          : [googleItem(FAMILY, 'g-pickup', 'School pickup', '2026-10-16T15:00:00-04:00', '2026-10-16T15:30:00-04:00')];
      return { read: { status: 'ok', calendars: [FAMILY, SPOUSE], goneIds: [], partial: null, stale: false }, items };
    },
    stampGoogleCache: async () => undefined,
  });

  // The carry-over query is faked; everything else in open-reminders.ts is the real one.
  const openReminders = nodeRequire(path.join(ROOT, 'src/services/native-reminders/open-reminders.ts'));
  stub('src/services/native-reminders/open-reminders.ts', {
    ...openReminders,
    fetchOpenReminderItems: async (user: Row, ctx: Row, cutoff: Date, summaryDay: string, tz: string, cap: number) => {
      carryCalls.push({ userId: user.id, ctx, cutoff, summaryDay, tz, cap });
      if (carryMode === 'throw') throw new Error('carry-over query failed');
      return user.id === 9 ? { items: talCarryOvers(), moreCount: 0 } : { items: [], moreCount: 0 };
    },
  });

  // Next's after() needs a live request scope; queue the task instead.
  const nextServer = nodeRequire('next/server');
  nextServer.after = (task: unknown) => {
    afterQueue.push(typeof task === 'function' ? (task as () => unknown) : () => task);
  };

  globalThis.fetch = (async (input: unknown) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    throw new Error(`network blocked in smoke: ${String(input)}`);
  }) as typeof fetch;
}

/** Valid Telegram initData for a Telegram user id, signed with the bot token, dated by the clock. */
function initDataFor(tgId: number): string {
  const params: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAH-smoke',
    user: JSON.stringify({ id: tgId, first_name: 'Test' }),
  };
  const checkString = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN ?? '').digest();
  const hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  return [...Object.entries(params), ['hash', hash]].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

async function main() {
  installStubs();
  seed();
  const { NextRequest } = nodeRequire('next/server');
  const { startOfLocalDay } = nodeRequire(path.join(ROOT, 'src/utils/day-events.ts'));
  const { openRemindersCutoff } = nodeRequire(path.join(ROOT, 'src/services/native-reminders/open-reminders.ts'));

  // The route logs refused attempts; keep the output to the results.
  const quiet = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  Object.assign(console, { log: () => {}, warn: () => {}, error: () => {}, info: () => {} });

  const route = await load('app/api/calendar/range/route.ts');
  const reader = await load('src/services/calendar-read/index.ts');

  type Call = { tg?: number; userId?: string; header?: boolean; queryInitData?: boolean; cookie?: string };
  /** GET the route as Telegram user `tg` (the header by default, a Cookie header too when given) with a query string. */
  const get = async (qs: string, o: Call = {}): Promise<{ status: number; body: Row; text: string; res: Response }> => {
    const tg = o.tg ?? TG.tal;
    const userId = o.userId ?? String(tg);
    const initQuery = o.queryInitData ? `&initData=${encodeURIComponent(initDataFor(tg))}` : '';
    const url = `http://localhost/api/calendar/range?user_id=${userId}${qs ? `&${qs}` : ''}${initQuery}`;
    const headers: Record<string, string> = o.header === false ? {} : { 'x-telegram-init-data': initDataFor(tg) };
    if (o.cookie) headers.cookie = o.cookie;
    const res: Response = await route.GET(new NextRequest(url, { headers }));
    const text = await res.clone().text();
    let body: Row = {};
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body, text, res };
  };
  const dates = (body: Row) => (body.days ?? []).map((d: Row) => d.date);
  const keysOn = (body: Row, date: string) => ((body.days ?? []).find((d: Row) => d.date === date)?.items ?? []).map((i: Row) => i.key);
  const iso = (d: Date) => new RealDate(d.getTime()).toISOString();

  await check('#1 401 without the header, and with valid init data in the query only; nothing is read', async () => {
    seed();
    const none = await get('', { header: false });
    const inQuery = await get('', { header: false, queryInitData: true });
    assert(none.status === 401 && inQuery.status === 401, `no header ${none.status}, query ${inQuery.status} ${inQuery.text}`);
    assert(none.res.headers.get('cache-control') === 'private, no-store', `401 cache-control: ${none.res.headers.get('cache-control')}`);
    assert(famcalCalls.length + googleCalls.length + rateChecks.length === 0, 'a refused request read or counted');
  });

  await check('#2 403 for a suspended user', async () => {
    seed();
    const r = await get('', { tg: TG.sus });
    assert(r.status === 403, `status ${r.status} ${r.text}`);
    assert(famcalCalls.length === 0, 'a suspended user was read');
  });

  await check('#3 429 when the limiter says no, with no store and no read', async () => {
    seed();
    rateAllow = false;
    const r = await get('');
    assert(r.status === 429, `status ${r.status} ${r.text}`);
    assert(r.res.headers.get('cache-control') === 'private, no-store', `cache-control: ${r.res.headers.get('cache-control')}`);
    assert(famcalCalls.length === 0, 'read after a 429');
  });

  await check('#4 everyone gets 200: an admin, a non-admin, no switch to ask', async () => {
    seed();
    const tal = await get('', { tg: TG.tal });
    const gil = await get('', { tg: TG.gil });
    assertSame([tal.status, gil.status], [200, 200], 'statuses');
    assertSame(famcalCalls.map((c) => c.user.id), [9, 42], 'both read');
  });

  await check('#5 400 for a bad window or source, before any read', async () => {
    seed();
    const bad = [
      'from=2026-02-30&to=2026-03-02', 'from=2026-1-05&to=2026-01-09', 'from=tomorrow&to=2026-10-20', 'from=2026-10-16',
      'to=2026-10-20', 'from=2026-10-16&to=2026-10-16', 'from=2026-10-20&to=2026-10-16', 'from=2026-10-01&to=2026-11-13',
      'from=2020-01-01&to=2020-01-10', 'from=2031-12-20&to=2032-01-02', 'sources=outlook', 'sources=famcal,', 'sources=',
    ];
    const wrong: string[] = [];
    for (const qs of bad) {
      const r = await get(qs);
      if (r.status !== 400 || r.body.error !== 'bad_request') wrong.push(`${qs} -> ${r.status} ${r.text}`);
    }
    assert(wrong.length === 0, wrong.join('; '));
    assert(famcalCalls.length === 0, `read on a 400: ${famcalCalls.length}`);
    const edge = await get('from=2031-12-01&to=2031-12-10');
    assert(edge.status === 200, `5 years away is allowed: ${edge.status} ${edge.text}`);
  });

  await check('#6 200 for 42-day windows across 2026-10-25 in Israel and 2026-11-01 in New York, with local-midnight windows', async () => {
    seed();
    const il = await get('from=2026-10-01&to=2026-11-12', { tg: TG.tal });
    const ny = await get('from=2026-10-15&to=2026-11-26', { tg: TG.ny });
    assert(il.status === 200 && ny.status === 200, `statuses ${il.status} ${ny.status} ${il.text.slice(0, 200)}`);
    assert(dates(il.body).length === 42 && dates(il.body)[0] === '2026-10-01' && dates(il.body)[41] === '2026-11-11', `IL days ${show(dates(il.body))}`);
    assert(dates(ny.body).length === 42 && dates(ny.body)[0] === '2026-10-15' && dates(ny.body)[41] === '2026-11-25', `NY days ${show(dates(ny.body))}`);
    assertSame(famcalCalls.map((c) => [iso(c.window.from), iso(c.window.to)]), [
      ['2026-09-30T21:00:00.000Z', '2026-11-11T22:00:00.000Z'],
      ['2026-10-15T04:00:00.000Z', '2026-11-26T05:00:00.000Z'],
    ], 'windows');
    assert(il.body.from === '2026-10-01' && il.body.to === '2026-11-12', `IL from/to ${il.body.from} ${il.body.to}`);
  });

  await check('#7 the default window is [today, today+7) in the user\'s timezone: at 23:30 UTC an Israeli user is on the next day', async () => {
    seed();
    clock = RealDate.parse('2026-10-16T23:30:00Z');
    const il = await get('', { tg: TG.tal });
    const ny = await get('', { tg: TG.ny });
    assertSame([il.body.today, il.body.from, il.body.to, dates(il.body).length], ['2026-10-17', '2026-10-17', '2026-10-24', 7], 'Israel');
    assertSame([ny.body.today, ny.body.from, ny.body.to, dates(ny.body).length], ['2026-10-16', '2026-10-16', '2026-10-23', 7], 'New York');
    assertSame(famcalCalls.map((c) => iso(c.window.from)), ['2026-10-16T21:00:00.000Z', '2026-10-16T04:00:00.000Z'], 'window starts');
  });

  await check('#8 the facts come from the server: timezone, week start and Hebrew dates (a tz in the query is ignored)', async () => {
    seed();
    const tal = await get('tz=UTC', { tg: TG.tal }); // he, Israel
    const noa = await get('', { tg: TG.gil }); // ru, Moscow
    const dana = await get('', { tg: TG.dana }); // en, New York, known through her Google token
    const pick = (b: Row) => [b.tz, b.weekStart, b.hebrewDates];
    assertSame([pick(tal.body), pick(noa.body), pick(dana.body)], [[IL, 0, true], ['Europe/Moscow', 1, false], [NY, 0, false]], 'facts');
  });

  await check('#9 sources: a user without a token has no google key; a Google user reads FamCal too (Google as a connection); requested-but-not-applicable reads nothing; applicable-but-not-requested is pending', async () => {
    seed();
    const famcalUser = await get('', { tg: TG.tal });
    const famcalOnlyGoogle = await get('sources=google', { tg: TG.tal });
    const googleOnlyFamcal = await get('sources=famcal', { tg: TG.dana });
    const both = await get('sources=famcal,google', { tg: TG.dana });
    assertSame(famcalUser.body.sources, { famcal: { status: 'ok' } }, 'FamCal user');
    assertSame(famcalOnlyGoogle.body.sources, { famcal: { status: 'pending' } }, 'FamCal user on sources=google');
    assert(!('carryOvers' in famcalOnlyGoogle.body), 'carry-overs without a FamCal read');
    assertSame(googleOnlyFamcal.body.sources, { famcal: { status: 'ok' }, google: { status: 'pending' } }, 'Google user on sources=famcal');
    assertSame(both.body.sources, { famcal: { status: 'ok' }, google: { status: 'ok' } }, 'Google user on both');
    assertSame([famcalCalls.map((c) => c.user.id), googleCalls.map((c) => c.user.id)], [[9, 50, 50], [50]], 'reads');
    assert(famcalCalls[0].opts.calendarIds === undefined, `calendarIds from the route: ${show(famcalCalls[0].opts)}`);
  });

  await check('#10 a Google user with an empty token has no Google half (Google as a connection: the page props say Reconnect): no google key, no Google read, no network', async () => {
    seed();
    const r = await get('sources=google', { tg: TG.omer });
    assert(r.status === 200, `status ${r.status} ${r.text}`);
    assertSame(r.body.sources, { famcal: { status: 'pending' } }, 'sources');
    assertSame([r.body.calendars, r.body.partner, 'carryOvers' in r.body], [[], null, false], 'legend, partner, carry-overs');
    assert(famcalCalls.length === 0 && carryCalls.length === 0 && googleCalls.length === 0, 'a read on sources=google with no token');
    // The user's rows, and the FamCal calendars the colours are judged against (no Google read).
    assert(prismaCalls.every((c) => c.startsWith('user.') || c === 'nativeCalendar.findMany'), `queries: ${show(prismaCalls)}`);
    assert(fetched.length === 0, `network: ${show(fetched)}`);
  });

  await check('#11 the Google read: cache "use" (fresh=1 "refresh"), 6,000 ms, the user\'s tz, after() as defer; partial, stale and unavailable carried', async () => {
    seed();
    googleMode = 'partialStale';
    const r = await get('sources=google', { tg: TG.dana });
    await get('sources=google&fresh=1', { tg: TG.dana });
    await get('sources=google&fresh=0', { tg: TG.dana });
    assertSame(googleCalls.map((c) => [c.opts.googleCache, c.opts.deadlineMs, c.opts.tz, c.opts.calendarIds, typeof c.opts.defer]), [
      ['use', 6000, NY, undefined, 'function'], ['refresh', 6000, NY, undefined, 'function'], ['use', 6000, NY, undefined, 'function'],
    ], 'readGoogle options');
    assertSame(r.body.sources, { famcal: { status: 'pending' }, google: { status: 'ok', partial: { failed: 1, truncated: 0 }, stale: true } }, 'sources');
    assertSame(r.body.calendars, [
      { id: FAMILY.id, source: 'google', name: 'Family', color: '#7986CB', mine: true },
      { id: SPOUSE.id, source: 'google', name: 'Dan', color: '#33B679', mine: false, ownerName: 'Dan', unavailable: true },
    ], 'legend');
    assertSame(keysOn(r.body, '2026-10-16'), [`google|${FAMILY.id}|g-pickup`], 'today');
    const item = r.body.days[0].items[0];
    assertSame([item.readOnly, item.start, item.tz, item.birthday], [true, '2026-10-16T15:00:00-04:00', null, false], 'Google item');
    assert(afterQueue.length === 3, `after() got ${afterQueue.length} tasks`);
    await afterQueue[0]();
    assert(fetched.includes('background refresh ran'), 'the deferred refresh did not run');
  });

  await check('#12 Google errors keep their reason; a FamCal error is reported and leaves the days unanswered', async () => {
    seed();
    googleMode = 'gone';
    const gone = await get('sources=google', { tg: TG.dana });
    famcalMode = 'error';
    const down = await get('', { tg: TG.tal });
    assertSame([gone.status, gone.body.sources, gone.body.calendars], [200, { famcal: { status: 'pending' }, google: { status: 'error', reason: 'calendars_gone' } }, []], 'calendars_gone');
    assertSame([down.status, down.body.sources, down.body.partner, 'carryOvers' in down.body], [200, { famcal: { status: 'error' } }, null, false], 'FamCal error');
    assert(down.body.days.every((d: Row) => d.items.length === 0) && down.body.days.length === 7, `days ${show(down.body.days)}`);
    assertSame(captured.map((c) => [c.ctx, c.severity, c.extra]), [['calendar-range-famcal', 'warning', { user_id: 9 }]], 'captured');
    assert(carryCalls.length === 0, 'carry-overs read after a FamCal error');
  });

  await check('#13 the days: every day in the window, daySpanOf placement, today\'s past-due reminder open, the legend and the partner', async () => {
    seed();
    const r = await get('', { tg: TG.tal });
    assertSame(dates(r.body), ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'], 'dates');
    assertSame(keysOn(r.body, '2026-10-16'), ['famcal|rem-plumber', 'famcal|ev-dentist'], 'today');
    assertSame(keysOn(r.body, '2026-10-17'), ['famcal|ev-dinner'], 'tomorrow');
    const plumber = r.body.days[0].items[0];
    assertSame([plumber.reminder.open, plumber.reminder.creatorName, plumber.calendar], [true, 'Noa', { id: null, name: 'Noa', color: null, mine: false, inLegend: false }], 'masked reminder');
    assertSame(r.body.partner, { name: 'Noa' }, 'partner');
    assertSame(r.body.calendars.map((c: Row) => c.id), ['native:cal-own', 'native:cal-noa'], 'legend');
  });

  await check('#14 carry-overs for a window holding today: all of them (cap Infinity) at today\'s cutoff, open, openSince, the occurrence as originalStart, masked by the legend rule', async () => {
    seed();
    const r = await get('', { tg: TG.tal });
    const now = new RealDate(clock);
    assertSame(carryCalls.map((c) => [c.userId, c.summaryDay, c.tz, c.cap, iso(c.cutoff), c.ctx.partner?.name]), [
      [9, '2026-10-16', IL, Infinity, iso(openRemindersCutoff('2026-10-16', IL, now)), 'Noa'],
    ], 'fetchOpenReminderItems arguments');
    const got = (r.body.carryOvers ?? []).map((c: Row) => [
      c.key, c.reminder.open, c.reminder.openSince, c.originalStart, c.calendar.id, c.calendar.name, c.repeatsDaily, c.reminder.snoozedUntil,
    ]);
    assertSame(got, [
      ['famcal|ser-lib', true, '2026-10-15', '2026-10-15T06:00:00.000Z', null, 'Noa', false, null],
      ['famcal|ser-water#2026-10-14T05:00:00.000Z', true, '2026-10-14', '2026-10-14T05:00:00.000Z', 'native:cal-own', 'Tal', true, '2026-10-16T12:00:00.000Z'],
    ], 'carry-overs');
  });

  await check('#15 no carry-overs for a window without today; a failed carry-over query costs only the card', async () => {
    seed();
    const later = await get('from=2026-10-17&to=2026-10-24', { tg: TG.tal });
    const past = await get('from=2026-10-09&to=2026-10-16', { tg: TG.tal });
    const lastDay = await get('from=2026-10-10&to=2026-10-17', { tg: TG.tal });
    assertSame(['carryOvers' in later.body, 'carryOvers' in past.body, (lastDay.body.carryOvers ?? []).length], [false, false, 2], 'carry-overs by window');
    carryMode = 'throw';
    const failed = await get('', { tg: TG.tal });
    assert(failed.status === 200 && !('carryOvers' in failed.body) && failed.body.days.length === 7, `failed: ${failed.status} ${failed.text.slice(0, 200)}`);
    assertSame(captured.map((c) => [c.ctx, c.severity, c.extra]), [['calendar-range-carryovers', 'warning', { user_id: 9 }]], 'captured');
  });

  await check('#16 privacy: no private calendar name or id, no token, phone, pairing or Telegram id in the JSON; private, no-store on every answer', async () => {
    seed();
    const answers = [
      await get('', { tg: TG.tal }),
      await get('from=2026-10-10&to=2026-10-17', { tg: TG.tal }),
      await get('', { tg: TG.dana }),
      await get('from=bad&to=2026-10-20', { tg: TG.tal }),
    ];
    const forbidden = [PRIVATE_NAME, PRIVATE_ID, 'cal-noa-private', 'googleRefreshToken', TOKEN, PHONE, 'whatsappPhone', 'pairingId', PAIRING, String(TG.tal), String(TG.dana), 'telegramId'];
    const leaks = answers.flatMap((a, i) => forbidden.filter((f) => a.text.includes(f)).map((f) => `answer ${i}: ${f}`));
    assert(leaks.length === 0, leaks.join('; '));
    assert(answers[0].text.includes('Call the plumber') && answers[1].text.includes('Return the library books'), 'the fixtures were not in the answers');
    const cc = answers.map((a) => [a.status, a.res.headers.get('cache-control')]);
    assertSame(cc, [[200, 'private, no-store'], [200, 'private, no-store'], [200, 'private, no-store'], [400, 'private, no-store']], 'cache-control');
  });

  await check('#17 an unexpected error is a 500 with only the user id in the capture context; no capture anywhere names a title', async () => {
    seed();
    famcalMode = 'broken';
    const r = await get('', { tg: TG.tal });
    assertSame([r.status, r.body], [500, { error: 'internal_error' }], 'answer');
    // The broken answer also fails its carry-over masking (a warning); the route's own error follows.
    assertSame(captured.map((c) => [c.ctx, c.severity, c.extra]), [['calendar-range-carryovers', 'warning', { user_id: 9 }], ['calendar-range', 'error', { user_id: 9 }]], 'captured');
    famcalMode = 'error';
    await get('', { tg: TG.tal });
    famcalMode = 'ok';
    carryMode = 'throw';
    await get('', { tg: TG.tal });
    const named = captured.filter((c) => TITLES.some((t) => show(c.extra).includes(t) || c.message.includes(t)));
    assert(named.length === 0, `titles in captures: ${show(named)}`);
  });

  await check('#18 the rate-limit bucket is the calendar limiter keyed u<id>: "111111111" and "0111111111" share it', async () => {
    seed();
    await get('', { tg: TG.tal, userId: '111111111' });
    await get('', { tg: TG.tal, userId: '0111111111' });
    await get('', { tg: TG.tal, userId: '9' });
    assertSame(rateChecks, ['calendar:u9', 'calendar:u9', 'calendar:u9'], 'limiter keys');
  });

  await check('#19 calendarRateLimiter: 60 a minute under the prefix ratelimit:calendar', () => {
    // A fresh copy of the real module, beside the stub the route uses.
    const file = path.join(ROOT, 'src/lib/rate-limit.ts');
    const source = fs.readFileSync(file, 'utf8');
    const block = source.match(/export const calendarRateLimiter = new Ratelimit\(\{([\s\S]*?)\}\);/)?.[1] ?? '(not found)';
    assert(/limiter:\s*Ratelimit\.slidingWindow\(60,\s*'1 m'\)/.test(block), `limiter: ${block}`);
    const stubbed = Module._cache[file];
    delete Module._cache[file];
    try {
      const real = nodeRequire(file);
      assert(real.calendarRateLimiter?.prefix === 'ratelimit:calendar', `prefix ${real.calendarRateLimiter?.prefix}`);
    } finally {
      Module._cache[file] = stubbed;
    }
  });

  await check('#20 readRange: the local-midnight window, notBefore, Chile\'s midnight DST, and an empty window throws', async () => {
    seed();
    const tal = DB.user.find((u) => u.id === 9);
    const user = { ...tal, telegramId: TG.tal };
    const opts = { tz: IL, deadlineMs: 1000 };
    const plain = await reader.readRange(user, '2026-10-16', '2026-10-18', opts);
    const later = await reader.readRange(user, '2026-10-16', '2026-10-18', { ...opts, notBefore: new RealDate('2026-10-16T06:00:00Z') });
    const earlier = await reader.readRange(user, '2026-10-16', '2026-10-18', { ...opts, notBefore: new RealDate('2026-10-15T06:00:00Z') });
    const chile = await reader.readRange(user, '2026-09-06', '2026-09-07', { ...opts, tz: 'America/Santiago' });
    const win = (r: Row) => [iso(r.window.from), iso(r.window.to)];
    assertSame([win(plain), win(later), win(earlier), win(chile)], [
      ['2026-10-15T21:00:00.000Z', '2026-10-17T21:00:00.000Z'],
      ['2026-10-16T06:00:00.000Z', '2026-10-17T21:00:00.000Z'],
      ['2026-10-15T21:00:00.000Z', '2026-10-17T21:00:00.000Z'],
      [iso(startOfLocalDay('2026-09-06', 'America/Santiago')), '2026-09-07T03:00:00.000Z'],
    ], 'windows');
    assert(iso(chile.window.from) === '2026-09-06T04:00:00.000Z', `Chile's day starts at 01:00 local: ${iso(chile.window.from)}`);
    assertSame(famcalCalls.map((c) => iso(c.window.from)), [win(plain)[0], win(later)[0], win(earlier)[0], win(chile)[0]], 'the halves get the window');
    let threw = '';
    try {
      await reader.readRange(user, '2026-10-16', '2026-10-17', { ...opts, notBefore: new RealDate('2026-10-16T21:00:00Z') });
    } catch (err) {
      threw = err instanceof RangeError ? 'RangeError' : String(err);
    }
    assert(threw === 'RangeError', `empty window: ${threw || 'no throw'}`);
  });

  await check('#21 readRange: sources intersect sourcesFor; calendarIds and the cache default reach the halves; FamCal then Google order; no start dropped', async () => {
    seed();
    const toUser = (id: number) => ({ ...DB.user.find((u) => u.id === id), telegramId: null });
    assertSame([reader.sourcesFor({ googleRefreshToken: '' }), reader.sourcesFor({ googleRefreshToken: 'rt' })], [['famcal'], ['famcal', 'google']], 'sourcesFor');
    const none = await reader.readRange(toUser(9), '2026-10-16', '2026-10-17', { tz: IL, deadlineMs: 1000, sources: ['google'] });
    assertSame([Object.keys(none).sort(), none.items.length, famcalCalls.length, googleCalls.length], [['items', 'window'], 0, 0, 0], 'FamCal user, sources [google]');
    const solo = await reader.readRange(toUser(42), '2026-10-16', '2026-10-17', { tz: IL, deadlineMs: 1000, calendarIds: ['native:cal-own'] });
    assertSame([solo.items.map((i: Row) => i.key), famcalCalls[0].opts.calendarIds], [['famcal|ev-solo'], ['native:cal-own']], 'no-start item dropped; calendarIds passed');
    googleMode = 'unsorted';
    const g = await reader.readRange(toUser(50), '2026-10-16', '2026-10-17', { tz: NY, deadlineMs: 4321, calendarIds: [FAMILY.id], sources: ['google'] });
    assertSame(g.items.map((i: Row) => i.event.eventId), ['g-allday', 'g-a', 'g-b', 'g-late'], 'Google order: by start, ties in the order of the choices');
    assertSame([googleCalls[0].opts.googleCache, googleCalls[0].opts.deadlineMs, googleCalls[0].opts.calendarIds, googleCalls[0].opts.defer], ['bypass', 4321, [FAMILY.id], undefined], 'Google options');
    assert(!('famcal' in g), 'sources [google] read a FamCal half');
  });

  await check('#22 readRange: a half that rejects reports error and the read still answers', async () => {
    seed();
    const toUser = (id: number) => ({ ...DB.user.find((u) => u.id === id), telegramId: null });
    famcalMode = 'reject';
    googleMode = 'reject';
    const f = await reader.readRange(toUser(9), '2026-10-16', '2026-10-17', { tz: IL, deadlineMs: 1000 });
    const g = await reader.readRange(toUser(50), '2026-10-16', '2026-10-17', { tz: NY, deadlineMs: 1000 });
    assertSame([f.famcal.status, f.famcal.cause?.message, f.items.length], ['error', 'famcal half rejected', 0], 'FamCal');
    assertSame([g.google.status, g.google.reason, g.google.cause?.message, g.items.length], ['error', 'unknown', 'google half rejected', 0], 'Google');
    const viaRoute = await get('', { tg: TG.tal });
    assertSame([viaRoute.status, viaRoute.body.sources], [200, { famcal: { status: 'error' } }], 'route');
  });

  await check('#23 the famcal_session cookie (WhatsApp, a browser): 200 for its own DB id with no header; 401 for another id, also with that user\'s init data in the query', async () => {
    seed();
    const { createSessionToken } = await load('src/lib/session-auth.ts');
    const cookie = `famcal_session=${createSessionToken(9)}`;
    const own = await get('', { userId: '9', header: false, cookie });
    assert(own.status === 200, `own id: ${own.status} ${own.text}`);
    assertSame(keysOn(own.body, '2026-10-16'), ['famcal|rem-plumber', 'famcal|ev-dentist'], 'today');
    assert(own.res.headers.get('cache-control') === 'private, no-store', `cache-control: ${own.res.headers.get('cache-control')}`);
    assertSame([rateChecks, famcalCalls.map((c) => c.user.id)], [['calendar:u9'], [9]], 'the limiter key and the read');
    const other = await get('', { userId: '42', header: false, cookie });
    const otherWithQuery = await get('', { tg: TG.gil, header: false, queryInitData: true, cookie });
    assertSame([other.status, otherWithQuery.status], [401, 401], 'another user\'s id');
    assertSame([rateChecks.length, famcalCalls.length], [1, 1], 'a refused request was counted or read');
  });

  await check('#24 a slow timezone lookup (no tz:user entry, Nominatim not answering): an answer within 2.6 s in the fallback zone, by the language rule; a quick lookup is used', async () => {
    seed();
    redisStore.delete('tz:user:42');
    const blocked = globalThis.fetch;
    /** While set, Nominatim never answers; each request ends only when its own timeout aborts it. */
    let slow = true;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      if (url.startsWith('https://nominatim.openstreetmap.org/')) {
        if (!slow) return json([{ lat: '55.7558', lon: '37.6173' }]);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      if (url.startsWith('https://api.open-meteo.com/')) return json({ timezone: 'Europe/Moscow' });
      throw new Error(`network blocked in smoke: ${url}`);
    }) as typeof fetch;
    try {
      const started = performance.now();
      const late = await Promise.race([get('', { tg: TG.gil }), new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000))]);
      const ms = performance.now() - started;
      assert(late !== null, 'no answer within 4 s: the route waits for the whole timezone lookup');
      assert(ms >= 1900 && ms < 2600, `answered after ${Math.round(ms)} ms`);
      // Asia/Jerusalem with tzKnown false: Noa's Russian gives Monday and no Hebrew dates.
      assertSame([late.status, late.body.tz, late.body.today, late.body.weekStart, late.body.hebrewDates], [200, IL, '2026-10-16', 1, false], 'the fallback facts');
      assert(fetched.some((u) => u.startsWith('https://nominatim.openstreetmap.org/')), `fetched ${show(fetched)}`);
      assert(!redisStore.has('tz:user:42'), `the route cached a zone: ${redisStore.get('tz:user:42')}`);
      assertSame(captured.map((c) => [c.ctx, c.severity, c.extra]), [['calendar-range-timezone', 'warning', { user_id: 42 }]], 'captured');
      seed();
      redisStore.delete('tz:user:42');
      slow = false;
      const quick = await get('', { tg: TG.gil });
      assertSame([quick.status, quick.body.tz, quick.body.weekStart, quick.body.hebrewDates], [200, 'Europe/Moscow', 1, false], 'a quick lookup');
      assert(redisStore.get('tz:user:42') === 'Europe/Moscow' && captured.length === 0, `tz:user:42 ${redisStore.get('tz:user:42')}, captured ${show(captured)}`);
    } finally {
      globalThis.fetch = blocked;
    }
  });

  Object.assign(console, quiet);
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? '(unset)'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  // console may still be silenced: write the failure straight to stderr.
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

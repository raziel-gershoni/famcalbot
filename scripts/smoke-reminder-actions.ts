// Smoke test for done, undo and snooze on a native reminder occurrence: the service
// (src/services/native-reminders/actions.ts) and the route that serves the calendar home,
// POST /api/calendar/reminder (reminder actions spec §2, §3, §6).
//
// The service covers who may act, which occurrences are live, the conditional writes on
// the unique (series, original start) key (the row is made when nobody pinged), the due
// gate, analytics with a source, the creator's notice and the live ping's edit. The route
// covers auth outcomes, validation, acting for the authenticated user only, no-store and
// the reminder DTO against the range route's. The real service, route, reader and DTO
// code run against an in-memory Prisma; the bot, the auth check, the rate limiter, the
// timezone lookup, analytics and error capture are faked. No network, no DB.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-reminder-actions.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-reminder-actions.ts

import path from 'path';
import { fromZonedTime } from 'date-fns-tz';
import { NextRequest } from 'next/server';
import type { UserConfig } from '../src/types';

// The ping edit decrypts the owner's Google token with the real encryption module.
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.ENCRYPTION_KEY_PREVIOUS = '';

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

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

function assertJson(got: unknown, want: unknown, what: string) {
  const g = json(got);
  const w = json(want);
  assert(g === w, `${what}\n     got  ${g}\n     want ${w}`);
}

globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network is blocked in this smoke test: ${String(input)}`);
}) as typeof fetch;

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const at = (local: string, tz = IL) => fromZonedTime(local, tz);

// ---- The clock: argument-less new Date() reads `clock` (the route takes its own now) ----

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

// ---- In-memory Prisma: what the service, the route and the reader use ----

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type Relations = Record<string, (row: Row) => Row | Row[] | undefined>;
type FindArgs = { where?: Where; select?: Record<string, unknown>; include?: Record<string, unknown>; orderBy?: unknown };

const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

function matches(row: Row, where: Where, relations: Relations = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w, relations));
    if (key === 'AND') return (Array.isArray(cond) ? (cond as Where[]) : [cond as Where]).every((w) => matches(row, w, relations));
    if (key === 'seriesEventId_originalStartsAt') return matches(row, cond as Where);
    if (Object.hasOwn(relations, key)) {
      const target = relations[key](row);
      if (Array.isArray(target)) {
        const { some, ...rest } = cond as { some?: Where };
        if (!some || Object.keys(rest).length > 0) throw new Error(`stand-in Prisma only knows '${key}: { some }'`);
        return target.some((r) => matches(r, some));
      }
      return target !== undefined && matches(target, cond as Where);
    }
    const value = row[key];
    if (cond === null) return value == null;
    if (typeof cond !== 'object' || cond instanceof Date) return same(value, cond);
    return Object.entries(cond as Where).every(([op, arg]) => {
      switch (op) {
        case 'in': return (arg as unknown[]).some((a) => same(a, value));
        case 'not': return arg === null ? value != null : !same(value, arg);
        case 'lt': return value != null && (value as Date) < (arg as Date);
        case 'lte': return value != null && (value as Date) <= (arg as Date);
        case 'gt': return value != null && (value as Date) > (arg as Date);
        case 'gte': return value != null && (value as Date) >= (arg as Date);
        default: throw new Error(`stand-in Prisma does not know '${op}'`);
      }
    });
  });
}

const sortKey = (row: Row, key: string) => {
  const v = row[key];
  return v instanceof Date ? v.getTime() : Number(v);
};

/** A query that throws, as "<model>.<method>". */
let failOn: string | null = null;

function table(name: string, rows: () => Row[], relations: Relations = {}) {
  const run = (method: string) => {
    if (failOn === `${name}.${method}`) throw new Error('connection reset');
  };
  const shape = (row: Row, args: FindArgs): Row => {
    const pickRelation = (k: string, opts: unknown) => {
      const target = relations[k](row);
      if (opts === true || typeof opts !== 'object' || opts === null) return target;
      const { where, select } = opts as { where?: Where; select?: Record<string, boolean> };
      const narrow = (r: Row) => (select ? Object.fromEntries(Object.keys(select).filter((x) => select[x]).map((x) => [x, r[x]])) : r);
      if (Array.isArray(target)) return target.filter((r) => matches(r, where ?? {})).map(narrow);
      if (target === undefined) return undefined;
      return select ? narrow(target) : target;
    };
    if (args.select) {
      const out: Row = {};
      for (const [k, on] of Object.entries(args.select)) {
        if (!on) continue;
        out[k] = Object.hasOwn(relations, k) ? pickRelation(k, on) : row[k];
      }
      return out;
    }
    const out: Row = { ...row };
    for (const [k, on] of Object.entries(args.include ?? {})) if (on) out[k] = pickRelation(k, on);
    return out;
  };
  return {
    findMany: async (args: FindArgs = {}) => {
      run('findMany');
      const found = rows().filter((r) => matches(r, args.where ?? {}, relations));
      const orderBy = args.orderBy ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) as Array<Record<string, 'asc' | 'desc'>> : [];
      found.sort((a, b) => {
        for (const o of orderBy) {
          const [key, dir] = Object.entries(o)[0];
          const d = sortKey(a, key) - sortKey(b, key);
          if (d !== 0) return dir === 'asc' ? d : -d;
        }
        return 0;
      });
      return found.map((r) => shape(r, args));
    },
    findUnique: async (args: FindArgs & { where: Where }) => {
      run('findUnique');
      const row = rows().find((r) => matches(r, args.where, relations));
      return row ? shape(row, args) : null;
    },
    updateMany: async ({ where, data }: { where: Where; data: Row }) => {
      run('updateMany');
      const found = rows().filter((r) => matches(r, where, relations));
      for (const r of found) Object.assign(r, data, { updatedAt: new RealDate(clock) });
      return { count: found.length };
    },
    createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
      run('createMany');
      let count = 0;
      for (const d of data) {
        const dup = rows().some((r) => r.seriesEventId === d.seriesEventId && same(r.originalStartsAt, d.originalStartsAt));
        if (dup) {
          if (skipDuplicates) continue;
          throw new Error('unique constraint');
        }
        rows().push({
          id: `state-${rows().length + 1}`, doneAt: null, doneByUserId: null, snoozedUntil: null, lastPingedAt: null,
          pingAttempts: 0, pingChatId: null, pingMessageId: null, createdAt: new RealDate(clock), updatedAt: new RealDate(clock), ...d,
        });
        count++;
      }
      return { count };
    },
  };
}

const db = { users: [] as Row[], pairings: [] as Row[], calendars: [] as Row[], events: [] as Row[], instances: [] as Row[], states: [] as Row[] };

const fakePrisma = {
  user: table('user', () => db.users),
  pairing: table('pairing', () => db.pairings),
  nativeCalendar: table('nativeCalendar', () => db.calendars),
  nativeEvent: table('nativeEvent', () => db.events, {
    calendar: (r) => db.calendars.find((c) => c.id === r.calendarId),
    creator: (r) => db.users.find((u) => u.id === r.creatorUserId),
    instances: (r) => db.instances.filter((i) => i.seriesEventId === r.id),
    states: (r) => db.states.filter((s) => s.seriesEventId === r.id),
  }),
  nativeEventInstance: table('nativeEventInstance', () => db.instances),
  nativeReminderState: table('nativeReminderState', () => db.states),
};

// ---- The household ----

const DANA = 1; // Dana, English; milk is for her; Raziel's partner
const RAZIEL = 2; // Raziel, Hebrew; creates milk for Dana
const NOAM = 3; // a stranger
const EX = 4; // was the target of Raziel's reminder; unlinked since
const tg = (id: number) => 1000 + id;
const TIMEZONES: Record<number, string> = { [DANA]: IL, [RAZIEL]: IL, [NOAM]: IL, [EX]: NY };
const CREATED = at('2026-10-01 09:00');
// A cuid is 25 characters; the route checks the shape.
const sid = (name: string) => `c${name.padEnd(24, '0')}`;
const MILK = sid('milk'); // Raziel's one-off for Dana, today 09:00, never pinged
const DAILY = sid('daily'); // Dana's daily 08:00 since Oct 1
const PINGED = sid('pinged'); // Raziel's own, pinged: the state row has the live ping
const GONE = sid('gone'); // deleted
const GONE_CAL = sid('gonecal'); // on a deleted calendar
const MEETING = sid('meeting'); // an event, not a reminder
const OLD = sid('old'); // Raziel's for EX, who is no longer his partner
const YEST = sid('yesterday'); // Dana's one-off from yesterday: a carry-over while open
const FOLLOW = sid('follow'); // a daily cut off after Oct 15 by a "following" edit

function household() {
  const user = (id: number, name: string, extra: Row = {}): Row => ({
    id, name, englishName: name, gender: 'female', calendarSource: 'NATIVE', telegramId: BigInt(tg(id)), language: 'en',
    pairingId: null, suspendedAt: null, unreachableSince: null, location: 'Tel Aviv', googleRefreshToken: null, ...extra,
  });
  db.users = [
    user(DANA, 'Dana', { pairingId: 'pair-1' }),
    user(RAZIEL, 'Raziel', { gender: 'male', language: 'he', pairingId: 'pair-1' }),
    user(NOAM, 'Noam', { gender: 'male' }),
    user(EX, 'Eli', { location: 'New York' }),
  ];
  db.pairings = [{ id: 'pair-1', status: 'ACTIVE', inviterUserId: RAZIEL, inviteeUserId: DANA }];
  const calendar = (id: string, ownerUserId: number, extra: Row = {}): Row => ({
    id, ownerUserId, name: id, color: '#039BE5', labels: ['yours'], personName: null, personEnglishName: null, personGender: null,
    rules: [], privacy: 'PRIVATE', isDeleted: false, createdAt: CREATED, updatedAt: CREATED, ...extra,
  });
  db.calendars = [
    calendar('cal-raz', RAZIEL, { privacy: 'SHARED_VIEWER' }),
    calendar('cal-dana', DANA, { privacy: 'SHARED_EDITOR' }),
    calendar('cal-noam', NOAM),
    calendar('cal-old', RAZIEL, { isDeleted: true }),
  ];
  const series = (id: string, calendarId: string, creatorUserId: number, title: string, startsAt: Date, extra: Row = {}): Row => ({
    id, calendarId, creatorUserId, title, startsAt, endsAt: startsAt, description: null, location: null, allDay: false, timeZone: IL,
    rrule: null, exdates: [], reminderMinutes: null, isDeleted: false, createdAt: CREATED, updatedAt: CREATED,
    kind: 'REMINDER', forUserId: null, armedAt: CREATED, ...extra,
  });
  db.events = [
    series(MILK, 'cal-raz', RAZIEL, 'Buy milk', at('2026-10-19 09:00'), { forUserId: DANA }),
    series(DAILY, 'cal-dana', DANA, 'Pills', at('2026-10-01 08:00'), { rrule: 'FREQ=DAILY', exdates: [at('2026-10-17 08:00')] }),
    series(PINGED, 'cal-raz', RAZIEL, 'Call the plumber', at('2026-10-19 08:30')),
    series(GONE, 'cal-raz', RAZIEL, 'Deleted one', at('2026-10-19 08:00'), { isDeleted: true }),
    series(GONE_CAL, 'cal-old', RAZIEL, 'On a deleted calendar', at('2026-10-19 08:00')),
    series(MEETING, 'cal-raz', RAZIEL, 'Dentist', at('2026-10-19 11:00'), { kind: 'EVENT' }),
    series(OLD, 'cal-raz', RAZIEL, 'Ask the landlord', at('2026-10-19 07:00'), { forUserId: EX }),
    series(YEST, 'cal-dana', DANA, 'Book the vet', at('2026-10-18 17:00')),
    series(FOLLOW, 'cal-dana', DANA, 'Vitamins', at('2026-10-01 07:00'), { rrule: 'FREQ=DAILY;UNTIL=20261015T040000Z' }),
  ];
  const override = (seriesEventId: string, originalStartsAt: Date, extra: Row): Row => ({
    id: `inst-${seriesEventId}-${originalStartsAt.getTime()}`, seriesEventId, originalStartsAt, status: 'OVERRIDE', title: null,
    description: null, location: null, startsAt: null, endsAt: null, allDay: null, createdAt: CREATED, updatedAt: CREATED, ...extra,
  });
  db.instances = [
    // Oct 18's pills moved to 19:30, Oct 16's cancelled.
    override(DAILY, at('2026-10-18 08:00'), { startsAt: at('2026-10-18 19:30'), endsAt: at('2026-10-18 19:30') }),
    override(DAILY, at('2026-10-16 08:00'), { status: 'CANCELLED' }),
  ];
  db.states = [
    {
      id: 'state-plumber', seriesEventId: PINGED, originalStartsAt: at('2026-10-19 08:30'), doneAt: null, doneByUserId: null,
      snoozedUntil: null, lastPingedAt: at('2026-10-19 08:30'), pingAttempts: 1, pingChatId: BigInt(tg(RAZIEL)), pingMessageId: 77,
      createdAt: CREATED, updatedAt: CREATED,
    },
  ];
}

const actor = (id: number) => {
  const row = db.users.find((u) => u.id === id)!;
  return { ...row, telegramId: Number(row.telegramId) } as unknown as UserConfig;
};
const stateFor = (seriesEventId: string, originalStartsAt: Date) =>
  db.states.find((s) => s.seriesEventId === seriesEventId && same(s.originalStartsAt, originalStartsAt));
const statesOf = (seriesEventId: string) => db.states.filter((s) => s.seriesEventId === seriesEventId);

// ---- Fakes at the edges ----

type BotCall = { kind: 'send' | 'edit'; chatId: number; text: string; messageId?: number; silent?: boolean; buttons?: boolean };
let botCalls: BotCall[] = [];
let botFailure: Error | null = null;
const fakeBot = {
  sendMessage: async (chatId: number | string, text: string, options?: { disable_notification?: boolean }) => {
    botCalls.push({ kind: 'send', chatId: Number(chatId), text, silent: options?.disable_notification === true });
    if (botFailure) throw botFailure;
    return { message_id: 900 };
  },
  editMessageText: async (text: string, options: { chat_id?: number | string; message_id?: number; reply_markup?: unknown }) => {
    botCalls.push({ kind: 'edit', chatId: Number(options.chat_id), messageId: options.message_id, text, buttons: options.reply_markup !== undefined });
    if (botFailure) throw botFailure;
    return true;
  },
};
const captured: { ctx: string; extra?: Row; message: string; severity?: string }[] = [];
/** The Google token each timezone lookup was given, in call order. */
const timezoneTokens: (string | undefined)[] = [];
const activity: { userId: number; action: string; meta?: Row }[] = [];

type AuthMode = 'ok' | 'missing' | 'unauthorized' | 'suspended' | 'limited';
let authMode: AuthMode = 'ok';
let authAs = DANA;
const authCalls: { userId: string | null; initData: string | null | undefined; limiter: string; endpoint: string }[] = [];

async function main() {
  const Module = (await import('module')).default as unknown as {
    new (id: string): { filename: string; loaded: boolean; exports: unknown };
    _cache: Record<string, unknown>;
  };
  const stub = (file: string, exports: Record<string, unknown>) => {
    const filename = path.resolve(__dirname, '..', file);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  stub('src/utils/prisma.ts', { prisma: fakePrisma });
  stub('src/utils/redis.ts', { redis: {} });
  const telegram = { getBot: () => fakeBot, getMessagingService: () => ({}) };
  stub('src/services/telegram/bot.ts', telegram);
  stub('src/services/telegram/index.ts', telegram);
  stub('src/lib/timezone.ts', {
    resolveUserTimezone: async (u: { id: number; googleRefreshToken?: string }) => {
      timezoneTokens.push(u.googleRefreshToken);
      return TIMEZONES[u.id] ?? IL;
    },
  });
  stub('src/lib/error-capture.ts', {
    captureError: (e: unknown, ctx: string, extra?: Row, severity?: string) => {
      captured.push({ ctx, extra, severity, message: e instanceof Error ? e.message : String(e) });
    },
    captureWarning: () => {},
    captureInfo: () => {},
  });
  stub('src/services/analytics-service.ts', {
    trackActivityAsync: (userId: number, action: string, meta?: Row) => { activity.push({ userId, action, meta }); },
    setUserContext: () => {},
    addBreadcrumb: () => {},
  });
  stub('src/lib/rate-limit.ts', {
    reminderActionRateLimiter: { name: 'reminderAction' },
    calendarRateLimiter: { name: 'calendar' },
  });
  // The real verifyUserAuth has its own smokes; this one answers as it does, and records what it was asked.
  const { NextResponse } = await import('next/server');
  stub('src/lib/api-auth.ts', {
    verifyUserAuth: async (_req: unknown, userId: string | null, initData: string | null | undefined, limiter: { name: string }, endpoint: string) => {
      authCalls.push({ userId, initData, limiter: limiter.name, endpoint });
      const fail = (error: string, status: number) => ({ success: false, response: NextResponse.json({ error }, { status }) });
      if (!userId || authMode === 'missing') return fail('Missing user_id parameter', 400);
      if (authMode === 'unauthorized') return fail('Unauthorized', 401);
      if (authMode === 'suspended') return fail('Account suspended', 403);
      if (authMode === 'limited') return fail('Too many requests. Please wait a minute.', 429);
      return { success: true, via: 'telegram', user: actor(authAs) };
    },
  });

  const { applyReminderAction } = await import('../src/services/native-reminders/actions');
  const { __resetDueGateForTests, setNextDue, shouldRunPass } = await import('../src/services/native-reminders/due-gate');
  const { isEligible } = await import('../src/services/native-reminders/due');
  const { getBotMessage } = await import('../src/lib/bot-messages');
  const { readFamcal } = await import('../src/services/calendar-read/famcal');
  const { toRangeDays, toCarryOverDto } = await import('../src/services/calendar-read/dto');
  const { carryOverReadItems } = await import('../src/services/calendar-read/famcal');
  const { fetchOpenReminderItems, openRemindersCutoff } = await import('../src/services/native-reminders/open-reminders');
  const route = await import('../app/api/calendar/reminder/route');
  const { localDate } = await import('../src/utils/day-events');

  // Monday 19 Oct 2026, 10:00 in Israel (UTC+3 until Oct 25).
  const NOW = at('2026-10-19 10:00');
  const MIN = 60 * 1000;
  const MILK_KEY = { seriesEventId: MILK, originalStartsAt: at('2026-10-19 09:00') };
  const PILLS_KEY = { seriesEventId: DAILY, originalStartsAt: at('2026-10-19 08:00') };
  const PLUMBER_KEY = { seriesEventId: PINGED, originalStartsAt: at('2026-10-19 08:30') };

  function reset() {
    household();
    botCalls = [];
    botFailure = null;
    captured.length = 0;
    timezoneTokens.length = 0;
    activity.length = 0;
    failOn = null;
    authMode = 'ok';
    authAs = DANA;
    authCalls.length = 0;
    clock = NOW.getTime();
    __resetDueGateForTests();
  }
  const sends = () => botCalls.filter((c) => c.kind === 'send');
  const edits = () => botCalls.filter((c) => c.kind === 'edit');
  const act = (id: number, key: { seriesEventId: string; originalStartsAt: Date }, action: Parameters<typeof applyReminderAction>[2], now = NOW, source: 'ping' | 'app' = 'app') =>
    applyReminderAction(actor(id), key, action, now, source);
  /** The gate is open when it was cleared since the last setNextDue. */
  const closeGate = () => setNextDue(new RealDate(NOW.getTime() + 50 * MIN), NOW);
  const gateOpen = () => shouldRunPass(new RealDate(NOW.getTime() + MIN));

  // ---- Who acts ----

  await check('who: the person it is for marks it done; the row is made (never pinged), the creator is told once, analytics say app', async () => {
    reset();
    const r = await act(DANA, MILK_KEY, 'done');
    assertJson(r, { status: 'ok', title: 'Buy milk' }, 'result');
    const row = stateFor(MILK, MILK_KEY.originalStartsAt)!;
    assert(!!row && same(row.doneAt, NOW) && row.doneByUserId === DANA, `row ${json(row)}`);
    assert(row.lastPingedAt === null, 'it never pinged, and still has not');
    assertJson(activity, [{ userId: DANA, action: 'native_reminder_done', meta: { series_event_id: MILK, source: 'app' } }], 'analytics');
    assert(sends().length === 1 && sends()[0].chatId === tg(RAZIEL) && sends()[0].silent === true, `notice ${json(botCalls)}`);
    assert(sends()[0].text.includes('Dana') && sends()[0].text.includes('Buy milk'), sends()[0].text);
    assert(edits().length === 0, 'no live ping, so no edit');
  });

  await check('who: the creator marks it done: no notice to themselves', async () => {
    reset();
    const r = await act(RAZIEL, MILK_KEY, 'done');
    assert(r.status === 'ok', json(r));
    assert(stateFor(MILK, MILK_KEY.originalStartsAt)?.doneByUserId === RAZIEL, 'doneBy');
    assert(sends().length === 0, json(botCalls));
  });

  await check('who: a stranger gets not_yours and nothing is written', async () => {
    reset();
    const r = await act(NOAM, MILK_KEY, 'done');
    assertJson(r, { status: 'not_yours', wasTarget: false }, 'result');
    assert(statesOf(MILK).length === 0 && activity.length === 0 && botCalls.length === 0, 'side effects');
    for (const action of ['undo', 'snooze15', 'snooze60', 'snoozeTomorrow'] as const) {
      assert((await act(NOAM, MILK_KEY, action)).status === 'not_yours', action);
    }
    assert(statesOf(MILK).length === 0, 'still nothing written');
  });

  await check('who: an ex-partner who was the target gets not_yours with wasTarget, nothing written', async () => {
    reset();
    const key = { seriesEventId: OLD, originalStartsAt: at('2026-10-19 07:00') };
    assertJson(await act(EX, key, 'done'), { status: 'not_yours', wasTarget: true }, 'result');
    assert(statesOf(OLD).length === 0, 'nothing written');
    assert((await act(RAZIEL, key, 'done')).status === 'ok', 'the creator can, it is theirs again');
  });

  await check('who: the person it is for loses it when the pair unlinks, the creator keeps it', async () => {
    reset();
    db.pairings[0].status = 'ENDED';
    assertJson(await act(DANA, MILK_KEY, 'snooze15'), { status: 'not_yours', wasTarget: true }, 'Dana');
    assert((await act(RAZIEL, MILK_KEY, 'snooze15')).status === 'ok', 'Raziel');
  });

  // ---- Which occurrences are live ----

  await check('live: one-off, recurring, moved (by its original key), exdated, cancelled, cut off, deleted series, deleted calendar, an event, no such series', async () => {
    reset();
    const answer = async (seriesEventId: string, originalStartsAt: Date, id = RAZIEL) => (await act(id, { seriesEventId, originalStartsAt }, 'done')).status;
    assert(await answer(MILK, at('2026-10-19 09:00')) === 'ok', 'one-off');
    assert(await answer(DAILY, at('2026-10-19 08:00'), DANA) === 'ok', 'recurring');
    assert(await answer(DAILY, at('2026-10-18 08:00'), DANA) === 'ok', 'moved: its original key');
    assert(await answer(DAILY, at('2026-10-18 19:30'), DANA) === 'changed', 'moved: its new time is not a key');
    assert(await answer(DAILY, at('2026-10-17 08:00'), DANA) === 'changed', 'exdated');
    assert(await answer(DAILY, at('2026-10-16 08:00'), DANA) === 'changed', 'cancelled');
    assert(await answer(DAILY, at('2026-10-19 08:01'), DANA) === 'changed', 'not an occurrence');
    assert(await answer(FOLLOW, at('2026-10-19 07:00'), DANA) === 'changed', 'cut off by a following edit');
    assert(await answer(GONE, at('2026-10-19 08:00')) === 'changed', 'deleted series');
    assert(await answer(GONE_CAL, at('2026-10-19 08:00')) === 'changed', 'deleted calendar');
    assert(await answer(MEETING, at('2026-10-19 11:00')) === 'changed', 'an event');
    assert(await answer(sid('nosuch'), at('2026-10-19 08:00')) === 'changed', 'no such series');
    for (const id of [GONE, GONE_CAL, MEETING, sid('nosuch')]) assert(statesOf(id).length === 0, `${id} got a row`);
    assert(statesOf(FOLLOW).length === 0 && !stateFor(DAILY, at('2026-10-17 08:00')), 'rows for dead occurrences');
  });

  await check('live: an override\'s title is the one the notice and the ping carry', async () => {
    reset();
    db.instances.push({
      id: 'ov-t', seriesEventId: MILK, originalStartsAt: at('2026-10-19 09:00'), status: 'OVERRIDE', title: 'Buy oat milk', description: null,
      location: null, startsAt: null, endsAt: null, allDay: null, createdAt: CREATED, updatedAt: CREATED,
    });
    const r = await act(DANA, MILK_KEY, 'done');
    assert(r.status === 'ok' && r.title === 'Buy oat milk', json(r));
    assert(sends()[0].text.includes('Buy oat milk'), sends()[0].text);
  });

  // ---- Each action, by state ----

  await check('done: twice is already_done, once in analytics; the notice is not repeated', async () => {
    reset();
    await act(DANA, MILK_KEY, 'done');
    const again = await act(RAZIEL, MILK_KEY, 'done', new RealDate(NOW.getTime() + MIN));
    assertJson(again, { status: 'already_done', title: 'Buy milk' }, 'second');
    const row = stateFor(MILK, MILK_KEY.originalStartsAt)!;
    assert(same(row.doneAt, NOW) && row.doneByUserId === DANA, `first writer keeps it: ${json(row)}`);
    assert(activity.length === 1 && sends().length === 1, `activity ${activity.length}, sends ${sends().length}`);
    assert(statesOf(MILK).length === 1, 'one row');
  });

  await check('undo: reopens a done one, clears the snooze, keeps lastPingedAt, wakes the gate, analytics undone', async () => {
    reset();
    const row = stateFor(PINGED, PLUMBER_KEY.originalStartsAt)!;
    row.doneAt = at('2026-10-19 09:00');
    row.doneByUserId = RAZIEL;
    row.snoozedUntil = at('2026-10-19 12:00');
    closeGate();
    assert(!gateOpen(), 'the gate starts closed');
    const r = await act(RAZIEL, PLUMBER_KEY, 'undo');
    assertJson(r, { status: 'ok', title: 'Call the plumber' }, 'result');
    assert(row.doneAt === null && row.doneByUserId === null && row.snoozedUntil === null, json(row));
    assertJson(row.lastPingedAt, at('2026-10-19 08:30'), 'lastPingedAt');
    assert(row.pingMessageId === 77, 'the ping message stays');
    assert(gateOpen(), 'the gate is open');
    assertJson(activity, [{ userId: RAZIEL, action: 'native_reminder_undone', meta: { series_event_id: PINGED, source: 'app' } }], 'analytics');
    assert(edits().length === 0, 'undo leaves the ping as it is');
  });

  await check('undo: of a not-done one is not_done, with no write, no analytics, and no row made', async () => {
    reset();
    assertJson(await act(DANA, MILK_KEY, 'undo'), { status: 'not_done', title: 'Buy milk' }, 'never pinged');
    assert(statesOf(MILK).length === 0, 'no row');
    assert((await act(RAZIEL, PLUMBER_KEY, 'undo')).status === 'not_done', 'pinged, open');
    assert(activity.length === 0, json(activity));
    closeGate();
    await act(RAZIEL, PLUMBER_KEY, 'undo');
    assert(!gateOpen(), 'nothing changed, so the gate stays');
  });

  await check('snooze: never pinged makes the row; 15 min, 1 hour, pingAttempts 0, lastPingedAt null, gate woken, analytics', async () => {
    reset();
    closeGate();
    const r = await act(DANA, MILK_KEY, 'snooze15');
    assert(r.status === 'ok' && r.title === 'Buy milk' && r.timeZone === IL, json(r));
    assertJson(r.status === 'ok' ? r.until : null, new RealDate(NOW.getTime() + 15 * MIN), 'until');
    const row = stateFor(MILK, MILK_KEY.originalStartsAt)!;
    assertJson(row.snoozedUntil, new RealDate(NOW.getTime() + 15 * MIN), 'snoozedUntil');
    assert(row.lastPingedAt === null && row.pingAttempts === 0 && row.doneAt === null, json(row));
    assert(gateOpen(), 'gate woken');
    assertJson(activity, [{ userId: DANA, action: 'native_reminder_snoozed', meta: { series_event_id: MILK, snooze: 's15', source: 'app' } }], 'analytics');
    assert(sends().length === 0, 'a snooze tells nobody');
    await act(DANA, MILK_KEY, 'snooze60');
    assertJson(row.snoozedUntil, new RealDate(NOW.getTime() + 60 * MIN), 'a second snooze replaces the first');
    assert(statesOf(MILK).length === 1, 'one row');
  });

  await check('snooze: a pinged one keeps lastPingedAt and gets its retry budget back', async () => {
    reset();
    const row = stateFor(PINGED, PLUMBER_KEY.originalStartsAt)!;
    row.pingAttempts = 3;
    await act(RAZIEL, PLUMBER_KEY, 'snooze60');
    assert(row.pingAttempts === 0, `attempts ${row.pingAttempts}`);
    assertJson(row.lastPingedAt, at('2026-10-19 08:30'), 'lastPingedAt');
  });

  await check('snooze: after done is already_done and writes nothing', async () => {
    reset();
    await act(DANA, MILK_KEY, 'done');
    activity.length = 0;
    closeGate();
    for (const action of ['snooze15', 'snooze60', 'snoozeTomorrow'] as const) {
      assertJson(await act(DANA, MILK_KEY, action), { status: 'already_done', title: 'Buy milk' }, action);
    }
    assert(stateFor(MILK, MILK_KEY.originalStartsAt)!.snoozedUntil === null, 'no snooze written');
    assert(activity.length === 0 && !gateOpen(), 'no analytics, gate untouched');
  });

  await check('done: after a snooze is fine, and a snoozed-then-done one never pings (not eligible)', async () => {
    reset();
    await act(DANA, MILK_KEY, 'snooze15');
    assert((await act(DANA, MILK_KEY, 'done', new RealDate(NOW.getTime() + 5 * MIN))).status === 'ok', 'done');
    const row = stateFor(MILK, MILK_KEY.originalStartsAt)!;
    assert(!isEligible({ due: row.snoozedUntil as Date, now: row.snoozedUntil as Date, armedAt: null, snoozed: true, lastPingedAt: null, doneAt: row.doneAt as Date }), 'eligible');
  });

  await check('snoozeTomorrow: 09:00 tomorrow on the actor\'s clock; before 04:00 it is this morning', async () => {
    reset();
    const r1 = await act(DANA, MILK_KEY, 'snoozeTomorrow', at('2026-10-19 10:00'));
    assertJson(r1.status === 'ok' ? r1.until : null, at('2026-10-20 09:00'), '10:00');
    const r2 = await act(DANA, MILK_KEY, 'snoozeTomorrow', at('2026-10-19 03:59'));
    assertJson(r2.status === 'ok' ? r2.until : null, at('2026-10-19 09:00'), '03:59');
    const r3 = await act(DANA, MILK_KEY, 'snoozeTomorrow', at('2026-10-19 04:00'));
    assertJson(r3.status === 'ok' ? r3.until : null, at('2026-10-20 09:00'), '04:00');
    // The clocks go back in Israel on Oct 25: 09:00 stays 09:00 local.
    const r4 = await act(DANA, MILK_KEY, 'snoozeTomorrow', at('2026-10-24 12:00'));
    assertJson(r4.status === 'ok' ? r4.until : null, at('2026-10-25 09:00'), 'across the change');
    assert(new RealDate(at('2026-10-25 09:00')).toISOString() === '2026-10-25T07:00:00.000Z', 'winter time');
    // Tapped in New York, the same moment: 09:00 where the actor is.
    const r5 = await act(EX, { seriesEventId: OLD, originalStartsAt: at('2026-10-19 07:00') }, 'snoozeTomorrow', at('2026-10-19 10:00', NY));
    assert(r5.status === 'not_yours', 'EX is not allowed (and writes nothing)');
    db.events.find((e) => e.id === OLD)!.creatorUserId = EX;
    const r6 = await act(EX, { seriesEventId: OLD, originalStartsAt: at('2026-10-19 07:00') }, 'snoozeTomorrow', at('2026-10-19 10:00', NY));
    assertJson(r6.status === 'ok' ? r6.until : null, at('2026-10-20 09:00', NY), 'New York');
  });

  // ---- The live ping ----

  await check('ping: an in-app done edits it to "✅ title", buttons gone; snooze to "💤 title · until HH:mm"; undo leaves it', async () => {
    reset();
    await act(RAZIEL, PLUMBER_KEY, 'done');
    assert(edits().length === 1, json(botCalls));
    assertJson(edits()[0], { kind: 'edit', chatId: tg(RAZIEL), messageId: 77, text: '✅ Call the plumber', buttons: false }, 'done edit');
    botCalls = [];
    await act(RAZIEL, PLUMBER_KEY, 'undo');
    assert(botCalls.length === 0, 'undo edits nothing');
    await act(RAZIEL, PLUMBER_KEY, 'snooze15');
    // Raziel's language is Hebrew: the edit follows the actor's.
    const want = await getBotMessage('he', 'nativeReminders.snoozedUntil', { title: 'Call the plumber', time: '10:15' });
    assert(want.includes('10:15'), want);
    assertJson(edits(), [{ kind: 'edit', chatId: tg(RAZIEL), messageId: 77, text: want, buttons: false }], 'snooze edit');
  });

  await check('ping: the edit is in the ping recipient\'s language and clock, not the actor\'s (Raziel acts on Dana\'s ping)', async () => {
    reset();
    db.states.push({
      id: 'state-milk', seriesEventId: MILK, originalStartsAt: MILK_KEY.originalStartsAt, doneAt: null, doneByUserId: null,
      snoozedUntil: null, lastPingedAt: NOW, pingAttempts: 1, pingChatId: BigInt(tg(DANA)), pingMessageId: 55,
      createdAt: CREATED, updatedAt: CREATED,
    });
    TIMEZONES[DANA] = NY;
    try {
      await act(RAZIEL, MILK_KEY, 'snooze15');
    } finally {
      TIMEZONES[DANA] = IL;
    }
    // Dana is English and in New York: 10:15 in Israel is 03:15 there.
    const want = await getBotMessage('en', 'nativeReminders.snoozedUntil', { title: 'Buy milk', time: '03:15' });
    assertJson(edits(), [{ kind: 'edit', chatId: tg(DANA), messageId: 55, text: want, buttons: false }], 'snooze edit');
    botCalls = [];
    await act(RAZIEL, MILK_KEY, 'done');
    const done = await getBotMessage('en', 'nativeReminders.done', { title: 'Buy milk' });
    assertJson(edits(), [{ kind: 'edit', chatId: tg(DANA), messageId: 55, text: done, buttons: false }], 'done edit');
  });

  await check('ping: the edit\'s timezone lookup gets the owner\'s Google token decrypted, never the stored ciphertext (secret rotation §a)', async () => {
    reset();
    const { encrypt } = await import('../src/utils/encryption');
    db.users.find((u) => u.id === RAZIEL)!.googleRefreshToken = encrypt('raz-google-token');
    // The actor comes decrypted, as convertPrismaUserToConfig gives it; the edit reads the owner's row itself.
    const r = await applyReminderAction({ ...actor(RAZIEL), googleRefreshToken: 'raz-google-token' }, PLUMBER_KEY, 'snooze15', NOW, 'app');
    assert(r.status === 'ok', json(r));
    assert(edits().length === 1, json(botCalls));
    assertJson(timezoneTokens, ['raz-google-token', 'raz-google-token'], 'the tokens the timezone lookups got');
  });

  await check('ping: the edit is Telegram\'s to fail: the action still succeeds, answered ok, a warning is captured', async () => {
    reset();
    botFailure = new Error('ETELEGRAM: 400 Bad Request: message can\'t be edited');
    const r = await act(RAZIEL, PLUMBER_KEY, 'done');
    assert(r.status === 'ok', json(r));
    assert(stateFor(PINGED, PLUMBER_KEY.originalStartsAt)!.doneAt !== null, 'written');
    assert(captured.some((c) => c.severity === 'warning'), json(captured));
    reset();
    botFailure = new Error('ETELEGRAM: 400 Bad Request: message is not modified');
    assert((await act(RAZIEL, PLUMBER_KEY, 'snooze15')).status === 'ok', 'not modified');
    assert(captured.length === 0, `"not modified" is not an error: ${json(captured)}`);
  });

  await check('ping: from a ping button (source ping) the service does not edit; the callback edits the tapped message', async () => {
    reset();
    await act(RAZIEL, PLUMBER_KEY, 'done', NOW, 'ping');
    assert(edits().length === 0, json(botCalls));
    assert(activity[0].meta?.source === 'ping', json(activity));
  });

  await check('ping: an already_done in-app action edits nothing', async () => {
    reset();
    await act(RAZIEL, PLUMBER_KEY, 'done');
    botCalls = [];
    assert((await act(RAZIEL, PLUMBER_KEY, 'done')).status === 'already_done', 'again');
    assert(botCalls.length === 0, json(botCalls));
  });

  await check('notice: a creator who is suspended, unreachable or has no Telegram is not messaged; a failed send does not fail the action', async () => {
    for (const patch of [{ suspendedAt: NOW }, { unreachableSince: NOW }, { telegramId: null }]) {
      reset();
      Object.assign(db.users.find((u) => u.id === RAZIEL)!, patch);
      assert((await act(DANA, MILK_KEY, 'done')).status === 'ok', json(patch));
      assert(sends().length === 0, `${json(patch)}: ${json(botCalls)}`);
    }
    reset();
    botFailure = new Error('ETELEGRAM: 502 Bad Gateway');
    assert((await act(DANA, MILK_KEY, 'done')).status === 'ok', 'a failed send');
    assert(captured.some((c) => c.ctx === 'native-reminder-done-notice'), json(captured));
  });

  await check('database errors surface to the caller (the route answers 500)', async () => {
    reset();
    failOn = 'nativeReminderState.updateMany';
    let threw = false;
    try { await act(DANA, MILK_KEY, 'done'); } catch { threw = true; }
    assert(threw, 'did not throw');
  });

  // ---- A snoozed, never-pinged occurrence is due at snoozedUntil ----

  await check('pass: the snooze row of a never-pinged occurrence is eligible at snoozedUntil and not before (the pass itself: smoke-native-reminders)', async () => {
    reset();
    await act(DANA, MILK_KEY, 'snooze60');
    const row = stateFor(MILK, MILK_KEY.originalStartsAt)!;
    const until = row.snoozedUntil as Date;
    const eligible = (now: Date) =>
      isEligible({ due: until, now, armedAt: CREATED, snoozed: true, lastPingedAt: row.lastPingedAt as Date | null, doneAt: row.doneAt as Date | null });
    assert(!eligible(new RealDate(until.getTime() - 1)), 'before');
    assert(eligible(until), 'at snoozedUntil');
  });

  // ---- The route ----

  const call = async (body: unknown, headers: Record<string, string> = {}, rawBody?: string) => {
    const req = new NextRequest('http://localhost/api/calendar/reminder', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: rawBody ?? JSON.stringify(body),
    });
    const res = await route.POST(req);
    const text = await res.clone().text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any = {};
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text, res };
  };
  const good = (extra: Row = {}) => ({
    user_id: String(tg(DANA)), seriesId: MILK, originalStart: MILK_KEY.originalStartsAt.toISOString(), action: 'done', ...extra,
  });
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  Object.assign(console, { log: () => {}, warn: () => {}, error: () => {} });

  await check('route: done answers { status: "ok", reminder } and is private, no-store; the limiter is the new one', async () => {
    reset();
    const r = await call(good());
    assert(r.status === 200 && r.body.status === 'ok', `${r.status} ${r.text}`);
    assert(r.res.headers.get('cache-control') === 'private, no-store', String(r.res.headers.get('cache-control')));
    assert(r.body.reminder?.done === true && r.body.reminder.open === false && typeof r.body.reminder.doneAt === 'string', r.text);
    assertJson(authCalls, [{ userId: String(tg(DANA)), initData: undefined, limiter: 'reminderAction', endpoint: 'calendar-reminder' }], 'auth call');
    assert(stateFor(MILK, MILK_KEY.originalStartsAt)?.doneByUserId === DANA, 'written for the authenticated user');
  });

  await check('route: init data comes from the header, else the body, and a numeric user_id is accepted', async () => {
    reset();
    await call(good(), { 'x-telegram-init-data': 'from-header' });
    await call(good({ initData: 'from-body' }));
    await call(good({ initData: 'ignored', user_id: tg(DANA) }), { 'x-telegram-init-data': 'from-header' });
    assertJson(authCalls.map((c) => [c.userId, c.initData]), [
      [String(tg(DANA)), 'from-header'], [String(tg(DANA)), 'from-body'], [String(tg(DANA)), 'from-header'],
    ], 'auth calls');
  });

  await check('route: auth failures pass through (400, 401, 403, 429), no-store, and nothing is written', async () => {
    reset();
    for (const [mode, status] of [['missing', 400], ['unauthorized', 401], ['suspended', 403], ['limited', 429]] as const) {
      authMode = mode;
      const r = await call(good());
      assert(r.status === status, `${mode}: ${r.status}`);
      assert(r.res.headers.get('cache-control') === 'private, no-store', `${mode} cache-control`);
    }
    authMode = 'ok';
    assert((await call(good(), {}, JSON.stringify({ seriesId: MILK }))).status === 400, 'no user_id');
    assert(db.states.length === 1, 'nothing written');
  });

  await check('route: validation is strict (400 bad_request, no-store) and runs after auth, before any write', async () => {
    reset();
    const bad: [string, unknown, string?][] = [
      ['seriesId missing', good({ seriesId: undefined })],
      ['seriesId not a string', good({ seriesId: 5 })],
      ['seriesId not cuid-shaped', good({ seriesId: 'native:abc' })],
      ['seriesId with a #', good({ seriesId: `${MILK}#2026-10-19T06:00:00.000Z` })],
      ['originalStart missing', good({ originalStart: undefined })],
      ['originalStart a number', good({ originalStart: MILK_KEY.originalStartsAt.getTime() })],
      ['originalStart a date only', good({ originalStart: '2026-10-19' })],
      ['originalStart with an offset', good({ originalStart: '2026-10-19T09:00:00.000+03:00' })],
      ['originalStart without ms', good({ originalStart: '2026-10-19T06:00:00Z' })],
      ['originalStart that overflows', good({ originalStart: '2026-02-30T06:00:00.000Z' })],
      ['originalStart garbage', good({ originalStart: 'tomorrow' })],
      ['action unknown', good({ action: 'delete' })],
      ['action missing', good({ action: undefined })],
      ['action wrong case', good({ action: 'Done' })],
      ['body an array', [good()]],
      ['body not JSON', null, '{nope'],
    ];
    for (const [label, body, rawBody] of bad) {
      const r = rawBody === undefined && !Array.isArray(body) ? await call(body) : await call(body, {}, rawBody);
      if (label === 'body an array' || label === 'body not JSON') {
        // No user_id to read: the auth stub answers 400 for a missing one, as the real check does.
        assert(r.status === 400, `${label}: ${r.status}`);
        continue;
      }
      assert(r.status === 400 && r.body.error === 'bad_request', `${label}: ${r.status} ${r.text}`);
      assert(r.res.headers.get('cache-control') === 'private, no-store', `${label}: cache-control`);
    }
    assert(db.states.length === 1, 'nothing written');
    authMode = 'unauthorized';
    assert((await call(good({ action: 'delete' }))).status === 401, 'auth first');
  });

  await check('route: every action is accepted', async () => {
    for (const action of ['done', 'undo', 'snooze15', 'snooze60', 'snoozeTomorrow']) {
      reset();
      const r = await call(good({ action }));
      assert(r.status === 200, `${action}: ${r.status} ${r.text}`);
      assert(r.body.status === (action === 'undo' ? 'not_done' : 'ok'), `${action}: ${r.text}`);
    }
  });

  await check('route: it acts for the authenticated user only; user and owner fields in the body change nothing', async () => {
    reset();
    authAs = NOAM; // the stranger, whatever the body says
    const r = await call(good({ user_id: String(tg(DANA)), userId: DANA, forUserId: DANA, actor: DANA, actorId: DANA, creatorUserId: DANA }));
    assertJson(r.body, { status: 'not_yours' }, 'answer');
    assert(r.res.headers.get('cache-control') === 'private, no-store', 'cache-control');
    assert(statesOf(MILK).length === 0 && activity.length === 0 && botCalls.length === 0, 'nothing happened');
    authAs = RAZIEL;
    const mine = await call(good({ user_id: String(tg(DANA)) }));
    assert(mine.body.status === 'ok', mine.text);
    assert(stateFor(MILK, MILK_KEY.originalStartsAt)?.doneByUserId === RAZIEL, 'done by the authenticated user, not the body\'s');
  });

  await check('route: changed, already_done and not_done answers; changed and not_yours carry no reminder', async () => {
    reset();
    const gone = await call(good({ seriesId: GONE, originalStart: at('2026-10-19 08:00').toISOString() }));
    assertJson(gone.body, { status: 'changed' }, 'deleted');
    await call(good());
    const again = await call(good());
    assert(again.body.status === 'already_done' && again.body.reminder?.done === true, again.text);
    const undo = await call(good({ action: 'undo' }));
    assert(undo.body.status === 'ok' && undo.body.reminder?.done === false, undo.text);
    const undoAgain = await call(good({ action: 'undo' }));
    assert(undoAgain.body.status === 'not_done' && undoAgain.body.reminder?.done === false, undoAgain.text);
  });

  await check('route: the reminder is the range route\'s DTO for the same occurrence (open today, snoozed, done, a carry-over, a moved one)', async () => {
    reset();
    const user = actor(DANA);
    const today = localDate(NOW, IL);
    const rangeDto = async (key: string) => {
      const from = at(`${today} 00:00`);
      const to = at('2026-10-20 00:00');
      const { read, items } = await readFamcal(user, { from: new RealDate(from.getTime() - 3 * 86400000), to }, {});
      if (read.status !== 'ok') throw new Error('read failed');
      // An older open reminder is listed twice, on its day (not open there) and in the "Still open"
      // card (open); the card's is the one the home shows as open.
      const open = await fetchOpenReminderItems(user, read.ctx, openRemindersCutoff(today, IL, NOW), today, IL, Infinity);
      const carry = carryOverReadItems(read, open.items).map((i) => toCarryOverDto(i, IL, NOW)).find((i) => i.key === key);
      if (carry) return carry.reminder;
      const days = toRangeDays(items, '2026-10-16', '2026-10-20', IL, NOW, today);
      return days.flatMap((d) => d.items).find((i) => i.key === key)?.reminder;
    };
    const check1 = async (label: string, seriesId: string, original: Date, action: string, key: string) => {
      const r = await call(good({ seriesId, originalStart: original.toISOString(), action }));
      assert(r.status === 200, `${label}: ${r.status} ${r.text}`);
      assertJson(r.body.reminder, await rangeDto(key), label);
    };
    await check1('today, still open after a snooze', MILK, MILK_KEY.originalStartsAt, 'snooze60', `famcal|${MILK}`);
    await check1('today, done', MILK, MILK_KEY.originalStartsAt, 'done', `famcal|${MILK}`);
    await check1('today, reopened', MILK, MILK_KEY.originalStartsAt, 'undo', `famcal|${MILK}`);
    const pills = `famcal|${DAILY}#${PILLS_KEY.originalStartsAt.toISOString()}`;
    await check1('a recurring occurrence, done', DAILY, PILLS_KEY.originalStartsAt, 'done', pills);
    // A one-off from yesterday is a carry-over while it is open: the card's DTO, openSince and all.
    const yest = `famcal|${YEST}`;
    const YEST_AT = at('2026-10-18 17:00');
    await check1('a carry-over, snoozed (still open)', YEST, YEST_AT, 'snooze60', yest);
    await check1('a carry-over, done (leaves the card)', YEST, YEST_AT, 'done', yest);
    await check1('a carry-over, reopened', YEST, YEST_AT, 'undo', yest);
    const reopened = await call(good({ seriesId: YEST, originalStart: YEST_AT.toISOString(), action: 'undo' }));
    assert(reopened.body.reminder?.open === true && reopened.body.reminder.openSince === '2026-10-18', reopened.text);
    // A daily's moved occurrence from yesterday is listed on its day, not in the card (today has its own).
    const moved = await call(good({ seriesId: DAILY, originalStart: at('2026-10-18 08:00').toISOString(), action: 'done' }));
    assert(moved.body.reminder?.done === true && moved.body.reminder.open === false, moved.text);
  });

  await check('route: a failure is 500 internal_error, no-store, and the captured context holds the user id and no title', async () => {
    reset();
    failOn = 'nativeReminderState.updateMany';
    const r = await call(good());
    assert(r.status === 500 && r.body.error === 'internal_error', `${r.status} ${r.text}`);
    assert(r.res.headers.get('cache-control') === 'private, no-store', 'cache-control');
    const c = captured.find((x) => x.ctx === 'calendar-reminder');
    assert(!!c, json(captured));
    assertJson(c.extra, { user_id: DANA }, 'context');
    assert(!json(captured).includes('Buy milk'), 'a title leaked');
  });

  await check('route: a failed DTO read still answers the action (status ok, no reminder), the failure captured as a warning', async () => {
    reset();
    failOn = 'nativeCalendar.findMany';
    const r = await call(good());
    assert(r.status === 200 && r.body.status === 'ok' && !('reminder' in r.body), `${r.status} ${r.text}`);
    assert(stateFor(MILK, MILK_KEY.originalStartsAt)?.doneAt !== null, 'written');
  });

  Object.assign(console, quiet);
  for (const r of results) console.log(`${r.ok ? 'OK ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

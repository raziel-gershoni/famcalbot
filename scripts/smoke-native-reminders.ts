// Smoke test for the native reminder pass: src/services/native-reminders/due.ts,
// claim.ts, ping.ts and pass.ts, and the 1-minute cron handler handleNativeReminders.
// A reminder pings the person it is for at its time (a date-only one at 09:00 where
// they are), once, through an atomic claim two overlapping passes can't both win, with
// ✅ Done / 💤 Snooze buttons that carry the claimed state row. A failed send is given
// back for a later pass only when the failure may pass, and the cron reads the database
// only when its gate says something may be due.
//
// Prisma (with the claim's ON CONFLICT upsert), Telegram, the timezone lookup, the
// moderation checks and the admin switch are faked; the clock is stepped by hand. No
// network, no DB.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-reminders.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminders.ts

import Module from 'node:module';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fromZonedTime } from 'date-fns-tz';
import { startOfLocalDay } from '../src/utils/day-events';
import en from '../messages/en.json';
import he from '../messages/he.json';

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

// Not `asserts cond`: a check re-reads counters and rows that change between asserts,
// and a narrowed `sent.length === 0` would make the next `=== 1` a type error.
function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

/** JSON that can show a BigInt telegramId. */
const show = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v));

function assertSame(got: unknown, want: unknown) {
  assert(show(got) === show(want), `\n     got  ${show(got)}\n     want ${show(want)}`);
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

const ms = (value: unknown) => (value instanceof RealDate ? value.getTime() : value);

function assertTime(got: Date | null | undefined, want: Date, label = 'time') {
  assert(!!got && got.getTime() === want.getTime(), `${label}: got ${got ? got.toISOString() : got}, want ${want.toISOString()}`);
}

// ---- Fake Prisma ----

type Row = Record<string, unknown>;
const db = { users: [] as Row[], pairings: [] as Row[], calendars: [] as Row[], events: [] as Row[], instances: [] as Row[], states: [] as Row[] };
/** Every Prisma call, as "<model>.<method>", to see when a pass read the database. */
const queries: string[] = [];
/** Thrown by the next nativeEvent.findMany: the database going away. */
let failNextFind: Error | null = null;
/** Awaited by the next nativeEvent.findMany: a slow pass. */
let holdFind: Promise<void> | null = null;
/** Thrown by the next claim: a database blip in the middle of a pass. */
let failNextClaim: Error | null = null;

// The filters the pass and the claim use: equality, null, in, not, ranges, OR, the
// event's calendar relation, and `some` over its instances.
const relations: Record<string, (row: Row) => Row | undefined> = {
  calendar: (row) => db.calendars.find((c) => c.id === row.calendarId),
};
const listRelations: Record<string, (row: Row) => Row[]> = {
  instances: (row) => db.instances.filter((i) => i.seriesEventId === row.id),
};

function fieldMatches(value: unknown, cond: unknown): boolean {
  if (cond === null) return value == null;
  if (cond instanceof RealDate || typeof cond !== 'object') return ms(value) === ms(cond);
  return Object.entries(cond as Row).every(([op, arg]) => {
    switch (op) {
      case 'in': return (arg as unknown[]).some((a) => ms(a) === ms(value));
      case 'not': return arg === null ? value != null : ms(value) !== ms(arg);
      case 'gte': return value != null && (ms(value) as number) >= (ms(arg) as number);
      case 'gt': return value != null && (ms(value) as number) > (ms(arg) as number);
      case 'lt': return value != null && (ms(value) as number) < (ms(arg) as number);
      case 'lte': return value != null && (ms(value) as number) <= (ms(arg) as number);
      default: throw new Error(`fake prisma: no operator ${op}`);
    }
  });
}

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (key in relations) {
      const related = relations[key](row);
      return !!related && matches(related, cond as Row);
    }
    if (key in listRelations) {
      const { some, ...rest } = cond as { some?: Row };
      if (!some || Object.keys(rest).length > 0) throw new Error(`fake prisma: only '${key}: { some }'`);
      return listRelations[key](row).some((r) => matches(r, some));
    }
    return fieldMatches(row[key], cond);
  });
}

/** Prisma returns only the selected columns, so a column the code forgets to select is missing. */
const pick = (row: Row | undefined, select?: Record<string, boolean>) =>
  !row ? null : !select ? { ...row } : Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));

type Args = { where?: Row; select?: Record<string, boolean>; data?: Row };
const fakePrisma = {
  user: {
    findUnique: async ({ where, select }: Args) => {
      queries.push('user.findUnique');
      return pick(db.users.find((u) => u.id === where!.id), select);
    },
  },
  pairing: {
    findUnique: async ({ where, select }: Args) => {
      queries.push('pairing.findUnique');
      return pick(db.pairings.find((p) => p.id === where!.id), select);
    },
  },
  nativeEvent: {
    // The pass re-reads a series after its claim (3b spec §3.1).
    findUnique: async ({ where, select }: Args) => {
      queries.push('nativeEvent.findUnique');
      return pick(db.events.find((e) => e.id === where!.id), select);
    },
    findMany: async ({ where }: Args) => {
      queries.push('nativeEvent.findMany');
      if (holdFind) {
        const hold = holdFind;
        holdFind = null;
        await hold;
      }
      if (failNextFind) {
        const error = failNextFind;
        failNextFind = null;
        throw error;
      }
      return db.events.filter((e) => matches(e, where)).map((e) => ({ ...e }));
    },
  },
  nativeEventInstance: {
    findMany: async ({ where }: Args) => {
      queries.push('nativeEventInstance.findMany');
      return db.instances.filter((i) => matches(i, where)).map((i) => ({ ...i }));
    },
  },
  nativeReminderState: {
    findMany: async ({ where, select }: Args) => {
      queries.push('nativeReminderState.findMany');
      return db.states.filter((s) => matches(s, where)).map((s) => pick(s, select));
    },
    findUnique: async ({ where, select }: Args) => {
      queries.push('nativeReminderState.findUnique');
      const key = where!.seriesEventId_originalStartsAt as Row;
      return pick(db.states.find((s) => s.seriesEventId === key.seriesEventId && ms(s.originalStartsAt) === ms(key.originalStartsAt)), select);
    },
    update: async ({ where, data }: Args) => {
      queries.push('nativeReminderState.update');
      const row = db.states.find((s) => s.id === where!.id);
      if (!row) throw new Error('fake prisma: P2025 record not found');
      return Object.assign(row, data);
    },
    updateMany: async ({ where, data }: Args) => {
      queries.push('nativeReminderState.updateMany');
      const rows = db.states.filter((s) => matches(s, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
  },
  // The claim: INSERT … ON CONFLICT (seriesEventId, originalStartsAt) DO UPDATE … WHERE
  // not done and not yet pinged for this due … RETURNING. One call is atomic here, as
  // one statement is in Postgres.
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push('$queryRaw');
    if (failNextClaim) {
      const error = failNextClaim;
      failNextClaim = null;
      throw error;
    }
    const sql = strings.join('$');
    assert(
      /INSERT INTO "NativeReminderState"[\s\S]*ON CONFLICT \("seriesEventId", "originalStartsAt"\) DO UPDATE[\s\S]*"doneAt" IS NULL[\s\S]*RETURNING/.test(sql),
      `unexpected claim SQL: ${sql}`
    );
    assert(sql.split("::timestamptz AT TIME ZONE 'UTC'").length === 5, 'every timestamp should be read as UTC');
    const [id, seriesEventId, occurrence, at] = values as string[];
    const due = new RealDate(values[values.length - 1] as string).getTime();
    const originalStartsAt = new RealDate(occurrence);
    const lastPingedAt = new RealDate(at);
    const row = db.states.find((s) => s.seriesEventId === seriesEventId && ms(s.originalStartsAt) === originalStartsAt.getTime());
    if (!row) {
      db.states.push({
        id, seriesEventId, originalStartsAt, doneAt: null, doneByUserId: null, snoozedUntil: null,
        lastPingedAt, pingAttempts: 1, pingChatId: null, pingMessageId: null,
      });
      return [{ id, lastPingedAt, pingAttempts: 1 }];
    }
    if (row.doneAt || (row.lastPingedAt && (ms(row.lastPingedAt) as number) >= due)) return [];
    Object.assign(row, { lastPingedAt, pingAttempts: (row.pingAttempts as number) + 1 });
    return [{ id: row.id, lastPingedAt, pingAttempts: row.pingAttempts }];
  },
};

// ---- Fake Telegram ----

type Keyboard = { inline_keyboard: { text: string; callback_data: string }[][] };
type Sent = { at: number; chatId: string; text: string; parseMode?: string; keyboard: Keyboard; messageId: number };
let sent: Sent[] = [];
/** Thrown by the next sends, in order. */
let sendFailures: unknown[] = [];
let sendCalls = 0;
let edits: { text: string; options: Row }[] = [];
let editFailure: unknown = null;
let nextMessageId = 100;
/** Runs inside the next send, as an action landing while the ping is on its way. */
let duringSend: (() => void) | null = null;
const fakeBot = {
  sendMessage: async (chatId: string, text: string, options: { parse_mode?: string; reply_markup: Keyboard }) => {
    sendCalls++;
    if (sendFailures.length) throw sendFailures.shift();
    const messageId = nextMessageId++;
    duringSend?.();
    duringSend = null;
    sent.push({ at: clock, chatId: String(chatId), text, parseMode: options.parse_mode, keyboard: options.reply_markup, messageId });
    return { message_id: messageId };
  },
  editMessageText: async (text: string, options: Row) => {
    if (editFailure) {
      const error = editFailure;
      editFailure = null;
      throw error;
    }
    edits.push({ text, options });
    return true;
  },
};

/** An error as node-telegram-bot-api throws it for an API refusal. */
const telegramError = (status: number, description: string) =>
  Object.assign(new Error(`ETELEGRAM: ${status} ${description}`), {
    code: 'ETELEGRAM',
    response: { statusCode: status, body: { ok: false, error_code: status, description } },
  });
/** No answer at all. */
const networkError = () => Object.assign(new Error('EFATAL: Error: socket hang up'), { code: 'EFATAL' });

// ---- The rest of the world ----

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const MSK = 'Europe/Moscow';
const MIN = 60_000;
const HOUR = 60 * MIN;

let timezones: Record<number, string> = {};
let tracked: { userId: number; action: string; meta: Row }[] = [];
let captured: { context: string; severity: string }[] = [];
let unreachable: number[] = [];
const adminNotices: string[] = [];
let blockedTelegramIds = new Set<string>();
let flagOn = true;
let noAccess = new Set<number>();

const SRC = path.resolve(__dirname, '../src');

/** Modules replaced by fakes, by package name or file path. */
const stubs: Record<string, object> = {
  [`${SRC}/utils/prisma.ts`]: { prisma: fakePrisma },
  [`${SRC}/utils/redis.ts`]: { redis: {} },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (_error: unknown, context: string, _extra?: unknown, severity = 'error') => captured.push({ context, severity }),
    captureWarning: () => {},
    captureInfo: () => {},
  },
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async (user: { id: number }) => timezones[user.id] ?? IL },
  [`${SRC}/lib/user-moderation.ts`]: {
    isIdentifierBlocked: async ({ telegramId }: { telegramId?: bigint | null }) => blockedTelegramIds.has(String(telegramId)),
  },
  [`${SRC}/lib/user-reachability.ts`]: {
    // The real helper's rule: a Telegram 403 flags the user.
    markUnreachableAfterSendFailure: async (user: { id: number }, error: unknown) => {
      const flagged = !!error && (error as { response?: { statusCode?: number; body?: { description?: string } } }).response?.statusCode === 403
        && /blocked/.test((error as { response: { body: { description: string } } }).response.body.description);
      if (flagged) unreachable.push(user.id);
      return flagged;
    },
  },
  [`${SRC}/services/telegram/index.ts`]: { getBot: () => fakeBot },
  [`${SRC}/services/analytics-service.ts`]: {
    trackActivityAsync: (userId: number, action: string, meta: Row = {}) => tracked.push({ userId, action, meta }),
  },
  [`${SRC}/services/native-reminders/support.ts`]: {
    isNativeRemindersEnabled: async () => flagOn,
    getReminderSupport: async (user: { id: number }) =>
      noAccess.has(user.id) ? { supported: false, reason: 'no_access' } : { supported: true },
  },
  [`${SRC}/utils/error-notifier.ts`]: {
    notifyAdminError: async (_context: string, _error: unknown, info?: string) => { adminNotices.push(info ?? ''); },
  },
};

// Static imports compile to require() and pass through Module._load.
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

// handlers.ts loads its services with import(), which may go through the ES module
// loader instead; a stubbed file gets the same fake, served as an ES module.
(globalThis as { smokeStubs?: typeof stubs }).smokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url) : '';
    const stub = stubs[file];
    if (!stub) return nextLoad(url, context);
    const names = Object.keys(stub).map((name) => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.smokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

// ---- Scenario helpers ----

const at = (local: string, tz = IL) => fromZonedTime(local, tz);
const today = (hhmm: string, tz = IL) => at(`2026-10-15 ${hhmm}`, tz);

/** Raziel (he) and Dana (en) are paired on the built-in calendar; Noa (ru) is on her own. */
function reset() {
  db.users = [
    { id: 1, name: 'רזיאל', englishName: 'Raziel', gender: 'male', language: 'he', telegramId: BigInt(1001), location: 'Tel Aviv', calendarSource: 'NATIVE', pairingId: 'pair-1', suspendedAt: null, unreachableSince: null },
    { id: 2, name: 'Dana', englishName: 'Dana', gender: 'female', language: 'en', telegramId: BigInt(1002), location: 'Tel Aviv', calendarSource: 'NATIVE', pairingId: 'pair-1', suspendedAt: null, unreachableSince: null },
    { id: 3, name: 'Noa', englishName: 'Noa', gender: 'female', language: 'ru', telegramId: BigInt(1003), location: 'Moscow', calendarSource: 'NATIVE', pairingId: null, suspendedAt: null, unreachableSince: null },
  ];
  db.pairings = [{ id: 'pair-1', status: 'ACTIVE', inviterUserId: 1, inviteeUserId: 2 }];
  db.calendars = [
    { id: 'cal-1', ownerUserId: 1, isDeleted: false },
    { id: 'cal-3', ownerUserId: 3, isDeleted: false },
    { id: 'cal-gone', ownerUserId: 1, isDeleted: true },
  ];
  db.events = [];
  db.instances = [];
  db.states = [];
  queries.length = 0;
  sent = [];
  sendFailures = [];
  sendCalls = 0;
  edits = [];
  editFailure = null;
  failNextFind = null;
  holdFind = null;
  failNextClaim = null;
  timezones = { 1: IL, 2: IL, 3: MSK };
  tracked = [];
  captured = [];
  unreachable = [];
  blockedTelegramIds = new Set();
  flagOn = true;
  noAccess = new Set();
}

let seq = 0;
/** A REMINDER row as the store writes it: zero length, by Raziel, armed an hour before its time. */
function reminder(p: Row & { startsAt: Date }): Row {
  const row: Row = {
    id: `rem${++seq}`, calendarId: 'cal-1', creatorUserId: 1, forUserId: null, title: 'Call the plumber',
    description: null, location: null, endsAt: p.startsAt, allDay: false, timeZone: IL, rrule: null, hebrewRule: null, hebrewAnchor: null, exdates: [],
    reminderMinutes: null, kind: 'REMINDER', armedAt: new RealDate(p.startsAt.getTime() - HOUR), isDeleted: false,
    createdAt: new RealDate(p.startsAt.getTime() - HOUR), updatedAt: new RealDate(p.startsAt.getTime() - HOUR),
    ...p,
  };
  db.events.push(row);
  return row;
}

/** A date-only reminder: the start of `day` in the event's timezone, zero length, set the day before. */
function dateOnly(day: string, p: Row = {}, tz = IL): Row {
  const startsAt = startOfLocalDay(day, tz);
  return reminder({ startsAt, allDay: true, timeZone: tz, armedAt: new RealDate(startsAt.getTime() - 12 * HOUR), ...p });
}

function state(p: Row & { seriesEventId: unknown; originalStartsAt: Date }): Row {
  const row: Row = {
    id: `state-${db.states.length + 1}`, doneAt: null, doneByUserId: null, snoozedUntil: null,
    lastPingedAt: null, pingAttempts: 0, pingChatId: null, pingMessageId: null, ...p,
  };
  db.states.push(row);
  return row;
}

const stateOf = (seriesEventId: unknown, originalStartsAt: Date) =>
  db.states.find((s) => s.seriesEventId === seriesEventId && ms(s.originalStartsAt) === originalStartsAt.getTime());

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

const sentLines = () => sent.map((s) => `${s.chatId}: ${s.text.replace(/\n/g, ' / ')}`).join(' | ') || '(nothing)';
const callbacks = (keyboard: Keyboard) => keyboard.inline_keyboard.flat().map((b) => b.callback_data);

async function main() {
  const due = await import('../src/services/native-reminders/due');
  const reminderTimeLib = await import('../src/lib/reminder-time');
  const { buildPingKeyboard, buildPingText, stripPingButtons } = await import('../src/services/native-reminders/ping');
  const { runNativeReminderPass } = await import('../src/services/native-reminders/pass');
  const gate = await import('../src/services/native-reminders/due-gate');
  const { handleNativeReminders } = await import('../src/cron/handlers');
  const copy = { en: en.bot.nativeReminders, he: he.bot.nativeReminders };
  const fromLine = (language: 'en' | 'he', name: string) => copy[language].ping.from.replace('{name}', name);

  const pass = (when: Date) => {
    clock = when.getTime();
    return quiet(() => runNativeReminderPass(when));
  };
  const tick = (when: Date) => {
    clock = when.getTime();
    return quiet(() => handleNativeReminders());
  };

  // ---- Due times ----

  await check('due: a timed reminder is due at its start, wherever the recipient is', () => {
    const occ = { startsAt: today('17:30'), allDay: false, timeZone: IL };
    for (const tz of [IL, NY, MSK]) assertTime(due.dueAtForOccurrence(occ, tz), occ.startsAt, tz);
  });

  await check("due: a date-only reminder is due at 09:00 where the recipient is, on the date it has in the event's timezone", () => {
    assert(reminderTimeLib.DEFAULT_REMINDER_TIME === '09:00', `default ${reminderTimeLib.DEFAULT_REMINDER_TIME}`);
    const occ = { startsAt: startOfLocalDay('2026-10-15', IL), allDay: true, timeZone: IL };
    assertTime(due.dueAtForOccurrence(occ, IL), at('2026-10-15 09:00', IL), 'Israel');
    // Thursday begins in Israel at 17:00 Wednesday in New York; it is still Thursday's reminder.
    assertTime(due.dueAtForOccurrence(occ, NY), at('2026-10-15 09:00', NY), 'New York, 7 hours behind');
    assertTime(due.dueAtForOccurrence(occ, MSK), at('2026-10-15 09:00', MSK), 'Moscow');
    const fromNewYork = { startsAt: startOfLocalDay('2026-10-15', NY), allDay: true, timeZone: NY };
    assertTime(due.dueAtForOccurrence(fromNewYork, MSK), at('2026-10-15 09:00', MSK), 'a New York reminder, read in Moscow');
  });

  await check('due: on the days the clocks go back, 09:00 is still 09:00 local (Israel Oct 25, New York Nov 1)', () => {
    const day = (d: string, tz: string) => ({ startsAt: startOfLocalDay(d, tz), allDay: true, timeZone: tz });
    assertTime(due.dueAtForOccurrence(day('2026-10-24', IL), IL), new RealDate('2026-10-24T06:00:00Z'), 'Israel, summer time');
    assertTime(due.dueAtForOccurrence(day('2026-10-25', IL), IL), new RealDate('2026-10-25T07:00:00Z'), 'Israel, winter time');
    assertTime(due.dueAtForOccurrence(day('2026-11-01', IL), NY), new RealDate('2026-11-01T14:00:00Z'), 'New York, winter time');
  });

  await check('tomorrowMorning: before 04:00 it is this morning at 09:00, from 04:00 tomorrow at 09:00', () => {
    assertTime(due.tomorrowMorning(today('02:00'), IL), today('09:00'), '02:00');
    assertTime(due.tomorrowMorning(today('03:59'), IL), today('09:00'), '03:59');
    assertTime(due.tomorrowMorning(today('04:00'), IL), at('2026-10-16 09:00'), '04:00');
    assertTime(due.tomorrowMorning(today('10:00'), IL), at('2026-10-16 09:00'), '10:00');
    assertTime(due.tomorrowMorning(today('23:30', NY), NY), at('2026-10-16 09:00', NY), 'New York 23:30');
  });

  await check('tomorrowMorning: the night before the clocks go back lands on 09:00 local', () => {
    assertTime(due.tomorrowMorning(at('2026-10-24 22:00'), IL), new RealDate('2026-10-25T07:00:00Z'), 'Israel');
    assertTime(due.tomorrowMorning(at('2026-10-31 21:00', NY), NY), new RealDate('2026-11-01T14:00:00Z'), 'New York');
  });

  // ---- Eligibility ----

  const now = today('10:00');
  const base = { due: now, now, armedAt: null, snoozed: false, lastPingedAt: null, doneAt: null };
  const plus = (d: Date, delta: number) => new RealDate(d.getTime() + delta);

  await check('eligible: due now yes, a millisecond ahead no', () => {
    assert(due.isEligible(base), 'due now');
    assert(!due.isEligible({ ...base, due: plus(now, 1) }), 'due ahead');
  });

  await check('eligible: up to 60 minutes late, not a millisecond more', () => {
    assert(due.PING_LOOKBACK_MS === HOUR, `lookback ${due.PING_LOOKBACK_MS}`);
    assert(due.isEligible({ ...base, due: plus(now, -HOUR) }), '60 minutes late');
    assert(!due.isEligible({ ...base, due: plus(now, -HOUR - 1) }), 'past the lookback');
  });

  await check('eligible: set at most 15 minutes after its time; a snooze, or no armedAt, skips that bound', () => {
    assert(due.ARMED_GRACE_MS === 15 * MIN, `grace ${due.ARMED_GRACE_MS}`);
    const d = plus(now, -20 * MIN);
    assert(due.isEligible({ ...base, due: d, armedAt: plus(d, 15 * MIN) }), 'armed 15 minutes after');
    assert(!due.isEligible({ ...base, due: d, armedAt: plus(d, 15 * MIN + 1) }), 'armed later than that');
    assert(due.isEligible({ ...base, due: d, armedAt: plus(d, 15 * MIN + 1), snoozed: true }), 'a snooze');
    assert(due.isEligible({ ...base, due: d, armedAt: null }), 'no armedAt');
  });

  await check('eligible: done, or already pinged for this due time, no; pinged before a later due (a snooze) yes', () => {
    assert(!due.isEligible({ ...base, doneAt: plus(now, -MIN) }), 'done');
    assert(!due.isEligible({ ...base, lastPingedAt: now }), 'pinged at the due time');
    assert(due.isEligible({ ...base, lastPingedAt: plus(now, -1) }), 'pinged before it');
  });

  // ---- The pass ----

  await check('pass: a due reminder pings its creator once, with Done and three snoozes on its state row', async () => {
    reset();
    const r = reminder({ startsAt: today('10:00') });
    const result = await pass(today('10:00'));
    assertSame(result, { sent: 1, skipped: 0, failed: 0, nextDue: null });
    assert(sent.length === 1 && sent[0].chatId === '1001' && sent[0].parseMode === 'HTML', sentLines());
    assert(sent[0].text === '⏰ <b>Call the plumber</b>', `text ${sent[0].text}`);
    const row = stateOf(r.id, today('10:00'))!;
    assertTime(row.lastPingedAt as Date, today('10:00'), 'lastPingedAt');
    assert(row.pingAttempts === 1 && row.pingChatId === BigInt(1001) && row.pingMessageId === sent[0].messageId, show(row));
    const b = copy.he.buttons;
    assertSame(sent[0].keyboard, {
      inline_keyboard: [
        [{ text: b.done, callback_data: `nr:d:${row.id}` }],
        [
          { text: b.snooze15, callback_data: `nr:s15:${row.id}` },
          { text: b.snooze60, callback_data: `nr:s60:${row.id}` },
          { text: b.snoozeTomorrow, callback_data: `nr:st:${row.id}` },
        ],
      ],
    });
    assert(tracked.some((t) => t.userId === 1 && t.action === 'native_reminder_pinged'), show(tracked));
    const again = await pass(today('10:01'));
    assert(sent.length === 1 && again.sent === 0, `next tick: ${sentLines()}`);
  });

  await check('pass: two passes at once send one ping', async () => {
    reset();
    reminder({ startsAt: today('10:00') });
    clock = today('10:00').getTime();
    const [a, b] = await quiet(() => Promise.all([runNativeReminderPass(today('10:00')), runNativeReminderPass(today('10:00'))]));
    assert(sent.length === 1, sentLines());
    assert(a.sent + b.sent === 1 && a.skipped + b.skipped === 1, `${show(a)} ${show(b)}`);
    assert(db.states.length === 1 && db.states[0].pingAttempts === 1, show(db.states));
  });

  await check("pass: a date-only reminder for the partner pings at 09:00 where she is, in her language, saying who set it", async () => {
    reset();
    timezones[2] = NY;
    dateOnly('2026-10-15', { forUserId: 2, title: 'Buy milk' });
    await pass(today('09:00', IL));
    await pass(today('08:59', NY));
    assert(sent.length === 0, `early: ${sentLines()}`);
    await pass(today('09:00', NY));
    assert(sent.length === 1 && sent[0].chatId === '1002', sentLines());
    assert(sent[0].text === `⏰ <b>Buy milk</b>\n${fromLine('en', 'רזיאל')}`, `text ${sent[0].text}`);
    assert(sent[0].keyboard.inline_keyboard[0][0].text === copy.en.buttons.done, 'buttons not in her language');
  });

  await check('pass: a Hebrew-date reminder pings on its Hebrew day (15 Oct this year), not on the Gregorian date it started on', async () => {
    reset();
    // Anchored on 26 Oct 2025: the same Hebrew date is 15 Oct 2026.
    const heb = reminder({
      startsAt: at('2025-10-26 10:00'), rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary', hebrewAnchor: '2025-10-26',
      armedAt: at('2026-10-01 12:00'), title: 'Call Grandma',
    });
    await pass(today('10:00'));
    assert(sent.length === 1 && sent[0].text === '⏰ <b>Call Grandma</b>', sentLines());
    assert(!!stateOf(heb.id, today('10:00')), `keyed ${show(db.states)}`);
    await pass(at('2026-10-26 10:00'));
    assert(sent.length === 1, `pinged on the Gregorian date too: ${sentLines()}`);
  });

  await check('pass: a daily 09:00 reminder pings at 09:00 local on the day the clocks go back', async () => {
    reset();
    const daily = reminder({ startsAt: at('2026-10-20 09:00'), rrule: 'FREQ=DAILY', armedAt: at('2026-10-19 12:00'), title: 'Pills' });
    await pass(new RealDate('2026-10-25T06:00:00Z')); // 08:00 in Israel's winter time
    assert(sent.length === 0, `an hour early: ${sentLines()}`);
    await pass(new RealDate('2026-10-25T07:00:00Z'));
    assert(sent.length === 1, sentLines());
    assert(!!stateOf(daily.id, new RealDate('2026-10-25T07:00:00Z')), `keyed ${show(db.states)}`);
  });

  await check('pass: after unlinking, a reminder for the ex-partner pings its creator, with no "from" line', async () => {
    reset();
    db.pairings[0].status = 'UNLINKED';
    for (const u of db.users) u.pairingId = null;
    reminder({ startsAt: today('10:00'), forUserId: 2 });
    await pass(today('10:00'));
    assert(sent.length === 1 && sent[0].chatId === '1001' && sent[0].text === '⏰ <b>Call the plumber</b>', sentLines());
  });

  await check('pass: a partner with Google connected (the legacy column says GOOGLE, the pairing ACTIVE) is still pinged (Google as a connection)', async () => {
    reset();
    db.users[1].calendarSource = 'GOOGLE';
    reminder({ startsAt: today('10:00'), forUserId: 2 });
    await pass(today('10:00'));
    assert(sent.length === 1 && sent[0].chatId === '1002', sentLines());
  });

  await check('pass: one live ping per series; a daily reminder snoozed into the next morning pings once, for the new day', async () => {
    reset();
    const daily = reminder({ startsAt: at('2026-10-10 09:00'), rrule: 'FREQ=DAILY', armedAt: at('2026-10-09 20:00'), title: 'Pills' });
    const yesterday = state({ seriesEventId: daily.id, originalStartsAt: at('2026-10-14 09:00'), lastPingedAt: at('2026-10-14 09:00'), pingAttempts: 1, snoozedUntil: today('09:00') });
    const result = await pass(today('09:00'));
    assert(sent.length === 1 && result.sent === 1 && result.skipped === 1, `${show(result)} ${sentLines()}`);
    const fresh = stateOf(daily.id, today('09:00'))!;
    assert(callbacks(sent[0].keyboard).every((c) => c.endsWith(`:${fresh.id}`)), `buttons ${callbacks(sent[0].keyboard)}`);
    assertTime(yesterday.lastPingedAt as Date, today('09:00'), "yesterday's claimed without a send");
    await pass(today('09:01'));
    assert(sent.length === 1, sentLines());
  });

  await check('pass: a snoozed ping comes back at snoozedUntil, a fresh message on the same state row', async () => {
    reset();
    const r = reminder({ startsAt: today('10:00') });
    await pass(today('10:00'));
    const row = stateOf(r.id, today('10:00'))!;
    row.snoozedUntil = today('10:15'); // 💤 15 min, tapped at 10:00
    await pass(today('10:14'));
    assert(sent.length === 1, `early: ${sentLines()}`);
    await pass(today('10:15'));
    assert(sent.length === 2 && sent[1].messageId !== sent[0].messageId, sentLines());
    assert(callbacks(sent[1].keyboard).every((c) => c.endsWith(`:${row.id}`)), 'new buttons on another row');
    assert(row.pingMessageId === sent[1].messageId && row.pingAttempts === 2, show(row));
  });

  await check('pass: a snooze on a never-pinged occurrence (an in-app row with lastPingedAt null) pings at snoozedUntil, not before', async () => {
    reset();
    const r = reminder({ startsAt: today('10:00') });
    // 💤 1 hour in the home at 10:03, before any ping: the row is made by the snooze.
    const row = state({ seriesEventId: r.id, originalStartsAt: today('10:00'), snoozedUntil: today('11:03') });
    await pass(today('10:05'));
    await pass(today('11:02'));
    assert(sent.length === 0, `early: ${sentLines()}`);
    await pass(today('11:03'));
    assert(sent.length === 1 && sent[0].chatId === '1001', sentLines());
    assert(callbacks(sent[0].keyboard).every((c) => c.endsWith(`:${row.id}`)), 'buttons on the same row');
    assertTime(row.lastPingedAt as Date, today('11:03'), 'claimed');
    await pass(today('11:04'));
    assert(sent.length === 1, `once: ${sentLines()}`);
  });

  await check('pass: a ping snoozed days after its time still comes back, though the occurrence is long past', async () => {
    reset();
    const r = reminder({ startsAt: at('2026-10-11 10:00') });
    state({ seriesEventId: r.id, originalStartsAt: at('2026-10-11 10:00'), lastPingedAt: at('2026-10-11 10:00'), pingAttempts: 1, snoozedUntil: today('09:00') });
    await pass(today('09:00'));
    assert(sent.length === 1 && sent[0].chatId === '1001', sentLines());
  });

  await check('pass: set after its time had passed: 10 minutes late still pings, 30 minutes late does not', async () => {
    reset();
    reminder({ startsAt: today('10:00'), armedAt: today('10:10'), title: 'Set at 10:10' });
    reminder({ startsAt: today('10:00'), armedAt: today('10:30'), title: 'Set at 10:30' });
    await pass(today('10:30'));
    assert(sentLines() === '1001: ⏰ <b>Set at 10:10</b>', sentLines());
  });

  await check('pass: a moved occurrence counts as set when it was moved', async () => {
    for (const [movedAt, pings] of [['10:58', true], ['11:30', false]] as const) {
      reset();
      const daily = reminder({ startsAt: at('2026-10-01 08:00'), rrule: 'FREQ=DAILY', armedAt: at('2026-09-30 12:00'), title: 'Walk' });
      db.instances.push({
        id: 'ov1', seriesEventId: daily.id, originalStartsAt: today('08:00'), status: 'OVERRIDE', title: null, description: null,
        location: null, startsAt: today('11:00'), endsAt: today('11:00'), allDay: null, createdAt: today(movedAt), updatedAt: today(movedAt),
      });
      await pass(today('08:00'));
      await pass(today(movedAt === '10:58' ? '11:00' : '11:30'));
      assert(sent.length === (pings ? 1 : 0), `moved at ${movedAt}: ${sentLines()}`);
      if (pings) assert(!!stateOf(daily.id, today('08:00')), 'not keyed by its original slot');
    }
  });

  await check('pass: a first occurrence moved before the series start pings at the time it moved to', async () => {
    reset();
    // Daily at 08:00 from Monday 19 Oct, set yesterday at noon. An hour later its first
    // time, Monday's, moved to today 10:00: four days before the series starts.
    const daily = (id: string, title: string) =>
      reminder({ id, title, startsAt: at('2026-10-19 08:00'), rrule: 'FREQ=DAILY', armedAt: at('2026-10-14 12:00') });
    const moveFirst = (seriesEventId: string, fields: Row) => db.instances.push({
      id: `ov-${seriesEventId}`, seriesEventId, originalStartsAt: at('2026-10-19 08:00'), status: 'OVERRIDE', title: null,
      description: null, location: null, startsAt: null, endsAt: null, allDay: null,
      createdAt: at('2026-10-14 13:00'), updatedAt: at('2026-10-14 13:00'), ...fields,
    });
    daily('pills', 'Pills');
    moveFirst('pills', { startsAt: today('10:00'), endsAt: today('10:00') });
    // These don't load: renamed only, moved later, and moved to today then deleted.
    daily('renamed', 'Renamed');
    moveFirst('renamed', { title: 'Pills (blue box)' });
    daily('later', 'Later');
    moveFirst('later', { startsAt: at('2026-10-20 10:00'), endsAt: at('2026-10-20 10:00') });
    daily('dropped', 'Dropped');
    moveFirst('dropped', { status: 'CANCELLED', startsAt: today('10:00'), endsAt: today('10:00') });

    // The series the query returned, before expansion drops any.
    const findSeries = fakePrisma.nativeEvent.findMany;
    const loaded: string[] = [];
    fakePrisma.nativeEvent.findMany = async (args: Args) => {
      const rows = await findSeries(args);
      loaded.push(...rows.map((r) => String(r.id)));
      return rows;
    };
    try {
      const result = await pass(today('10:00'));
      assert(sentLines() === '1001: ⏰ <b>Pills</b>', `${sentLines()}, loaded [${loaded}]`);
      assert(result.sent === 1, show(result));
      assert(!!stateOf('pills', at('2026-10-19 08:00')), `not keyed by its original slot: ${show(db.states)}`);
      assert(loaded.join(', ') === 'pills', `loaded [${loaded}]`);
    } finally {
      fakePrisma.nativeEvent.findMany = findSeries;
    }
  });

  await check('pass: done, deleted, on a deleted calendar, an event, or an exdated occurrence: no ping', async () => {
    reset();
    const done = reminder({ startsAt: today('10:00'), title: 'Done' });
    state({ seriesEventId: done.id, originalStartsAt: today('10:00'), doneAt: today('09:50') });
    reminder({ startsAt: today('10:00'), title: 'Deleted', isDeleted: true });
    reminder({ startsAt: today('10:00'), title: 'Deleted calendar', calendarId: 'cal-gone' });
    reminder({ startsAt: today('10:00'), title: 'An event', kind: 'EVENT', endsAt: today('11:00') });
    reminder({ startsAt: at('2026-10-14 10:00'), rrule: 'FREQ=DAILY', exdates: [today('10:00')], armedAt: at('2026-10-13 10:00'), title: 'Skipped today' });
    await pass(today('10:00'));
    assert(sent.length === 0, sentLines());
  });

  await check("pass: a series whose rule can't be read is reported, and the others still ping", async () => {
    reset();
    reminder({ startsAt: at('2026-10-14 10:00'), rrule: 'FREQ=SOMETIMES', title: 'Broken' });
    reminder({ startsAt: today('10:00'), title: 'Fine' });
    const result = await pass(today('10:00'));
    assert(sentLines() === '1001: ⏰ <b>Fine</b>', sentLines());
    assert(result.failed === 1 && captured.some((c) => c.context === 'native-reminders-series'), show(result));
    assert(result.nextDue === null, `a rule that fails every time made it retry: ${result.nextDue?.toISOString()}`);
  });

  await check('pass: a database blip on one series lets the others ping, and the next tick tries it again', async () => {
    reset();
    reminder({ startsAt: today('10:00'), title: 'Blip' });
    reminder({ startsAt: today('10:00'), title: 'Fine' });
    failNextClaim = new Error('Connection terminated unexpectedly');
    const result = await pass(today('10:00'));
    assert(sentLines() === '1001: ⏰ <b>Fine</b>' && result.failed === 1, `${show(result)} ${sentLines()}`);
    assertTime(result.nextDue, today('10:01'), 'nextDue');
    await pass(today('10:01'));
    assert(sentLines() === '1001: ⏰ <b>Fine</b> | 1001: ⏰ <b>Blip</b>', sentLines());
  });

  // ---- Skips and send failures ----

  const recipientStates: [string, () => void][] = [
    ['suspended', () => { db.users[1].suspendedAt = at('2026-10-01 12:00'); }],
    ['unreachable', () => { db.users[1].unreachableSince = at('2026-10-01 12:00'); }],
    ['banned', () => { blockedTelegramIds.add('1002'); }],
    ['not on Telegram', () => { db.users[1].telegramId = null; }],
  ];
  for (const [label, setUp] of recipientStates) {
    await check(`skip: a ${label} recipient gets no ping, and nothing is claimed`, async () => {
      reset();
      setUp();
      reminder({ startsAt: today('10:00'), forUserId: 2 });
      const result = await pass(today('10:00'));
      assert(sent.length === 0 && result.skipped === 1 && db.states.length === 0, `${show(result)} ${sentLines()}`);
    });
  }

  await check('skip: a creator without reminder access: no ping, for them or for the partner', async () => {
    reset();
    noAccess.add(1);
    reminder({ startsAt: today('10:00'), forUserId: 2 });
    reminder({ startsAt: today('10:00') });
    const result = await pass(today('10:00'));
    assert(sent.length === 0 && result.skipped === 2 && db.states.length === 0, `${show(result)} ${sentLines()}`);
  });

  await check('admin switch off: the pass does nothing and reads nothing', async () => {
    reset();
    flagOn = false;
    reminder({ startsAt: today('10:00') });
    const result = await pass(today('10:00'));
    assertSame(result, { sent: 0, skipped: 0, failed: 0, nextDue: null });
    assert(queries.length === 0 && sent.length === 0, `queried ${queries.join(', ')}`);
  });

  await check('send failure: a 429, a dropped connection and a 502 each give the claim back; the third attempt is the last', async () => {
    reset();
    assert(due.MAX_PING_ATTEMPTS === 3, `attempts ${due.MAX_PING_ATTEMPTS}`);
    const r = reminder({ startsAt: today('10:00') });
    sendFailures = [telegramError(429, 'Too Many Requests: retry after 5'), networkError(), telegramError(502, 'Bad Gateway')];
    const first = await pass(today('10:00'));
    const row = stateOf(r.id, today('10:00'))!;
    assert(first.failed === 1 && row.lastPingedAt === null && row.pingAttempts === 1, `${show(first)} ${show(row)}`);
    assertTime(first.nextDue, today('10:01'), 'retry on the next tick');
    await pass(today('10:01'));
    assert(row.lastPingedAt === null && row.pingAttempts === 2, show(row));
    await pass(today('10:02'));
    assertTime(row.lastPingedAt as Date, today('10:02'), 'third claim kept');
    assert(row.pingAttempts === 3 && captured.some((c) => c.context === 'native-reminders-send'), show(captured));
    await pass(today('10:03'));
    assert(sendCalls === 3 && sent.length === 0, `sends tried ${sendCalls}`);
  });

  await check('send failure: one passing failure, then the retry gets through', async () => {
    reset();
    const r = reminder({ startsAt: today('10:00') });
    sendFailures = [telegramError(502, 'Bad Gateway')];
    await pass(today('10:00'));
    await pass(today('10:01'));
    const row = stateOf(r.id, today('10:00'))!;
    assert(sent.length === 1 && row.pingAttempts === 2 && row.pingMessageId === sent[0].messageId, show(row));
  });

  await check('send failure: a re-ping after two snoozes (the budget reset) gives the claim back on a 502, and the next tick sends it', async () => {
    reset();
    const r = reminder({ startsAt: today('10:00') });
    await pass(today('10:00'));
    const row = stateOf(r.id, today('10:00'))!;
    // 💤 tapped twice: the snooze writes snoozedUntil and resets pingAttempts, never lastPingedAt.
    row.snoozedUntil = today('10:15');
    row.pingAttempts = 0;
    await pass(today('10:15'));
    row.snoozedUntil = today('10:30');
    row.pingAttempts = 0;
    const pinged = row.lastPingedAt as Date;
    assert(sent.length === 2, sentLines());
    sendFailures = [telegramError(502, 'Bad Gateway')];
    const failed = await pass(today('10:30'));
    assert(failed.failed === 1 && sent.length === 2 && row.pingAttempts === 1, `${show(failed)} ${show(row)}`);
    assertTime(row.lastPingedAt as Date, pinged, 'claim given back');
    await pass(today('10:31'));
    assert(sent.length === 3 && row.pingAttempts === 2 && row.pingMessageId === sent[2].messageId, `${sentLines()} ${show(row)}`);
    assertTime(row.lastPingedAt as Date, today('10:31'), 're-ping claimed');
  });

  await check('send failure: a user who blocked the bot is marked unreachable, and not retried', async () => {
    reset();
    const r = reminder({ startsAt: today('10:00') });
    sendFailures = [telegramError(403, 'Forbidden: bot was blocked by the user')];
    const result = await pass(today('10:00'));
    assert(result.failed === 1 && unreachable.join() === '1', `${show(result)} unreachable ${unreachable}`);
    assertTime(stateOf(r.id, today('10:00'))!.lastPingedAt as Date, today('10:00'), 'claim kept');
    await pass(today('10:01'));
    assert(sendCalls === 1, `sends tried ${sendCalls}`);
  });

  await check('send failure: any other refusal is reported and kept, not retried', async () => {
    reset();
    reminder({ startsAt: today('10:00') });
    sendFailures = [telegramError(400, "Bad Request: can't parse entities")];
    await pass(today('10:00'));
    await pass(today('10:01'));
    assert(sendCalls === 1 && unreachable.length === 0, `sends tried ${sendCalls}`);
    assert(captured.some((c) => c.context === 'native-reminders-send' && c.severity === 'error'), show(captured));
  });

  // ---- The message ----

  await check('ping: a title and a name with <, > and & are escaped for HTML', async () => {
    reset();
    db.users[0].name = 'Raz <&> Co';
    reminder({ startsAt: today('10:00'), forUserId: 2, title: '<script>alert("x")</script> & milk' });
    await pass(today('10:00'));
    const want = `⏰ <b>&lt;script&gt;alert("x")&lt;/script&gt; &amp; milk</b>\n${fromLine('en', 'Raz &lt;&amp;&gt; Co')}`;
    assert(sent.length === 1 && sent[0].text === want, `\n     got  ${sent[0]?.text}\n     want ${want}`);
    const hebrew = await buildPingText({ title: 'קניות <דחוף>', creatorName: 'Dana', language: 'he' });
    assert(hebrew === `⏰ <b>קניות &lt;דחוף&gt;</b>\n${fromLine('he', 'Dana')}`, hebrew);
  });

  await check("ping: every button's callback data fits Telegram's 64 bytes", async () => {
    const keyboard = await buildPingKeyboard(randomUUID(), 'ru');
    const data = callbacks(keyboard as Keyboard);
    assert(data.length === 4 && data.every((d) => Buffer.byteLength(d) <= 64), data.join(' '));
    assertSame(data.map((d) => d.split(':')[1]), ['d', 's15', 's60', 'st']);
  });

  await check('pass: a done that lands while the ping is being sent leaves it closed, not with live buttons', async () => {
    reset();
    const r = reminder({ startsAt: today('10:00') });
    duringSend = () => { stateOf(r.id, today('10:00'))!.doneAt = today('10:00'); };
    await pass(today('10:00'));
    const row = stateOf(r.id, today('10:00'))!;
    assert(row.pingMessageId === sent[0].messageId, show(row));
    const text = copy.he.done.replace('{title}', 'Call the plumber');
    assertSame(edits, [{ text, options: { chat_id: '1001', message_id: sent[0].messageId, parse_mode: 'HTML' } }]);
    reset();
    reminder({ startsAt: today('10:00') });
    await pass(today('10:00'));
    assert(edits.length === 0, 'an open ping is left alone');
  });

  await check('stripPingButtons: edits to the text with no buttons; a ping already edited or deleted is fine', async () => {
    reset();
    await stripPingButtons(BigInt(1001), 77, '⏰ Call · moved to Fri 10:00');
    assertSame(edits, [{ text: '⏰ Call · moved to Fri 10:00', options: { chat_id: '1001', message_id: 77, parse_mode: 'HTML' } }]);
    editFailure = telegramError(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same');
    await stripPingButtons(1001, 77, 'same');
    editFailure = telegramError(400, 'Bad Request: message to edit not found');
    await stripPingButtons(1001, 77, 'gone');
    editFailure = telegramError(403, 'Forbidden: bot was blocked by the user');
    const thrown = await stripPingButtons(1001, 77, 'x').then(() => 'resolved', (e: Error) => e.message);
    assert(thrown.includes('403'), `a refusal: ${thrown}`);
  });

  // ---- Reminder time per user (B1) ----

  await check('reminder time: a date-only reminder is due at the recipient\'s own time, with 09:00 for null, junk and a step off 15 minutes', () => {
    const occ = { startsAt: startOfLocalDay('2026-10-15', IL), allDay: true, timeZone: IL };
    assertTime(due.dueAtForOccurrence(occ, IL, '07:30'), at('2026-10-15 07:30', IL), '07:30');
    assertTime(due.dueAtForOccurrence(occ, NY, '23:45'), at('2026-10-15 23:45', NY), '23:45 in New York');
    for (const bad of [null, undefined, '', '7:30', '24:00', '09:10', 'x']) assertTime(due.dueAtForOccurrence(occ, IL, bad), at('2026-10-15 09:00', IL), `bad ${bad}`);
    assertTime(due.reminderDueAt({ start: '2026-10-15' }, IL, '06:15'), at('2026-10-15 06:15', IL), 'reminderDueAt');
  });

  await check('reminder time: 💤 Tomorrow wakes at the actor\'s time; a time before 04:00 tapped after it has passed is tomorrow\'s', () => {
    assertTime(due.tomorrowMorning(today('10:00'), IL, '07:30'), at('2026-10-16 07:30'), '07:30');
    assertTime(due.tomorrowMorning(today('02:00'), IL, '05:00'), today('05:00'), 'still ahead this morning');
    assertTime(due.tomorrowMorning(today('02:00'), IL, '01:00'), at('2026-10-16 01:00'), 'has gone by');
    assertTime(due.tomorrowMorning(today('10:00'), IL), at('2026-10-16 09:00'), 'unset');
  });

  await check('reminder time: two recipients of date-only reminders each ping at their own time; the gate sleeps to the earliest of them', async () => {
    reset();
    gate.__resetDueGateForTests();
    db.users[0].reminderTime = '07:30';
    db.users[1].reminderTime = null;
    const mine = dateOnly('2026-10-15', { title: 'Mine' });
    dateOnly('2026-10-15', { forUserId: 2, title: 'Dana\'s' });
    await tick(today('07:29'));
    assert(sent.length === 0, `too early: ${sentLines()}`);
    await tick(today('07:30'));
    assert(sent.length === 1 && sent[0].chatId === '1001', `07:30: ${sentLines()}`);
    assert(!!stateOf(mine.id, mine.startsAt as Date), 'state row for the 07:30 reminder');
    queries.length = 0;
    await tick(today('08:00')); // gate: next due is 09:00 (Dana), so this tick reads nothing
    assert(!queries.includes('nativeEvent.findMany'), `woke before 09:00: ${queries.join(', ')}`);
    await tick(today('09:00'));
    assert(sent.length === 2 && sent[1].chatId === '1002', `09:00: ${sentLines()}`);
  });

  await check('reminder time: the widest case, 23:45 for a recipient at UTC-12 on an event dated at UTC+14 (49.75 hours after the event starts), is inside the pass window', async () => {
    reset();
    db.users[1].reminderTime = '23:45';
    timezones[2] = 'Etc/GMT+12';
    dateOnly('2026-10-15', { forUserId: 2, title: 'Late' }, 'Pacific/Kiritimati');
    const pingAt = at('2026-10-15 23:45', 'Etc/GMT+12');
    assertTime((await pass(plus(pingAt, -MIN))).nextDue, pingAt, 'nextDue');
    await pass(pingAt);
    assert(sent.length === 1 && sent[0].chatId === '1002', sentLines());
  });

  await check('reminder time moved later after the ping: the date-only reminder does not ping again that day', async () => {
    reset();
    const r = dateOnly('2026-10-15', { title: 'Mine' });
    await pass(today('09:00'));
    assert(sent.length === 1, `first ping: ${sentLines()}`);
    db.users[0].reminderTime = '18:00';
    await pass(today('18:00'));
    assert(sent.length === 1, `pinged again: ${sentLines()}`);
    assert(!!stateOf(r.id, r.startsAt as Date), 'state');
  });

  await check('reminder time moved earlier past the catch-up window: the date-only reminder still pings once that day, not again, not on the next day', async () => {
    reset();
    db.users[0].reminderTime = '18:00';
    dateOnly('2026-10-15', { title: 'Mine' });
    await pass(today('10:30'));
    assert(sent.length === 0, 'early');
    db.users[0].reminderTime = '09:00'; // 90 minutes after the new time
    await pass(today('10:31'));
    assert(sent.length === 1, `caught up: ${sentLines()}`);
    await pass(today('10:32'));
    assert(sent.length === 1, 'pinged twice');
    await pass(at('2026-10-16 00:05'));
    assert(sent.length === 1, `pinged the next day: ${sentLines()}`);
  });

  // ---- nextDue and the gate ----

  await check('nextDue: the earliest due still ahead, a snooze and a date-only one in the recipient\'s timezone included', async () => {
    reset();
    reminder({ startsAt: today('10:40') });
    const snoozed = reminder({ startsAt: today('09:00'), title: 'Snoozed' });
    state({ seriesEventId: snoozed.id, originalStartsAt: today('09:00'), lastPingedAt: today('09:00'), pingAttempts: 1, snoozedUntil: today('10:15') });
    assertTime((await pass(today('10:00'))).nextDue, today('10:15'), 'with the snooze');
    reset();
    timezones[2] = NY;
    dateOnly('2026-10-16', { forUserId: 2 });
    assertTime((await pass(today('10:00'))).nextDue, at('2026-10-16 09:00', NY), "Dana's 09:00 tomorrow");
    reset();
    assert((await pass(today('10:00'))).nextDue === null, 'nothing in the window');
  });

  await check('handler: the first tick reads; later ones sleep until the next due or the 60-minute ceiling; a write wakes it', async () => {
    reset();
    gate.__resetDueGateForTests();
    reminder({ startsAt: today('10:20') });
    await tick(today('10:00'));
    assert(queries.includes('nativeEvent.findMany'), 'the first tick did not read');
    queries.length = 0;
    await tick(today('10:01'));
    await tick(today('10:19'));
    assert(queries.length === 0, `slept badly: ${queries.join(', ')}`);
    gate.invalidateDueGate(); // a reminder write
    await tick(today('10:02'));
    assert(queries.includes('nativeEvent.findMany'), 'a write did not wake it');
    await tick(today('10:20'));
    assert(sent.length === 1, sentLines());
    queries.length = 0;
    await tick(today('11:19')); // nothing ahead: wakes at the ceiling
    assert(queries.length === 0, `woke early: ${queries.join(', ')}`);
    await tick(today('11:20'));
    assert(queries.includes('nativeEvent.findMany'), 'did not wake at the ceiling');
  });

  await check('handler: a tick that finds the last pass still running skips', async () => {
    reset();
    gate.__resetDueGateForTests();
    reminder({ startsAt: today('10:00') });
    let release = () => {};
    holdFind = new Promise<void>((resolve) => (release = resolve));
    const first = tick(today('10:00'));
    await tick(today('10:00'));
    release();
    await first;
    assert(queries.filter((q) => q === 'nativeEvent.findMany').length === 1 && sent.length === 1, `${queries.join(', ')} ${sentLines()}`);
  });

  type CronState = { running: boolean; startedAt: number };
  const cron = () => (globalThis as { __nativeRemindersCron?: CronState }).__nativeRemindersCron!;

  await check('handler: a pass running over 5 minutes is taken for dead; one running 1 minute still blocks the tick', async () => {
    reset();
    gate.__resetDueGateForTests();
    reminder({ startsAt: today('10:00') });
    Object.assign(cron(), { running: true, startedAt: today('09:59').getTime() });
    await tick(today('10:00'));
    assert(queries.length === 0 && sent.length === 0, `a 1-minute-old pass did not block: ${queries.join(', ')} ${sentLines()}`);
    assert(!captured.some((c) => c.context === 'native-reminders-stuck'), show(captured));
    Object.assign(cron(), { running: true, startedAt: today('09:54').getTime() });
    await tick(today('10:00'));
    assert(queries.includes('nativeEvent.findMany') && sent.length === 1, `a 6-minute-old pass blocked: ${queries.join(', ')} ${sentLines()}`);
    assert(captured.some((c) => c.context === 'native-reminders-stuck' && c.severity === 'warning'), show(captured));
    assert(!cron().running, 'the flag stayed set');
  });

  await check('handler: a pass taken for dead that finishes late leaves the flag of the pass that replaced it', async () => {
    reset();
    gate.__resetDueGateForTests();
    // Both passes overlap, so one quiet() around them all (nested ones would restore console out of order)
    await quiet(async () => {
      const run = (when: Date) => {
        clock = when.getTime();
        return handleNativeReminders();
      };
      const inFind = async () => {
        for (let i = 0; i < 1000 && holdFind; i++) await new Promise((resolve) => setImmediate(resolve));
        assert(!holdFind, 'the pass never reached the database');
      };
      let releaseDead = () => {};
      holdFind = new Promise<void>((resolve) => (releaseDead = resolve));
      const dead = run(today('10:00'));
      await inFind();
      let releaseNew = () => {};
      holdFind = new Promise<void>((resolve) => (releaseNew = resolve));
      const replacement = run(today('10:06'));
      await inFind();
      releaseDead();
      await dead;
      assert(cron().running, 'the dead pass cleared the running flag of its replacement');
      queries.length = 0;
      await run(today('10:07'));
      assert(queries.length === 0, `a tick ran beside the replacement: ${queries.join(', ')}`);
      releaseNew();
      await replacement;
      assert(!cron().running, 'the replacement left the flag set');
    });
  });

  await check('handler: a replaced pass that finishes late does not move the gate', async () => {
    reset();
    gate.__resetDueGateForTests();
    await quiet(async () => {
      const run = (when: Date) => {
        clock = when.getTime();
        return handleNativeReminders();
      };
      let releaseDead = () => {};
      holdFind = new Promise<void>((resolve) => (releaseDead = resolve));
      const dead = run(today('10:00'));
      for (let i = 0; i < 1000 && holdFind; i++) await new Promise((resolve) => setImmediate(resolve));
      assert(!holdFind, 'the dead pass never reached the database');
      // Written after the dead pass read: its replacement sees it and sleeps until 10:20
      const later = reminder({ startsAt: today('10:20') });
      await run(today('10:06'));
      db.events.splice(db.events.indexOf(later), 1); // the dead pass's older view: nothing due
      releaseDead();
      await dead; // would close the gate until 11:00
      db.events.push(later);
      queries.length = 0;
      await run(today('10:20'));
      assert(queries.includes('nativeEvent.findMany') && sent.length === 1, `the gate slept past 10:20: ${queries.join(', ')} ${sentLines()}`);
    });
  });

  await check('handler: a failing pass throws nothing, leaves the gate open, and tells the admin at most once an hour', async () => {
    reset();
    gate.__resetDueGateForTests();
    failNextFind = new Error('Connection terminated unexpectedly');
    await tick(today('10:00'));
    assert(captured.some((c) => c.context === 'cron-native-reminders') && adminNotices.length === 1, `${show(captured)} ${adminNotices}`);
    queries.length = 0;
    failNextFind = new Error('Connection terminated unexpectedly');
    await tick(today('10:01'));
    assert(queries.includes('nativeEvent.findMany'), 'the gate closed after a failure');
    assert(adminNotices.length === 1, `told the admin again within the hour: ${adminNotices.length}`);
    failNextFind = new Error('Connection terminated unexpectedly');
    await tick(today('11:00'));
    assert(adminNotices.length === 2 && adminNotices[1] === 'Job: Native Reminders', show(adminNotices));
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

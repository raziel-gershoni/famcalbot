// Smoke test for the summaries on the shared reader (calendar home spec §3.1, §10; Plan C,
// Task C6).
//
// The daily and tomorrow summaries, the tomorrow summary's week block, /week and
// /nextweek read through the shared reader (readDigestDay, readLookaheadEvents). This
// smoke runs them over a fake Google and an in-memory database:
// (a) The day: for every user, timezone and clock, the reader's day, shaped by
//     shapeEventsForDay, is the golden's. The reader leaves out the C1/C2 items, and the
//     fixtures reach the shaping's edges.
// (b) The prompts, byte for byte the golden's, for a paired FamCal user with reminders
//     and a Google user with yours/spouse/kids/birthday calendars. An Outlook/Teams HTML
//     description (a table row, a heading) keeps its words apart in the prompt.
// (c) /week and /nextweek list the golden's events, read through the reader; the weeks
//     start by country.
// (d) How each Google failure ends, scheduled and on demand, with recording fakes; also
//     a week block that fails on its own, and an on-demand tomorrow summary whose reads
//     and AI call come close to the command's 50 s limit.
// (e) A scheduled batch doesn't wait for its Google retries, also when Google stalls.
//
// scripts/fixtures/digest-reader-golden.json holds (a)-(c)'s answers: what the summaries
// read and sent the AI with the rollout switch on, taken before the switch and the
// providers' day reads were removed (the code of 5a74d6c), with:
//   npx tsx scripts/smoke-digest-reader.ts --write-golden-fixture
// That mode refuses to overwrite the file. Take a new one only when the summaries' reads
// or prompts are meant to change: delete the file, then run it again.
//
// Real: summary.ts, commands.ts (/week), the command pipeline, week-lookahead.ts, the
// digest adapters, readRange and both halves, calendar.ts, the native provider, the event
// store, ownership, open reminders, locale-rules, the claude.ts prompt builders, the bot
// texts and the summary scheduling. Faked: Google (@googleapis/calendar's OAuth client
// and calendar client), the database (in memory), Redis (in memory), the timezone
// lookup, the users, the AI, the holiday lookup, Telegram, the voice note, quota,
// analytics, Sentry and the admin notifier. The clock is a fake Date; timers are real. No
// network, no DB.
//
// Real timers run the reader's 1 s pause before a quick retry (three times) and its 10 s
// deadline (the hanging token server), so a run takes about 15 s. Three checks run on
// virtual time instead (runVirtual): their timers wait on the fake clock, which jumps to
// the next timer whenever nothing else can run, so a 135 s stall takes a moment.
//
// Run under each clock; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-digest-reader.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-digest-reader.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-digest-reader.ts

import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import type { NativeCalendar, NativeEvent, NativeReminderState } from '@prisma/client';
import { MessageFormat, MessagingPlatform } from '../src/services/messaging/types';
import type { MessageOptions, StreamMessageHandle } from '../src/services/messaging/types';
import type { CalendarAssignment, CalendarEvent, CalendarLabel, UserConfig } from '../src/types';
import type { AICompletionResult } from '../src/services/ai-provider';
import { localDate, nextDate, shapeEventsForDay, startOfLocalDay } from '../src/utils/day-events';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

function assertList(got: readonly string[], want: readonly string[], what: string) {
  assert(show(got) === show(want), `${what}\n     got  ${JSON.stringify(got, null, 1)}\n     want ${JSON.stringify(want, null, 1)}`);
}

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

// ---- Environment: fakes only ----

process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.test';

/** Any request that slips past the fakes is refused and counted. */
const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error(`network is blocked in this smoke test: ${String(input)}`);
}) as typeof fetch;

const unhandled: unknown[] = [];
process.on('unhandledRejection', reason => {
  unhandled.push(reason);
});

// ---- Clock: every argument-less new Date() and Date.now() reads `clock` ----

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const LONDON = 'Europe/London';
const CAIRO = 'Africa/Cairo';
/** An instant from a wall-clock time, in Israel unless said otherwise. */
const at = (local: string, tz = IL) => fromZonedTime(local, tz);

const RealDate = Date;
let clock = at('2026-10-22 07:00:00').getTime();
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

// ---- Timers stay real; the durations asked for are recorded ----

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
/** Every setTimeout duration since the last reset: the reader's deadlines, the retry pause, the pipeline's 50 s. */
let timersAsked: number[] = [];
/** While set (runVirtual), timers wait on the fake clock instead of real time. */
let virtualTime = false;
type VirtualTimer = { due: number; seq: number; run: () => void; cleared: boolean };
const virtualTimers: VirtualTimer[] = [];
let timerSeq = 0;
globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  timersAsked.push(ms ?? 0);
  if (!virtualTime) return realSetTimeout(handler, ms, ...args);
  const timer: VirtualTimer = { due: clock + Math.max(0, ms ?? 0), seq: timerSeq++, run: () => handler(...args), cleared: false };
  virtualTimers.push(timer);
  // What a Node timer offers the code that holds it.
  return Object.assign(timer, { ref: () => timer, unref: () => timer, hasRef: () => true, refresh: () => timer });
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((handle?: unknown) => {
  const timer = virtualTimers.find(t => t === handle);
  if (timer) timer.cleared = true;
  else realClearTimeout(handle as ReturnType<typeof setTimeout>);
}) as typeof clearTimeout;

/**
 * Node's in-flight I/O: requests, connections, and a MessagePort (a module still loading
 * through tsx's loader thread, the CI-only case). Not timers, immediates or stdout.
 */
const pendingIo = () => process.getActiveResourcesInfo().filter(r => /Req|Connect|MessagePort/.test(r));
/** Turns real time until no I/O request is in flight (or `done`), at most 5 s; says what it waited for. */
async function waitForRealIo(done: () => boolean): Promise<void> {
  const start = performance.now();
  while (!done() && pendingIo().length > 0 && performance.now() - start < 5000) {
    await new Promise(resolve => realSetTimeout(resolve, 1));
  }
  const waited = performance.now() - start;
  if (waited > 50) process.stderr.write(`[virtual time] waited ${Math.round(waited)} ms for real I/O before the next timer\n`);
}

/**
 * Runs `work` on virtual time: whenever nothing else can run (50 turns of the event loop
 * with no progress), the earliest timer fires and the fake clock jumps to it. Timers left
 * when the work ends (the pipeline's 50 s, which nobody clears) are dropped.
 */
async function runVirtual<T>(work: () => Promise<T>): Promise<T> {
  virtualTime = true;
  let settled = false;
  const result = work().finally(() => {
    settled = true;
  });
  result.catch(() => {});
  try {
    for (;;) {
      for (let i = 0; i < 50 && !settled; i++) await new Promise(resolve => setImmediate(resolve));
      if (settled) return await result;
      // With no timer to fire yet, the work may still be on its way to one: on Node 22 the
      // stall check's token step takes 51 turns to start its deadline. Keep turning first.
      for (let i = 0; i < 10_000 && !settled && !virtualTimers.some(t => !t.cleared); i++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      if (settled) return await result;
      // Real I/O (a file read, a module load, a refused connection) is no timer and the turns
      // above don't wait for it; on a slower machine (CI) it outlasts them, and the clock would
      // jump to the pipeline's 50 s before the work reached its next timer. Wait it out first.
      await waitForRealIo(() => settled);
      if (settled) return await result;
      const next = virtualTimers.filter(t => !t.cleared).sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
      if (!next) throw new Error('virtual time: the work is waiting on something that is not a timer');
      next.cleared = true;
      clock = Math.max(clock, next.due);
      next.run();
    }
  } finally {
    virtualTime = false;
    virtualTimers.length = 0;
  }
}
/** The long timers only: 1 s and up. */
const longTimers = () => timersAsked.filter(ms => ms >= 1000);

// ---- What happened, in order ----

/** Google calls, sends, drafts, voice notes, dedup marks, admin notices, cleared tokens and waits. */
let log: string[] = [];
/** Every prompt the AI got, in order. */
let prompts: string[] = [];
/** Sentry, as "<context> <level> <message>". */
let captured: string[] = [];
/** Every admin error notice of the whole run. */
const adminErrors: string[] = [];
/** Every Redis key the run read or wrote. */
const redisKeys = new Set<string>();
/** When each message, draft and voice note went out, on the fake clock: "<what> @<ms>". */
let sentAt: string[] = [];
/** The code under test logs timings and errors; they are kept out of the report. */
const logs: string[] = [];

// ---- In-memory Prisma: the operators, relation filters, include, select and orderBy the code under test uses ----

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type Relations = Record<string, (row: Row) => Row | Row[] | undefined>;
type FindArgs = {
  where?: Where;
  select?: Record<string, boolean>;
  include?: Record<string, boolean>;
  orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
};

const same = (a: unknown, b: unknown) => (a instanceof RealDate && b instanceof RealDate ? a.getTime() === b.getTime() : a === b);

function matches(row: Row, where: Where, relations: Relations = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some(w => matches(row, w, relations));
    if (key === 'AND') return (Array.isArray(cond) ? (cond as Where[]) : [cond as Where]).every(w => matches(row, w, relations));
    if (Object.hasOwn(relations, key)) {
      const target = relations[key](row);
      if (Array.isArray(target)) {
        const { some, ...rest } = cond as { some?: Where };
        if (!some || Object.keys(rest).length > 0) throw new Error(`stand-in Prisma only knows '${key}: { some }'`);
        return target.some(r => matches(r, some));
      }
      return target !== undefined && matches(target, cond as Where);
    }
    const value = row[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return same(value, cond);
    return Object.entries(cond as Where).every(([op, arg]) => {
      switch (op) {
        case 'in': return (arg as unknown[]).some(a => same(a, value));
        case 'not': return !same(value, arg);
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
  return v instanceof RealDate ? v.getTime() : Number(v);
};

/** Every query since the last reset, as "<model>.<method>". */
let queries: string[] = [];

function table(name: string, rows: () => Row[], relations: Relations = {}) {
  const shape = (row: Row, args: FindArgs) => {
    if (args.select) return Object.fromEntries(Object.keys(args.select).filter(k => args.select![k]).map(k => [k, row[k]]));
    const out: Row = { ...row };
    for (const [k, on] of Object.entries(args.include ?? {})) if (on) out[k] = relations[k](row);
    return out;
  };
  return {
    findMany: async (args: FindArgs = {}) => {
      queries.push(`${name}.findMany`);
      const found = rows().filter(r => matches(r, args.where ?? {}, relations));
      const orderBy = args.orderBy ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) : [];
      found.sort((a, b) => {
        for (const o of orderBy) {
          const [key, dir] = Object.entries(o)[0];
          const d = sortKey(a, key) - sortKey(b, key);
          if (d !== 0) return dir === 'asc' ? d : -d;
        }
        return 0;
      });
      return found.map(r => shape(r, args));
    },
    findUnique: async (args: FindArgs & { where: Where }) => {
      queries.push(`${name}.findUnique`);
      const row = rows().find(r => matches(r, args.where, relations));
      return row ? shape(row, args) : null;
    },
  };
}

const db = { users: [] as Row[], pairings: [] as Row[], calendars: [] as Row[], events: [] as Row[], instances: [] as Row[], states: [] as Row[] };

const fakePrisma = {
  user: table('user', () => db.users),
  pairing: table('pairing', () => db.pairings),
  nativeCalendar: table('nativeCalendar', () => db.calendars),
  nativeEvent: table('nativeEvent', () => db.events, {
    calendar: r => db.calendars.find(c => c.id === r.calendarId),
    instances: r => db.instances.filter(i => i.seriesEventId === r.id),
    states: r => db.states.filter(s => s.seriesEventId === r.id),
  }),
  nativeEventInstance: table('nativeEventInstance', () => db.instances),
  nativeReminderState: table('nativeReminderState', () => db.states),
};

// ---- The built-in calendar: Dana and Raziel paired, Noam solo, Lior paired with Tom (a Google user) ----

const CREATED = at('2026-09-01 09:00:00');

function nativeCalendar(fields: Partial<NativeCalendar> & Pick<NativeCalendar, 'id' | 'ownerUserId' | 'name' | 'createdAt'>): NativeCalendar {
  return {
    color: '#039BE5', labels: ['yours'], personName: null, personEnglishName: null, personGender: null, rules: [],
    privacy: 'PRIVATE', isDeleted: false, updatedAt: CREATED,
    ...fields,
  };
}

function nativeEvent(fields: Partial<NativeEvent> & Pick<NativeEvent, 'id' | 'calendarId' | 'creatorUserId' | 'title' | 'startsAt'>): NativeEvent {
  return {
    description: null, location: null, endsAt: fields.startsAt, allDay: false, timeZone: IL, rrule: null, hebrewRule: null, hebrewAnchor: null, exdates: [],
    ownAlerts: false, alertMinutes: [], isDeleted: false, createdAt: CREATED, updatedAt: CREATED,
    kind: 'EVENT', forUserId: null, armedAt: null,
    ...fields,
  };
}

/** A reminder has no length: it ends where it starts. */
const reminderRow = (fields: Parameters<typeof nativeEvent>[0]) => nativeEvent({ kind: 'REMINDER', armedAt: CREATED, ...fields, endsAt: fields.startsAt });

function reminderState(fields: Partial<NativeReminderState> & Pick<NativeReminderState, 'seriesEventId' | 'originalStartsAt'>): NativeReminderState {
  return {
    id: `state-${fields.seriesEventId}-${fields.originalStartsAt.getTime()}`, doneAt: null, doneByUserId: null, snoozedUntil: null,
    lastPingedAt: null, pingAttempts: 0, pingChatId: null, pingMessageId: null, createdAt: CREATED, updatedAt: CREATED,
    ...fields,
  };
}

const userRow = (id: number, name: string, extra: Row = {}): Row => ({
  id, name, englishName: name, gender: 'female', calendarSource: 'NATIVE', telegramId: BigInt(1000 + id), language: 'en',
  pairingId: null, suspendedAt: null, googleRefreshToken: '', ...extra,
});

db.users = [
  userRow(1, 'Dana', { pairingId: 'pair-1', language: 'he' }),
  userRow(2, 'Raziel', { gender: 'male', pairingId: 'pair-1', language: 'he' }),
  userRow(3, 'Noam', { gender: 'male', language: 'ru' }),
  userRow(5, 'Tom', { gender: 'male', calendarSource: 'GOOGLE', pairingId: 'pair-2', googleRefreshToken: 'tok-tom' }),
  userRow(6, 'Lior', { pairingId: 'pair-2' }),
  userRow(16, 'Omri', { gender: 'male', calendarSource: 'GOOGLE' }),
];
db.pairings = [
  { id: 'pair-1', status: 'ACTIVE', inviterUserId: 2, inviteeUserId: 1 },
  { id: 'pair-2', status: 'ACTIVE', inviterUserId: 6, inviteeUserId: 5 },
];
db.calendars = [
  nativeCalendar({ id: 'cal-dana', ownerUserId: 1, name: 'Dana', labels: ['primary', 'yours'], createdAt: at('2026-09-01 09:00:00') }),
  nativeCalendar({ id: 'cal-raz', ownerUserId: 2, name: 'Raziel', labels: ['primary', 'yours'], privacy: 'SHARED_EDITOR', createdAt: at('2026-09-02 09:00:00') }),
  nativeCalendar({ id: 'cal-raz-private', ownerUserId: 2, name: 'Surprise party plans', createdAt: at('2026-09-03 09:00:00') }),
  nativeCalendar({ id: 'cal-dana-kids', ownerUserId: 1, name: 'Kids', labels: ['kids'], personName: 'Noa', createdAt: at('2026-09-04 09:00:00') }),
  nativeCalendar({ id: 'cal-noam', ownerUserId: 3, name: 'Noam', labels: ['primary', 'yours'], createdAt: at('2026-09-05 09:00:00') }),
  nativeCalendar({ id: 'cal-lior', ownerUserId: 6, name: 'Lior', labels: ['primary', 'yours'], createdAt: at('2026-09-06 09:00:00') }),
  // Omri's lazy FamCal main: he has Google choices, so it is 'yours' only (spec §3)
  nativeCalendar({ id: 'cal-omri', ownerUserId: 16, name: 'Omri', labels: ['yours'], createdAt: at('2026-09-07 09:00:00') }),
] as unknown as Row[];
db.events = [
  // Dana's own and her kids' calendar
  nativeEvent({ id: 'n-dentist', calendarId: 'cal-dana', creatorUserId: 1, title: 'Dentist', startsAt: at('2026-10-22 10:00:00'), endsAt: at('2026-10-22 11:00:00'), description: 'Bring the forms', location: '12 Herzl St' }),
  nativeEvent({ id: 'n-swim', calendarId: 'cal-dana-kids', creatorUserId: 1, title: 'Swimming', startsAt: at('2026-10-08 16:00:00'), endsAt: at('2026-10-08 17:00:00'), rrule: 'FREQ=WEEKLY;BYDAY=TH' }),
  nativeEvent({ id: 'n-sleepover', calendarId: 'cal-dana-kids', creatorUserId: 1, title: "Sleepover at Ben's", startsAt: at('2026-10-22 19:00:00'), endsAt: at('2026-10-23 10:00:00') }),
  nativeEvent({ id: 'n-hike', calendarId: 'cal-dana', creatorUserId: 1, title: 'Hiking trip', startsAt: at('2026-10-24 00:00:00'), endsAt: at('2026-10-25 23:59:00'), allDay: true }),
  // Israel's clocks go back at 02:00 on 25 October: a 25-hour day.
  nativeEvent({ id: 'n-shift', calendarId: 'cal-dana', creatorUserId: 1, title: 'Night shift', startsAt: at('2026-10-25 00:30:00'), endsAt: at('2026-10-25 03:00:00') }),
  reminderRow({ id: 'r-plants', calendarId: 'cal-dana', creatorUserId: 1, title: 'Water the plants', startsAt: at('2026-10-22 08:00:00') }),
  reminderRow({ id: 'r-bank', calendarId: 'cal-dana', creatorUserId: 1, forUserId: 2, title: 'Call the bank', startsAt: at('2026-10-22 15:00:00') }),
  reminderRow({ id: 'r-passport', calendarId: 'cal-dana', creatorUserId: 1, title: 'Renew the passport', startsAt: at('2026-10-22 12:00:00') }),
  reminderRow({ id: 'r-recycling', calendarId: 'cal-dana', creatorUserId: 1, title: 'Take out the recycling', startsAt: at('2026-10-24 00:00:00') }),
  reminderRow({ id: 'r-car', calendarId: 'cal-dana', creatorUserId: 1, title: 'Lock the car', startsAt: at('2026-10-23 23:59:00') }),
  reminderRow({ id: 'r-plumber', calendarId: 'cal-dana', creatorUserId: 1, title: 'Call the plumber', startsAt: at('2026-10-20 10:00:00') }),
  // Raziel's shared calendar, and his PRIVATE one: Dana sees only the reminders he set for her
  nativeEvent({ id: 'n-movies', calendarId: 'cal-raz', creatorUserId: 2, title: 'Movie marathon', startsAt: at('2026-10-23 22:00:00'), endsAt: at('2026-10-24 02:00:00') }),
  nativeEvent({ id: 'n-pilates', calendarId: 'cal-raz', creatorUserId: 2, title: 'Pilates', startsAt: at('2026-10-22 19:00:00'), endsAt: at('2026-10-22 20:00:00') }),
  reminderRow({ id: 'r-cake', calendarId: 'cal-raz', creatorUserId: 2, forUserId: 1, title: 'Pick up the cake', startsAt: at('2026-10-24 18:00:00') }),
  reminderRow({ id: 'r-milk', calendarId: 'cal-raz-private', creatorUserId: 2, forUserId: 1, title: 'Buy milk', startsAt: at('2026-10-22 17:00:00') }),
  reminderRow({ id: 'r-vitamins', calendarId: 'cal-raz-private', creatorUserId: 2, forUserId: 1, title: 'Vitamins', startsAt: at('2026-10-20 08:00:00'), rrule: 'FREQ=DAILY' }),
  reminderRow({ id: 'r-vet', calendarId: 'cal-raz-private', creatorUserId: 2, forUserId: 1, title: 'Book the vet', startsAt: at('2026-10-19 09:00:00') }),
  reminderRow({ id: 'r-surprise', calendarId: 'cal-raz-private', creatorUserId: 2, title: 'Plan the surprise', startsAt: at('2026-10-22 12:00:00') }),
  // Noam, on his own
  nativeEvent({ id: 'n-gym', calendarId: 'cal-noam', creatorUserId: 3, title: 'Gym', startsAt: at('2026-10-01 07:00:00'), endsAt: at('2026-10-01 08:00:00'), rrule: 'FREQ=DAILY' }),
  nativeEvent({ id: 'n-galilee', calendarId: 'cal-noam', creatorUserId: 3, title: 'Galilee trip', startsAt: at('2026-10-23 00:00:00'), endsAt: at('2026-10-25 23:59:00'), allDay: true }),
  nativeEvent({ id: 'n-late', calendarId: 'cal-noam', creatorUserId: 3, title: 'Late call', startsAt: at('2026-10-22 23:00:00'), endsAt: at('2026-10-23 01:00:00') }),
  reminderRow({ id: 'r-garden', calendarId: 'cal-noam', creatorUserId: 3, title: 'Water the garden', startsAt: at('2026-10-24 00:00:00') }),
  nativeEvent({ id: 'n-dinner', calendarId: 'cal-noam', creatorUserId: 3, title: 'Dinner with Lena', startsAt: at('2026-10-28 20:00:00'), endsAt: at('2026-10-28 22:00:00') }),
  // Omri's one FamCal event, on Thursday; Friday has none
  nativeEvent({ id: 'n-parents', calendarId: 'cal-omri', creatorUserId: 16, title: 'Parent meeting', startsAt: at('2026-10-22 18:00:00'), endsAt: at('2026-10-22 19:00:00') }),
  // Lior's reminder for Tom, a Google user: never in Tom's summary (R3)
  reminderRow({ id: 'r-lior', calendarId: 'cal-lior', creatorUserId: 6, forUserId: 5, title: 'Pick up the dry cleaning', startsAt: at('2026-10-22 09:00:00') }),
] as unknown as Row[];
db.states = [
  reminderState({ seriesEventId: 'r-plants', originalStartsAt: at('2026-10-22 08:00:00'), doneAt: at('2026-10-22 08:10:00'), doneByUserId: 1 }),
  reminderState({ seriesEventId: 'r-passport', originalStartsAt: at('2026-10-22 12:00:00'), snoozedUntil: at('2099-01-01 09:00:00') }),
  reminderState({ seriesEventId: 'r-vitamins', originalStartsAt: at('2026-10-21 08:00:00'), doneAt: at('2026-10-21 08:05:00') }),
] as unknown as Row[];

// ---- Google: each calendar's events, as events.list returns them ----

type GoogleFixture = {
  id: string;
  summary: string;
  /** A Date for a timed event; yyyy-MM-dd for an all-day one (the end exclusive). */
  start: Date | string;
  end: Date | string;
  description?: string;
  location?: string;
  eventType?: string;
  recurringEventId?: string;
  attendees?: { email?: string; self?: boolean; responseStatus: string }[];
  reminders?: { useDefault: boolean };
  /** A deliberate change of the reader (spec §3.3): C1/C2 drop the item, C3 makes its description plain text. */
  changed?: 'C1' | 'C2' | 'C3';
};

const GALI_CAL = 'gali@example.com';
const TOM_CAL = 'tom@example.com';
const KIDS_CAL = 'kids@group.calendar.google.com';
const FAMILY_CAL = 'family@group.calendar.google.com';
const BIRTHDAYS_CAL = 'addressbook#contacts@group.v.calendar.google.com';

/** The instances of a repeating Google event: one per day listed, at `time` for `minutes`. */
function instances(seriesId: string, summary: string, days: string[], time: string, minutes: number): GoogleFixture[] {
  return days.map(day => {
    const start = at(`${day} ${time}:00`);
    return { id: `${seriesId}_${day.replaceAll('-', '')}`, summary, start, end: new RealDate(start.getTime() + minutes * 60_000), recurringEventId: seriesId };
  });
}
const daysFrom = (first: string, count: number) => Array.from({ length: count }, (_, i) => {
  const d = new RealDate(`${first}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
});

const GOOGLE: Record<string, { summary: string; events: GoogleFixture[] }> = {
  [GALI_CAL]: {
    summary: 'Gali',
    events: [
      { id: 'g-standup', summary: 'Team standup', start: at('2026-10-22 09:30:00'), end: at('2026-10-22 09:45:00'), location: 'Zoom', reminders: { useDefault: true } },
      { id: 'g-pitch', summary: 'Vendor pitch', start: at('2026-10-22 11:00:00'), end: at('2026-10-22 12:00:00'), attendees: [{ self: true, responseStatus: 'declined' }], changed: 'C2' },
      { id: 'g-budget', summary: 'Budget review', start: at('2026-10-22 12:30:00'), end: at('2026-10-22 13:00:00'), attendees: [{ email: 'boss@example.com', responseStatus: 'declined' }, { self: true, responseStatus: 'accepted' }] },
      { id: 'g-dentist', summary: 'Dentist', start: at('2026-10-22 14:00:00'), end: at('2026-10-22 15:00:00'), location: '12 Herzl St', description: 'Bring the insurance card\nand the x-rays' },
      {
        // An Outlook or Teams invite's HTML: a table row, a heading, a paragraph.
        id: 'g-review', summary: 'Quarterly review', start: at('2026-10-22 15:00:00'), end: at('2026-10-22 15:45:00'), changed: 'C3',
        description: '<table><tr><td>Agenda</td><td>Budget</td></tr></table><h2>Join</h2><p>Room 4</p>',
      },
      { id: 'g-focus', summary: 'Focus time', start: at('2026-10-22 16:00:00'), end: at('2026-10-22 17:00:00'), eventType: 'focusTime', changed: 'C1' },
      { id: 'g-release', summary: 'Release window', start: at('2026-10-22 22:00:00'), end: at('2026-10-23 02:00:00') },
      { id: 'g-office', summary: 'Office', start: '2026-10-23', end: '2026-10-24', eventType: 'workingLocation', changed: 'C1' },
      {
        id: 'g-planning', summary: 'Planning', start: at('2026-10-23 10:00:00'), end: at('2026-10-23 11:00:00'), changed: 'C3',
        description: '<p>Agenda:</p><ul><li>Budget</li><li>Hiring</li></ul><a href="https://meet.example.com/abc">Join the call</a>',
      },
      { id: 'g-alarm', summary: 'Set the alarm', start: at('2026-10-24 23:59:00'), end: at('2026-10-24 23:59:00') },
      { id: 'g-away', summary: 'Out of office', start: at('2026-10-26 09:00:00'), end: at('2026-10-26 18:00:00'), eventType: 'outOfOffice', changed: 'C1' },
      { id: 'g-book_20261027', summary: 'Book club', start: at('2026-10-27 20:00:00'), end: at('2026-10-27 21:30:00'), recurringEventId: 'g-book' },
      ...instances('g-choir', 'Choir', ['2026-10-18', '2026-10-25', '2026-11-01', '2026-11-08'], '18:00', 90),
      ...instances('g-run', 'Morning run', daysFrom('2026-10-15', 27), '07:30', 30),
    ],
  },
  [TOM_CAL]: {
    summary: 'Tom',
    events: [
      { id: 'g-conference', summary: 'Design conference', start: '2026-10-21', end: '2026-10-24' },
      { id: 'g-home-office', summary: 'Home office', start: at('2026-10-22 08:00:00'), end: at('2026-10-22 17:00:00'), eventType: 'workingLocation', changed: 'C1' },
      { id: 'g-yoga', summary: 'Yoga', start: at('2026-10-22 18:00:00'), end: at('2026-10-22 19:00:00') },
      { id: 'g-gym', summary: 'Gym', start: at('2026-10-24 10:00:00'), end: at('2026-10-24 11:00:00') },
      { id: 'g-business-trip', summary: 'Business trip', start: '2026-10-27', end: '2026-10-30' },
    ],
  },
  [KIDS_CAL]: {
    summary: 'Noa',
    events: [
      { id: 'g-school', summary: 'School', start: at('2026-10-22 08:00:00'), end: at('2026-10-22 13:50:00'), location: 'Oak School' },
      { id: 'g-sleepover', summary: "Sleepover at Ben's", start: at('2026-10-23 18:00:00'), end: at('2026-10-24 10:00:00') },
      { id: 'g-party', summary: 'Class party', start: at('2026-10-23 22:00:00'), end: at('2026-10-24 02:00:00') },
      { id: 'g-trip', summary: 'Field trip', start: '2026-10-26', end: '2026-10-27' },
    ],
  },
  [FAMILY_CAL]: {
    summary: 'Family',
    events: [
      { id: 'g-soccer', summary: 'Soccer - Noa and Itai', start: at('2026-10-22 16:00:00'), end: at('2026-10-22 17:30:00'), location: 'City Park' },
      { id: 'g-flight', summary: 'Night flight', start: at('2026-10-25 00:30:00'), end: at('2026-10-25 03:00:00') },
      { id: 'g-brunch', summary: 'Brunch', start: at('2026-10-26 10:00:00'), end: at('2026-10-26 11:00:00') },
    ],
  },
  [BIRTHDAYS_CAL]: {
    summary: 'Birthdays',
    events: [{ id: 'g-bday', summary: "Grandma Ruth's birthday", start: '2026-10-24', end: '2026-10-25', eventType: 'birthday' }],
  },
  'ori@example.com': { summary: 'Ori', events: [{ id: 'g-ori', summary: 'Standup (Ori)', start: at('2026-10-22 09:00:00'), end: at('2026-10-22 09:30:00') }] },
  'shira@example.com': { summary: 'Shira', events: [{ id: 'g-shira', summary: 'Standup (Shira)', start: at('2026-10-22 09:00:00'), end: at('2026-10-22 09:30:00') }] },
  'maya@example.com': { summary: 'Maya', events: [{ id: 'g-maya', summary: 'Dentist (Maya)', start: at('2026-10-22 10:00:00'), end: at('2026-10-22 11:00:00') }] },
  'ella@example.com': {
    summary: 'Ella',
    events: [
      { id: 'g-ella-thu', summary: 'Dentist (Ella)', start: at('2026-10-22 10:00:00'), end: at('2026-10-22 11:00:00') },
      { id: 'g-ella-sun', summary: 'Pottery (Ella)', start: at('2026-10-25 10:00:00'), end: at('2026-10-25 11:00:00') },
      { id: 'g-ella-mon', summary: 'Haircut (Ella)', start: at('2026-10-26 10:00:00'), end: at('2026-10-26 11:00:00') },
    ],
  },
  // Not listed: yoni-old@…, avi-old1@… and avi-old2@… are gone (404).
};

/** The repeating events' masters, which the week lookahead asks for (events.get). */
const MASTERS: Record<string, string[]> = {
  'g-choir': ['RRULE:FREQ=WEEKLY;BYDAY=SU'],
  'g-run': ['RRULE:FREQ=DAILY'],
  'g-book': ['RRULE:FREQ=MONTHLY;BYDAY=4TU'],
};

/** The titles C1/C2 take out of a Google read: Google lists them, the reader doesn't. */
const DROPPED_SUMMARIES = new Set(Object.values(GOOGLE).flatMap(c => c.events.filter(e => e.changed === 'C1' || e.changed === 'C2').map(e => e.summary)));

// ---- Google's failures, as its clients throw them ----

const invalidGrant = () => Object.assign(new Error('invalid_grant'), {
  status: 400, response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } },
});
const insufficientScopes = () => Object.assign(new Error('Request had insufficient authentication scopes.'), {
  code: 403, status: 403, response: { status: 403, data: { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } } },
});
const rateLimited = () => Object.assign(new Error('Rate Limit Exceeded'), {
  code: 403, status: 403, response: { status: 403, data: { error: { code: 403, errors: [{ reason: 'rateLimitExceeded' }] } } },
});
const backendError = () => Object.assign(new Error('Backend Error'), { code: 500, status: 500, response: { status: 500 } });
const notFound = () => Object.assign(new Error('Not Found'), { code: 404, status: 404, response: { status: 404 } });

// ---- Users ----

const cal = (calendarId: string, name: string, labels: CalendarLabel[], more: Partial<CalendarAssignment> = {}): CalendarAssignment =>
  ({ calendarId, labels, name, color: '#039BE5', ...more });

function person(id: number, name: string, extra: Record<string, unknown>): UserConfig {
  return {
    id, telegramId: 1000 + id, name, englishName: name, gender: 'female', language: 'en', culture: 'default',
    calendarSource: 'GOOGLE', googleRefreshToken: '', calendarAssignments: undefined, pairingId: null,
    isAdmin: true, messagingPlatform: 'telegram', whatsappPhone: null, whatsappBsuid: null,
    location: 'Tel Aviv', weatherEnabled: false, textSummaryEnabled: true, voiceSummaryEnabled: true,
    includeLookaheadInTomorrow: false, includeWeeklyInLookahead: true, lookaheadAlways7Days: false, globalRules: [],
    suspendedAt: null, unreachableSince: null, preferredMorningHour: 7, preferredEveningHour: 19,
    dailySummaryDays: [0, 1, 2, 3, 4, 5, 6], tomorrowSummaryDays: [0, 1, 2, 3, 4, 5, 6],
    ...extra,
  } as unknown as UserConfig;
}
const own = (calendarId: string, name: string) => [cal(calendarId, name, ['primary', 'yours'])];

/** FamCal, paired: own and kids' calendars, Raziel's shared one, and his private reminders for her. */
const DANA = person(1, 'Dana', { calendarSource: 'NATIVE', pairingId: 'pair-1', language: 'he', culture: 'jewish', includeLookaheadInTomorrow: true });
/** FamCal, solo. */
const NOAM = person(3, 'Noam', { calendarSource: 'NATIVE', gender: 'male', language: 'ru' });
/** Google, with yours, spouse, kids, family and birthdays calendars. */
const GALI = person(4, 'Gali', {
  googleRefreshToken: 'tok-gali', includeLookaheadInTomorrow: true,
  calendarAssignments: [
    cal(GALI_CAL, 'Gali', ['primary', 'yours']),
    cal(TOM_CAL, 'Tom', ['spouse'], { personName: 'Tom', personEnglishName: 'Tom', personGender: 'male' }),
    cal(KIDS_CAL, 'Noa', ['kids'], { personName: 'Noa' }),
    cal(FAMILY_CAL, 'Family', []),
    cal(BIRTHDAYS_CAL, 'Birthdays', ['birthdays']),
  ],
});
/** Google, paired with Lior, a FamCal user who set him a reminder. */
const TOM = person(5, 'Tom', { gender: 'male', googleRefreshToken: 'tok-tom', pairingId: 'pair-2', calendarAssignments: own(TOM_CAL, 'Tom') });
/** Google, dead token. */
const ORI = person(7, 'Ori', { gender: 'male', googleRefreshToken: 'tok-ori', calendarAssignments: own('ori@example.com', 'Ori') });
/** Google, missing scopes. */
const SHIRA = person(8, 'Shira', { googleRefreshToken: 'tok-shira', calendarAssignments: own('shira@example.com', 'Shira') });
/** Google, one calendar gone. */
const YONI = person(9, 'Yoni', {
  gender: 'male', googleRefreshToken: 'tok-yoni',
  calendarAssignments: [cal('yoni-old@group.calendar.google.com', 'Old', []), cal(FAMILY_CAL, 'Family', [])],
});
const MAYA = person(10, 'Maya', { googleRefreshToken: 'tok-maya', calendarAssignments: own('maya@example.com', 'Maya') });
const ELLA = person(11, 'Ella', { googleRefreshToken: 'tok-ella', calendarAssignments: own('ella@example.com', 'Ella') });
/** Google, every chosen calendar gone. */
const AVI = person(12, 'Avi', {
  gender: 'male', googleRefreshToken: 'tok-avi',
  calendarAssignments: [cal('avi-old1@group.calendar.google.com', 'Old 1', []), cal('avi-old2@group.calendar.google.com', 'Old 2', [])],
});
// The week start by country: nothing to read, only their weeks' days.
const SAM = person(13, 'Sam', { gender: 'male', googleRefreshToken: 'tok-sam', calendarAssignments: [], location: 'Brooklyn' });
const OLIVIA = person(14, 'Olivia', { googleRefreshToken: 'tok-olivia', calendarAssignments: [], location: 'London' });
const KARIM = person(15, 'Karim', { gender: 'male', googleRefreshToken: 'tok-karim', calendarAssignments: [], location: 'Cairo' });

/** A legacy Google user (calendarSource GOOGLE), choices stored, token cleared (a scope error): googleState 'reconnect'. The reader leaves his Google out. */
const OMRI = person(16, 'Omri', { gender: 'male', googleRefreshToken: '', calendarAssignments: own('omri@gmail.com', 'Omri') });

const USERS = [DANA, NOAM, GALI, TOM, ORI, SHIRA, YONI, MAYA, ELLA, AVI, SAM, OLIVIA, KARIM, OMRI];
const nameOfChat = (chatId: unknown) => USERS.find(u => u.telegramId === Number(chatId))?.name ?? `chat ${String(chatId)}`;
const userOfChat = (chatId: unknown) => USERS.find(u => u.telegramId === Number(chatId));
const ownerOfToken = (token: string) => USERS.find(u => u.googleRefreshToken === token)?.name ?? `token ${token}`;
const TIMEZONES: Record<number, string> = { [SAM.id]: NY, [OLIVIA.id]: LONDON, [KARIM.id]: CAIRO };

// ---- The knobs a check turns ----

/** Every user's timezone, when set; otherwise their own. */
let zoneOverride: string | undefined;
/** The scheduled batch's users. */
let batch: UserConfig[] = [];
/** How long each token step takes on the fake clock. */
let tokenStepMs = 0;
/** How long a user's first timezone lookup takes (a Nominatim miss); later ones are cached. */
let timezoneLookupMs = 0;
const timezoneLooked = new Set<number>();
/** How long the AI takes to stream a summary. */
let aiStreamMs = 0;

/** An answer that comes after a while (on whichever timers run): a failure, or the calendar. */
type DelayedStep = { after: number; then: Error | 'ok' };
type GoogleStep = 'ok' | 'empty' | 'hang' | Error | DelayedStep;
const isDelayed = (step: GoogleStep): step is DelayedStep => typeof step === 'object' && !(step instanceof Error);
/**
 * What a refresh token's calls do, by their number (from 1): the token step, and each
 * calendar's lists. Unset: 'ok'.
 */
type GoogleBehaviour = { token?: (n: number) => GoogleStep; list?: (calendarId: string, n: number) => GoogleStep };
let behaviours: Record<string, GoogleBehaviour> = {};
/** Accounts that fail every call: a dead token, or permissions the user unticked. */
const ACCOUNT_STATE: Record<string, 'dead' | 'noScopes'> = { 'tok-ori': 'dead', 'tok-shira': 'noScopes' };
const callCounts = new Map<string, number>();
const nthCall = (key: string) => {
  const n = (callCounts.get(key) ?? 0) + 1;
  callCounts.set(key, n);
  return n;
};

const zoneOf = (u: { id: number }) => zoneOverride ?? TIMEZONES[u.id] ?? IL;

function reset(over: { now?: string; zone?: string } = {}) {
  log = [];
  prompts = [];
  captured = [];
  queries = [];
  timersAsked = [];
  behaviours = {};
  callCounts.clear();
  store.clear();
  zoneOverride = undefined;
  batch = [];
  tokenStepMs = 0;
  timezoneLookupMs = 0;
  timezoneLooked.clear();
  aiStreamMs = 0;
  sentAt = [];
  clock = at(over.now ?? '2026-10-22 07:00:00', over.zone ?? IL).getTime();
}

// ---- The fake Google client ----

const local = (iso: string) => formatInTimeZone(new Date(iso), IL, 'MM-dd HH:mm');
const instantOf = (v: Date | string, tz: string) => (typeof v === 'string' ? startOfLocalDay(v, tz).getTime() : v.getTime());
const when = (v: Date | string, tz: string) => (typeof v === 'string' ? { date: v } : { dateTime: formatInTimeZone(v, tz, "yyyy-MM-dd'T'HH:mm:ssXXX") });

/** An event as events.list returns it, with times in the zone the request asked for. */
function rawEvent(e: GoogleFixture, tz: string) {
  return {
    id: e.id, status: 'confirmed', summary: e.summary, description: e.description, location: e.location,
    start: when(e.start, tz), end: when(e.end, tz),
    recurringEventId: e.recurringEventId, originalStartTime: e.recurringEventId ? when(e.start, tz) : undefined,
    eventType: e.eventType ?? 'default', attendees: e.attendees, reminders: e.reminders,
    htmlLink: `https://www.google.com/calendar/event?eid=${e.id}`,
  };
}

/** The OAuth client calendar.ts builds (new auth.OAuth2, setCredentials); the reader runs its token step first. */
class FakeOAuth2 {
  refreshToken = '';
  setCredentials(credentials: { refresh_token?: string | null }) {
    this.refreshToken = credentials.refresh_token ?? '';
  }
  async getAccessToken(): Promise<{ token: string }> {
    const token = this.refreshToken;
    log.push(`token ${ownerOfToken(token)}`);
    clock += tokenStepMs;
    if (ACCOUNT_STATE[token] === 'dead') throw invalidGrant();
    const step = behaviours[token]?.token?.(nthCall(`token|${token}`)) ?? 'ok';
    if (step === 'hang') return new Promise<never>(() => {});
    if (step instanceof Error) throw step;
    return { token: `access-${token}` };
  }
}

/** The calendar client the reader builds from that OAuth client. */
function fakeCalendarClient({ auth }: { auth: FakeOAuth2 }) {
  const token = auth.refreshToken;
  const who = ownerOfToken(token);
  const gate = () => {
    if (ACCOUNT_STATE[token] === 'dead') throw invalidGrant();
    if (ACCOUNT_STATE[token] === 'noScopes') throw insufficientScopes();
  };
  return {
    calendars: {
      get: async ({ calendarId }: { calendarId: string }) => {
        log.push(`get ${who} ${calendarId}`);
        gate();
        const found = GOOGLE[calendarId];
        if (!found) throw notFound();
        return { data: { summary: found.summary } };
      },
    },
    events: {
      list: async (params: { calendarId: string; timeMin: string; timeMax: string; timeZone?: string }, options?: { timeout?: number }) => {
        log.push(`list ${who} ${params.calendarId} ${local(params.timeMin)}..${local(params.timeMax)} ${options?.timeout ?? 'untimed'}`);
        gate();
        let step = behaviours[token]?.list?.(params.calendarId, nthCall(`list|${token}|${params.calendarId}`)) ?? 'ok';
        if (isDelayed(step)) {
          // A request's own timeout cuts a slow answer off, as gaxios does.
          const { after, then } = step;
          const timeout = options?.timeout ?? Infinity;
          await new Promise(resolve => setTimeout(resolve, Math.min(after, timeout)));
          if (after > timeout) throw Object.assign(new Error(`network timeout at: ${params.calendarId}`), { type: 'request-timeout' });
          step = then;
        }
        if (step === 'hang') return new Promise<never>(() => {});
        if (step instanceof Error) throw step;
        const found = GOOGLE[params.calendarId];
        if (!found) throw notFound();
        const tz = params.timeZone ?? IL;
        const from = Date.parse(params.timeMin);
        const to = Date.parse(params.timeMax);
        // Google's rule: the event ends after timeMin and starts before timeMax.
        const items = step === 'empty' ? [] : found.events
          .filter(e => instantOf(e.end, tz) > from && instantOf(e.start, tz) < to)
          .sort((a, b) => instantOf(a.start, tz) - instantOf(b.start, tz))
          .map(e => rawEvent(e, tz));
        return { data: { summary: found.summary, items } };
      },
      get: async ({ calendarId, eventId }: { calendarId: string; eventId: string }) => {
        log.push(`master ${who} ${eventId}`);
        gate();
        const recurrence = MASTERS[eventId];
        if (!recurrence || !GOOGLE[calendarId]) throw notFound();
        return { data: { recurrence } };
      },
    },
  };
}

// ---- Redis, in memory: dedup marks, the gone-warning gate, story texts ----

const store = new Map<string, string>();
const fakeRedis = {
  get: async (key: string) => {
    redisKeys.add(key);
    return store.get(key) ?? null;
  },
  set: async (key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
    redisKeys.add(key);
    if (opts?.nx && store.has(key)) return null;
    if (key.startsWith('summary:dedup:')) {
      const [, , type, userId, date] = key.split(':');
      log.push(`mark ${USERS.find(u => u.id === Number(userId))?.name} ${type} ${date}`);
    }
    store.set(key, String(value));
    return 'OK';
  },
  del: async (...keys: string[]) => keys.filter(k => store.delete(k)).length,
  mget: async (...keys: string[]) => keys.map(k => {
    redisKeys.add(k);
    return store.get(k) ?? null;
  }),
};

// ---- The bot's texts, read from the files the bot reads ----

type BotTexts = {
  errors: Record<string, string>;
  tokenExpired: { title: string; message: string };
  insufficientScopes: { title: string; message: string };
};
const BOT = Object.fromEntries(['en', 'he', 'ru'].map(lang => {
  const t = (JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${lang}.json`), 'utf8')) as { bot: BotTexts }).bot;
  return [lang, {
    token: `${t.tokenExpired.title}\n\n${t.tokenExpired.message}`,
    scopes: `${t.insufficientScopes.title}\n\n${t.insufficientScopes.message}`,
    unreachable: t.errors.googleUnreachable,
    outage: t.errors.googleOutageNote,
  }];
})) as Record<string, { token: string; scopes: string; unreachable: string; outage: string }>;

/** What the AI answers every prompt with. */
const AI_TEXT = 'Here is your day.';

/** A sent text by what it is, in its recipient's language. */
function kindOf(text: string, lang: string): string {
  const t = BOT[lang] ?? BOT.en;
  if (text === t.unreachable) return 'unreachable';
  if (text === t.token) return 'token';
  if (text === t.scopes) return 'scopes';
  if (text.startsWith(AI_TEXT)) return text.includes(t.outage) ? 'summary with outage line' : 'summary';
  return `other ${JSON.stringify(text.slice(0, 60))}`;
}
const langOfChat = (chatId: unknown) => userOfChat(chatId)?.language ?? 'en';

// ---- Telegram, the draft and the voice note ----

let nextMessageId = 1;
type ReplyMarkup = { inline_keyboard?: { web_app?: { url: string } }[][] };
function messagingService(via: 'telegram' | 'whatsapp') {
  return {
    sendMessage: async (chatId: number | string, text: string, options?: MessageOptions) => {
      const button = (options?.replyMarkup as ReplyMarkup | undefined)?.inline_keyboard?.[0]?.[0]?.web_app?.url ?? '';
      log.push(`send ${nameOfChat(chatId)} ${kindOf(text, langOfChat(chatId))}${button.includes('/refresh-token') ? ' + refresh button' : ''}${via === 'whatsapp' ? ' (WhatsApp)' : ''}`);
      sentAt.push(`send ${nameOfChat(chatId)} @${clock}`);
      return nextMessageId++;
    },
    updateMessage: async () => {},
    deleteMessage: async () => {},
    sendTypingIndicator: async () => {},
  };
}
const telegram = messagingService('telegram');
const whatsapp = messagingService('whatsapp');

/** An open streaming draft, as the Mini App's on-demand path hands one in. */
function draftFor(user: UserConfig): StreamMessageHandle {
  const lang = user.language ?? 'en';
  return {
    pushStage: () => {},
    pushDelta: () => {},
    finalize: async (text: string) => {
      log.push(`draft ${user.name} finalized: ${kindOf(text, lang)}`);
      sentAt.push(`draft ${user.name} @${clock}`);
      return nextMessageId++;
    },
    cancel: async (text: string) => {
      log.push(`draft ${user.name} replaced: ${kindOf(text, lang)}`);
    },
  };
}

// ---- The AI ----

const aiResult = (): AICompletionResult => ({
  text: AI_TEXT, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn', model: 'fake-model', durationMs: 0,
});

// ---- Stubs: static imports go through Module._load, import() through a load hook ----

const SRC = path.resolve(__dirname, '../src');
type RealModule = Record<string, unknown>;
const stubs: Record<string, object | ((real: RealModule) => object)> = {
  '@googleapis/calendar': { __esModule: true, calendar: fakeCalendarClient, auth: { OAuth2: FakeOAuth2 } },
  [`${SRC}/utils/prisma.ts`]: { prisma: fakePrisma, withRetry: <T>(fn: () => Promise<T>) => fn() },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/lib/timezone.ts`]: {
    resolveUserTimezone: async (u: { id: number }) => {
      if (timezoneLookupMs > 0 && !timezoneLooked.has(u.id)) {
        timezoneLooked.add(u.id);
        await new Promise(resolve => setTimeout(resolve, timezoneLookupMs));
      }
      return zoneOf(u);
    },
  },
  [`${SRC}/services/user-service.ts`]: {
    getUserByIdentifier: async (id: number | string) => {
      const found = userOfChat(id);
      return found ? { ...found } : null;
    },
    getUserByTelegramId: async (id: number) => {
      const found = userOfChat(id);
      return found ? { ...found } : null;
    },
    getAllUsers: async () => batch.map(u => ({ ...u })),
    getWhatsAppChatId: (u: UserConfig) => u.whatsappPhone || u.whatsappBsuid || null,
    // A tripwire: missing permissions keep the token now (a cleared one made stale Google choices)
    clearGoogleRefreshToken: async (telegramId: bigint) => {
      log.push(`cleared the token of ${String(telegramId)}`);
    },
  },
  [`${SRC}/services/ai-provider.ts`]: {
    generateAICompletion: async (prompt: string) => {
      prompts.push(prompt);
      return aiResult();
    },
    streamAICompletion: async (opts: { prompt: string; onTextDelta?: (delta: string, accumulated: string) => void | Promise<void> }) => {
      prompts.push(opts.prompt);
      if (aiStreamMs > 0) await new Promise(resolve => setTimeout(resolve, aiStreamMs));
      await opts.onTextDelta?.(AI_TEXT, AI_TEXT);
      return aiResult();
    },
  },
  [`${SRC}/services/hebrew-holidays.ts`]: { getHolidaysForDate: async () => [], weekParashaFor: () => null },
  [`${SRC}/services/messaging/index.ts`]: {
    MessagingPlatform, MessageFormat,
    getMessagingService: (platform: MessagingPlatform) => (platform === MessagingPlatform.WHATSAPP ? whatsapp : telegram),
  },
  [`${SRC}/services/telegram/bot.ts`]: { getMessagingService: () => telegram },
  [`${SRC}/services/telegram/voice.ts`]: {
    sendVoiceMessage: async (chatId: number | string, text: string) => {
      log.push(`voice ${nameOfChat(chatId)}${text.includes(BOT[langOfChat(chatId)].outage) ? ' with outage line' : ''}`);
    },
    sendWeeklyVoiceMessage: async () => {},
  },
  [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => {}, addBreadcrumb: () => {} },
  [`${SRC}/services/subscription-service.ts`]: { checkFeatureAccess: async () => ({ allowed: true }), incrementUsage: async () => {} },
  [`${SRC}/services/kid-name-detection.ts`]: { sendKidNameFollowUp: async () => {} },
  [`${SRC}/services/magic-link.ts`]: { generateMagicLink: async () => 'https://famcal.test/magic' },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (error: unknown, context: string, _extra?: unknown, severity = 'error') => {
      captured.push(`${context} ${severity} ${error instanceof Error ? error.message : String(error)}`);
    },
    captureWarning: (message: string, context: string) => {
      captured.push(`${context} warning ${message}`);
    },
    captureInfo: () => {},
  },
  [`${SRC}/utils/error-notifier.ts`]: {
    notifyAdminWarning: async (title: string) => {
      log.push(`admin warning ${title}`);
    },
    notifyAdminError: async (title: string) => {
      log.push(`admin error ${title}`);
      adminErrors.push(title);
    },
  },
};

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-week-lookahead.ts).
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request, parent, isMain) {
  if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, parent, isMain);
};

/** A partial fake is built once from the real module, then served to require() and import() alike. */
const built = new Map<string, object>();
const loadingReal = new Set<string>();
function fakeFor(key: string, loadReal: () => unknown): object {
  const stub = stubs[key];
  if (typeof stub !== 'function') return stub;
  if (!built.has(key)) {
    loadingReal.add(key);
    try {
      built.set(key, stub(loadReal() as RealModule));
    } finally {
      loadingReal.delete(key);
    }
  }
  return built.get(key)!;
}

const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  const key = request in stubs ? request : resolved;
  if (!(key in stubs) || loadingReal.has(key)) return realLoad.call(this, request, parent, isMain);
  return fakeFor(key, () => realLoad.call(this, request, parent, isMain));
};

// summary.ts and commands.ts load the timezone, the user service, Redis, the notifier,
// the magic link and the kid-name follow-up with import(), which goes through the ES
// module loader; each gets the same fake, as an ES module.
(globalThis as { paritySmokeFake?: (file: string) => object }).paritySmokeFake = file =>
  fakeFor(file, () => realLoad.call(Module, file, null, false));
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs) || loadingReal.has(file)) return nextLoad(url, context);
    const fake = (globalThis as unknown as { paritySmokeFake: (file: string) => object }).paritySmokeFake(file);
    const names = Object.keys(fake).map(name => `export const ${name} = fake[${JSON.stringify(name)}];`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.paritySmokeFake(${JSON.stringify(file)});\n${names}\n` };
  },
});

// ---- Helpers over the log ----

/** The log with each read's run of list calls folded into one line: "list <who> ×<n> <window> <timeout>". */
function folded(lines: readonly string[] = log): string[] {
  const out: string[] = [];
  let runKey = '';
  let runCount = 0;
  // A last empty line flushes the final run.
  for (const line of [...lines, '']) {
    const m = /^list (\S+) \S+ (.+)$/.exec(line);
    const key = m ? `${m[1]} ${m[2]}` : '';
    if (key && key === runKey) {
      runCount++;
      continue;
    }
    if (runKey) out.push(`list ${runKey.replace(' ', ` ×${runCount} `)}`);
    runKey = key;
    runCount = key ? 1 : 0;
    if (!key && line !== '') out.push(line);
  }
  return out;
}
/** What summary.ts itself reported to Sentry; the reader's own warnings are checked where they matter. */
const reportedBySummary = () => captured.filter(c => c.startsWith('summary-'));
/** Let fire-and-forget work (the reader's gone warning, voice notes) finish. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};

async function main() {
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const keep = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  Object.assign(console, { log: keep, error: keep, warn: keep, info: keep });

  const summary = await import('../src/services/telegram/summary');
  const commands = await import('../src/services/telegram/commands');
  const { getWeekLookahead, getNextWeekLookahead } = await import('../src/services/week-lookahead');
  const { getCalendarAssignmentsForUser } = await import('../src/services/calendar-provider/user-calendars');
  // These timelines read one user after another on a single fake clock; the batch's own
  // concurrency is checked in smoke-summary-retry.
  summary.__setSummaryConcurrencyForTests(1);
  summary.__setScheduledRetrySleepForTests(async (ms: number) => {
    log.push(`sleep ${ms}`);
    clock += ms;
  });

  const CLOCKS = [
    { name: 'Thursday 07:00', local: '2026-10-22 07:00:00' },
    { name: 'Thursday 19:00', local: '2026-10-22 19:00:00' },
    { name: 'Friday 00:30', local: '2026-10-23 00:30:00' },
    { name: 'Saturday 19:00', local: '2026-10-24 19:00:00' },
    { name: "Sunday 25 October 07:00, Israel's 25-hour day", local: '2026-10-25 07:00:00' },
  ];

  // ---- The golden: what (a)-(c) read and prompted before the providers' reads went ----

  const GOLDEN_FILE = path.resolve(__dirname, 'fixtures/digest-reader-golden.json');
  type Golden = { days: Record<string, unknown>; prompts: Record<string, string>; weeks: Record<string, unknown> };
  const taking = process.argv.includes('--write-golden-fixture');
  if (taking && fs.existsSync(GOLDEN_FILE)) {
    original.error(`${path.relative(process.cwd(), GOLDEN_FILE)} exists. Delete it first to take a new one.`);
    process.exit(1);
  }
  assert(taking || fs.existsSync(GOLDEN_FILE), `${GOLDEN_FILE} is missing: take it first (see the header)`);
  const golden: Golden = taking ? { days: {}, prompts: {}, weeks: {} } : JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8'));
  /** This run's answers, under the golden's keys. */
  const got: Golden = { days: {}, prompts: {}, weeks: {} };

  /** Fails unless this run has the golden's keys, in its order, each with the golden's answer. */
  function assertGolden(part: 'days' | 'weeks', count: number) {
    const keys = Object.keys(got[part]);
    assert(keys.length === count, `${keys.length} ${part}`);
    assertList(keys, Object.keys(golden[part]), `the golden's ${part}`);
    const differ = keys.filter(k => show(got[part][k]) !== show(golden[part][k]));
    assert(differ.length === 0, `${differ.length} of ${count} differ; the first, ${differ[0]}:\n     got  ${show(got[part][differ[0]])}\n     want ${show(golden[part][differ[0]])}`);
  }

  /** Where two prompts first differ, for a failure message. */
  function firstDifference(gotText: string, wantText: string): string {
    const a = gotText.split('\n');
    const b = wantText.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) return `line ${i + 1}:\n     got  ${JSON.stringify(a[i])}\n     want ${JSON.stringify(b[i])}`;
    }
    return 'nowhere';
  }

  // ---- (a) The day: the reader's, shaped ----

  type DayRead = { events: CalendarEvent[] } | { error: string };
  /** One day read as the summary makes it: the resolved ids, the summary's read, then shapeEventsForDay. */
  async function dayRead(user: UserConfig, kind: 'today' | 'tomorrow', zone: string): Promise<{ day: string; read: DayRead }> {
    const ids = (await getCalendarAssignmentsForUser(user)).map(a => a.calendarId);
    const today = localDate(new Date(), zone);
    const day = kind === 'today' ? today : nextDate(today);
    try {
      return { day, read: { events: shapeEventsForDay(await summary.readSummaryDay(user, ids, zone, day), day, zone) } };
    } catch (err) {
      return { day, read: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  /** The shaped lines in Israel, for the coverage check: "<user> <day> <title> [<span>]". */
  const shapedLines = new Set<string>();
  /** Every title the reads listed, in either zone. */
  const titles = new Set<string>();
  let tomQueries = 0;
  const tomEvents: CalendarEvent[] = [];

  for (const zone of [IL, NY]) {
    for (const c of CLOCKS) {
      for (const user of [DANA, NOAM, GALI, TOM, YONI, AVI, ORI, SHIRA]) {
        for (const kind of ['today', 'tomorrow'] as const) {
          reset({ now: c.local, zone });
          zoneOverride = zone;
          const { day, read } = await dayRead(user, kind, zone);
          if (user === TOM) tomQueries += queries.length;
          got.days[`${user.name}, ${kind} (${day}) at ${c.name} in ${zone}`] = read;
          if ('error' in read) continue;
          for (const e of read.events) titles.add(e.summary);
          if (user === TOM) tomEvents.push(...read.events);
          if (zone === IL) {
            for (const e of read.events) shapedLines.add(`${user.name} ${day} ${e.summary}${e.daySpan ? ` [${e.daySpan}]` : ''}`);
          }
        }
      }
    }
  }

  // ---- (b) The prompts ----

  /** The prompt one summary builds. */
  async function promptOf(user: UserConfig, kind: 'today' | 'tomorrow'): Promise<string> {
    prompts = [];
    const tomorrowFlag = kind === 'tomorrow' ? new Date(clock + 86_400_000) : undefined;
    await summary.prepareSummaryForUser(user, summary.readSummaryDay, tomorrowFlag);
    assert(prompts.length === 1, `${user.name} ${kind}: ${prompts.length} prompts`);
    return prompts[0];
  }
  const PROMPT_RUNS = [
    { name: 'the daily on Thursday 07:00', local: '2026-10-22 07:00:00', kind: 'today' as const },
    { name: 'the tomorrow summary on Thursday 19:00', local: '2026-10-22 19:00:00', kind: 'tomorrow' as const },
    { name: 'the tomorrow summary on Friday 19:00', local: '2026-10-23 19:00:00', kind: 'tomorrow' as const },
    { name: 'the daily on Sunday 25 October 07:00', local: '2026-10-25 07:00:00', kind: 'today' as const },
  ];
  for (const user of [DANA, GALI]) {
    for (const run of PROMPT_RUNS) {
      reset({ now: run.local });
      got.prompts[`${user.name}, ${run.name}`] = await promptOf(user, run.kind);
    }
  }

  // ---- (c) /week and /nextweek ----

  /** Google reads that did not go through the reader (no token step first, or calendars.get), and empty weeks. */
  const weekProblems: string[] = [];
  for (const local of ['2026-10-22 07:00:00', '2026-10-24 19:00:00', '2026-10-25 07:00:00']) {
    for (const user of [DANA, NOAM, GALI, TOM]) {
      const calendars = await getCalendarAssignmentsForUser(user);
      for (const [command, read] of [['/week', getWeekLookahead], ['/nextweek', getNextWeekLookahead]] as const) {
        reset({ now: local });
        const lookahead = await read(user, calendars);
        const where = `${user.name} ${command} at ${local}`;
        got.weeks[where] = JSON.parse(show(lookahead));
        if (user.calendarSource === 'GOOGLE' && (!log.some(l => l.startsWith('token ')) || log.some(l => l.startsWith('get ')))) {
          weekProblems.push(`${where}: not read through the reader: ${show(log)}`);
        }
        if (local === '2026-10-22 07:00:00' && lookahead.events.length === 0) weekProblems.push(`${where}: nothing listed`);
      }
    }
  }

  if (taking) {
    fs.mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true });
    fs.writeFileSync(GOLDEN_FILE, JSON.stringify(got, null, 1) + '\n');
    original.log(`Wrote ${Object.keys(got.days).length} days, ${Object.keys(got.prompts).length} prompts and ${Object.keys(got.weeks).length} weeks to ${path.relative(process.cwd(), GOLDEN_FILE)}`);
    process.exit(0);
  }

  await check('(a) the day: the reader\'s day, shaped, is the golden\'s for every user, zone (Israel, New York), clock and today/tomorrow', async () => {
    assertGolden('days', 160);
  });

  await check('(a) the reader leaves out what Google lists and the summaries never take: working-location, focus time, out of office, a declined invite (C1/C2)', async () => {
    assert(DROPPED_SUMMARIES.size === 5, `${DROPPED_SUMMARIES.size} C1/C2 titles in the fixture`);
    const listed = [...DROPPED_SUMMARIES].filter(title => titles.has(title));
    assert(listed.length === 0, `listed: ${show(listed)}`);
  });

  await check('(a) the fixtures reach the shaping: overnight, sleepover, multi-day all-day, zero-length at 00:00 and 23:59, the 25-hour day, partner reminders', async () => {
    const want = [
      "Dana 2026-10-22 Sleepover at Ben's [endsLater]",
      "Dana 2026-10-23 Sleepover at Ben's [continues]",
      'Dana 2026-10-23 Movie marathon [endsLater]',
      'Dana 2026-10-23 Lock the car',
      'Dana 2026-10-24 Take out the recycling',
      'Dana 2026-10-24 Hiking trip [endsLater]',
      'Dana 2026-10-25 Hiking trip [continues]',
      'Dana 2026-10-25 Night shift',
      'Dana 2026-10-22 Buy milk',
      'Dana 2026-10-24 Pick up the cake',
      'Noam 2026-10-24 Galilee trip [spansDay]',
      'Noam 2026-10-24 Water the garden',
      'Gali 2026-10-22 Design conference [spansDay]',
      'Gali 2026-10-22 Release window [endsLater]',
      'Gali 2026-10-23 Class party [endsLater]',
      "Gali 2026-10-24 Sleepover at Ben's [continues]",
      "Gali 2026-10-24 Grandma Ruth's birthday",
      'Gali 2026-10-24 Set the alarm',
      'Gali 2026-10-25 Night flight',
      'Yoni 2026-10-22 Soccer - Noa and Itai',
    ];
    const missing = want.filter(line => !shapedLines.has(line));
    assert(missing.length === 0, `not seen: ${show(missing)}`);
    // Last night's short tail is dropped on its second day (the 06:00 rule).
    const dropped = ['Dana 2026-10-24 Movie marathon [continues]', 'Gali 2026-10-24 Class party [continues]', 'Noam 2026-10-23 Late call [continues]'];
    const seen = dropped.filter(line => shapedLines.has(line));
    assert(seen.length === 0, `kept past 06:00: ${show(seen)}`);
  });

  await check('(a) a Google user paired with a FamCal partner reads FamCal too (Google as a connection): his reads query the database', async () => {
    assert(tomEvents.length > 0, 'Tom read nothing');
    assert(tomQueries > 0, 'Tom\'s reads never asked the database');
  });

  for (const user of [DANA, GALI]) {
    await check(`(b) the prompts: ${user === DANA ? 'the paired FamCal user with reminders' : 'the Google user with yours/spouse/kids/birthday calendars'}, daily and tomorrow (with its week block), byte for byte the golden's`, async () => {
      for (const run of PROMPT_RUNS) {
        const key = `${user.name}, ${run.name}`;
        const want = golden.prompts[key];
        assert(typeof want === 'string', `no golden prompt for ${key}`);
        assert(got.prompts[key] === want, `${run.name}: ${firstDifference(got.prompts[key], want)}`);
      }
    });
  }

  await check('(b) the prompts show what they hold: reminders and their guideline, carry-overs, the spouse, kids, a birthday, the week block', async () => {
    const of = (name: string) => Object.entries(got.prompts).filter(([key]) => key.startsWith(`${name}, `)).map(([, prompt]) => prompt).join('\n');
    const dana = of('Dana');
    const gali = of('Gali');
    const needles: [string, string][] = [
      [dana, 'Buy milk'], [dana, 'Call the plumber'], [dana, 'Pilates'], [dana, 'Swimming'], [dana, '- **תזכורות**'],
      [gali, 'Team standup'], [gali, '[Calendar: Tom]'], [gali, 'School'], [gali, "Grandma Ruth's birthday"],
      [gali, 'WEEK LOOKAHEAD (events after tomorrow)'], [gali, 'Night flight'],
    ];
    const missing = needles.filter(([text, needle]) => !text.includes(needle)).map(([, needle]) => needle);
    assert(missing.length === 0, `not in the prompts: ${show(missing)}`);
  });

  await check('(b) an Outlook/Teams HTML description (a table row, a heading, a paragraph) keeps its words apart: on separate lines in the reader\'s event, as separate words in the prompt', async () => {
    reset();
    const ids = (await getCalendarAssignmentsForUser(GALI)).map(a => a.calendarId);
    const review = (await summary.readSummaryDay(GALI, ids, IL, '2026-10-22')).find(e => e.eventId === 'g-review');
    assert(review?.description === 'Agenda Budget\nJoin\nRoom 4', `the reader's description ${show(review?.description)}`);
    prompts = [];
    await summary.prepareSummaryForUser(GALI, summary.readSummaryDay, undefined);
    // The prompt's own sanitizing turns a description's line breaks into spaces (A-13, unchanged).
    const line = prompts[0]?.split('\n').find(l => l.includes('Description: Agenda'))?.trim();
    assert(line === 'Description: Agenda Budget Join Room 4', `the prompt's line ${show(line)}`);
    assert(!/AgendaBudget|BudgetJoin|JoinRoom/.test(prompts[0] ?? ''), 'words run together in the prompt');
  });

  await check('(c) /week and /nextweek list the golden\'s events, read through the reader (FamCal paired, FamCal solo, Google, Google still paired; Thursday, Saturday, Sunday)', async () => {
    assertGolden('weeks', 24);
    assert(weekProblems.length === 0, `${weekProblems.length} problems:\n     ${weekProblems.join('\n     ')}`);
  });

  await check('(c) the weeks start by country, from Saturday and Sunday: New York and Israel (default culture) Sun-Sat, London Mon-Sun, Cairo Sat-Fri', async () => {
    const day = (d: Date, tz: string) => formatInTimeZone(d, tz, 'EEE d');
    /** /week's last day and /nextweek's days, from `local` on the user's clock. */
    const weeks = async (user: UserConfig, local: string) => {
      const tz = zoneOf(user);
      reset({ now: local, zone: tz });
      const week = await getWeekLookahead(user, []);
      const next = await getNextWeekLookahead(user, []);
      return `/week to ${day(week.dateRange.end, tz)}, /nextweek ${day(next.dateRange.start, tz)} to ${day(next.dateRange.end, tz)}`;
    };
    const israeli = { ...GALI, calendarAssignments: [] } as UserConfig;
    const weekDays: string[] = [];
    for (const [when, local] of [['Saturday', '2026-10-24 19:00:00'], ['Sunday', '2026-10-25 07:00:00']]) {
      for (const [place, user] of [['New York', SAM], ['Israel', israeli], ['London', OLIVIA], ['Cairo', KARIM]] as const) {
        weekDays.push(`${place} ${when}: ${await weeks(user, local)}`);
      }
    }
    assertList(weekDays, [
      'New York Saturday: /week to Sat 24, /nextweek Sun 25 to Sat 31',
      'Israel Saturday: /week to Sat 24, /nextweek Sun 25 to Sat 31',
      'London Saturday: /week to Sun 25, /nextweek Mon 26 to Sun 1',
      'Cairo Saturday: /week to Fri 30, /nextweek Sat 31 to Fri 6',
      'New York Sunday: /week to Sat 31, /nextweek Sun 1 to Sat 7',
      'Israel Sunday: /week to Sat 31, /nextweek Sun 1 to Sat 7',
      'London Sunday: /week to Sun 25, /nextweek Mon 26 to Sun 1',
      'Cairo Sunday: /week to Fri 30, /nextweek Sat 31 to Fri 6',
    ], 'the weeks');
  });

  // ---- (d) Outcomes ----

  const tg = (u: UserConfig) => u.telegramId as number;
  /** The user-facing part of the log: sends, drafts, voice notes, marks, admin notices, cleared tokens. */
  const facing = () => log.filter(l => !/^(token|list|get|master|sleep) /.test(l));

  await check('(d) a dead token (invalid_grant): on demand the token text, scheduled the token text with the refresh button, an admin warning, no dedup mark', async () => {
    reset();
    await summary.sendDailySummaryToUser(tg(ORI));
    const onDemand = facing();
    const onDemandGoogle = log.filter(l => /^(token|list|get) /.test(l));
    reset();
    batch = [ORI];
    await summary.sendDailySummaryToAll({ filterByHour: true });
    assertList([...onDemandGoogle, '|', ...log.filter(l => /^(token|list|get) /.test(l))], ['token Ori', '|', 'token Ori'], 'the reader\'s Google calls');
    assertList([...onDemand, '|', ...facing()], ['send Ori token', 'admin warning Token Expired', '|', 'send Ori token + refresh button', 'admin warning Token Expired'], 'what Ori got');
  });

  await check('(d) missing scopes: on demand the scopes text, the token kept and an admin warning; scheduled Sentry only', async () => {
    reset();
    await summary.sendDailySummaryToUser(tg(SHIRA));
    const onDemand = facing();
    reset();
    batch = [SHIRA];
    await summary.sendDailySummaryToAll({ filterByHour: true });
    assertList([...onDemand, '|', ...facing(), ...reportedBySummary()], [
      'send Shira scopes', 'admin warning Insufficient Scopes', '|', 'summary-batch-user error GOOGLE_INSUFFICIENT_SCOPES',
    ], 'what Shira got');
  });

  await check("(d) a token cleared while Google choices are stored, FamCal empty (Friday): on demand the token text, scheduled the token text with the refresh button, no dedup mark; /week the token text; never a free day", async () => {
    reset({ now: '2026-10-23 07:00:00' });
    await summary.sendDailySummaryToUser(tg(OMRI));
    const onDemand = facing();
    reset({ now: '2026-10-23 07:00:00' });
    await commands.handleLookaheadCommand(tg(OMRI), tg(OMRI), MessagingPlatform.TELEGRAM);
    const week = facing();
    reset({ now: '2026-10-23 07:00:00' });
    batch = [OMRI];
    await summary.sendDailySummaryToAll({ filterByHour: true });
    await settle();
    assertList([...onDemand, '|', ...week, '|', ...facing()], [
      'send Omri token', 'admin warning Token Expired', '|', 'send Omri token', 'admin warning Token Expired', '|', 'send Omri token + refresh button', 'admin warning Token Expired',
    ], 'what Omri got');
    assert(prompts.length === 0, 'the AI was asked for a summary of a day whose Google half was never read');
  });

  await check("(d) a token cleared while Google choices are stored, with FamCal events (Thursday): on demand the summary then the token text; scheduled the summary, the token text with the refresh button and the dedup mark; /week the list then the token text", async () => {
    reset();
    await summary.sendDailySummaryToUser(tg(OMRI));
    const onDemand = facing();
    reset();
    await commands.handleLookaheadCommand(tg(OMRI), tg(OMRI), MessagingPlatform.TELEGRAM);
    const week = facing();
    reset();
    batch = [OMRI];
    await summary.sendDailySummaryToAll({ filterByHour: true });
    await settle();
    assertList([...onDemand, '|', ...week, '|', ...facing()], [
      'send Omri summary', 'voice Omri', 'send Omri token', 'admin warning Token Expired',
      '|', 'send Omri summary', 'send Omri token', 'admin warning Token Expired',
      '|', 'send Omri summary', 'voice Omri', 'send Omri token + refresh button', 'admin warning Token Expired', 'mark Omri daily 2026-10-22',
    ], 'what Omri got');
    assert(prompts.length === 1 && prompts[0].includes('Parent meeting'), `the scheduled prompt lacks his FamCal event: ${prompts.length} prompts`);
  });

  /** The empty-retry run of the next check, which the check after it reads too. */
  let emptyRetry: { log: string[]; timers: number[] } = { log: [], timers: [] };

  await check('(d) rate limit on every calendar, scheduled: set aside, one retry on the first attempt\'s day with 15,000 ms, then the summary with the outage line, its guideline and the dedup mark, and no week-block Google read', async () => {
    // The tomorrow summary on Thursday 19:00 (Friday's, with the week block).
    reset({ now: '2026-10-22 19:00:00' });
    behaviours[GALI.googleRefreshToken] = { list: () => rateLimited() };
    batch = [GALI];
    await summary.sendTomorrowSummaryToAll({ filterByHour: true });
    await settle();
    const outageLog = folded();
    const outageTimers = longTimers();
    const outagePrompt = prompts;
    const outageReports = reportedBySummary();
    // The same run, but the retry gets an empty Google: the empty-day prompt.
    reset({ now: '2026-10-22 19:00:00' });
    behaviours[GALI.googleRefreshToken] = { list: (_id, n) => (n === 1 ? rateLimited() : 'empty') };
    batch = [GALI];
    await summary.sendTomorrowSummaryToAll({ filterByHour: true });
    const emptyPrompt = prompts;
    emptyRetry = { log: folded().filter(l => !l.startsWith('master ')), timers: longTimers() };
    assertList(outageLog, [
      'token Gali',
      'list Gali ×5 10-23 00:00..10-24 00:00 10000',
      'sleep 30000',
      'token Gali',
      'list Gali ×5 10-23 00:00..10-24 00:00 10000',
      'send Gali summary with outage line',
      'voice Gali with outage line',
      'mark Gali tomorrow 2026-10-22',
    ], 'the run');
    assertList(outageTimers.map(String), ['30000', '15000'], "the reader's deadlines");
    assertList(outageReports, [
      'summary-google-retry warning 1 scheduled summaries set aside for a Google retry',
      'summary-google-outage warning GOOGLE_FETCH_FAILED',
    ], 'what summary.ts reported');
    assert(outagePrompt.length === 1 && emptyPrompt.length === 1, `prompts ${outagePrompt.length}, ${emptyPrompt.length}`);
    const a = emptyPrompt[0].split('\n');
    const b = outagePrompt[0].split('\n');
    const added = b.findIndex((line, i) => line !== a[i]);
    assert(b.length === a.length + 1 && added >= 0 && show([...b.slice(0, added), ...b.slice(added + 1)]) === show(a), `the outage prompt is not the empty-day prompt plus one line (${a.length} -> ${b.length} lines)`);
    assert(b[added].startsWith('- **'), `the added line is not a guideline: ${b[added]}`);
  });

  await check('(d) scheduled reads carry their deadline to the week block: 30,000 ms on the first attempt, 15,000 ms on the retry, with no quick retry', async () => {
    reset({ now: '2026-10-22 19:00:00' });
    batch = [GALI];
    await summary.sendTomorrowSummaryToAll({ filterByHour: true });
    await settle();
    // The week block runs from Friday noon to the end of Saturday (Sunday weeks in Israel).
    assertList([...folded().filter(l => !l.startsWith('master ')), '|', ...longTimers().map(String)], [
      'token Gali',
      'list Gali ×5 10-23 00:00..10-24 00:00 10000',
      'token Gali',
      'list Gali ×5 10-23 12:00..10-25 00:00 10000',
      'send Gali summary',
      'voice Gali',
      'mark Gali tomorrow 2026-10-22',
      '|', '30000', '30000',
    ], 'a first attempt that reads');
    assertList([...emptyRetry.log, '|', ...emptyRetry.timers.map(String)], [
      'token Gali',
      'list Gali ×5 10-23 00:00..10-24 00:00 10000',
      'sleep 30000',
      'token Gali',
      'list Gali ×5 10-23 00:00..10-24 00:00 10000',
      'token Gali',
      'list Gali ×5 10-23 12:00..10-25 00:00 10000',
      'send Gali summary',
      'voice Gali',
      'mark Gali tomorrow 2026-10-22',
      '|', '30000', '15000', '15000',
    ], 'a retry that reads');
  });

  await check('(d) rate limit on every calendar, on demand: one quick retry at 8,000 ms inside the operation, then R13\'s text, no admin notice', async () => {
    reset();
    behaviours[GALI.googleRefreshToken] = { list: () => rateLimited() };
    await summary.sendDailySummaryToUser(tg(GALI));
    assertList(folded(), [
      'token Gali',
      'list Gali ×5 10-22 00:00..10-23 00:00 9500',
      'token Gali',
      'list Gali ×5 10-22 00:00..10-23 00:00 7500',
      'send Gali unreachable',
    ], 'the run');
    assertList(longTimers().map(String), ['50000', '10000', '1000', '8000'], 'the pipeline\'s limit, the deadline, the pause, the retry\'s deadline');
    assert(prompts.length === 0, 'the AI was asked');
  });

  await check('(d) rate limit on every calendar, /week: the same quick retry, then R13\'s text, no admin notice', async () => {
    reset();
    behaviours[GALI.googleRefreshToken] = { list: () => rateLimited() };
    await commands.handleLookaheadCommand(tg(GALI), tg(GALI), MessagingPlatform.TELEGRAM);
    assertList(folded(), [
      'token Gali',
      'list Gali ×5 10-22 07:00..10-25 00:00 9500',
      'token Gali',
      'list Gali ×5 10-22 07:00..10-25 00:00 7500',
      'send Gali unreachable',
    ], 'the run');
    assertList(longTimers().map(String), ['50000', '10000', '1000', '8000'], 'the pipeline\'s limit, the deadline, the pause, the retry\'s deadline');
  });

  await check('(d) a fast 500 on demand that the quick retry gets past: the summary, delivered by onSuccess', async () => {
    reset();
    behaviours[GALI.googleRefreshToken] = { list: (_id, n) => (n === 1 ? backendError() : 'ok') };
    await summary.sendDailySummaryToUser(tg(GALI));
    await settle();
    assertList(folded(), [
      'token Gali',
      'list Gali ×5 10-22 00:00..10-23 00:00 9500',
      'token Gali',
      'list Gali ×5 10-22 00:00..10-23 00:00 7500',
      'send Gali summary',
      'voice Gali',
    ], 'the run');
    assert(prompts.length === 1 && prompts[0].includes('Team standup'), 'the retry\'s events are not in the prompt');
  });

  await check('(d) a hanging token server on demand: a timeout gets no quick retry, and R13\'s text replaces the draft within 50 s, with no admin notice', async () => {
    reset();
    behaviours[GALI.googleRefreshToken] = { token: () => 'hang' };
    const started = performance.now();
    await summary.sendDailySummaryToUser(tg(GALI), MessagingPlatform.TELEGRAM, draftFor(GALI));
    const seconds = (performance.now() - started) / 1000;
    assertList(folded(), ['token Gali', 'draft Gali replaced: unreachable'], 'the run');
    assertList(longTimers().map(String), ['50000', '10000'], "the pipeline's limit and the reader's deadline");
    assert(seconds >= 9.5 && seconds < 50, `R13's text after ${seconds.toFixed(1)} s`);
  });

  await check('(d) scheduled, a retry that gets invalid_grant: the token text with the refresh button and an admin warning, no outage line, no dedup mark', async () => {
    reset();
    behaviours[MAYA.googleRefreshToken] = { token: n => (n === 1 ? 'ok' : invalidGrant()), list: () => rateLimited() };
    batch = [MAYA];
    await summary.sendDailySummaryToAll({ filterByHour: true });
    assertList(folded(), [
      'token Maya',
      'list Maya ×1 10-22 00:00..10-23 00:00 10000',
      'sleep 30000',
      'token Maya',
      'send Maya token + refresh button',
      'admin warning Token Expired',
    ], 'the run');
    assertList(reportedBySummary(), [
      'summary-google-retry warning 1 scheduled summaries set aside for a Google retry',
      'summary-batch-user error GOOGLE_TOKEN_EXPIRED',
    ], 'what summary.ts reported');
  });

  await check('(d) scheduled, a retry that crosses local midnight reads and shapes the first attempt\'s day', async () => {
    // The tomorrow summary at 23:59:50 on Saturday is Sunday's; the retry runs on Sunday.
    reset({ now: '2026-10-24 23:59:50' });
    behaviours[ELLA.googleRefreshToken] = { list: (_id, n) => (n === 1 ? rateLimited() : 'ok') };
    batch = [ELLA];
    await summary.sendTomorrowSummaryToAll();
    await settle();
    assertList(folded(), [
      'token Ella',
      'list Ella ×1 10-25 00:00..10-26 00:00 10000',
      'sleep 30000',
      'token Ella',
      'list Ella ×1 10-25 00:00..10-26 00:00 10000',
      'send Ella summary',
      'voice Ella',
    ], 'the run');
    assert(prompts.length === 1 && prompts[0].includes('Pottery (Ella)') && !prompts[0].includes('Haircut (Ella)'), 'the prompt is not Sunday\'s');
  });

  await check('(d) the week block alone fails (a rate limit after a good day read), scheduled: the tomorrow summary goes out without the block and without the outage line, marked sent, with no retry; Sentry has the block\'s warning (A-28)', async () => {
    reset({ now: '2026-10-22 19:00:00' });
    behaviours[GALI.googleRefreshToken] = { list: (_id, n) => (n === 1 ? 'ok' : rateLimited()) };
    batch = [GALI];
    await summary.sendTomorrowSummaryToAll({ filterByHour: true });
    await settle();
    assertList([...folded().filter(l => !l.startsWith('master ')), '|', ...longTimers().map(String)], [
      'token Gali',
      'list Gali ×5 10-23 00:00..10-24 00:00 10000',
      'token Gali',
      'list Gali ×5 10-23 12:00..10-25 00:00 10000',
      'send Gali summary',
      'voice Gali',
      'mark Gali tomorrow 2026-10-22',
      '|', '30000', '30000',
    ], 'the run');
    assert(prompts.length === 1 && !prompts[0].includes('WEEK LOOKAHEAD'), 'the prompt has a week block');
    assertList(reportedBySummary(), ['summary-week-lookahead warning GOOGLE_FETCH_FAILED'], 'what summary.ts reported');
  });

  await check('(d) on demand, the tomorrow summary with its week block, each read rate-limited after 4.9 s and answered on the quick retry after 7.4 s, a 2 s timezone lookup and a 20 s AI stream: onSuccess delivers it at 48.6 s, inside the 50 s limit, with no admin notice', async () => {
    reset({ now: '2026-10-22 19:00:00' });
    timezoneLookupMs = 2_000;
    aiStreamMs = 20_000;
    // Each calendar's odd lists (each read's first attempt) fail, its even ones (the quick retries) answer.
    behaviours[GALI.googleRefreshToken] = { list: (_id, n) => (n % 2 === 1 ? { after: 4_900, then: rateLimited() } : { after: 7_400, then: 'ok' }) };
    const tapped = clock;
    await runVirtual(() => summary.sendTomorrowSummaryToUser(tg(GALI), MessagingPlatform.TELEGRAM, draftFor(GALI)));
    await settle();
    assertList(folded().filter(l => !l.startsWith('master ')), [
      'token Gali',
      'list Gali ×5 10-23 00:00..10-24 00:00 9500',
      'token Gali',
      'list Gali ×5 10-23 00:00..10-24 00:00 7500',
      'token Gali',
      'list Gali ×5 10-23 12:00..10-25 00:00 9500',
      'token Gali',
      'list Gali ×5 10-23 12:00..10-25 00:00 7500',
      'draft Gali finalized: summary',
      'voice Gali',
    ], 'the run');
    // 2 s of timezone, 4.9 + 1 + 7.4 s for the day and again for the week block, 20 s of AI.
    assertList(sentAt.map(l => l.replace(/@(\d+)$/, (_m, t) => `+${(Number(t) - tapped) / 1000} s`)), ['draft Gali +48.6 s'], 'when it went out');
    assert(prompts.length === 1 && prompts[0].includes('WEEK LOOKAHEAD (events after tomorrow)'), 'the prompt has no week block');
    assert(!log.some(l => l.startsWith('admin ')) && reportedBySummary().length === 0, `admin ${show(log.filter(l => l.startsWith('admin ')))}, reported ${show(reportedBySummary())}`);
  });

  await check("(d) on demand, a quick retry answered after 7.9 s, past its 7.5 s request timeout: too late, so R13's text, with no admin notice", async () => {
    reset();
    behaviours[GALI.googleRefreshToken] = { list: (_id, n) => (n % 2 === 1 ? { after: 4_900, then: rateLimited() } : { after: 7_900, then: 'ok' }) };
    await runVirtual(() => summary.sendDailySummaryToUser(tg(GALI)));
    assertList(folded(), [
      'token Gali',
      'list Gali ×5 10-22 00:00..10-23 00:00 9500',
      'token Gali',
      'list Gali ×5 10-22 00:00..10-23 00:00 7500',
      'send Gali unreachable',
    ], 'the run');
    assert(!log.some(l => l.startsWith('admin ')) && prompts.length === 0, `admin ${show(log.filter(l => l.startsWith('admin ')))}, prompts ${prompts.length}`);
  });

  await check('(d) one calendar gone (404): a summary from the rest, and the reader\'s gone warning', async () => {
    reset();
    await summary.sendDailySummaryToUser(tg(YONI));
    await settle();
    assertList(folded(), ['token Yoni', 'list Yoni ×2 10-22 00:00..10-23 00:00 9500', 'send Yoni summary', 'voice Yoni'], 'the run');
    assert(prompts.length === 1 && prompts[0].includes('Soccer - Noa and Itai'), 'the other calendar\'s event is not in the prompt');
    assertList(captured.filter(c => c.includes('gone')), [
      'calendar-read-google warning 1 of 2 chosen Google calendars are gone (deleted, unshared or on another account)',
    ], 'warnings');
  });

  await check('(d) every chosen calendar gone: an empty summary, and a warning', async () => {
    reset();
    await summary.sendDailySummaryToUser(tg(AVI));
    await settle();
    assertList(folded(), ['token Avi', 'list Avi ×2 10-22 00:00..10-23 00:00 9500', 'send Avi summary', 'voice Avi'], 'the run');
    assert(prompts.length === 1 && prompts[0].includes('None'), 'the prompt has no empty list');
    // The reader warns in the background, so the two arrive in either order.
    assertList(captured.filter(c => c.includes('gone')).sort(), [
      'calendar-read-digest warning Every chosen Google calendar is gone (deleted, unshared or on another account); the summary has no Google events',
      'calendar-read-google warning 2 of 2 chosen Google calendars are gone (deleted, unshared or on another account)',
    ], 'warnings');
  });

  // ---- (e) The batch doesn't wait ----

  await check('(e) the batch: 3 Google users fail and a FamCal user doesn\'t; the FamCal summary goes out first, one wait counted from the first failure, then each retry in order', async () => {
    reset();
    tokenStepMs = 1000;
    for (const u of [GALI, MAYA, ELLA]) behaviours[u.googleRefreshToken] = { list: (_id, n) => (n === 1 ? rateLimited() : 'ok') };
    batch = [GALI, DANA, MAYA, ELLA];
    const result = await summary.sendDailySummaryToAll({ filterByHour: true });
    assertList(log.filter(l => /^(token|send|mark|sleep) /.test(l)), [
      'token Gali',
      'send Dana summary',
      'mark Dana daily 2026-10-22',
      'token Maya',
      'token Ella',
      'sleep 28000',
      'token Gali',
      'send Gali summary',
      'mark Gali daily 2026-10-22',
      'token Maya',
      'send Maya summary',
      'mark Maya daily 2026-10-22',
      'token Ella',
      'send Ella summary',
      'mark Ella daily 2026-10-22',
    ], 'the run');
    assert(result.processed === 4, `processed ${result.processed}`);
  });

  await check('(e) a Google stall (the token server never answers), scheduled: each first read ends at its 30 s deadline and is set aside, the FamCal user behind them is delivered at 90 s, each retry ends at its 15 s deadline, then the outage summaries; 135 s in all, logged, and no admin notice', async () => {
    reset();
    for (const u of [GALI, MAYA, ELLA]) behaviours[u.googleRefreshToken] = { token: () => 'hang' };
    batch = [GALI, MAYA, ELLA, DANA];
    const started = clock;
    const result = await runVirtual(() => summary.sendDailySummaryToAll({ filterByHour: true }));
    await settle();
    // The loop ends 60 s after the first failure, so the retries start at once: no sleep.
    assertList(log.filter(l => /^(token|list|send|mark|sleep|admin) /.test(l)), [
      'token Gali',
      'token Maya',
      'token Ella',
      'send Dana summary',
      'mark Dana daily 2026-10-22',
      'token Gali',
      'send Gali summary with outage line',
      'mark Gali daily 2026-10-22',
      'token Maya',
      'send Maya summary with outage line',
      'mark Maya daily 2026-10-22',
      'token Ella',
      'send Ella summary with outage line',
      'mark Ella daily 2026-10-22',
    ], 'the run');
    assertList(sentAt.map(l => l.replace(/@(\d+)$/, (_m, t) => `+${(Number(t) - started) / 1000} s`)), [
      'send Dana +90 s', 'send Gali +105 s', 'send Maya +120 s', 'send Ella +135 s',
    ], 'when each went out');
    const deadlines = captured.filter(c => c.includes('deadline'));
    assertList(deadlines, [
      ...Array(3).fill('calendar-read-google warning Google read passed its 30000 ms deadline in the token step'),
      ...Array(3).fill('calendar-read-google warning Google read passed its 15000 ms deadline in the token step'),
    ], "the reader's timeouts");
    assertList(reportedBySummary(), [
      'summary-google-retry warning 3 scheduled summaries set aside for a Google retry',
      ...Array(3).fill('summary-google-outage warning GOOGLE_FETCH_FAILED'),
    ], 'what summary.ts reported');
    assert(logs.includes('[Batch Summary] daily done: processed=4 set aside=3 total=135000ms'), `the batch's closing line: ${show(logs.filter(l => l.includes(' done: ')))}`);
    assert(result.processed === 4, `processed ${result.processed}`);
  });

  // ---- (f) Nothing left over ----

  await check('nothing left over: no network, no unhandled rejection, no admin error notice, and no summary read touched the Google cache', async () => {
    await settle();
    assert(networkAttempts.length === 0, `network: ${networkAttempts.join(', ')}`);
    assert(unhandled.length === 0, `unhandled: ${unhandled.map(String).join(' | ')}`);
    assert(adminErrors.length === 0, `admin errors: ${adminErrors.join(', ')}`);
    const cacheKeys = [...redisKeys].filter(k => /^gcal:(range|stamp|fresh)/.test(k));
    assert(cacheKeys.length === 0, `Google cache keys: ${cacheKeys.join(', ')}`);
  });

  Object.assign(console, original);
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  // The pipeline's 50 s operation timer is never cleared; don't wait for it.
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

// Smoke test for the summaries' calendar read (calendar home spec §3.1 "Adapters"):
// readDigestDay, readLookaheadEvents and the three read kinds in
// src/services/calendar-read/digest.ts.
//
// For the users the rollout switch covers, a summary reads its day, and the week block,
// /week and /nextweek their range, through the shared reader. The adapters must ask the
// reader for exactly today's window, never through the Google cache, and turn each way
// a read can end into what the summaries answer:
// - a dead token or missing scopes: GOOGLE_TOKEN_EXPIRED / GOOGLE_INSUFFICIENT_SCOPES;
// - any other Google failure: GOOGLE_FETCH_FAILED with the read's first day (C5, R13),
//   after one quick retry when an on-demand read failed fast;
// - every chosen calendar gone: no Google events and a warning (R18);
// - a FamCal error: its own cause, rethrown (A-28).
//
// readRange is a fake that answers from a script and moves a fake clock (Date.now) by
// the time each read takes. setTimeout is faked too, so the pause before a quick retry
// moves the same clock at once. Error capture is a recorder. No network, DB or Redis.
//
// Run under each clock; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-digest-adapters.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-digest-adapters.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-digest-adapters.ts

import Module from 'node:module';
import path from 'node:path';
import { formatInTimeZone } from 'date-fns-tz';
import { localDate, nextDate, startOfLocalDay } from '../src/utils/day-events';
import type { CalendarEvent, UserConfig } from '../src/types';
import type { UnifiedEvent } from '../src/services/calendar-provider/types';
import type { GoogleRead, RangeRead, ReadItem, ReadRangeOptions } from '../src/services/calendar-read/types';
import type { DigestRead } from '../src/services/calendar-read/digest';
import type { ViewerContext } from '../src/services/native-reminders/ownership';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (v: unknown) => JSON.stringify(v);

/** A list's length read afresh: an assert on `.length` would narrow it for the checks after it. */
const count = (list: readonly unknown[]): number => list.length;

globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network is blocked in this smoke test: ${String(input)}`);
}) as typeof fetch;

// ---- Clock and sleep: Date.now reads `clock`; setTimeout moves it and fires at once ----

const BASE_CLOCK = Date.parse('2026-10-15T06:30:00.000Z'); // Thursday 09:30 in Israel
let clock = BASE_CLOCK;
Date.now = () => clock;

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
/** Every pause the adapters took: its length and the clock when it began. */
const sleeps: { ms: number; at: number }[] = [];
const fakeSetTimeout = ((callback: () => void, ms?: number) => {
  sleeps.push({ ms: ms ?? 0, at: clock });
  clock += ms ?? 0;
  setImmediate(callback);
  return 0;
}) as unknown as typeof setTimeout;

// ---- The fake reader ----

type Answer = { result: RangeRead | Error; takesMs?: number };
type Call = { user: UserConfig; fromKey: string; toKey: string; opts: ReadRangeOptions; at: number };

const reader = {
  /** Answered in order; the last one repeats. */
  answers: [] as Answer[],
  calls: [] as Call[],
  /** Every call of the whole run, for the last check. */
  allCalls: [] as Call[],
};

async function fakeReadRange(user: UserConfig, fromKey: string, toKey: string, opts: ReadRangeOptions): Promise<RangeRead> {
  const call = { user, fromKey, toKey, opts: { ...opts }, at: clock };
  reader.calls.push(call);
  reader.allCalls.push(call);
  const answer = reader.answers.length > 1 ? reader.answers.shift() : reader.answers[0];
  if (!answer) throw new Error('the smoke gave readRange no answer');
  await Promise.resolve();
  clock += answer.takesMs ?? 200;
  if (answer.result instanceof Error) throw answer.result;
  return answer.result;
}

// ---- Error capture ----

type Captured = { level: string; context: string; message: string; extra?: Record<string, unknown> };
const captured: Captured[] = [];

// ---- Stubs: the reader and error capture; day-events is the real one ----

const SRC = path.resolve(__dirname, '../src');
const stubs: Record<string, object> = {
  [`${SRC}/services/calendar-read/index.ts`]: {
    readRange: fakeReadRange,
    sourcesFor: () => {
      throw new Error('sourcesFor is not part of this smoke');
    },
  },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (error: unknown, context: string, extra?: Record<string, unknown>, severity = 'error') => {
      captured.push({ level: severity, context, message: error instanceof Error ? error.message : String(error), extra });
    },
    captureWarning: (message: string, context: string, extra?: Record<string, unknown>) => {
      captured.push({ level: 'warning', context, message, extra });
    },
    captureInfo: () => {},
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

// ---- Fixtures ----

const IL = 'Asia/Jerusalem';
const DAY = '2026-10-15';
const TOMORROW = '2026-10-16';
const FAMCAL_IDS = ['native:cal-dana', 'native:cal-raziel-shared'];
const GOOGLE_IDS = ['family.kids@group.calendar.google.com', 'noa@gmail.com'];
const WINDOW = { from: new Date('2026-10-14T21:00:00.000Z'), to: new Date('2026-10-15T21:00:00.000Z') };

const famcalUser = {
  id: 11, telegramId: 1011, name: 'Dana', calendarSource: 'NATIVE', googleRefreshToken: '', pairingId: 'pair-1',
} as unknown as UserConfig;
const googleUser = {
  id: 12, telegramId: 1012, name: 'Noa', calendarSource: 'GOOGLE', googleRefreshToken: 'refresh-token', pairingId: null,
  calendarAssignments: [
    { calendarId: GOOGLE_IDS[0], labels: ['kids'], name: 'Kids', color: '#33b679' },
    { calendarId: GOOGLE_IDS[1], labels: ['yours'], name: 'Noa', color: '#039BE5' },
  ],
} as unknown as UserConfig;
const tokenlessGoogleUser = { ...googleUser, googleRefreshToken: '' } as UserConfig;

function famcalItem(id: string, summary: string, start: string, end: string, kind: 'event' | 'reminder' = 'event'): ReadItem {
  const event: UnifiedEvent = {
    summary, start, end, calendarName: 'Dana', calendarId: FAMCAL_IDS[0], eventId: id, provider: 'native',
    ...(kind === 'reminder' ? { eventType: 'reminder', reminder: { ownerIsViewer: true, creatorIsViewer: true } } : {}),
  };
  return {
    source: 'famcal', key: `famcal|${id}`, event,
    calendar: { id: FAMCAL_IDS[0], source: 'famcal', name: 'Dana', color: '#039BE5', mine: true, inLegend: true },
    title: summary, kind, seriesId: id, originalStart: start, recurring: false, rrule: null,
    ...(kind === 'reminder' ? { state: { doneAt: null, snoozedUntil: null } } : {}),
  };
}

function googleItem(id: string, summary: string, start: string, end: string, eventType?: string): ReadItem {
  const event: UnifiedEvent = {
    summary, start, end, calendarName: 'Family (kids)', calendarId: GOOGLE_IDS[0], eventId: id, provider: 'google',
    ...(eventType ? { eventType } : {}),
  };
  return {
    source: 'google', key: `google|${GOOGLE_IDS[0]}|${id}`, event,
    calendar: { id: GOOGLE_IDS[0], source: 'google', name: 'Kids', color: '#33b679', mine: true, inLegend: true },
    title: summary, kind: 'event', seriesId: null, originalStart: null, recurring: false, rrule: null,
    google: { birthday: eventType === 'birthday', htmlLink: null },
  };
}

const DENTIST = famcalItem('evt-dentist', 'Dentist', '2026-10-15T07:00:00.000Z', '2026-10-15T08:00:00.000Z');
const VITAMINS = famcalItem('rem-vitamins#2026-10-15T05:00:00.000Z', 'Vitamins', '2026-10-15T05:00:00.000Z', '2026-10-15T05:00:00.000Z', 'reminder');
const SWIM = googleItem('swim1', 'Swim practice', '2026-10-15T16:00:00+03:00', '2026-10-15T17:00:00+03:00');
const BIRTHDAY = googleItem('bday1', 'Dana birthday', '2026-10-15', '2026-10-16', 'birthday');

const CTX = { viewerId: 11, partner: null } as unknown as ViewerContext;
const famcalOk = (items: ReadItem[]): RangeRead => ({
  window: WINDOW, items, famcal: { status: 'ok', ctx: CTX, calendars: [], partner: null },
});
const famcalError = (cause: unknown): RangeRead => ({ window: WINDOW, items: [], famcal: { status: 'error', cause } });
const GOOGLE_OK: Extract<GoogleRead, { status: 'ok' }> = { status: 'ok', calendars: [], goneIds: [], partial: null, stale: false };
const googleRead = (google: GoogleRead, items: ReadItem[] = []): RangeRead => ({ window: WINDOW, items, google });
type ErrorReason = Extract<GoogleRead, { status: 'error' }>['reason'];
const googleError = (reason: ErrorReason) =>
  googleRead({ status: 'error', reason, cause: new Error(`${reason} (smoke)`) });
const reconnect = (reason: 'token' | 'scopes') => googleRead({ status: 'reconnect', reason });

/** week-lookahead.ts's endOfLocalDay: the inclusive last instant of `day` in `tz`. */
const endOfLocalDay = (day: string, tz: string) => new Date(startOfLocalDay(nextDate(day), tz).getTime() - 1);

/** What a failed adapter call threw, or a failure when it didn't. */
async function thrown(p: Promise<unknown>): Promise<Error & { day?: unknown }> {
  try {
    const got = await p;
    throw new Error(`expected a throw, got ${show(got)}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('expected a throw')) throw err;
    return err as Error & { day?: unknown };
  }
}

const eventsOf = (items: ReadItem[]) => items.map(i => i.event);
function assertSameEvents(got: CalendarEvent[], want: CalendarEvent[], what: string) {
  assert(got.length === want.length && got.every((e, i) => e === want[i]), `${what}: got ${show(got.map(e => e.summary))}, want ${show(want.map(e => e.summary))}`);
}

function assertOpts(call: Call, want: Record<string, unknown>, what: string) {
  const got: Record<string, unknown> = { ...call.opts };
  if (got.notBefore instanceof Date) got.notBefore = got.notBefore.toISOString();
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter(k => o[k] !== undefined).sort();
  assert(show(keys(got)) === show(keys(want)), `${what}: option keys ${show(keys(got))}, want ${show(keys(want))}`);
  for (const k of keys(want)) assert(show(got[k]) === show(want[k]), `${what}: ${k} = ${show(got[k])}, want ${show(want[k])}`);
}

const warnings = () => captured.filter(c => c.level === 'warning' && c.context === 'calendar-read-digest');

function reset(...answers: Answer[]) {
  clock = BASE_CLOCK;
  reader.answers = answers;
  reader.calls.length = 0;
  sleeps.length = 0;
  captured.length = 0;
}

async function check(name: string, fn: () => Promise<void>) {
  reset();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        watchdog = realSetTimeout(() => reject(new Error('did not settle within 5 s')), 5000);
      }),
    ]);
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  } finally {
    realClearTimeout(watchdog);
  }
}

async function main() {
  const { readDigestDay, readLookaheadEvents, DEFAULT_ON_DEMAND_READ, SCHEDULED_READ, SCHEDULED_RETRY_READ } = await import(
    '../src/services/calendar-read/digest'
  );
  globalThis.setTimeout = fakeSetTimeout;

  const ON_DEMAND: DigestRead = DEFAULT_ON_DEMAND_READ;
  const day = (user: UserConfig, read: DigestRead, d = DAY, ids = GOOGLE_IDS) => readDigestDay(user, d, IL, ids, read);

  await check('the read kinds: on demand 10,000 ms, scheduled 30,000 ms, the scheduled retry 15,000 ms, none changeable', async () => {
    assert(show(DEFAULT_ON_DEMAND_READ) === show({ mode: 'onDemand', deadlineMs: 10000 }), show(DEFAULT_ON_DEMAND_READ));
    assert(show(SCHEDULED_READ) === show({ mode: 'scheduled', deadlineMs: 30000 }), show(SCHEDULED_READ));
    assert(show(SCHEDULED_RETRY_READ) === show({ mode: 'scheduled', deadlineMs: 15000 }), show(SCHEDULED_RETRY_READ));
    for (const r of [DEFAULT_ON_DEMAND_READ, SCHEDULED_READ, SCHEDULED_RETRY_READ]) assert(Object.isFrozen(r), `${show(r)} is not frozen`);
  });

  await check("readDigestDay: a FamCal user's day is the reader's events in its order, read over [day, next day) on the summary's calendars, never through the Google cache", async () => {
    reset({ result: famcalOk([VITAMINS, DENTIST]) });
    const got = await day(famcalUser, ON_DEMAND, DAY, FAMCAL_IDS);
    assertSameEvents(got, eventsOf([VITAMINS, DENTIST]), 'events');
    assert(count(reader.calls) === 1, `${reader.calls.length} reads`);
    const [call] = reader.calls;
    assert(call.user === famcalUser, 'not the summary\'s own user row');
    assert(call.fromKey === DAY && call.toKey === TOMORROW, `window ${call.fromKey}..${call.toKey}`);
    assertOpts(call, { tz: IL, calendarIds: FAMCAL_IDS, googleCache: 'bypass', deadlineMs: 10000 }, 'options');
    assert(sleeps.length === 0 && captured.length === 0, `sleeps ${show(sleeps)}, captured ${show(captured)}`);
  });

  await check('readDigestDay: a scheduled tomorrow summary on 31 October reads [2026-10-31, 2026-11-01) with 30,000 ms; its retry with 15,000 ms', async () => {
    for (const [read, deadlineMs] of [[SCHEDULED_READ, 30000], [SCHEDULED_RETRY_READ, 15000]] as const) {
      reset({ result: famcalOk([DENTIST]) });
      const got = await day(famcalUser, read, '2026-10-31', FAMCAL_IDS);
      assertSameEvents(got, eventsOf([DENTIST]), 'events');
      const [call] = reader.calls;
      assert(call.fromKey === '2026-10-31' && call.toKey === '2026-11-01', `window ${call.fromKey}..${call.toKey}`);
      assertOpts(call, { tz: IL, calendarIds: FAMCAL_IDS, googleCache: 'bypass', deadlineMs }, `${deadlineMs} ms`);
    }
  });

  await check("readDigestDay: a Google user's day is what loaded, birthdays included, also when a calendar failed or is gone (A-11, A-26)", async () => {
    reset({ result: googleRead({ ...GOOGLE_OK, goneIds: ['old@group.calendar.google.com'], partial: { failed: 1, truncated: 1 } }, [BIRTHDAY, SWIM]) });
    const got = await day(googleUser, ON_DEMAND);
    assertSameEvents(got, eventsOf([BIRTHDAY, SWIM]), 'events');
    assert(count(reader.calls) === 1 && sleeps.length === 0, `${reader.calls.length} reads, sleeps ${show(sleeps)}`);
    assertOpts(reader.calls[0], { tz: IL, calendarIds: GOOGLE_IDS, googleCache: 'bypass', deadlineMs: 10000 }, 'options');
    assert(warnings().length === 0, show(captured));
  });

  await check('a dead token: GOOGLE_TOKEN_EXPIRED, with no retry, on demand and scheduled', async () => {
    for (const read of [ON_DEMAND, SCHEDULED_READ]) {
      reset({ result: reconnect('token'), takesMs: 300 });
      const err = await thrown(day(googleUser, read));
      assert(err instanceof Error && err.message === 'GOOGLE_TOKEN_EXPIRED', `${read.mode}: ${err.message}`);
      assert(count(reader.calls) === 1 && sleeps.length === 0, `${read.mode}: ${reader.calls.length} reads`);
    }
  });

  await check('missing scopes: GOOGLE_INSUFFICIENT_SCOPES, with no retry, on demand and scheduled', async () => {
    for (const read of [ON_DEMAND, SCHEDULED_READ]) {
      reset({ result: reconnect('scopes'), takesMs: 300 });
      const err = await thrown(day(googleUser, read));
      assert(err instanceof Error && err.message === 'GOOGLE_INSUFFICIENT_SCOPES', `${read.mode}: ${err.message}`);
      assert(count(reader.calls) === 1 && sleeps.length === 0, `${read.mode}: ${reader.calls.length} reads`);
    }
  });

  await check('a FamCal error rethrows its own cause, with no retry, so the pipeline answers as today (A-28)', async () => {
    for (const read of [ON_DEMAND, SCHEDULED_READ]) {
      const cause = new Error('Timed out fetching a new connection from the connection pool (smoke)');
      reset({ result: famcalError(cause), takesMs: 100 });
      const err = await thrown(day(famcalUser, read, DAY, FAMCAL_IDS));
      assert(err === cause, `${read.mode}: threw ${err.message}, not the cause`);
      assert(count(reader.calls) === 1 && sleeps.length === 0, `${read.mode}: ${reader.calls.length} reads`);
    }
  });

  await check('a Google user with no token reads nothing and gets no events, as the provider today', async () => {
    reset({ result: reconnect('token') });
    const dayGot = await day(tokenlessGoogleUser, ON_DEMAND);
    const weekGot = await readLookaheadEvents(tokenlessGoogleUser, new Date(clock), endOfLocalDay('2026-10-17', IL), IL, GOOGLE_IDS, SCHEDULED_READ);
    assert(dayGot.length === 0 && weekGot.length === 0, `${show(dayGot)} ${show(weekGot)}`);
    assert(reader.calls.length === 0, `${reader.calls.length} reads`);
  });

  await check('every chosen calendar gone: no events and one warning, with no retry and no outage code (R18)', async () => {
    for (const read of [ON_DEMAND, SCHEDULED_READ]) {
      reset({ result: googleError('calendars_gone'), takesMs: 300 });
      const got = await day(googleUser, read);
      assert(got.length === 0, `${read.mode}: ${show(got)}`);
      assert(count(reader.calls) === 1 && sleeps.length === 0, `${read.mode}: ${reader.calls.length} reads`);
      const w = warnings();
      assert(w.length === 1, `${read.mode}: warnings ${show(captured)}`);
      assert(w[0].extra?.user_id === 12 && w[0].extra?.day === DAY && w[0].extra?.mode === read.mode, `${read.mode}: extra ${show(w[0].extra)}`);
    }
  });

  await check("scheduled: a Google outage is GOOGLE_FETCH_FAILED carrying the read's day, after one read (C5 retries later)", async () => {
    for (const read of [SCHEDULED_READ, SCHEDULED_RETRY_READ]) {
      reset({ result: googleError('transient'), takesMs: 300 });
      const err = await thrown(day(googleUser, read, TOMORROW));
      assert(err instanceof Error && err.message === 'GOOGLE_FETCH_FAILED', `${read.deadlineMs}: ${err.message}`);
      assert(err.day === TOMORROW, `${read.deadlineMs}: day ${show(err.day)}`);
      assert(count(reader.calls) === 1 && sleeps.length === 0, `${read.deadlineMs}: ${reader.calls.length} reads, sleeps ${show(sleeps)}`);
      assert(reader.calls[0].opts.deadlineMs === read.deadlineMs, `deadline ${reader.calls[0].opts.deadlineMs}`);
    }
  });

  await check('on demand: a fast failure is read once more, 1 s later, with 8,000 ms, and that read is the answer (R13)', async () => {
    reset({ result: googleError('transient'), takesMs: 400 }, { result: googleRead(GOOGLE_OK, [SWIM]), takesMs: 600 });
    const got = await day(googleUser, ON_DEMAND);
    assertSameEvents(got, eventsOf([SWIM]), 'events');
    assert(count(reader.calls) === 2, `${reader.calls.length} reads`);
    const [first, second] = reader.calls;
    assertOpts(first, { tz: IL, calendarIds: GOOGLE_IDS, googleCache: 'bypass', deadlineMs: 10000 }, 'first read');
    assertOpts(second, { tz: IL, calendarIds: GOOGLE_IDS, googleCache: 'bypass', deadlineMs: 8000 }, 'second read');
    assert(second.fromKey === DAY && second.toKey === TOMORROW, `second window ${second.fromKey}..${second.toKey}`);
    assert(show(sleeps.map(s => s.ms)) === show([1000]), `pauses ${show(sleeps)}`);
    assert(second.at - first.at === 400 + 1000, `the second read began ${second.at - first.at} ms after the first`);
  });

  await check("on demand: a second failure is GOOGLE_FETCH_FAILED with the day, after exactly two reads", async () => {
    reset({ result: googleError('transient'), takesMs: 300 });
    const err = await thrown(day(googleUser, ON_DEMAND, TOMORROW));
    assert(err.message === 'GOOGLE_FETCH_FAILED' && err.day === TOMORROW, `${err.message} ${show(err.day)}`);
    assert(count(reader.calls) === 2 && sleeps.length === 1, `${reader.calls.length} reads, ${sleeps.length} pauses`);
  });

  await check('on demand: the quick retry is for a failure within 5,000 ms: one that took 5,000 ms is retried, 5,001 ms is not', async () => {
    reset({ result: googleError('transient'), takesMs: 5000 }, { result: googleRead(GOOGLE_OK, [SWIM]) });
    const got = await day(googleUser, ON_DEMAND);
    assertSameEvents(got, eventsOf([SWIM]), '5,000 ms');
    assert(count(reader.calls) === 2, `5,000 ms: ${reader.calls.length} reads`);
    reset({ result: googleError('transient'), takesMs: 5001 }, { result: googleRead(GOOGLE_OK, [SWIM]) });
    const err = await thrown(day(googleUser, ON_DEMAND));
    assert(err.message === 'GOOGLE_FETCH_FAILED', `5,001 ms: ${err.message}`);
    assert(count(reader.calls) === 1 && sleeps.length === 0, `5,001 ms: ${reader.calls.length} reads`);
  });

  await check('on demand: a timeout gets no quick retry, however fast it came back', async () => {
    for (const takesMs of [10000, 100]) {
      reset({ result: googleError('timeout'), takesMs }, { result: googleRead(GOOGLE_OK, [SWIM]) });
      const err = await thrown(day(googleUser, ON_DEMAND));
      assert(err.message === 'GOOGLE_FETCH_FAILED' && err.day === DAY, `${takesMs} ms: ${err.message}`);
      assert(count(reader.calls) === 1 && sleeps.length === 0, `${takesMs} ms: ${reader.calls.length} reads`);
    }
  });

  await check('on demand: every other failure is retried once: transient, config, unknown', async () => {
    for (const reason of ['transient', 'config', 'unknown'] as const) {
      reset({ result: googleError(reason), takesMs: 250 }, { result: googleRead(GOOGLE_OK, [SWIM]) });
      const got = await day(googleUser, ON_DEMAND);
      assertSameEvents(got, eventsOf([SWIM]), reason);
      assert(count(reader.calls) === 2, `${reason}: ${reader.calls.length} reads`);
    }
  });

  await check("on demand: the retry's own ending decides: a dead token, missing scopes, or every calendar gone", async () => {
    reset({ result: googleError('transient'), takesMs: 300 }, { result: reconnect('token') });
    assert((await thrown(day(googleUser, ON_DEMAND))).message === 'GOOGLE_TOKEN_EXPIRED', 'token');
    reset({ result: googleError('transient'), takesMs: 300 }, { result: reconnect('scopes') });
    assert((await thrown(day(googleUser, ON_DEMAND))).message === 'GOOGLE_INSUFFICIENT_SCOPES', 'scopes');
    reset({ result: googleError('transient'), takesMs: 300 }, { result: googleError('calendars_gone') });
    const got = await day(googleUser, ON_DEMAND);
    assert(got.length === 0 && warnings().length === 1 && count(reader.calls) === 2, `gone: ${show(got)}, ${show(captured)}, ${reader.calls.length} reads`);
  });

  await check('on demand: calendars gone on the first read are not retried', async () => {
    reset({ result: googleError('calendars_gone'), takesMs: 100 }, { result: googleRead(GOOGLE_OK, [SWIM]) });
    const got = await day(googleUser, ON_DEMAND);
    assert(got.length === 0 && count(reader.calls) === 1 && sleeps.length === 0, `${show(got)}, ${reader.calls.length} reads`);
  });

  await check('a reader that throws (a caller\'s empty window): the same error goes up, with no retry', async () => {
    const bug = new RangeError('readRange: empty window (smoke)');
    reset({ result: bug, takesMs: 0 });
    const err = await thrown(day(googleUser, ON_DEMAND));
    assert(err === bug && count(reader.calls) === 1 && sleeps.length === 0, `${err.message}, ${reader.calls.length} reads`);
  });

  await check("readLookaheadEvents: This week from now reads [today, the day after the last) clipped to now, which is today's [now, end of the last day]", async () => {
    const start = new Date(clock);
    const end = endOfLocalDay('2026-10-17', IL);
    reset({ result: googleRead(GOOGLE_OK, [SWIM, BIRTHDAY]) });
    const got = await readLookaheadEvents(googleUser, start, end, IL, GOOGLE_IDS, ON_DEMAND);
    assertSameEvents(got, eventsOf([SWIM, BIRTHDAY]), 'events');
    assert(count(reader.calls) === 1, `${reader.calls.length} reads`);
    const [call] = reader.calls;
    assert(call.user === googleUser, 'not the user row');
    assert(call.fromKey === DAY && call.toKey === '2026-10-18', `window ${call.fromKey}..${call.toKey}`);
    assertOpts(call, { tz: IL, calendarIds: GOOGLE_IDS, notBefore: start.toISOString(), googleCache: 'bypass', deadlineMs: 10000 }, 'options');
  });

  await check("readLookaheadEvents: the reader's window is exactly [start, end + 1 ms) in New York, Kiritimati, on Israel's 25 October change and Chile's midnight change", async () => {
    // Chile's clocks go from 00:00 to 01:00 on 6 September 2026: that day starts at 01:00.
    const santiagoStart = startOfLocalDay('2026-09-06', 'America/Santiago');
    assert(formatInTimeZone(santiagoStart, 'America/Santiago', 'yyyy-MM-dd HH:mm') === '2026-09-06 01:00', `fixture: Chile's day starts ${formatInTimeZone(santiagoStart, 'America/Santiago', 'yyyy-MM-dd HH:mm')}`);
    const cases: { tz: string; start: Date; last: string; what: string }[] = [
      { tz: 'America/New_York', start: new Date('2026-10-15T23:30:00.000Z'), last: '2026-10-18', what: 'New York this week, at 19:30' },
      { tz: 'Pacific/Kiritimati', start: new Date('2026-10-15T10:30:00.000Z'), last: '2026-10-18', what: 'Kiritimati this week, past midnight' },
      { tz: IL, start: startOfLocalDay('2026-10-25', IL), last: '2026-10-31', what: 'Israel next week from 25 October (25-hour day)' },
      { tz: IL, start: new Date('2026-10-24T09:00:00.000Z'), last: '2026-10-25', what: 'Israel this week through 25 October' },
      { tz: 'America/Santiago', start: santiagoStart, last: '2026-09-12', what: 'Chile next week from 6 September' },
      { tz: 'America/Santiago', start: new Date('2026-09-04T15:00:00.000Z'), last: '2026-09-05', what: 'Chile this week through 5 September' },
    ];
    for (const c of cases) {
      const end = endOfLocalDay(c.last, c.tz);
      reset({ result: googleRead(GOOGLE_OK, [SWIM]) });
      await readLookaheadEvents(googleUser, c.start, end, c.tz, GOOGLE_IDS, SCHEDULED_READ);
      const [call] = reader.calls;
      const from = Math.max(startOfLocalDay(call.fromKey, c.tz).getTime(), call.opts.notBefore?.getTime() ?? -Infinity);
      const to = startOfLocalDay(call.toKey, c.tz).getTime();
      assert(call.fromKey === localDate(c.start, c.tz) && call.toKey === nextDate(c.last), `${c.what}: ${call.fromKey}..${call.toKey}`);
      assert(from === c.start.getTime(), `${c.what}: the window starts ${new Date(from).toISOString()}, not ${c.start.toISOString()}`);
      assert(to === end.getTime() + 1, `${c.what}: the window ends ${new Date(to).toISOString()}, not ${new Date(end.getTime() + 1).toISOString()}`);
      assert(call.opts.tz === c.tz && call.opts.deadlineMs === 30000, `${c.what}: ${show(call.opts)}`);
    }
  });

  await check("readLookaheadEvents: GOOGLE_FETCH_FAILED carries the range's first day in the user's zone, not the server's", async () => {
    // 22:30 UTC on 15 October is 01:30 on 16 October in Israel.
    const start = new Date('2026-10-15T22:30:00.000Z');
    reset({ result: googleError('transient'), takesMs: 300 });
    const err = await thrown(readLookaheadEvents(googleUser, start, endOfLocalDay('2026-10-17', IL), IL, GOOGLE_IDS, SCHEDULED_READ));
    assert(err.message === 'GOOGLE_FETCH_FAILED' && err.day === TOMORROW, `${err.message} ${show(err.day)}`);
    assert(reader.calls[0].fromKey === TOMORROW, `fromKey ${reader.calls[0].fromKey}`);
  });

  await check('readLookaheadEvents: the endings of the day read: a quick retry over the same window, a dead token, every calendar gone', async () => {
    const start = new Date(clock);
    const end = endOfLocalDay('2026-10-17', IL);
    reset({ result: googleError('transient'), takesMs: 300 }, { result: googleRead(GOOGLE_OK, [SWIM]) });
    const got = await readLookaheadEvents(googleUser, start, end, IL, GOOGLE_IDS, ON_DEMAND);
    assertSameEvents(got, eventsOf([SWIM]), 'retry');
    assert(count(reader.calls) === 2, `retry: ${reader.calls.length} reads`);
    assertOpts(reader.calls[1], { tz: IL, calendarIds: GOOGLE_IDS, notBefore: start.toISOString(), googleCache: 'bypass', deadlineMs: 8000 }, 'retry options');
    assert(reader.calls[1].fromKey === DAY && reader.calls[1].toKey === '2026-10-18', 'retry window');

    reset({ result: reconnect('token') });
    const err = await thrown(readLookaheadEvents(googleUser, start, end, IL, GOOGLE_IDS, ON_DEMAND));
    assert(err.message === 'GOOGLE_TOKEN_EXPIRED' && count(reader.calls) === 1, `token: ${err.message}`);

    reset({ result: googleError('calendars_gone') });
    const gone = await readLookaheadEvents(googleUser, start, end, IL, GOOGLE_IDS, ON_DEMAND);
    assert(gone.length === 0 && warnings().length === 1, `gone: ${show(gone)} ${show(captured)}`);
  });

  await check('no summary read asks for the Google cache or hands the reader a background task', async () => {
    assert(reader.allCalls.length >= 30, `only ${reader.allCalls.length} reads were made above`);
    for (const c of reader.allCalls) {
      assert(c.opts.googleCache === 'bypass', `googleCache ${show(c.opts.googleCache)}`);
      assert(!('defer' in c.opts) && !('sources' in c.opts), `options ${show(Object.keys(c.opts))}`);
    }
  });

  globalThis.setTimeout = realSetTimeout;

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

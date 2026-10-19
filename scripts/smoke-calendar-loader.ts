// Smoke test for the calendar home's loader (src/lib/calendar-view/home-loader.ts; spec
// §5 "Month windows", Plan E Ruling 7): which range requests go out, and when.
//
// The Month asks each month's own days, [1st, 1st of the next month) (R12), for the
// months on screen or next to it (the host's getMonths(), most wanted first). At most
// MONTH_INFLIGHT_MAX month requests are in flight; every send for a month window counts
// (the first ask, a refetch, Retry, and the stale and error follow-ups), and the
// Agenda's weeks never do. A queued month that is no longer wanted when a slot frees is
// dropped, never marked asked, so it is asked again once it comes back; a month's stale
// or error follow-up that falls due once it is no longer wanted is dropped. A window is
// keyed by both its ends, so on the 1st of a month the Agenda's week 0 and that month
// don't collide. refetchVisible() asks the Agenda's weeks only while agendaShowing().
// An older epoch's 429 or 500 after a reset changes nothing (no state row, no card).
// D's host, which has no getMonths, sends exactly what it sent before.
//
// A fake host on the real reducer (D3's reduceStore), a fake fetch whose answers the
// checks hand out one by one, and a fake timer. No network, no React.
//
// Run with the fake env from the plan, under three clocks (the output must not depend
// on the process timezone):
//   TZ=UTC npx tsx scripts/smoke-calendar-loader.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-loader.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-calendar-loader.ts

import {
  ERROR_RETRY_MS,
  MONTH_INFLIGHT_MAX,
  RANGE_TIMEOUT_MS,
  STALE_RETRY_MS,
  createHomeLoader,
  type HomeLoader,
  type LoaderHost,
} from '../src/lib/calendar-view/home-loader';
import { dayStatus, emptyStore, reduceStore, type CalendarStore } from '../src/lib/calendar-view/store';
import type { RangeWindow } from '../src/lib/calendar-view/home-client';
import type { DayKey, ItemDTO, ItemReminderDTO, RangeResponse, SourceName } from '../src/lib/calendar-view/types';

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

const show = (value: unknown) => JSON.stringify(value);

function assertSame(got: unknown, want: unknown, label: string) {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

// ---- Fixtures: Thursday 15 October 2026 in Israel ----

const IL = 'Asia/Jerusalem';
const TODAY: DayKey = '2026-10-15';
const USER_ID = 5550001;
/** The fixtures' own day arithmetic (UTC), so the checks never lean on the code under test. */
const plusDays = (key: DayKey, n: number): DayKey => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const month = (from: DayKey, to: DayKey): RangeWindow => ({ from, to });
const SEP = month('2026-09-01', '2026-10-01');
const OCT = month('2026-10-01', '2026-11-01');
const NOV = month('2026-11-01', '2026-12-01');
const DEC = month('2026-12-01', '2027-01-01');

// ---- A fake fetch: every range call waits until a check answers it ----

type Reply = { status: number; body?: unknown } | 'throw';
interface Call {
  url: string;
  source: string;
  from: string | null;
  to: string | null;
  fresh: boolean;
  settled: boolean;
  reply: (r: Reply) => void;
}
const calls: Call[] = [];

globalThis.fetch = ((input: unknown) => {
  const url = String(input);
  const q = new URL(url, 'https://famcal.test').searchParams;
  return new Promise((resolve, reject) => {
    const call: Call = {
      url,
      source: q.get('sources') ?? '',
      from: q.get('from'),
      to: q.get('to'),
      fresh: q.get('fresh') === '1',
      settled: false,
      reply: (r) => {
        assert(!call.settled, `${describe(call)} answered twice`);
        call.settled = true;
        if (r === 'throw') reject(new TypeError('Failed to fetch (smoke)'));
        else resolve({ status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body } as Response);
      },
    };
    calls.push(call);
  });
}) as typeof fetch;

/** A call as "<source> <from>..<to>[ fresh]", or "<source> default" with no dates. */
const describe = (c: Call) => `${c.source} ${c.from ? `${c.from}..${c.to}` : 'default'}${c.fresh ? ' fresh' : ''}`;
const sent = (since = 0) => calls.slice(since).map(describe);
const isMonth = (c: Call) => c.from !== null && c.from.endsWith('-01') && c.to !== null && c.to.endsWith('-01');
const monthsInFlight = () => calls.filter((c) => isMonth(c) && !c.settled).length;
/** The one call still waiting that `describe` names. */
function pending(what: string): Call {
  const found = calls.filter((c) => !c.settled && describe(c) === what);
  assert(found.length === 1, `${found.length} calls waiting for ${show(what)}; sent ${show(sent())}`);
  return found[0];
}

/** Lets fetchRange's promise chain and the loader's handlers run. */
async function flush() {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** An answer for a call's own window (the no-dates one is [today, today+7)), every day listed, nothing on them. */
function answerFor(
  c: Call,
  o: { today?: DayKey; sources?: readonly SourceName[]; status?: RangeResponse['sources'] } = {},
): Reply {
  const today = o.today ?? TODAY;
  const from = c.from ?? today;
  const to = c.to ?? plusDays(today, 7);
  const days: RangeResponse['days'] = [];
  for (let d = from; d < to; d = plusDays(d, 1)) days.push({ date: d, items: [] });
  const sources: RangeResponse['sources'] = {};
  for (const s of o.sources ?? [c.source as SourceName]) sources[s] = s === c.source ? { status: 'ok' } : { status: 'pending' };
  const body: RangeResponse = {
    tz: IL,
    today,
    weekStart: 0,
    hebrewDates: true,
    from,
    to,
    sources: { ...sources, ...o.status },
    partner: null,
    calendars: [],
    days,
  };
  return { status: 200, body };
}

async function answer(what: string, o: Parameters<typeof answerFor>[1] = {}) {
  const c = pending(what);
  c.reply(answerFor(c, o));
  await flush();
}

async function fail(what: string, reply: Reply) {
  pending(what).reply(reply);
  await flush();
}

// ---- A fake host on the real reducer, with a fake timer ----

interface HostOptions {
  sources?: SourceName[];
  /** The Month windows wanted now; null leaves getMonths out (D's host). */
  months?: RangeWindow[] | null;
  /** agendaShowing()'s answer; null leaves the method out (D's host). */
  agenda?: boolean | null;
  weeks?: number;
}

function fakeHost(o: HostOptions = {}) {
  let now = 0;
  let seq = 0;
  const timers: { id: number; at: number; run: () => void }[] = [];
  const state = {
    store: emptyStore() as CalendarStore,
    weeks: o.weeks ?? 1,
    months: o.months ?? [],
    agenda: o.agenda ?? true,
    blocked: false,
    firstFailed: null as 'busy' | 'error' | null,
    /** What the loader did to the host: dispatches and callbacks, in order. */
    log: [] as string[],
  };
  const host: LoaderHost = {
    userId: USER_ID,
    sources: o.sources ?? ['famcal'],
    getStore: () => state.store,
    getWeeks: () => state.weeks,
    dispatch: (a) => {
      state.store = reduceStore(state.store, a);
      if (a.type === 'response') state.log.push(`response ${a.response.from}..${a.response.to} @${a.epoch}`);
      else if (a.type === 'windowFailed') state.log.push(`windowFailed ${a.from}..${a.to} ${a.kind} @${a.epoch}`);
      else if (a.type === 'patchReminder') state.log.push(`patchReminder ${a.key}`);
      else state.log.push('reset');
    },
    isBlocked: () => state.blocked,
    firstLoadFailed: () => state.firstFailed !== null,
    onAnswer: () => {
      state.firstFailed = null;
    },
    onFirstLoadFailed: (kind) => {
      state.firstFailed = kind;
      state.log.push(`firstLoadFailed ${kind}`);
    },
    onNoCredential: () => state.log.push('noCredential'),
    setTimer: (run, ms) => {
      const id = ++seq;
      timers.push({ id, at: now + ms, run });
      return () => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  };
  if (o.months !== null) host.getMonths = () => state.months;
  if (o.agenda !== null) host.agendaShowing = () => state.agenda;
  const loader: HomeLoader = createHomeLoader(host);
  return {
    state,
    host,
    loader,
    /** Moves the clock on, running each timer that falls due, in order. */
    advance: async (ms: number) => {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        now = next.at;
        next.run();
        await flush();
      }
      now = end;
    },
    /** The first load: ensure(), then its no-dates request answered, so the facts are pinned. */
    firstLoad: async (o2: Parameters<typeof answerFor>[1] = {}) => {
      loader.ensure();
      for (const s of host.sources) await answer(`${s} default`, { sources: host.sources, ...o2 });
      assert(state.store.facts !== null, 'the first answer pinned no facts');
    },
  };
}

/** A fresh slate for a check: no calls from the last one. */
function reset() {
  for (const c of calls) if (!c.settled) c.settled = true; // the last check's leftovers never answer
  calls.length = 0;
}

async function main() {
  await check('at most 2 month requests are in flight (MONTH_INFLIGHT_MAX); the rest wait, and when a slot frees the most wanted goes; the Agenda\'s weeks never wait', async () => {
    reset();
    assert(MONTH_INFLIGHT_MAX === 2, `MONTH_INFLIGHT_MAX is ${MONTH_INFLIGHT_MAX}`);
    const h = fakeHost({ months: [OCT, NOV, SEP, DEC] });
    await h.firstLoad();
    const start = calls.length;
    h.loader.ensure();
    assertSame(sent(start), ['famcal 2026-10-01..2026-11-01', 'famcal 2026-11-01..2026-12-01'], 'the two most wanted');
    h.state.weeks = 3;
    h.loader.ensure();
    assertSame(sent(start), ['famcal 2026-10-01..2026-11-01', 'famcal 2026-11-01..2026-12-01', 'famcal 2026-10-22..2026-10-29', 'famcal 2026-10-29..2026-11-05'], 'weeks 1 and 2 go at once');
    // The user scrolls down: December is wanted before September now.
    h.state.months = [OCT, NOV, DEC, SEP];
    await answer('famcal 2026-10-01..2026-11-01');
    assertSame(sent(start + 4), ['famcal 2026-12-01..2027-01-01'], 'October answered: December goes');
    assert(monthsInFlight() === 2, `${monthsInFlight()} months in flight`);
    await answer('famcal 2026-11-01..2026-12-01');
    assertSame(sent(start + 4), ['famcal 2026-12-01..2027-01-01', 'famcal 2026-09-01..2026-10-01'], 'November answered: September goes');
    await answer('famcal 2026-12-01..2027-01-01');
    await answer('famcal 2026-09-01..2026-10-01');
    assert(calls.length === start + 6, `nothing more: ${show(sent(start))}`);
    assert(dayStatus(h.state.store, '2026-09-01') === 'answered' && dayStatus(h.state.store, '2026-12-31') === 'answered', 'the months are in the store');
  });

  await check('a queued month that is no longer wanted when a slot frees is dropped, never sent, and not marked asked: it is asked once it is wanted again', async () => {
    reset();
    const h = fakeHost({ months: [OCT, NOV, SEP] });
    await h.firstLoad();
    const start = calls.length;
    h.loader.ensure();
    assertSame(sent(start), ['famcal 2026-10-01..2026-11-01', 'famcal 2026-11-01..2026-12-01'], 'September waits');
    h.state.months = [OCT, NOV]; // scrolled away from September
    await answer('famcal 2026-10-01..2026-11-01');
    await answer('famcal 2026-11-01..2026-12-01');
    assertSame(sent(start), ['famcal 2026-10-01..2026-11-01', 'famcal 2026-11-01..2026-12-01'], 'September was never sent');
    h.state.months = [SEP, OCT, NOV];
    h.loader.ensure();
    assertSame(sent(start + 2), ['famcal 2026-09-01..2026-10-01'], 'back in view: asked now');
  });

  await check('months are deduped per epoch, source and window: two ensure()s send one request per month and source, and an answered month is not asked again', async () => {
    reset();
    const h = fakeHost({ months: [OCT, NOV, SEP] });
    await h.firstLoad();
    const start = calls.length;
    h.loader.ensure();
    h.loader.ensure();
    assertSame(sent(start), ['famcal 2026-10-01..2026-11-01', 'famcal 2026-11-01..2026-12-01'], 'two ensure()s in flight');
    await answer('famcal 2026-10-01..2026-11-01'); // September takes the slot
    h.loader.ensure();
    await answer('famcal 2026-09-01..2026-10-01');
    h.loader.ensure();
    await answer('famcal 2026-11-01..2026-12-01'); // a slot frees with nothing left to ask
    h.loader.ensure();
    h.loader.ensure();
    assertSame(sent(start), ['famcal 2026-10-01..2026-11-01', 'famcal 2026-11-01..2026-12-01', 'famcal 2026-09-01..2026-10-01'], 'each month once');
    // Two sources (the store is ready for "Google becomes a connection"): one request per month
    // and source, and both count towards the cap.
    reset();
    const both = fakeHost({ sources: ['famcal', 'google'], months: [OCT, NOV] });
    await both.firstLoad();
    assertSame(both.state.store.facts?.sources, ['famcal', 'google'], 'both sources apply');
    const from = calls.length;
    both.loader.ensure();
    both.loader.ensure();
    assertSame(sent(from), ['famcal 2026-10-01..2026-11-01', 'google 2026-10-01..2026-11-01'], 'October for each source, November waits');
    await answer('famcal 2026-10-01..2026-11-01', { sources: ['famcal', 'google'] });
    await answer('google 2026-10-01..2026-11-01', { sources: ['famcal', 'google'] });
    assertSame(sent(from + 2), ['famcal 2026-11-01..2026-12-01', 'google 2026-11-01..2026-12-01'], 'then November for each');
  });

  await check('a window is keyed by both its ends: on the 1st, the Agenda\'s week 0 [1st, 8th) and the month [1st, 1st of next month) never collide', async () => {
    reset();
    const h = fakeHost({ months: [] });
    await h.firstLoad({ today: '2026-11-01' });
    const start = calls.length;
    h.loader.refetchVisible(); // week 0, asked with its dates, on the Agenda
    await answer('famcal 2026-11-01..2026-11-08', { today: '2026-11-01' });
    h.state.months = [NOV]; // the Month tab opens on November
    h.loader.ensure();
    assertSame(sent(start), ['famcal 2026-11-01..2026-11-08', 'famcal 2026-11-01..2026-12-01'], 'November is asked although week 0 was');
    await answer('famcal 2026-11-01..2026-12-01', { today: '2026-11-01' });
    // One refetch asks both at once: neither is deduped behind the other.
    h.loader.refetchVisible();
    assertSame(sent(start + 2), ['famcal 2026-11-01..2026-11-08', 'famcal 2026-11-01..2026-12-01'], 'a refetch asks both');
  });

  await check('the stale and the error follow-ups of a month go through the cap: they wait while 2 months are in flight, and go when a slot frees', async () => {
    reset();
    const h = fakeHost({ sources: ['google'], months: [OCT, NOV, SEP] });
    await h.firstLoad();
    const start = calls.length;
    h.loader.ensure();
    await answer('google 2026-10-01..2026-11-01', { status: { google: { status: 'ok', stale: true } } });
    assertSame(sent(start), ['google 2026-10-01..2026-11-01', 'google 2026-11-01..2026-12-01', 'google 2026-09-01..2026-10-01'], 'September took October\'s slot');
    await h.advance(STALE_RETRY_MS);
    assert(calls.length === start + 3 && monthsInFlight() === 2, `the stale re-request waits: ${show(sent(start))}`);
    await answer('google 2026-11-01..2026-12-01', { status: { google: { status: 'error', reason: 'transient' } } });
    assertSame(sent(start + 3), ['google 2026-10-01..2026-11-01'], 'November answered: October\'s stale re-request goes');
    await h.advance(ERROR_RETRY_MS);
    assert(calls.length === start + 4 && monthsInFlight() === 2, `the error retry waits: ${show(sent(start))}`);
    await answer('google 2026-09-01..2026-10-01');
    assertSame(sent(start + 4), ['google 2026-11-01..2026-12-01'], 'September answered: November\'s retry goes');
    await answer('google 2026-10-01..2026-11-01', { status: { google: { status: 'ok', stale: true } } });
    await answer('google 2026-11-01..2026-12-01', { status: { google: { status: 'error', reason: 'transient' } } });
    await h.advance(ERROR_RETRY_MS);
    assert(calls.length === start + 5, `each follow-up once: ${show(sent(start))}`);
  });

  await check('a month\'s stale or error follow-up that falls due once the month is no longer wanted is dropped, even with both slots free: the months a fast scroll passed are not asked again; one still wanted goes', async () => {
    reset();
    const h = fakeHost({ sources: ['google'], months: [OCT, NOV] });
    await h.firstLoad();
    const start = calls.length;
    h.loader.ensure();
    await answer('google 2026-10-01..2026-11-01', { status: { google: { status: 'ok', stale: true } } });
    await answer('google 2026-11-01..2026-12-01', { status: { google: { status: 'error', reason: 'transient' } } });
    const MAR = month('2027-03-01', '2027-04-01');
    const APR = month('2027-04-01', '2027-05-01');
    h.state.months = [MAR, APR]; // the user flung on to March
    await h.advance(ERROR_RETRY_MS);
    assert(monthsInFlight() === 0, `${monthsInFlight()} months in flight`);
    assertSame(sent(start + 2), [], 'October\'s stale re-request and November\'s error retry, with both slots free');
    h.loader.ensure();
    assertSame(sent(start + 2), ['google 2027-03-01..2027-04-01', 'google 2027-04-01..2027-05-01'], 'March and April');
    await answer('google 2027-03-01..2027-04-01', { status: { google: { status: 'ok', stale: true } } });
    await answer('google 2027-04-01..2027-05-01');
    await h.advance(STALE_RETRY_MS);
    assertSame(sent(start + 4), ['google 2027-03-01..2027-04-01'], 'March, still wanted: its stale re-request goes');
  });

  await check('a month request that never settles frees its slot at the time limit (about 15 s), and the next month goes', async () => {
    reset();
    const h = fakeHost({ months: [OCT, NOV, SEP] });
    await h.firstLoad();
    const start = calls.length;
    h.loader.ensure();
    await h.advance(RANGE_TIMEOUT_MS - 1);
    assert(calls.length === start + 2, `before the limit: ${show(sent(start))}`);
    await h.advance(1);
    assertSame(sent(start + 2), ['famcal 2026-09-01..2026-10-01'], 'past the limit');
    assert(h.state.log.includes('windowFailed 2026-10-01..2026-11-01 error @0'), `log ${show(h.state.log)}`);
  });

  await check('refetchVisible() asks the Agenda\'s weeks only while agendaShowing() (absent = true), and the wanted months always, fresh=1 included', async () => {
    reset();
    const h = fakeHost({ months: [OCT, NOV], agenda: false });
    await h.firstLoad();
    h.loader.ensure();
    await answer('famcal 2026-10-01..2026-11-01');
    await answer('famcal 2026-11-01..2026-12-01');
    let start = calls.length;
    h.loader.refetchVisible();
    assertSame(sent(start), ['famcal 2026-10-01..2026-11-01', 'famcal 2026-11-01..2026-12-01'], 'on the Month: the months only');
    await answer('famcal 2026-10-01..2026-11-01');
    await answer('famcal 2026-11-01..2026-12-01');
    start = calls.length;
    h.loader.refetchVisible({ fresh: true });
    assertSame(sent(start), ['famcal 2026-10-01..2026-11-01 fresh', 'famcal 2026-11-01..2026-12-01 fresh'], 'Refresh on the Month');
    await answer('famcal 2026-10-01..2026-11-01 fresh');
    await answer('famcal 2026-11-01..2026-12-01 fresh');
    h.state.agenda = true;
    h.state.months = [];
    start = calls.length;
    h.loader.refetchVisible();
    assertSame(sent(start), ['famcal 2026-10-15..2026-10-22'], 'on the Agenda: its weeks only');
    reset();
    const d = fakeHost({ months: [OCT], agenda: null });
    await d.firstLoad();
    start = calls.length;
    d.loader.refetchVisible();
    assertSame(sent(start), ['famcal 2026-10-15..2026-10-22', 'famcal 2026-10-01..2026-11-01'], 'no agendaShowing: the weeks, then the months');
  });

  await check('refetchVisible() settles once every request it sent has been answered and applied (after its dispatch, a failure\'s too), never before; one it joined counts, in flight or queued; a queued month dropped settles it; blocked or disposed, it settles at once', async () => {
    reset();
    const h = fakeHost();
    await h.firstLoad();
    const watch = (p: Promise<void>) => {
      const w = { done: false, log: [] as string[] };
      void p.then(() => {
        w.done = true;
        w.log = [...h.state.log];
      });
      return w;
    };
    const renewed = watch(h.loader.refetchVisible({ only: 'famcal', renew: true }));
    await flush();
    assert(!renewed.done, 'settled before its answer');
    await answer(`famcal ${TODAY}..${plusDays(TODAY, 7)}`);
    assert(renewed.done && renewed.log[renewed.log.length - 1] === `response ${TODAY}..${plusDays(TODAY, 7)} @0`, `after the dispatch: ${show(renewed.log)}`);
    const failed = watch(h.loader.refetchVisible({ only: 'famcal', renew: true }));
    await fail(`famcal ${TODAY}..${plusDays(TODAY, 7)}`, { status: 500 });
    assert(failed.done && failed.log[failed.log.length - 1].startsWith('windowFailed'), `a failure settles it too: ${show(failed.log)}`);
    // A plain refetch joins the one in flight, and settles with it.
    const first = watch(h.loader.refetchVisible());
    const joined = watch(h.loader.refetchVisible());
    assertSame(calls.filter((c) => !c.settled).length, 1, 'one request');
    await flush();
    assert(!first.done && !joined.done, 'settled early');
    await answer(`famcal ${TODAY}..${plusDays(TODAY, 7)}`);
    assert(first.done && joined.done, 'both settle with the answer');
    // Months: September waits for a slot; the refetch joins it, and it is dropped when no longer wanted.
    reset();
    const m = fakeHost({ months: [OCT, NOV, SEP], agenda: false });
    await m.firstLoad();
    m.loader.ensure();
    assertSame(sent(calls.length - 2), ['famcal 2026-10-01..2026-11-01', 'famcal 2026-11-01..2026-12-01'], 'September waits');
    const months = watch(m.loader.refetchVisible());
    m.state.months = [OCT, NOV];
    await answer('famcal 2026-10-01..2026-11-01');
    assert(!months.done, 'November is still out');
    await answer('famcal 2026-11-01..2026-12-01');
    assert(months.done && !sent().includes('famcal 2026-09-01..2026-10-01'), `settled with September dropped, never sent: ${show(sent())}`);
    // A queued renew settles once it has gone and been answered.
    m.state.months = [OCT, NOV, SEP];
    m.loader.ensure();
    const queued = watch(m.loader.refetchVisible({ renew: true }));
    await answer('famcal 2026-09-01..2026-10-01');
    await answer('famcal 2026-10-01..2026-11-01');
    assert(!queued.done, 'the renewed months are still out');
    await answer('famcal 2026-11-01..2026-12-01');
    await answer('famcal 2026-09-01..2026-10-01');
    assert(queued.done, `settled once they were answered: ${show(sent())}`);
    // Blocked: nothing goes, and it settles at once. Disposed with a month queued: its waiters settle.
    m.state.blocked = true;
    const blocked = watch(m.loader.refetchVisible());
    await flush();
    assert(blocked.done, 'blocked: settled at once');
    m.state.blocked = false;
    const started = watch(m.loader.refetchVisible({ renew: true })); // October and November go, September waits
    m.loader.refetchVisible({ renew: true }); // all three wait
    const waiting = watch(m.loader.refetchVisible({ renew: true })); // joins the three waiting
    m.loader.dispose();
    await flush();
    assert(waiting.done && !started.done, `disposed: the queue is dropped (${waiting.done}), what is out still runs (${started.done})`);
    for (const c of calls.filter((x) => !x.settled)) c.reply(answerFor(c));
    await flush();
    assert(started.done && m.state.log[m.state.log.length - 1] === 'response 2026-09-01..2026-10-01 @0', `and settles when answered, with nothing applied: ${show(m.state.log.slice(-2))}`);
  });

  await check('retryWindow() asks a window again for each applicable source (or `only`), through the cap', async () => {
    reset();
    const h = fakeHost({ months: [OCT, NOV, SEP] });
    await h.firstLoad();
    h.loader.ensure();
    await fail('famcal 2026-10-01..2026-11-01', { status: 429, body: {} });
    await answer('famcal 2026-11-01..2026-12-01');
    await answer('famcal 2026-09-01..2026-10-01');
    assert(dayStatus(h.state.store, '2026-10-05') === 'failed', `5 October is ${dayStatus(h.state.store, '2026-10-05')}`);
    let start = calls.length;
    h.loader.ensure();
    assert(calls.length === start, `ensure() asks a failed month again: ${show(sent(start))}`);
    h.loader.retryWindow(OCT, 'google');
    assert(calls.length === start, `only: google on a FamCal user: ${show(sent(start))}`);
    h.loader.retryWindow(OCT);
    assertSame(sent(start), ['famcal 2026-10-01..2026-11-01'], 'Retry');
    await answer('famcal 2026-10-01..2026-11-01');
    assert(dayStatus(h.state.store, '2026-10-05') === 'answered', `after Retry, 5 October is ${dayStatus(h.state.store, '2026-10-05')}`);
    // Through the cap: with two months in flight, a third Retry waits for a slot.
    start = calls.length;
    h.loader.retryWindow(NOV);
    h.loader.retryWindow(SEP);
    h.loader.retryWindow(OCT);
    assertSame(sent(start), ['famcal 2026-11-01..2026-12-01', 'famcal 2026-09-01..2026-10-01'], 'October\'s Retry waits');
    await answer('famcal 2026-11-01..2026-12-01');
    assertSame(sent(start + 2), ['famcal 2026-10-01..2026-11-01'], 'then goes');
  });

  await check('an older epoch\'s 500 or 429 after a reset dispatches nothing and never calls onFirstLoadFailed, and its queued months are dropped; the new epoch\'s own failure still shows the card', async () => {
    for (const reply of [{ status: 500, body: { error: 'internal_error' } }, { status: 429, body: {} }, 'throw'] as Reply[]) {
      reset();
      const h = fakeHost({ months: [OCT, NOV, SEP] });
      await h.firstLoad();
      h.loader.ensure(); // October and November in flight, September queued, under epoch 0
      h.loader.refetchVisible(); // week 0 again, under epoch 0
      h.state.store = reduceStore(h.state.store, { type: 'reset' }); // midnight
      h.loader.ensure();
      const start = calls.length;
      assertSame(sent(start - 1), ['famcal default'], `${show(reply)}: the new epoch's first load`);
      const before = h.state.log.length;
      await fail('famcal 2026-10-15..2026-10-22', reply);
      assertSame(h.state.log.slice(before), [], `${show(reply)}: the old epoch's week 0`);
      await fail('famcal 2026-10-01..2026-11-01', reply);
      assertSame(h.state.log.slice(before), [], `${show(reply)}: the old epoch's October`);
      assert(h.state.firstFailed === null, `${show(reply)}: the card is up (${h.state.firstFailed})`);
      assertSame(sent(start), [], `${show(reply)}: September, queued under epoch 0, was sent`);
      await fail('famcal default', reply);
      assertSame(h.state.log.slice(before), [`firstLoadFailed ${reply !== 'throw' && reply.status === 429 ? 'busy' : 'error'}`], `${show(reply)}: the new epoch's own failure`);
    }
  });

  await check('dispose() drops the queue and the timers: nothing more is sent or dispatched', async () => {
    reset();
    const h = fakeHost({ sources: ['google'], months: [OCT, NOV, SEP] });
    await h.firstLoad({ status: { google: { status: 'ok', stale: true } } });
    h.loader.ensure();
    const start = calls.length;
    const before = h.state.log.length;
    h.loader.dispose();
    await answer('google 2026-10-01..2026-11-01');
    await answer('google 2026-11-01..2026-12-01');
    await h.advance(RANGE_TIMEOUT_MS + STALE_RETRY_MS + ERROR_RETRY_MS);
    h.loader.ensure();
    h.loader.refetchVisible();
    h.loader.retryWindow(SEP);
    assert(calls.length === start, `sent after dispose: ${show(sent(start))}`);
    assertSame(h.state.log.slice(before), [], 'dispatched after dispose');
  });

  await check('D\'s host (no getMonths, no agendaShowing) sends exactly what it sent before: the same URLs, in the same order', async () => {
    reset();
    const famcal = fakeHost({ months: null, agenda: null });
    assert(famcal.host.getMonths === undefined && famcal.host.agendaShowing === undefined, 'the host has the new methods');
    famcal.loader.ensure();
    famcal.loader.ensure();
    await answer('famcal default');
    famcal.loader.ensure();
    famcal.state.weeks = 2;
    famcal.loader.ensure();
    await answer('famcal 2026-10-22..2026-10-29');
    famcal.loader.refetchVisible();
    famcal.loader.refetchVisible();
    famcal.loader.refetchVisible({ fresh: true });
    famcal.loader.refetchVisible({ only: 'google' });
    const google = fakeHost({ sources: ['google'], months: null, agenda: null });
    google.loader.ensure();
    await answer('google default', { status: { google: { status: 'ok', stale: true } } });
    await google.advance(STALE_RETRY_MS);
    await answer('google 2026-10-15..2026-10-22', { status: { google: { status: 'error', reason: 'timeout' } } });
    await google.advance(ERROR_RETRY_MS);
    await answer('google 2026-10-15..2026-10-22', { status: { google: { status: 'error', reason: 'timeout' } } });
    await google.advance(ERROR_RETRY_MS);
    const base = '/api/calendar/range?user_id=5550001';
    assertSame(calls.map((c) => c.url), [
      `${base}&sources=famcal`,
      `${base}&sources=famcal&from=2026-10-22&to=2026-10-29`,
      `${base}&sources=famcal&from=2026-10-15&to=2026-10-22`,
      `${base}&sources=famcal&from=2026-10-22&to=2026-10-29`,
      `${base}&sources=famcal&from=2026-10-15&to=2026-10-22&fresh=1`,
      `${base}&sources=famcal&from=2026-10-22&to=2026-10-29&fresh=1`,
      `${base}&sources=google`,
      `${base}&sources=google&from=2026-10-15&to=2026-10-22`,
      `${base}&sources=google&from=2026-10-15&to=2026-10-22`,
    ], 'the URLs');
  });

  // ---- Reminder actions: an older answer never undoes a patch ----

  const KEY = 'famcal|plumber';
  const reminderState = (o: Partial<ItemReminderDTO>): ItemReminderDTO => ({
    done: false, doneAt: null, snoozedUntil: null, open: true, openSince: null, ownerIsViewer: true, creatorIsViewer: true, ...o,
  });
  const plumber = (o: Partial<ItemReminderDTO>) => ({ key: KEY, source: 'famcal', kind: 'reminder', start: '2026-10-15T05:00:00.000Z', reminder: reminderState(o) }) as unknown as ItemDTO;
  /** A call's own window answered with the plumber on today, in the state `o` says. */
  const withPlumber = (c: Call, o: Partial<ItemReminderDTO>): Reply => {
    const r = answerFor(c);
    if (r === 'throw' || !r.body) return r;
    const body = r.body as RangeResponse;
    return { status: 200, body: { ...body, days: body.days.map((d) => (d.date === TODAY ? { ...d, items: [plumber(o)] } : d)) } };
  };
  const storedState = (h: ReturnType<typeof fakeHost>) => h.state.store.days[TODAY].items.find((i) => i.key === KEY)?.reminder;
  const DONE = reminderState({ done: true, doneAt: '2026-10-15T07:00:00.000Z', open: false });
  const weekCalls = () => calls.filter((c) => !c.settled && c.from === TODAY);

  await check('patchReminder: an answer asked before the patch cannot undo it (a Done right after a foreground refetch), and the confirming refetch is a new request even with one in flight', async () => {
    reset();
    const h = fakeHost();
    await h.firstLoad();
    h.loader.refetchVisible(); // the foreground read, still out
    assertSame(weekCalls().length, 1, 'the foreground read');
    const [foreground] = weekCalls();
    h.loader.patchReminder(KEY, DONE);
    h.loader.refetchVisible({ only: 'famcal' });
    assertSame(weekCalls().length, 1, 'a plain refetch still joins the one in flight');
    h.loader.refetchVisible({ only: 'famcal', renew: true });
    assertSame(weekCalls().length, 2, 'a renewed one goes out anew');
    foreground.reply(withPlumber(foreground, { done: false }));
    await flush();
    assertSame(storedState(h)?.done, true, 'the answer asked before the patch comes back not done and is held to it');
  });

  await check('patchReminder: the stale answer keeps the patched state, the newer one is the truth; undo then a late answer of the done request stays undone', async () => {
    reset();
    const h = fakeHost();
    await h.firstLoad();
    h.loader.refetchVisible();
    const [foreground] = weekCalls();
    // Present in the store first, as the sheet's item would be.
    h.state.store = reduceStore(h.state.store, { type: 'response', epoch: h.state.store.epoch, response: (withPlumber(foreground, { done: false }) as { body: RangeResponse }).body });
    h.loader.patchReminder(KEY, DONE);
    assertSame(storedState(h)?.done, true, 'patched');
    h.loader.refetchVisible({ only: 'famcal', renew: true });
    const confirming = weekCalls().filter((c) => c !== foreground)[0];
    foreground.reply(withPlumber(foreground, { done: false })); // asked before the patch: not done yet
    await flush();
    assertSame(storedState(h)?.done, true, 'the older answer does not revert it');
    confirming.reply(withPlumber(confirming, { done: true, doneAt: DONE.doneAt, open: false }));
    await flush();
    assertSame(storedState(h)?.done, true, 'the confirming one agrees');
    // Done, then a quick Not done: the done confirmation arrives after the undo.
    h.loader.refetchVisible({ only: 'famcal', renew: true });
    const doneConfirm = weekCalls()[0];
    h.loader.patchReminder(KEY, reminderState({ done: false }));
    h.loader.refetchVisible({ only: 'famcal', renew: true });
    const undoConfirm = weekCalls().filter((c) => c !== doneConfirm)[0];
    doneConfirm.reply(withPlumber(doneConfirm, { done: true, doneAt: DONE.doneAt, open: false }));
    await flush();
    assertSame(storedState(h)?.done, false, 'a done answer asked before the undo does not bring it back');
    undoConfirm.reply(withPlumber(undoConfirm, { done: false }));
    await flush();
    assertSame(storedState(h)?.done, false, 'the undo confirmed');
    // A later request is the truth again: someone else marked it done.
    h.loader.refetchVisible();
    const later = weekCalls()[0];
    later.reply(withPlumber(later, { done: true, doneAt: DONE.doneAt, open: false }));
    await flush();
    assertSame(storedState(h)?.done, true, 'an answer asked after the last patch is taken');
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

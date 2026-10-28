// Smoke test for the calendar home's client store and Agenda model (spec §5, §7.3,
// Rulings R8 and R10): the reducer in src/lib/calendar-view/store.ts and buildAgenda in
// src/lib/calendar-view/agenda.ts.
//
// An ok answer replaces its source's items over its window and nothing else; an error,
// a reconnect or a pending source never wipes what an earlier ok answer brought. A
// change of timezone, today, week start or sources drops the store. Later empty days
// fold into one line only once every source has answered ok for them, and a source that
// failed with no earlier data shows its state row instead of empty lines. The
// "Still open" card holds today's open reminders and the carry-overs, 5 then the rest.
// Whose an item is follows the summaries' rules. Pure: no network, no DB, no React.
// Each failed day keeps the failure that marked it (Plan E): a state row gives the
// earliest shown failed day's reason, so a 429 on a later week never turns an earlier
// week's "Choose again" into "Busy".
//
// Run under three clocks; the output must not depend on the process timezone:
//   TZ=UTC npx tsx scripts/smoke-calendar-agenda.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-agenda.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-calendar-agenda.ts

import path from 'path';
import {
  addDaysToKey,
  dayFailure,
  dayItems,
  dayStatus,
  emptyStore,
  homeNotices,
  reduceStore,
  type CalendarStore,
  type StoreAction,
} from '../src/lib/calendar-view/store';
import {
  agendaWeekWindow,
  buildAgenda,
  reminderMark,
  reminderStateAt,
  storeRow,
  whoseItem,
  type AgendaEntry,
  type AgendaModel,
} from '../src/lib/calendar-view/agenda';
import type { DayKey, ItemDTO, ItemReminderDTO, RangeResponse } from '../src/lib/calendar-view/types';

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

function assertJson(got: unknown, want: unknown, label: string) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  assert(g === w, `${label}\n     got  ${g}\n     want ${w}`);
}

// ---- Fixtures: a FamCal user in Israel, Thursday 15 October 2026 ----

const IL = 'Asia/Jerusalem';
const TODAY = '2026-10-15';
/** The fixtures' own day arithmetic, so a broken addDaysToKey fails its check instead of the fixtures. */
const plusDays = (key: DayKey, n: number) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const day = (n: number) => plusDays(TODAY, n);

const OWN_CAL = { id: 'native:cal-own', name: 'Raziel', color: '#039BE5', mine: true, inLegend: true };
const NOA_CAL = { id: 'native:cal-noa', name: 'Noa family', color: '#E67C73', mine: false, ownerName: 'Noa', inLegend: true };
const MASKED = { id: null, name: 'Noa', color: null, mine: false, inLegend: false };
const FAMILY_G = { id: 'family@group.calendar.google.com', name: 'Family', color: '#7986CB', mine: true, inLegend: true };
const SPOUSE_G = { id: 'dana@gmail.com', name: 'Dana', color: '#33B679', mine: false, ownerName: 'Dana', inLegend: true };

/** A FamCal event; start/end are UTC ISO, or yyyy-MM-dd for all-day. */
function ev(id: string, start: string, end: string, extra: Partial<ItemDTO> = {}): ItemDTO {
  return {
    key: `famcal|${id}`,
    source: 'famcal',
    readOnly: false,
    id,
    seriesId: id.split('#')[0],
    originalStart: start.includes('T') ? start : null,
    kind: 'event',
    title: id,
    start,
    end,
    allDay: !start.includes('T'),
    tz: IL,
    recurring: false,
    repeatsDaily: false,
    repeatsEveryDay: false,
    canEdit: true,
    span: null,
    calendar: OWN_CAL,
    location: null,
    description: null,
    ...extra,
  };
}

/** A FamCal reminder at `start` (UTC ISO). Defaults: the viewer's own, not due yet. */
function rem(id: string, start: string, r: Partial<ItemReminderDTO> = {}, extra: Partial<ItemDTO> = {}): ItemDTO {
  return ev(id, start, start, {
    kind: 'reminder',
    reminder: {
      done: false,
      doneAt: null,
      snoozedUntil: null,
      open: false,
      openSince: null,
      ownerIsViewer: true,
      creatorIsViewer: true,
      ...r,
    },
    ...extra,
  });
}

function gev(id: string, start: string, end: string, extra: Partial<ItemDTO> = {}): ItemDTO {
  return ev(id, start, end, {
    key: `google|${FAMILY_G.id}|${id}`,
    source: 'google',
    readOnly: true, canEdit: false,
    seriesId: null,
    originalStart: null,
    tz: null,
    calendar: FAMILY_G,
    birthday: false,
    htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
    ...extra,
  });
}

type Answer = Omit<Partial<RangeResponse>, 'days'> & { days?: Record<DayKey, ItemDTO[]> };

/** A FamCal user's answer for [from, to) (default: the route's no-dates window), every day listed. */
function famcalAnswer(a: Answer = {}): RangeResponse {
  const from = a.from ?? TODAY;
  const to = a.to ?? plusDays(from, 7);
  const days: RangeResponse['days'] = [];
  for (let d = from; d < to; d = plusDays(d, 1)) days.push({ date: d, items: a.days?.[d] ?? [] });
  return {
    tz: a.tz ?? IL,
    today: a.today ?? TODAY,
    weekStart: a.weekStart ?? 0,
    hebrewDates: a.hebrewDates ?? true,
    from,
    to,
    sources: a.sources ?? { famcal: { status: 'ok' } },
    partner: a.partner === undefined ? { name: 'Noa' } : a.partner,
    calendars: a.calendars ?? [
      { id: OWN_CAL.id, source: 'famcal', name: OWN_CAL.name, color: OWN_CAL.color, mine: true },
      { id: NOA_CAL.id, source: 'famcal', name: NOA_CAL.name, color: NOA_CAL.color, mine: false, ownerName: 'Noa' },
    ],
    days,
    ...(a.carryOvers ? { carryOvers: a.carryOvers } : {}),
  };
}

/** A Google user's answer: no famcal key, no partner, the Google legend. */
function googleAnswer(a: Answer = {}): RangeResponse {
  return famcalAnswer({
    partner: null,
    calendars: [
      { id: FAMILY_G.id, source: 'google', name: 'Family', color: FAMILY_G.color, mine: true },
      { id: SPOUSE_G.id, source: 'google', name: 'Dana', color: SPOUSE_G.color, mine: false, ownerName: 'Dana' },
    ],
    sources: { google: { status: 'ok' } },
    ...a,
  });
}

const answer = (response: RangeResponse, epoch = 0): StoreAction => ({ type: 'response', response, epoch });
const run = (actions: StoreAction[], from: CalendarStore = emptyStore()) => actions.reduce(reduceStore, from);
const keys = (items: readonly ItemDTO[]) => items.map((i) => i.key);

/** The Agenda as short strings: "D 2026-10-15 today answered [famcal|a, …]" or "F 2026-10-17..2026-10-18". */
function shape(model: AgendaModel | null): string[] {
  assert(model !== null, 'no Agenda model');
  return model.entries.map((e: AgendaEntry) =>
    e.type === 'fold'
      ? `F ${e.first}..${e.last}`
      : `D ${e.date} ${e.relative ?? '-'} ${e.status} [${e.rows.map((r) => r.item.key).join(', ')}]`
  );
}

// A wall time in Israel n days from today, as UTC ISO, at UTC+3 throughout: the store
// never buckets by time (the server did), so the values only need to sort right.
const T = (n: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 15 + n, h - 3, m)).toISOString();
};

async function main() {
  // ---------------- The store ----------------

  await check('an empty store has no facts, no Agenda, and every day is loading', () => {
    const s = emptyStore();
    assert(s.facts === null && s.epoch === 0, `facts ${JSON.stringify(s.facts)} epoch ${s.epoch}`);
    assert(buildAgenda(s) === null, 'an Agenda without facts');
    assert(dayStatus(s, TODAY) === 'loading', `today is ${dayStatus(s, TODAY)}`);
  });

  await check('the first answer pins tz, today, week start and the sources that apply', () => {
    const s = run([answer(famcalAnswer({ weekStart: 0, hebrewDates: true }))]);
    assertJson(s.facts, { tz: IL, today: TODAY, weekStart: 0, hebrewDates: true, sources: ['famcal'] }, 'facts');
    assert(s.epoch === 0, `epoch ${s.epoch}`);
    const g = run([answer(googleAnswer({ weekStart: 1 }))]);
    assertJson(g.facts?.sources, ['google'], 'a Google user\'s sources');
  });

  await check('a day\'s items are deduped by key and sorted with compareItems', () => {
    const late = ev('late', T(0, '18:00'), T(0, '19:00'));
    const early = ev('early', T(0, '09:00'), T(0, '10:00'));
    const allDay = ev('trip', TODAY, day(1));
    const s = run([answer(famcalAnswer({ days: { [TODAY]: [late, early, { ...early, title: 'dup' }, allDay] } }))]);
    assertJson(keys(dayItems(s, TODAY)), ['famcal|trip', 'famcal|early', 'famcal|late'], 'today');
  });

  await check('a reminder by zman sorts among the timed items at its zman time, not with the all-day ones', () => {
    const noon = ev('noon', T(0, '13:00'), T(0, '14:00'));
    const trip = ev('trip', TODAY, day(1));
    const reminder = { done: false, doneAt: null, snoozedUntil: null, open: false, openSince: null, ownerIsViewer: true, creatorIsViewer: true };
    const candles = ev('candles', TODAY, day(1), { kind: 'reminder', reminder: { ...reminder, zman: { spec: { zman: 'CANDLE_LIGHTING', offsetMin: -30 }, at: T(0, '17:25'), opinion: null } } } as Partial<ItemDTO>);
    const shema = ev('shema', TODAY, day(1), { kind: 'reminder', reminder: { ...reminder, zman: { spec: { zman: 'SOF_SHMA_GRA', offsetMin: -10 }, at: T(0, '09:17'), opinion: 'gra' } } } as Partial<ItemDTO>);
    // No zman time that day (the sun does not make it, or no place): it stays with the all-day items.
    const none = ev('none', TODAY, day(1), { kind: 'reminder', reminder: { ...reminder, zman: { spec: { zman: 'SHKIA', offsetMin: 15 }, at: null, opinion: null } } } as Partial<ItemDTO>);
    const s = run([answer(famcalAnswer({ days: { [TODAY]: [candles, noon, none, shema, trip] } }))]);
    assertJson(keys(dayItems(s, TODAY)), ['famcal|none', 'famcal|trip', 'famcal|shema', 'famcal|noon', 'famcal|candles'], 'today');
  });

  await check('an ok answer replaces its source\'s items on every day of its window, and only there', () => {
    const a = ev('a', T(0, '09:00'), T(0, '10:00'));
    const b = ev('b', T(2, '09:00'), T(2, '10:00'));
    const c = ev('c', T(8, '09:00'), T(8, '10:00'));
    const w1 = agendaWeekWindow(TODAY, 1);
    let s = run([
      answer(famcalAnswer({ days: { [TODAY]: [a], [day(2)]: [b] } })),
      answer(famcalAnswer({ ...w1, days: { [day(8)]: [c] } })),
    ]);
    // b was deleted, d was added; week 1 is not in this window.
    const d = ev('d', T(3, '12:00'), T(3, '13:00'));
    s = reduceStore(s, answer(famcalAnswer({ days: { [TODAY]: [a], [day(3)]: [d] } })));
    assertJson(keys(dayItems(s, day(2))), [], 'day 2 after b was deleted');
    assertJson(keys(dayItems(s, day(3))), ['famcal|d'], 'day 3');
    assertJson(keys(dayItems(s, day(8))), ['famcal|c'], 'day 8, outside the window');
    assert(dayStatus(s, day(2)) === 'answered', `day 2 is ${dayStatus(s, day(2))}`);
  });

  await check('a multi-day item has one entry on each of its days', () => {
    const conf = (span: ItemDTO['span']) => ev('conf', T(1, '20:00'), T(3, '10:00'), { span });
    const s = run([
      answer(famcalAnswer({ days: { [day(1)]: [conf('endsLater')], [day(2)]: [conf('spansDay')], [day(3)]: [conf('continues')] } })),
    ]);
    const spans = [1, 2, 3].map((n) => dayItems(s, day(n)).map((i) => `${i.key}:${i.span}`).join());
    assertJson(spans, ['famcal|conf:endsLater', 'famcal|conf:spansDay', 'famcal|conf:continues'], 'spans');
    const model = buildAgenda(s);
    assertJson(shape(model).slice(1, 4), [
      `D ${day(1)} tomorrow answered [famcal|conf]`,
      `D ${day(2)} - answered [famcal|conf]`,
      `D ${day(3)} - answered [famcal|conf]`,
    ], 'Agenda days 1-3');
  });

  await check('an error or a reconnect keeps the earlier ok items, and the day stays answered', () => {
    const g = gev('dinner', T(0, '19:30'), T(0, '22:00'));
    let s = run([answer(googleAnswer({ days: { [TODAY]: [g] } }))]);
    s = reduceStore(s, answer(googleAnswer({ sources: { google: { status: 'error', reason: 'transient' } }, calendars: [] })));
    assertJson(keys(dayItems(s, TODAY)), [g.key], 'after an error');
    assert(dayStatus(s, TODAY) === 'answered', `today is ${dayStatus(s, TODAY)}`);
    assertJson(s.status.google, { status: 'error', reason: 'transient' }, 'status');
    assertJson(s.lastFailure.google, { kind: 'error', source: 'google', reason: 'transient' }, 'lastFailure');
    assert(s.calendars.length === 2, `the legend went with the error: ${s.calendars.length}`);
    s = reduceStore(s, answer(googleAnswer({ sources: { google: { status: 'reconnect', reason: 'token' } }, calendars: [] })));
    assertJson(keys(dayItems(s, TODAY)), [g.key], 'after a reconnect');
  });

  await check('a pending source changes nothing: not its status, not its days', () => {
    let s = run([answer(googleAnswer({ days: { [TODAY]: [gev('x', T(0, '09:00'), T(0, '10:00'))] } }))]);
    const before = JSON.stringify(s);
    s = reduceStore(s, answer(googleAnswer({ sources: { google: { status: 'pending' } }, calendars: [] })));
    assert(JSON.stringify(s) === before, 'a pending answer changed the store');
    const fresh = run([answer(googleAnswer({ sources: { google: { status: 'pending' } }, calendars: [] }))]);
    assert(dayStatus(fresh, TODAY) === 'loading', `pending reads as ${dayStatus(fresh, TODAY)}`);
    assert(fresh.status.google === undefined, 'pending was stored as a status');
  });

  await check('items of a source that is not ok are never stored', () => {
    const stray = ev('stray', T(0, '09:00'), T(0, '10:00'));
    const s = run([answer(famcalAnswer({ sources: { famcal: { status: 'error' } }, days: { [TODAY]: [stray] } }))]);
    assertJson(keys(dayItems(s, TODAY)), [], 'today');
    assert(dayStatus(s, TODAY) === 'failed', `today is ${dayStatus(s, TODAY)}`);
  });

  await check('with both sources, an answer replaces only its ok sources\' items and never stores a failed one\'s', () => {
    // Not in step 1 (sourcesFor gives one source); the store is ready for "Google becomes a connection".
    const legend: RangeResponse['calendars'] = [
      { id: FAMILY_G.id, source: 'google', name: 'Family', color: null, mine: true },
      { id: OWN_CAL.id, source: 'famcal', name: 'Raziel', color: null, mine: true },
    ];
    const both = (sources: RangeResponse['sources'], items: ItemDTO[]) => famcalAnswer({ sources, calendars: legend, days: { [TODAY]: items } });
    const f1 = ev('f1', T(0, '09:00'), T(0, '10:00'));
    const f2 = ev('f2', T(0, '11:00'), T(0, '12:00'));
    const g1 = gev('g1', T(0, '10:00'), T(0, '11:00'));
    const stray = gev('stray', T(0, '08:00'), T(0, '09:00'));
    let s = run([answer(both({ famcal: { status: 'ok' }, google: { status: 'pending' } }, [f1]))]);
    assert(dayStatus(s, TODAY) === 'loading', `FamCal only: today is ${dayStatus(s, TODAY)}`);
    assert(s.status.google === undefined, `a pending Google was stored: ${JSON.stringify(s.status.google)}`);
    s = reduceStore(s, answer(both({ famcal: { status: 'pending' }, google: { status: 'ok' } }, [g1])));
    assertJson(keys(dayItems(s, TODAY)), [f1.key, g1.key], 'after both answered');
    assertJson(s.status, { famcal: { status: 'ok' }, google: { status: 'ok' } }, 'a pending FamCal overwrote its status');
    assertJson(s.calendars.map((c) => c.source), ['famcal', 'google'], 'the legend, FamCal first');
    s = reduceStore(s, answer(both({ famcal: { status: 'ok' }, google: { status: 'error', reason: 'transient' } }, [f2, stray])));
    assertJson(keys(dayItems(s, TODAY)), [g1.key, f2.key], 'FamCal replaced, Google kept, the stray item dropped');
    assert(dayStatus(s, TODAY) === 'answered', `today is ${dayStatus(s, TODAY)}`);
    s = reduceStore(s, answer(both({ famcal: { status: 'ok' }, google: { status: 'pending' } }, [f2])));
    assertJson(s.status.google, { status: 'error', reason: 'transient' }, 'a pending Google overwrote its error');
  });

  await check('a different tz, today, week start or set of sources drops the store and bumps the epoch', () => {
    const base = run([
      answer(famcalAnswer({ days: { [TODAY]: [ev('a', T(0, '09:00'), T(0, '10:00'))] }, carryOvers: [rem('old', T(-2, '09:00'), { open: true, openSince: day(-2) })] })),
      answer(famcalAnswer({ ...agendaWeekWindow(TODAY, 1), days: { [day(8)]: [ev('c', T(8, '09:00'), T(8, '10:00'))] } })),
    ]);
    const cases: [string, RangeResponse][] = [
      ['tz', famcalAnswer({ tz: 'Europe/London' })],
      ['today', famcalAnswer({ today: day(1), from: day(1) })],
      ['weekStart', famcalAnswer({ weekStart: 1 })],
      ['sources', googleAnswer()],
    ];
    for (const [what, r] of cases) {
      const s = reduceStore(base, answer(r));
      assert(s.epoch === 1, `${what}: epoch ${s.epoch}`);
      assertJson([s.facts?.tz, s.facts?.today, s.facts?.weekStart, s.facts?.sources], [r.tz, r.today, r.weekStart, Object.keys(r.sources)], `${what}: facts`);
      assertJson(keys(dayItems(s, day(8))), [], `${what}: day 8 kept`);
      assert(s.carryOvers === null, `${what}: carry-overs kept`);
    }
  });

  await check('hebrewDates follows the latest answer, without a drop', () => {
    const a = ev('a', T(0, '09:00'), T(0, '10:00'));
    let s = run([answer(famcalAnswer({ hebrewDates: false, days: { [TODAY]: [a] } }))]);
    s = reduceStore(s, answer(famcalAnswer({ ...agendaWeekWindow(TODAY, 1), hebrewDates: true })));
    assert(s.facts?.hebrewDates === true && s.epoch === 0, `hebrewDates ${s.facts?.hebrewDates}, epoch ${s.epoch}`);
    assertJson(keys(dayItems(s, TODAY)), [a.key], 'today');
  });

  await check('an answer sent before the last drop is kept only when its facts still match', () => {
    const london = reduceStore(run([answer(famcalAnswer())]), answer(famcalAnswer({ tz: 'Europe/London' })));
    assert(london.epoch === 1, `epoch ${london.epoch}`);
    const stale = reduceStore(london, answer(famcalAnswer({ tz: IL, days: { [TODAY]: [ev('a', T(0, '09:00'), T(0, '10:00'))] } }), 0));
    assert(stale === london, 'a stale answer from epoch 0 was applied');
    const late = reduceStore(london, answer(famcalAnswer({ tz: 'Europe/London', days: { [TODAY]: [ev('b', T(0, '09:00'), T(0, '10:00'))] } }), 0));
    assertJson(keys(dayItems(late, TODAY)), ['famcal|b'], 'an epoch-0 answer with the same facts');
  });

  await check('reset (the midnight timer) empties the store; an answer sent before it is ignored', () => {
    const s = reduceStore(run([answer(famcalAnswer({ days: { [TODAY]: [ev('a', T(0, '09:00'), T(0, '10:00'))] } }))]), { type: 'reset' });
    assert(s.facts === null && s.epoch === 1 && Object.keys(s.days).length === 0, `after reset: ${JSON.stringify(s)}`);
    const before = reduceStore(s, answer(famcalAnswer(), 0));
    assert(before === s, 'an answer sent before midnight was applied');
    const after = reduceStore(s, answer(famcalAnswer({ today: day(1), from: day(1) }), 1));
    assert(after.facts?.today === day(1) && after.epoch === 1, `after: today ${after.facts?.today}, epoch ${after.epoch}`);
  });

  await check('the legend, the partner and the carry-overs come only from answers that carry them', () => {
    const co = [rem('old', T(-2, '09:00'), { open: true, openSince: day(-2) })];
    let s = run([answer(famcalAnswer({ carryOvers: co }))]);
    assertJson(s.calendars.map((c) => c.id), [OWN_CAL.id, NOA_CAL.id], 'legend');
    assert(s.partner?.name === 'Noa', 'partner');
    // A FamCal error answer: no legend, no partner, no carry-overs. Nothing is erased.
    s = reduceStore(s, answer(famcalAnswer({ sources: { famcal: { status: 'error' } }, partner: null, calendars: [] })));
    assertJson(s.calendars.map((c) => c.id), [OWN_CAL.id, NOA_CAL.id], 'legend after an error');
    assert(s.partner?.name === 'Noa', 'partner after an error');
    // Week 1 doesn't hold today: no carry-overs in it, and the old ones stay.
    s = reduceStore(s, answer(famcalAnswer({ ...agendaWeekWindow(TODAY, 1), calendars: [] })));
    assertJson(keys(s.carryOvers ?? []), ['famcal|old'], 'carry-overs after week 1');
    assertJson(s.calendars, [], 'an ok answer\'s empty legend replaces the old one');
    // Unpaired: an ok answer with partner null clears the partner.
    s = reduceStore(s, answer(famcalAnswer({ partner: null, carryOvers: [] })));
    assert(s.partner === null, 'partner after unpairing');
    assertJson(s.carryOvers, [], 'carry-overs replaced by an empty list');
  });

  await check('the reducer never changes its input', () => {
    const a = famcalAnswer({ days: { [TODAY]: [ev('b', T(0, '10:00'), T(0, '11:00')), ev('a', T(0, '09:00'), T(0, '10:00'))] }, carryOvers: [rem('old', T(-2, '09:00'), { open: true, openSince: day(-2) })] });
    const b = famcalAnswer({ days: { [TODAY]: [ev('c', T(0, '08:00'), T(0, '09:00'))] } });
    const s1 = run([answer(a)]);
    const snapshot = JSON.stringify([a, b, s1]);
    const s2 = reduceStore(s1, answer(b));
    reduceStore(s2, { type: 'windowFailed', ...agendaWeekWindow(TODAY, 1), sources: ['famcal'], kind: 'busy', epoch: 0 });
    reduceStore(s2, answer(famcalAnswer({ tz: 'Europe/London' })));
    reduceStore(s2, { type: 'reset' });
    assert(JSON.stringify([a, b, s1]) === snapshot, 'an answer or the earlier state was changed');
    assertJson(keys(a.days[0].items), ['famcal|b', 'famcal|a'], 'the answer\'s own order');
  });

  await check('a failed request marks only the days no ok answer covers', () => {
    const a = ev('a', T(0, '09:00'), T(0, '10:00'));
    const s0 = run([answer(famcalAnswer({ days: { [TODAY]: [a] } }))]);
    const s = reduceStore(s0, { type: 'windowFailed', from: TODAY, to: day(14), sources: ['famcal'], kind: 'busy', epoch: 0 });
    assert(dayStatus(s, TODAY) === 'answered' && dayStatus(s, day(9)) === 'failed', `today ${dayStatus(s, TODAY)}, day 9 ${dayStatus(s, day(9))}`);
    assertJson(keys(dayItems(s, TODAY)), [a.key], 'today');
    assertJson(s.lastFailure.famcal, { kind: 'busy', source: 'famcal' }, 'lastFailure');
    assert(reduceStore(emptyStore(), { type: 'windowFailed', from: TODAY, to: day(7), sources: ['famcal'], kind: 'error', epoch: 0 }).facts === null, 'a failure pinned facts');
    const old = reduceStore({ ...s0, epoch: 2 }, { type: 'windowFailed', from: TODAY, to: day(7), sources: ['famcal'], kind: 'error', epoch: 1 });
    assert(old.lastFailure.famcal === undefined, 'a failure from an older epoch was applied');
    const other = reduceStore(s0, { type: 'windowFailed', from: TODAY, to: day(7), sources: ['google'], kind: 'error', epoch: 0 });
    assert(other === s0, 'a failure of a source that does not apply changed the store');
  });

  await check('a failed day keeps the failure that marked it (DayCoverage.failure, set exactly when failed); an ok answer clears it, and a failure over ok data marks nothing', () => {
    const TIMEOUT = { kind: 'error', source: 'google', reason: 'timeout' } as const;
    let s = run([answer(googleAnswer({ sources: { google: { status: 'error', reason: 'timeout' } }, calendars: [] }))]);
    assertJson(s.days[TODAY]?.coverage.google, { ok: false, failed: true, partial: false, failure: TIMEOUT }, 'today after a timeout');
    assertJson(dayFailure(s, day(6), 'google'), TIMEOUT, 'dayFailure on day 6');
    assert(dayFailure(s, day(7), 'google') === null, 'a day nothing covered has a failure');
    assert(dayFailure(s, TODAY, 'famcal') === null, 'a source that does not apply has a failure');
    s = reduceStore(s, answer(googleAnswer()));
    assertJson(s.days[TODAY]?.coverage.google, { ok: true, failed: false, partial: false, failure: null }, 'today after an ok answer');
    assert(dayFailure(s, TODAY, 'google') === null, 'the failure outlived an ok answer');
    s = reduceStore(s, { type: 'windowFailed', from: TODAY, to: day(14), sources: ['google'], kind: 'busy', epoch: 0 });
    assert(dayFailure(s, TODAY, 'google') === null, 'a busy over ok data marked the day');
    assertJson(dayFailure(s, day(7), 'google'), { kind: 'busy', source: 'google' }, 'dayFailure on day 7');
    for (const [date, d] of Object.entries(s.days)) {
      const c = d.coverage.google;
      assert(c !== undefined && (c.failure !== null) === c.failed && c.failed !== c.ok, `${date}: ${JSON.stringify(c)}`);
    }
  });

  await check('a newer failure replaces an older one on its own days only', () => {
    const TRANSIENT = { kind: 'error', source: 'google', reason: 'transient' } as const;
    const BUSY = { kind: 'busy', source: 'google' } as const;
    const GONE = { kind: 'calendarsGone', source: 'google' } as const;
    const failures = (st: CalendarStore) => [0, 6, 7, 13, 14, 20, 21].map((n) => dayFailure(st, day(n), 'google'));
    let s = run([answer(googleAnswer({ sources: { google: { status: 'error', reason: 'transient' } }, calendars: [] }))]);
    s = reduceStore(s, { type: 'windowFailed', from: day(7), to: day(21), sources: ['google'], kind: 'busy', epoch: 0 });
    assertJson(failures(s), [TRANSIENT, TRANSIENT, BUSY, BUSY, BUSY, BUSY, null], 'a busy on weeks 1 and 2');
    assertJson(buildAgenda(s, 3)?.stateRows, [{ source: 'google', failure: TRANSIENT }], 'the state row: week 0\'s reason');
    s = reduceStore(s, answer(googleAnswer({ sources: { google: { status: 'error', reason: 'calendars_gone' } }, calendars: [] })));
    assertJson(failures(s), [GONE, GONE, BUSY, BUSY, BUSY, BUSY, null], 'calendars_gone on week 0');
    s = reduceStore(s, answer(googleAnswer({ ...agendaWeekWindow(TODAY, 2), sources: { google: { status: 'error', reason: 'timeout' } }, calendars: [] })));
    assertJson(failures(s).slice(4), [{ kind: 'error', source: 'google', reason: 'timeout' }, { kind: 'error', source: 'google', reason: 'timeout' }, null], 'a timeout on week 2');
    assertJson(failures(s).slice(0, 4), [GONE, GONE, BUSY, BUSY], 'weeks 0 and 1 keep theirs');
    assertJson(buildAgenda(s, 3)?.stateRows, [{ source: 'google', failure: GONE }], 'the state row: week 0\'s reason');
  });

  await check('addDaysToKey matches the server\'s addDaysToDate across DST and year ends', async () => {
    const { addDaysToDate } = await import('../src/utils/day-events');
    for (const start of ['2026-10-24', '2026-03-27', '2026-12-30', '2028-02-28', '2026-10-31']) {
      for (const n of [-400, -8, -1, 0, 1, 2, 7, 13, 42, 366]) {
        assert(addDaysToKey(start, n) === addDaysToDate(start, n), `${start} ${n}: ${addDaysToKey(start, n)} vs ${addDaysToDate(start, n)}`);
      }
    }
  });

  // ---------------- The Agenda ----------------

  await check('the Agenda lists today and the next 6 days; today and tomorrow show even when empty', () => {
    const model = buildAgenda(run([answer(famcalAnswer({ days: { [day(3)]: [ev('x', T(3, '09:00'), T(3, '10:00'))] } }))]));
    assertJson(shape(model), [
      `D ${TODAY} today answered []`,
      `D ${day(1)} tomorrow answered []`,
      `F ${day(2)}..${day(2)}`,
      `D ${day(3)} - answered [famcal|x]`,
      `F ${day(4)}..${day(6)}`,
    ], 'entries');
    assert(model?.end === day(7) && model.weeks === 1, `end ${model?.end}, weeks ${model?.weeks}`);
    assertJson([model?.today, model?.tz, model?.weekStart, model?.hebrewDates], [TODAY, IL, 0, true], 'facts');
  });

  await check('Show next week adds 7 days, and a fold runs across the week boundary', () => {
    const s = run([
      answer(famcalAnswer({ days: { [day(4)]: [ev('x', T(4, '09:00'), T(4, '10:00'))] } })),
      answer(famcalAnswer({ ...agendaWeekWindow(TODAY, 1), days: { [day(10)]: [ev('y', T(10, '09:00'), T(10, '10:00'))] } })),
    ]);
    assertJson(shape(buildAgenda(s, 2)), [
      `D ${TODAY} today answered []`,
      `D ${day(1)} tomorrow answered []`,
      `F ${day(2)}..${day(3)}`,
      `D ${day(4)} - answered [famcal|x]`,
      `F ${day(5)}..${day(9)}`,
      `D ${day(10)} - answered [famcal|y]`,
      `F ${day(11)}..${day(13)}`,
    ], 'two weeks');
    assert(buildAgenda(s, 2)?.end === day(14), 'end');
  });

  await check('nothing reads as empty before every source has answered', () => {
    const s = run([answer(famcalAnswer({ days: { [day(4)]: [ev('x', T(4, '09:00'), T(4, '10:00'))] } }))]);
    const model = buildAgenda(s, 2);
    const week1 = shape(model).slice(-7);
    assertJson(week1, [7, 8, 9, 10, 11, 12, 13].map((n) => `D ${day(n)} - loading []`), 'week 1 before its answer');
    assert(model?.empty === false, 'empty while loading');
  });

  await check('a source that failed with no earlier ok data shows its state row once, and no empty line or fold', () => {
    const s = run([answer(googleAnswer({ sources: { google: { status: 'error', reason: 'timeout' } }, calendars: [] }))]);
    const model = buildAgenda(s);
    assertJson(shape(model), [`D ${TODAY} today failed []`, `D ${day(1)} tomorrow failed []`], 'entries');
    assertJson(model?.stateRows, [{ source: 'google', failure: { kind: 'error', source: 'google', reason: 'timeout' } }], 'state rows');
    assert(model?.empty === false, 'empty after a failure');
  });

  await check('an error after an ok answer shows the earlier data and no state row', () => {
    const g = gev('dinner', T(0, '19:30'), T(0, '22:00'));
    const s = run([
      answer(googleAnswer({ days: { [TODAY]: [g] } })),
      answer(googleAnswer({ sources: { google: { status: 'error', reason: 'transient' } }, calendars: [] })),
    ]);
    const model = buildAgenda(s);
    assertJson(model?.stateRows, [], 'state rows');
    assertJson(shape(model).slice(0, 3), [`D ${TODAY} today answered [${g.key}]`, `D ${day(1)} tomorrow answered []`, `F ${day(2)}..${day(6)}`], 'entries');
  });

  await check('reconnect is never a state row: the banner (homeNotices) carries it, and only for Google users', () => {
    const s = run([answer(googleAnswer({ sources: { google: { status: 'reconnect', reason: 'scopes' } }, calendars: [] }))]);
    assertJson(buildAgenda(s)?.stateRows, [], 'state rows');
    assertJson(homeNotices(s), { reconnect: 'scopes', unavailableCalendars: 0 }, 'notices');
    const famcal = run([answer(famcalAnswer({ sources: { famcal: { status: 'error' } } }))]);
    assertJson(homeNotices(famcal), { reconnect: null, unavailableCalendars: 0 }, 'a FamCal user\'s notices');
    const back = reduceStore(s, answer(googleAnswer()));
    assert(homeNotices(back).reconnect === 'scopes', 'a later ok answer (a cache hit) took the banner away');
  });

  await check('calendars_gone, a FamCal error and a busy request each give their own state row', () => {
    const gone = run([answer(googleAnswer({ sources: { google: { status: 'error', reason: 'calendars_gone' } }, calendars: [] }))]);
    assertJson(buildAgenda(gone)?.stateRows, [{ source: 'google', failure: { kind: 'calendarsGone', source: 'google' } }], 'calendars_gone');
    const famcal = run([answer(famcalAnswer({ sources: { famcal: { status: 'error' } } }))]);
    assertJson(buildAgenda(famcal)?.stateRows, [{ source: 'famcal', failure: { kind: 'error', source: 'famcal', reason: null } }], 'FamCal error');
    const busy = reduceStore(run([answer(famcalAnswer())]), { type: 'windowFailed', ...agendaWeekWindow(TODAY, 1), sources: ['famcal'], kind: 'busy', epoch: 0 });
    const model = buildAgenda(busy, 2);
    assertJson(model?.stateRows, [{ source: 'famcal', failure: { kind: 'busy', source: 'famcal' } }], 'busy');
    assertJson(shape(model), [`D ${TODAY} today answered []`, `D ${day(1)} tomorrow answered []`, `F ${day(2)}..${day(6)}`], 'week 1 left out');
    assertJson(buildAgenda(busy, 1)?.stateRows, [], 'week 1 not shown: no row');
    // Week 2 answers: its empty days fold on their own; the failed week between ends the first run.
    const later = reduceStore(busy, answer(famcalAnswer(agendaWeekWindow(TODAY, 2))));
    assertJson(shape(buildAgenda(later, 3)), [
      `D ${TODAY} today answered []`,
      `D ${day(1)} tomorrow answered []`,
      `F ${day(2)}..${day(6)}`,
      `F ${day(14)}..${day(20)}`,
    ], 'weeks 0 and 2 answered, week 1 failed');
  });

  await check('a busy week 1 keeps week 0\'s calendars-gone row: a state row gives the earliest shown failed day\'s reason, then lastFailure, then a generic error', () => {
    const GONE_ROW = [{ source: 'google', failure: { kind: 'calendarsGone', source: 'google' } }];
    const gone = run([answer(googleAnswer({ sources: { google: { status: 'error', reason: 'calendars_gone' } }, calendars: [] }))]);
    const s = reduceStore(gone, { type: 'windowFailed', ...agendaWeekWindow(TODAY, 1), sources: ['google'], kind: 'busy', epoch: 0 });
    assertJson(s.lastFailure.google, { kind: 'busy', source: 'google' }, 'lastFailure is still the latest');
    assertJson(buildAgenda(s, 1)?.stateRows, GONE_ROW, 'week 0');
    assertJson(buildAgenda(s, 2)?.stateRows, GONE_ROW, 'weeks 0 and 1: Choose again, not Busy');
    const back = reduceStore(s, answer(googleAnswer()));
    assertJson(buildAgenda(back, 2)?.stateRows, [{ source: 'google', failure: { kind: 'busy', source: 'google' } }], 'week 0 answered: week 1\'s busy');
    // A failed day without a failure of its own (the reducer never makes one) reads lastFailure, then a generic error.
    const bare: CalendarStore = { ...back, days: { ...back.days, [day(7)]: { items: [], coverage: { google: { ok: false, failed: true, partial: false, failure: null } } } } };
    assertJson(buildAgenda(bare, 2)?.stateRows, [{ source: 'google', failure: { kind: 'busy', source: 'google' } }], 'no failure of its own: lastFailure');
    assertJson(buildAgenda({ ...bare, lastFailure: {} }, 2)?.stateRows, [{ source: 'google', failure: { kind: 'error', source: 'google', reason: null } }], 'no lastFailure either: a generic error');
  });

  await check('a partial Google answer counts as answered and sets partial; unavailable calendars are counted', () => {
    const s = run([
      answer(googleAnswer({
        sources: { google: { status: 'ok', partial: { failed: 1, truncated: 0 } } },
        calendars: [
          { id: FAMILY_G.id, source: 'google', name: 'Family', color: null, mine: true },
          { id: 'gone@group.calendar.google.com', source: 'google', name: 'Old', color: null, mine: true, unavailable: true },
        ],
      })),
    ]);
    const model = buildAgenda(s);
    assert(model?.partial === true, 'partial');
    assertJson(shape(model), [`D ${TODAY} today answered []`, `D ${day(1)} tomorrow answered []`, `F ${day(2)}..${day(6)}`], 'entries');
    assert(homeNotices(s).unavailableCalendars === 1 && model?.unavailableCalendars === 1, 'unavailable');
    assert(buildAgenda(reduceStore(s, answer(googleAnswer())))?.partial === false, 'partial after a whole answer');
  });

  await check('the Reconnect banner and the unavailable calendars hold for the whole epoch, so a row above the Month never comes and goes with each month\'s answer (iOS has no scroll anchoring): ok, reconnect, ok keep reconnect at "token"; a calendar once listed unavailable stays counted; a store drop clears both', () => {
    const GONE = { id: 'gone@group.calendar.google.com', source: 'google' as const, name: 'Old', color: null, mine: true };
    const legend = (gone: boolean, more: RangeResponse['calendars'] = []) => [
      { id: FAMILY_G.id, source: 'google' as const, name: 'Family', color: null, mine: true },
      { ...GONE, unavailable: gone },
      ...more,
    ];
    // A dead token: a window with a cache entry answers ok, one without answers reconnect.
    let s = run([answer(googleAnswer())]);
    assertJson(homeNotices(s), { reconnect: null, unavailableCalendars: 0 }, 'the first answer, a cache hit');
    s = reduceStore(s, answer(googleAnswer({ from: '2026-11-01', to: '2026-12-01', sources: { google: { status: 'reconnect', reason: 'token' } }, calendars: [] })));
    assertJson(homeNotices(s), { reconnect: 'token', unavailableCalendars: 0 }, 'November, no cache entry');
    s = reduceStore(s, answer(googleAnswer({ from: '2026-12-01', to: '2027-01-01' })));
    assertJson(homeNotices(s), { reconnect: 'token', unavailableCalendars: 0 }, 'December, a cache hit');
    // A chosen calendar gone: listed unavailable in one month's answer, not in an older cache entry's.
    s = reduceStore(s, answer(googleAnswer({ from: '2027-02-01', to: '2027-03-01', calendars: legend(true) })));
    assertJson(homeNotices(s), { reconnect: 'token', unavailableCalendars: 1 }, 'February');
    s = reduceStore(s, answer(googleAnswer({ from: '2027-03-01', to: '2027-04-01', calendars: legend(false) })));
    assertJson(homeNotices(s), { reconnect: 'token', unavailableCalendars: 1 }, 'March, from an older cache entry');
    s = reduceStore(s, answer(googleAnswer({ from: '2027-04-01', to: '2027-05-01', calendars: legend(true, [{ id: 'x@group.calendar.google.com', source: 'google', name: 'X', color: null, mine: true, unavailable: true }]) })));
    assertJson(homeNotices(s), { reconnect: 'token', unavailableCalendars: 2 }, 'April, a second one gone');
    assert(buildAgenda(s)?.unavailableCalendars === 2, `the Agenda's row: ${buildAgenda(s)?.unavailableCalendars}`);
    s = reduceStore(s, { type: 'reset' });
    assertJson(homeNotices(s), { reconnect: null, unavailableCalendars: 0 }, 'after the midnight drop');
    s = reduceStore(s, answer(googleAnswer(), 1));
    assertJson(homeNotices(s), { reconnect: null, unavailableCalendars: 0 }, 'the new epoch\'s first answer');
  });

  await check('agendaWeekWindow: week 0 is the route\'s no-dates window, each later week the next 7 days', () => {
    assertJson(agendaWeekWindow(TODAY, 0), { from: TODAY, to: '2026-10-22' }, 'week 0');
    assertJson(agendaWeekWindow(TODAY, 1), { from: '2026-10-22', to: '2026-10-29' }, 'week 1');
    assertJson(agendaWeekWindow('2026-12-28', 1), { from: '2027-01-04', to: '2027-01-11' }, 'across the year end');
  });

  await check('Still open: today\'s open reminders by time, then the carry-overs newest first; 5 shown, then the rest', () => {
    const todays = [rem('t2', T(0, '08:30'), { open: true }), rem('t1', T(0, '07:00'), { open: true }), rem('t3', T(0, '23:00'))];
    const carry = [1, 2, 3, 4, 5].map((n) => rem(`c${n}`, T(-n, '09:00'), { open: true, openSince: day(-n) }));
    const model = buildAgenda(run([answer(famcalAnswer({ days: { [TODAY]: todays }, carryOvers: carry }))]));
    const card = model?.stillOpen;
    assert(card != null, 'no card');
    assertJson(card.shown.map((r) => r.item.key), ['famcal|t1', 'famcal|t2', 'famcal|c1', 'famcal|c2', 'famcal|c3'], 'shown');
    assertJson(card.more.map((r) => r.item.key), ['famcal|c4', 'famcal|c5'], 'more');
    assertJson([...card.shown, ...card.more].map((r) => r.since), [TODAY, TODAY, day(-1), day(-2), day(-3), day(-4), day(-5)], 'since');
    assertJson(card.shown.map((r) => r.carriedOver), [false, false, true, true, true], 'carriedOver');
  });

  await check('Still open leaves out done reminders and the partner\'s own, and lists a key once', () => {
    const todays = [
      rem('done', T(0, '07:00'), { open: false, done: true, doneAt: T(0, '07:05') }),
      rem('noas', T(0, '07:30'), { open: true, ownerIsViewer: false, creatorIsViewer: false, ownerName: 'Noa', creatorName: 'Noa' }, { calendar: NOA_CAL }),
      rem('forNoa', T(0, '08:00'), { open: true, ownerIsViewer: false, ownerName: 'Noa' }),
      rem('fromNoa', T(0, '08:30'), { open: true, creatorIsViewer: false, creatorName: 'Noa' }, { calendar: MASKED }),
    ];
    const s = run([answer(famcalAnswer({ days: { [TODAY]: todays }, carryOvers: [rem('forNoa', T(0, '08:00'), { open: true, openSince: TODAY, ownerIsViewer: false, ownerName: 'Noa' })] }))]);
    const card = buildAgenda(s)?.stillOpen;
    assertJson(card?.shown.map((r) => r.item.key), ['famcal|forNoa', 'famcal|fromNoa'], 'shown');
    assertJson(card?.more, [], 'more');
    assert(buildAgenda(run([answer(famcalAnswer({ days: { [TODAY]: [todays[0]] } }))]))?.stillOpen === null, 'a card with nothing open');
  });

  await check('reminder marks: done, snoozed, open, later; events have none', () => {
    const marks = [
      rem('d', T(0, '07:00'), { done: true, doneAt: T(0, '07:01'), open: false }),
      rem('s', T(0, '07:00'), { open: true, snoozedUntil: T(0, '20:00') }),
      rem('o', T(0, '07:00'), { open: true }),
      rem('l', T(0, '23:00')),
      ev('e', T(0, '07:00'), T(0, '08:00')),
    ].map(reminderMark);
    assertJson(marks, ['done', 'snoozed', 'open', 'later', null], 'marks');
  });

  await check('whose: reminders go by ownerIsViewer and events by calendar.mine; "for" and "from" as the summaries say', async () => {
    const { reminderAttribution } = await import('../src/utils/event-formatter');
    const combos: [boolean, boolean][] = [[true, true], [true, false], [false, true], [false, false]];
    for (const [ownerIsViewer, creatorIsViewer] of combos) {
      const r = rem('r', T(0, '09:00'), {
        ownerIsViewer,
        creatorIsViewer,
        ...(ownerIsViewer ? {} : { ownerName: 'Noa' }),
        ...(creatorIsViewer ? {} : { creatorName: 'Noa' }),
      });
      const w = whoseItem(r, 'Noa');
      const said = reminderAttribution({ reminder: { ownerIsViewer, creatorIsViewer, ownerName: r.reminder?.ownerName, creatorName: r.reminder?.creatorName } });
      const ours = w.relation === null ? undefined : w.relation === 'from' ? `from ${w.person}` : `for ${w.person}, you asked`;
      assert(ours === said, `owner ${ownerIsViewer} creator ${creatorIsViewer}: ours ${ours}, the summary's ${said}`);
      assert(w.mine === ownerIsViewer, `owner ${ownerIsViewer} creator ${creatorIsViewer}: mine ${w.mine}`);
      assert((w.person === null) === (ownerIsViewer && creatorIsViewer), `owner ${ownerIsViewer} creator ${creatorIsViewer}: person ${w.person}`);
    }
    // A reminder for the viewer on the partner's calendar is the viewer's (not the calendar's).
    assert(whoseItem(rem('r', T(0, '09:00'), {}, { calendar: NOA_CAL }), 'Noa').mine === true, 'a reminder for me on Noa\'s calendar');
  });

  await check('whose: a reminder for both partners is the viewer\'s, with no name and relation "both"; the summaries say "for both of you" for it', async () => {
    const { reminderAttribution } = await import('../src/utils/event-formatter');
    const r = rem('r', T(0, '09:00'), { ownerIsViewer: true, creatorIsViewer: false, creatorName: 'Noa', forBoth: true });
    assertJson(whoseItem(r, 'Noa'), { mine: true, person: null, relation: 'both' }, 'from the partner');
    assertJson(whoseItem(rem('s', T(0, '09:00'), { ownerIsViewer: true, creatorIsViewer: true, forBoth: true }), 'Noa'), { mine: true, person: null, relation: 'both' }, 'from the creator');
    assert(reminderAttribution({ reminder: { ownerIsViewer: true, creatorIsViewer: false, creatorName: 'Noa', forBoth: true } }) === 'for both of you', 'the summaries');
  });

  await check('whose: the person chip names the partner or the spouse calendar\'s person, with the partner as fallback', () => {
    const cases: [string, ItemDTO, string | null][] = [
      ['own event', ev('a', T(0, '09:00'), T(0, '10:00')), null],
      ['partner calendar', ev('b', T(0, '09:00'), T(0, '10:00'), { calendar: NOA_CAL }), 'Noa'],
      ['masked calendar', rem('c', T(0, '09:00'), { ownerIsViewer: false, creatorIsViewer: false }, { calendar: MASKED }), 'Noa'],
      ['Google family', gev('d', T(0, '09:00'), T(0, '10:00')), null],
      ['Google spouse', gev('e', T(0, '09:00'), T(0, '10:00'), { calendar: SPOUSE_G }), 'Dana'],
      ['from, name missing', rem('f', T(0, '09:00'), { creatorIsViewer: false }), 'Noa'],
    ];
    for (const [what, item, person] of cases) {
      const w = whoseItem(item, 'Noa');
      assert(w.person === person, `${what}: ${w.person}, want ${person}`);
    }
    const unpaired = whoseItem(rem('g', T(0, '09:00'), { creatorIsViewer: false }), null);
    assertJson(unpaired, { mine: true, person: null, relation: null }, 'no name anywhere');
    const rows = buildAgenda(run([answer(famcalAnswer({ days: { [TODAY]: [cases[1][1]] } }))]))?.entries[0];
    assert(rows?.type === 'day' && rows.rows[0].whose.person === 'Noa', 'the Agenda row\'s whose');
  });

  await check('the empty state shows only when every day answered and nothing is planned or open', () => {
    assert(buildAgenda(run([answer(famcalAnswer())]))?.empty === true, 'an empty week');
    assert(buildAgenda(run([answer(famcalAnswer({ carryOvers: [rem('old', T(-2, '09:00'), { open: true, openSince: day(-2) })] }))]))?.empty === false, 'with a carry-over');
    assert(buildAgenda(run([answer(famcalAnswer({ days: { [day(5)]: [ev('x', T(5, '09:00'), T(5, '10:00'))] } }))]))?.empty === false, 'with an event on day 5');
    assert(buildAgenda(run([answer(famcalAnswer())]), 2)?.empty === false, 'week 1 still loading');
  });

  await check('patchReminder: done, undo and snooze reach every copy of the item (each day, the carry-overs), with open worked out per place; the Still open card follows; nothing else is touched', () => {
    const copy = (r: Partial<ItemReminderDTO> = {}) => rem('plumber', T(0, '08:00'), { open: true, ...r });
    const other = rem('other', T(0, '09:00'), { open: true });
    const carried = rem('plumber', T(0, '08:00'), { open: true, openSince: day(-1) });
    const s0 = run([answer(famcalAnswer({ days: { [TODAY]: [copy(), other], [day(2)]: [copy()] }, carryOvers: [carried] }))]);
    const keyOf = 'famcal|plumber';
    const reminderOf = (s: CalendarStore, where: 'today' | 'later' | 'carry') =>
      (where === 'carry' ? s.carryOvers?.find((i) => i.key === keyOf) : dayItems(s, where === 'today' ? TODAY : day(2)).find((i) => i.key === keyOf))?.reminder;
    const done = { done: true, doneAt: T(0, '10:00'), snoozedUntil: null, open: true, openSince: null, ownerIsViewer: true, creatorIsViewer: true };
    const s1 = reduceStore(s0, { type: 'patchReminder', key: keyOf, reminder: done });
    for (const where of ['today', 'later', 'carry'] as const) {
      const r = reminderOf(s1, where);
      assert(r?.done === true && r.doneAt === T(0, '10:00') && r.open === false, `done, ${where}: ${JSON.stringify(r)}`);
    }
    assert(reminderOf(s1, 'carry')?.openSince === day(-1), 'a carry-over keeps its since');
    assert(dayItems(s1, TODAY).find((i) => i.key === 'famcal|other') === dayItems(s0, TODAY).find((i) => i.key === 'famcal|other'), 'another item is the same object');
    assert(s1.days[day(3)] === s0.days[day(3)], 'a day without it is the same object');
    const card = (s: CalendarStore) => (buildAgenda(s)?.stillOpen?.shown ?? []).map((r) => r.item.key).sort();
    assertJson(card(s0), ['famcal|other', keyOf].sort(), 'the card before');
    assertJson(card(s1), ['famcal|other'], 'the card after done');
    assert(reminderMark(dayItems(s1, TODAY).find((i) => i.key === keyOf) as ItemDTO) === 'done', 'the mark follows');

    // Undo: the server's open is for today's copy only; a copy on another day is never open; the carry-over is.
    const s2 = reduceStore(s1, { type: 'patchReminder', key: keyOf, reminder: { ...done, done: false, doneAt: null, open: true } });
    assert(reminderOf(s2, 'today')?.open === true && reminderMark(dayItems(s2, TODAY).find((i) => i.key === keyOf) as ItemDTO) === 'open', 'undo, today open');
    assert(reminderOf(s2, 'later')?.open === false && reminderOf(s2, 'carry')?.open === true, 'undo, later never open, carry-over open');
    assertJson(card(s2), ['famcal|other', keyOf].sort(), 'the card after undo');

    // Snooze: still open and marked snoozed; an undue copy stays not open.
    const snoozed = { ...done, done: false, doneAt: null, snoozedUntil: T(0, '12:30'), open: true };
    const s3 = reduceStore(s2, { type: 'patchReminder', key: keyOf, reminder: snoozed });
    assert(reminderMark(dayItems(s3, TODAY).find((i) => i.key === keyOf) as ItemDTO) === 'snoozed' && reminderOf(s3, 'today')?.open === true, 'snoozed, today');
    assert(card(s3).includes(keyOf), 'a snoozed past-due item stays on the card');

    // The next answer is the truth: it replaces what the patch said.
    const s4 = reduceStore(s3, answer(famcalAnswer({ days: { [TODAY]: [copy({ done: true, doneAt: T(0, '11:00') }), other] } })));
    assert(reminderOf(s4, 'today')?.doneAt === T(0, '11:00'), 'the answer replaces the patch');

    // A key the store does not hold changes nothing; an event of that key is not a reminder.
    assert(reduceStore(s0, { type: 'patchReminder', key: 'famcal|nope', reminder: done }) === s0, 'unknown key: same state');
    const evState = run([answer(famcalAnswer({ days: { [TODAY]: [ev('plumber', T(0, '08:00'), T(0, '09:00'))] } }))]);
    assert(reduceStore(evState, { type: 'patchReminder', key: keyOf, reminder: done }) === evState, 'an event is not patched');
  });

  await check('storeRow: the copy the sheet was opened from (a day or the carry-overs) wins over the earliest day\'s; without an origin the earliest day, then the carry-over', () => {
    const past = rem('plumber', T(-3, '08:00'), { open: false });
    const carried = rem('plumber', T(-3, '08:00'), { open: true, openSince: day(-3) });
    const s = run([answer(famcalAnswer({ from: day(-3), days: { [day(-3)]: [past] }, carryOvers: [carried] }))]);
    const row = (origin?: string) => storeRow(s, 'famcal|plumber', origin);
    assert(row('carryOver')?.item.reminder?.open === true && row('carryOver')?.origin === 'carryOver', 'a card opens the carry-over copy');
    assert(row(day(-3))?.item.reminder?.open === false && row(day(-3))?.origin === day(-3), 'a past day opens its own copy');
    assert(row()?.origin === day(-3), 'no origin: the earliest day');
    assert(row(day(5))?.origin === day(-3), 'an origin the store lacks: falls back');
    const only = run([answer(famcalAnswer({ days: {}, carryOvers: [carried] }))]);
    assert(storeRow(only, 'famcal|plumber', day(-3))?.origin === 'carryOver', 'a day copy that is gone: the carry-over');
    assert(storeRow(only, 'famcal|nope', 'carryOver') === null, 'no copy at all');
    const card = buildAgenda(run([answer(famcalAnswer({ days: {}, carryOvers: [carried] }))]))?.stillOpen?.shown[0];
    assert(card?.origin === 'carryOver', 'the card\'s row carries its origin');
  });

  await check('reminderStateAt: done, snoozed, open once its time has passed (a date-only one from 09:00 its day), else not due yet; events have none', () => {
    const r = (start: string, o: Partial<ItemReminderDTO> = {}) => rem('x', start, o);
    assert(reminderStateAt(r(T(0, '13:00')), Date.parse(T(0, '14:00')), IL) === 'open', 'past due');
    assert(reminderStateAt(r(T(0, '13:00')), Date.parse(T(0, '13:00')), IL) === 'open', 'at its time');
    assert(reminderStateAt(r(T(0, '13:00'), { open: true }), Date.parse(T(0, '12:00')), IL) === 'later', 'ahead, whatever the per-day flag says');
    assert(reminderStateAt(r(T(-2, '13:00'), { open: false }), Date.parse(T(0, '12:00')), IL) === 'open', 'a past day\'s copy that was never done is open');
    assert(reminderStateAt(r(T(0, '13:00'), { done: true }), Date.parse(T(0, '14:00')), IL) === 'done', 'done');
    assert(reminderStateAt(r(T(0, '13:00'), { snoozedUntil: T(0, '15:00') }), Date.parse(T(0, '14:00')), IL) === 'snoozed', 'snoozed');
    assert(reminderStateAt(r(TODAY, { dueAt: T(0, '09:00') }), Date.parse(T(0, '08:59')), IL) === 'later', 'date-only before 09:00');
    assert(reminderStateAt(r(TODAY, { dueAt: T(0, '09:00') }), Date.parse(T(0, '09:00')), IL) === 'open', 'date-only at 09:00');
    assert(reminderStateAt(r(day(-1)), Date.parse(T(0, '00:30')), IL) === 'open', 'date-only, yesterday');
    assert(reminderStateAt(r(day(1)), Date.parse(T(0, '23:00')), IL) === 'later', 'date-only, tomorrow');
    assert(reminderStateAt(ev('e', T(0, '13:00'), T(0, '14:00')), Date.parse(T(0, '14:00')), IL) === null, 'an event');
  });

  await check("reminderStateAt: a date-only reminder is open from the dueAt the server computed for the viewer (their reminder time, minutes included), not from a fixed 09:00", () => {
    const r = (start: string, o: Partial<ItemReminderDTO> = {}) => rem('x', start, o);
    assert(reminderStateAt(r(TODAY, { dueAt: T(0, '18:00') }), Date.parse(T(0, '10:00')), IL) === 'later', '10:00, due 18:00');
    assert(reminderStateAt(r(TODAY, { dueAt: T(0, '18:00') }), Date.parse(T(0, '18:00')), IL) === 'open', '18:00, due 18:00');
    assert(reminderStateAt(r(TODAY, { dueAt: T(0, '07:30') }), Date.parse(T(0, '08:00')), IL) === 'open', '08:00, due 07:30');
    assert(reminderStateAt(r(TODAY, { dueAt: T(0, '07:30') }), Date.parse(T(0, '07:29')), IL) === 'later', '07:29, due 07:30');
  });

  await check('response with hold: an answer asked before a patch leaves that key as patched, in the days and the carry-overs; the other keys and a later answer are taken as they are', () => {
    const copy = (id: string, r: Partial<ItemReminderDTO> = {}) => rem(id, T(0, '08:00'), { open: true, ...r });
    const body = (done: boolean) => famcalAnswer({ days: { [TODAY]: [copy('plumber', { done }), copy('other')] }, carryOvers: [rem('plumber', T(0, '08:00'), { open: true, openSince: day(-1) })] });
    const patch = { done: true, doneAt: T(0, '10:00'), snoozedUntil: null, open: false, openSince: null, ownerIsViewer: true, creatorIsViewer: true };
    const s1 = reduceStore(run([answer(body(false))]), { type: 'patchReminder', key: 'famcal|plumber', reminder: patch });
    const hold = new Map([['famcal|plumber', patch]]);
    const stale = reduceStore(s1, { type: 'response', response: body(false), epoch: 0, hold });
    const doneIn = (st: CalendarStore, id: string) => dayItems(st, TODAY).find((i) => i.key === `famcal|${id}`)?.reminder?.done;
    assert(doneIn(stale, 'plumber') === true && doneIn(stale, 'other') === false, 'the stale answer does not undo the patch');
    assert(stale.carryOvers?.[0].reminder?.done === true && stale.carryOvers[0].reminder.open === false, 'nor the carry-over\'s');
    assert(reduceStore(s1, { type: 'response', response: body(false), epoch: 0 }).days[TODAY].items.find((i) => i.key === 'famcal|plumber')?.reminder?.done === false, 'without hold the answer is taken');
    const later = reduceStore(stale, { type: 'response', response: body(false), epoch: 0 });
    assert(doneIn(later, 'plumber') === false, 'an answer asked after is the truth');
  });

  await check('the model is client-safe: store.ts and agenda.ts load nothing outside src/lib/calendar-view', () => {
    const view = path.resolve(__dirname, '..', 'src', 'lib', 'calendar-view');
    const roots = [path.join(view, 'store.ts'), path.join(view, 'agenda.ts')];
    // Everything the two files required, and what that required in turn. They are the
    // smoke's first imports, so every module they need is loaded by them.
    const loaded = new Set<string>();
    const walk = (id: string) => {
      for (const child of require.cache[id]?.children ?? []) {
        if (loaded.has(child.id)) continue;
        loaded.add(child.id);
        walk(child.id);
      }
    };
    for (const id of roots) {
      assert(require.cache[id] !== undefined, `${id} is not in require.cache: the check would be empty`);
      walk(id);
    }
    assert(loaded.has(path.join(view, 'types.ts')), `types.ts not found among ${JSON.stringify([...loaded])}: the check would be empty`);
    assertJson([...loaded].filter((p) => !p.startsWith(view + path.sep)), [], 'modules outside src/lib/calendar-view');
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

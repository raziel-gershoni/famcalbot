// Smoke test for drag to move's pure logic (editor upgrades spec §4): src/lib/calendar-view/
// drag-model.ts on the editor's real model (editItemForm, moveStart, scopePlan, updateBody).
//
// It checks, with nothing mocked but the item's edit info (a plain object):
//  - which items lift: not when the viewer can't change them, not when they repeat every day;
//  - the day delta (the drop day less the grabbed day) and the drop ids the grid registers;
//  - the target start and end: a timed item keeps its time and length, an all-day one its days,
//    a multi-day one grabbed on its 2nd day shifts by the days between the grabbed and drop days,
//    past midnight, over a daylight-saving day in Asia/Jerusalem, and a series in another zone
//    keeps its time of day THERE;
//  - the scope the editor's own scopePlan asks, per kind of series: a one-off none, a series
//    this one / this one and the ones after / all of them, a set-weekdays series "Only this one",
//    a Hebrew series, a reminder;
//  - the PATCH body updateBody builds for each, and the Undo body: the same scope, the key the
//    PATCH answered, the start shifted back, and none offered after "following";
//  - the optimistic item the store shows (shiftItemDto).
//
// Run: TZ=Asia/Jerusalem npx tsx scripts/smoke-drag-move.ts (also TZ=UTC and TZ=America/New_York).

import {
  dayDelta,
  dayOfDrop,
  dropId,
  liftVerdict,
  moveBody,
  planMove,
  repeatsEveryDayInfo,
  shiftedForm,
  shiftItemDto,
  spanOnDay,
  undoBody,
  undoable,
  type MovePlan,
} from '../src/lib/calendar-view/drag-model';
import { fromZonedTime } from 'date-fns-tz';
import { daySpanOf } from '../src/utils/day-events';
import { OVERLAY_CLASS, ghostTranslation, visibleHits, type HitElement } from '../app/[locale]/(app)/dashboard/DragSurface';
import { dayItems, dayStatus, emptyStore, itemCopies, reduceStore } from '../src/lib/calendar-view/store';
import type { RangeResponse } from '../src/lib/calendar-view/types';
import type { EditScope, ItemEditInfoResponse, RepeatInfo, RepeatSpec } from '../src/lib/calendar-view/editor-types';
import type { ItemDTO } from '../src/lib/calendar-view/types';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function same(got: unknown, want: unknown, label: string) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label}\n     got  ${g}\n     want ${w}`);
}

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';

// ---- Fixtures ----

/** An item's edit info; only what a drop reads. */
function info(o: {
  start: string;
  end: string;
  allDay?: boolean;
  kind?: 'event' | 'reminder';
  canEdit?: boolean;
  tz?: string;
  zone?: string;
  series?: Partial<ItemEditInfoResponse['series']>;
  scopes?: EditScope[];
}): ItemEditInfoResponse {
  const recurring = o.series?.recurring === true;
  return {
    kind: o.kind ?? 'event',
    canEdit: o.canEdit ?? true,
    canDelete: true,
    occurrence: { start: o.start, end: o.end, allDay: o.allDay ?? false, title: 'Swim', location: '', description: '' },
    series: { recurring: false, start: o.start, repeat: null, fixedDays: false, zone: o.zone ?? o.tz ?? IL, rule: { choice: 'none' }, first: true, ...o.series },
    tz: o.tz ?? IL,
    calendar: { id: 'native:cal', name: 'Family', color: null },
    forName: null,
    scopes: o.scopes ?? (recurring ? ['single', 'following', 'all'] : ['single']),
    source: 'famcal',
  };
}

const weekly = (byDay: string[] = []): RepeatInfo => ({ freq: 'weekly', interval: 1, byDay, ends: false });
const weeklySpec = (byDay: RepeatSpec['byDay']): RepeatSpec => ({ freq: 'weekly', interval: 1, byDay });

const one = info({ start: '2026-10-20T09:00', end: '2026-10-20T10:00' });
const swim = info({ start: '2026-10-20T17:00', end: '2026-10-20T18:00', series: { recurring: true, start: '2026-10-06T17:00', repeat: weekly(), rule: { choice: 'weekly' }, spec: weeklySpec(['TU']), first: false } });
/** "Every Tuesday" as the bot writes it: BYDAY names the day, so a day move can only apply to this one (or restate the rule). */
const tuesdays = (o: { first?: boolean; custom?: boolean } = {}) =>
  info({
    start: '2026-10-20T17:00',
    end: '2026-10-20T18:00',
    series: {
      recurring: true,
      start: '2026-10-06T17:00',
      repeat: weekly(o.custom ? ['TU', 'TH'] : ['TU']),
      fixedDays: true,
      rule: { choice: o.custom ? 'custom' : 'weekly' },
      ...(o.custom ? {} : { spec: weeklySpec(['TU']) }),
      first: o.first ?? false,
    },
  });

const dto = (o: Partial<ItemDTO>): ItemDTO => ({
  key: 'famcal|x', source: 'famcal', readOnly: false, id: 'x', seriesId: null, originalStart: null, kind: 'event', title: 'x',
  start: '2026-10-20T07:00:00.000Z', end: '2026-10-20T08:00:00.000Z', allDay: false, tz: IL, recurring: false, repeatsDaily: false,
  repeatsEveryDay: false, canEdit: true, span: null, calendar: { id: 'native:cal', name: 'Family', color: null, mine: true, inLegend: true },
  location: null, description: null, ...o,
});

const saved = (plan: MovePlan) => {
  assert(plan.kind === 'save', `expected a save, got ${JSON.stringify(plan)}`);
  return plan;
};
const asked = (plan: MovePlan) => {
  assert(plan.kind === 'ask', `expected a question, got ${JSON.stringify(plan)}`);
  return plan;
};
/** The PATCH body of a plan with a scope, for an item addressed by `key`. */
const body = (plan: MovePlan, i: ItemEditInfoResponse, scope: EditScope = 'single', key = 'famcal|x') => {
  assert(plan.kind === 'save' || plan.kind === 'ask', `no body for ${plan.kind}`);
  return moveBody(plan, key, scope, i);
};

// ---- Which items lift ----

check('lift: an item the viewer can change lifts; not one they can\'t, not one that repeats every day, and "can\'t change" wins', () => {
  assert(liftVerdict({ canEdit: true, repeatsEveryDay: false }) === null, 'a plain item');
  assert(liftVerdict({ canEdit: false, repeatsEveryDay: false }) === 'cantMove', 'a read-only one');
  assert(liftVerdict({ canEdit: true, repeatsEveryDay: true }) === 'cantMoveDaily', 'a daily one');
  assert(liftVerdict({ canEdit: false, repeatsEveryDay: true }) === 'cantMove', 'a read-only daily one says it can\'t be changed');
});

check('lift: the drop\'s item info is the final word: not editable, or a daily series Google didn\'t show at lift time', () => {
  same(planMove(info({ start: '2026-10-20T09:00', end: '2026-10-20T10:00', canEdit: false }), 2), { kind: 'cant', reason: 'cantMove' }, 'not editable');
  const daily = (interval: number) => info({ start: '2026-10-20T09:00', end: '2026-10-20T10:00', series: { recurring: true, repeat: { freq: 'daily', interval, byDay: [], ends: false } } });
  same(planMove(daily(1), 2), { kind: 'cant', reason: 'cantMoveDaily' }, 'every day');
  assert(planMove(daily(2), 2).kind !== 'cant', 'every other day is movable');
  assert(repeatsEveryDayInfo(daily(1)) && !repeatsEveryDayInfo(daily(3)) && !repeatsEveryDayInfo(one), 'repeatsEveryDayInfo');
  const weeklyEnds = info({ start: '2026-10-20T09:00', end: '2026-10-20T10:00', series: { recurring: true, repeat: weekly() } });
  assert(!repeatsEveryDayInfo(weeklyEnds), 'weekly');
});

// ---- The day delta and the grid's ids ----

check('delta: the drop day less the grabbed day, 0 on its own day, across months and years, null for no real day', () => {
  assert(dayDelta('2026-10-20', '2026-10-20') === 0, 'own day');
  assert(dayDelta('2026-10-20', '2026-10-23') === 3, 'forward');
  assert(dayDelta('2026-10-20', '2026-10-17') === -3, 'back');
  assert(dayDelta('2026-10-30', '2026-11-02') === 3, 'over a month');
  assert(dayDelta('2026-12-30', '2027-01-02') === 3, 'over a year');
  assert(dayDelta('2026-10-20', 'nope') === null && dayDelta('2026-13-01', '2026-10-01') === null, 'no real day');
});

check('drop ids: a day cell registers as day:<yyyy-MM-dd>; anything else (a chevron, nothing) names no day', () => {
  assert(dropId('2026-10-20') === 'day:2026-10-20', dropId('2026-10-20'));
  assert(dayOfDrop('day:2026-10-20') === '2026-10-20', 'round trip');
  assert(dayOfDrop('nav:next') === null && dayOfDrop(undefined) === null && dayOfDrop(7) === null, 'other targets');
});

// ---- The target start and end ----

check('target: a timed item keeps its time and length on the drop day', () => {
  const plan = saved(planMove(one, 3));
  same(body(plan, one), { key: 'famcal|x', scope: 'single', changes: { start: '2026-10-23T09:00', end: '2026-10-23T10:00' } }, 'body');
  const long = info({ start: '2026-10-20T09:15', end: '2026-10-20T12:45' });
  same(body(saved(planMove(long, -5)), long)?.changes, { start: '2026-10-15T09:15', end: '2026-10-15T12:45' }, '3 h 30 min back');
});

check('target: an all-day item keeps its days; a one-day all-day item\'s end is its last day', () => {
  const day = info({ start: '2026-10-20', end: '2026-10-20', allDay: true });
  same(body(saved(planMove(day, 4)), day)?.changes, { start: '2026-10-24', end: '2026-10-24' }, 'one day');
  const trip = info({ start: '2026-10-20', end: '2026-10-22', allDay: true });
  same(body(saved(planMove(trip, 4)), trip)?.changes, { start: '2026-10-24', end: '2026-10-26' }, 'three days');
});

check('target: a multi-day item grabbed on its 2nd day shifts by the days between the grabbed and the drop days', () => {
  const trip = info({ start: '2026-10-20', end: '2026-10-22', allDay: true });
  // Grabbed on the 21st (its 2nd day), dropped on the 25th: 4 days, so it starts the 24th, not the 25th.
  const delta = dayDelta('2026-10-21', '2026-10-25');
  assert(delta === 4, `delta ${delta}`);
  same(body(saved(planMove(trip, delta ?? 0)), trip)?.changes, { start: '2026-10-24', end: '2026-10-26' }, 'all-day');
  // A timed trip over midnight, grabbed on its last day (the 22nd), dropped on the 19th: 3 days back.
  const night = info({ start: '2026-10-20T20:00', end: '2026-10-22T08:00' });
  const back = dayDelta('2026-10-22', '2026-10-19');
  same(body(saved(planMove(night, back ?? 0)), night)?.changes, { start: '2026-10-17T20:00', end: '2026-10-19T08:00' }, 'timed');
});

check('target: an item that ends past midnight keeps its length across the new midnight', () => {
  const late = info({ start: '2026-10-20T22:30', end: '2026-10-21T01:15' });
  same(body(saved(planMove(late, 1)), late)?.changes, { start: '2026-10-21T22:30', end: '2026-10-22T01:15' }, 'late');
  const monthEnd = info({ start: '2026-10-31T23:00', end: '2026-11-01T02:00' });
  same(body(saved(planMove(monthEnd, 1)), monthEnd)?.changes, { start: '2026-11-01T23:00', end: '2026-11-02T02:00' }, 'over the month');
});

check('target: a reminder moves its one time; it has no end in the body', () => {
  const reminder = info({ kind: 'reminder', start: '2026-10-20T08:00', end: '2026-10-20T08:00' });
  same(body(saved(planMove(reminder, 2)), reminder)?.changes, { start: '2026-10-22T08:00' }, 'reminder');
  const dateOnly = info({ kind: 'reminder', start: '2026-10-20', end: '2026-10-20', allDay: true });
  same(body(saved(planMove(dateOnly, 2)), dateOnly)?.changes, { start: '2026-10-22' }, 'date only');
});

check('target: a drop on its own day plans nothing', () => {
  same(planMove(one, 0), { kind: 'nothing' }, 'own day');
});

check('target (DST, Asia/Jerusalem): the time of day stays across the day the clocks change, either way', () => {
  // Israel falls back on 2026-10-25 (02:00 -> 01:00) and springs forward on 2027-03-26 (02:00 -> 03:00).
  const night = info({ start: '2026-10-23T01:30', end: '2026-10-23T02:30' });
  same(body(saved(planMove(night, 2)), night)?.changes, { start: '2026-10-25T01:30', end: '2026-10-25T02:30' }, 'onto the fall-back day, wall times kept');
  same(body(saved(planMove(night, 3)), night)?.changes, { start: '2026-10-26T01:30', end: '2026-10-26T02:30' }, 'past it');
  const evening = info({ start: '2027-03-24T20:00', end: '2027-03-24T21:30' });
  same(body(saved(planMove(evening, 3)), evening)?.changes, { start: '2027-03-27T20:00', end: '2027-03-27T21:30' }, 'past the spring-forward day');
});

check('target (another zone): a series in New York keeps its time of day in New York while Israel and New York change clocks on different days', () => {
  // 09:00 in New York on Fri 2026-10-23 is 16:00 in Israel (EDT -4, IDT +3). Israel falls back on 10-25, New York on 11-01.
  // Mon 10-26 at 09:00 in New York (EDT) is 15:00 in Israel (IST +2): the wall time on the user's clock moves, the series' does not.
  const ny = info({ start: '2026-10-23T16:00', end: '2026-10-23T17:00', tz: IL, zone: NY, series: { recurring: true, start: '2026-10-02T16:00', repeat: weekly(), rule: { choice: 'weekly' }, spec: weeklySpec(['FR']), first: false } });
  same(body(asked(planMove(ny, 3)), ny)?.changes, { start: '2026-10-26T15:00', end: '2026-10-26T16:00' }, 'Fri to Mon');
  // Once both have fallen back (after 11-01) the two clocks agree again: 09:00 NY is 16:00 in Israel (EST -5, IST +2 = 7 h).
  const later = info({ start: '2026-10-23T16:00', end: '2026-10-23T17:00', tz: IL, zone: NY, series: { recurring: true, start: '2026-10-02T16:00', repeat: weekly(), rule: { choice: 'weekly' }, spec: weeklySpec(['FR']), first: false } });
  same(body(asked(planMove(later, 14)), later)?.changes, { start: '2026-11-06T16:00', end: '2026-11-06T17:00' }, 'two weeks on');
  // The same item, if its zone were the user's: the user\'s wall time simply stays.
  const plain = info({ start: '2026-10-23T16:00', end: '2026-10-23T17:00', series: { recurring: true, start: '2026-10-02T16:00', repeat: weekly(), rule: { choice: 'weekly' }, spec: weeklySpec(['FR']), first: false } });
  same(body(asked(planMove(plain, 3)), plain)?.changes, { start: '2026-10-26T16:00', end: '2026-10-26T17:00' }, 'own zone');
});

check('target: shiftedForm moves a form\'s start only; its title, repeat and the rest are the item\'s', () => {
  const form = shiftedForm(swim, 2);
  assert(form.title === 'Swim' && form.startDay === '2026-10-22' && form.endDay === '2026-10-22' && form.startTime === '17:00' && form.endTime === '18:00', JSON.stringify(form));
});

// ---- The scope the editor asks ----

check('scope: a one-off item saves with no question, as this one', () => {
  const plan = saved(planMove(one, 2));
  assert(plan.scope === 'single', plan.scope);
});

check('scope: a repeating item asks this one / this one and the ones after / all of them, with no note', () => {
  const plan = asked(planMove(swim, 2));
  same([plan.choices, plan.note], [['single', 'following', 'all'], undefined], 'choices');
  for (const scope of plan.choices) same(body(plan, swim, scope, 'famcal|swim')?.scope, scope, `the body carries ${scope}`);
  same(body(plan, swim, 'all', 'famcal|swim'), { key: 'famcal|swim', scope: 'all', changes: { start: '2026-10-22T17:00', end: '2026-10-22T18:00' } }, 'all of them');
});

check('scope: a set-weekdays series ("every Tuesday") offers "Only this one" (and the ones after with the rule sent again, with a note unless it is the first occurrence)', () => {
  const later = asked(planMove(tuesdays(), 1));
  same([later.choices, later.note], [['single', 'following'], 'dayMove'], 'a later occurrence');
  const first = asked(planMove(tuesdays({ first: true }), 1));
  same([first.choices, first.note], [['single', 'following'], undefined], 'the first occurrence');
  const custom = asked(planMove(tuesdays({ custom: true }), 1));
  same([custom.choices, custom.note], [['single'], 'dayMove'], 'a rule the Repeat sheet can\'t say');
  // Only this one is a plain body; the ones after restate the weekly rule on the new day.
  same(body(later, tuesdays(), 'single', 'famcal|t')?.changes, { start: '2026-10-21T17:00', end: '2026-10-21T18:00' }, 'single');
  const following = body(later, tuesdays(), 'following', 'famcal|t');
  same([following?.scope, following?.changes.start, (following?.changes.repeat as RepeatSpec | undefined)?.freq], ['following', '2026-10-21T17:00', 'weekly'], 'following restates the repeat');
});

check('scope: a Hebrew-date series asks this one / the ones after / all, and "all" carries only the start and end (the store moves the anchor)', () => {
  const hebrew = info({
    start: '2026-10-20T09:00',
    end: '2026-10-20T10:00',
    series: { recurring: true, start: '2024-10-02T09:00', repeat: { freq: 'yearly', interval: 1, byDay: [], ends: false, hebrew: { anchor: '2024-10-02' } }, rule: { choice: 'hebrew', anchor: '2024-10-02' }, spec: { freq: 'hebrew', interval: 1 }, first: false },
  });
  const plan = asked(planMove(hebrew, 1));
  same(plan.choices, ['single', 'following', 'all'], 'choices');
  same(body(plan, hebrew, 'all', 'famcal|h')?.changes, { start: '2026-10-21T09:00', end: '2026-10-21T10:00' }, 'all');
});

check('scope: a repeating reminder asks too', () => {
  const reminder = info({ kind: 'reminder', start: '2026-10-20T08:00', end: '2026-10-20T08:00', series: { recurring: true, repeat: weekly(), rule: { choice: 'weekly' }, spec: weeklySpec(['TU']), first: false } });
  const plan = asked(planMove(reminder, 1));
  same(plan.choices, ['single', 'following', 'all'], 'choices');
});

check('scope: a series with one scope left (a cut-off last one) saves with no question', () => {
  const last = info({ start: '2026-10-20T17:00', end: '2026-10-20T18:00', scopes: ['single'], series: { recurring: true, repeat: weekly(), rule: { choice: 'weekly' }, spec: weeklySpec(['TU']), first: false } });
  assert(saved(planMove(last, 1)).scope === 'single', 'scope');
});

// ---- Undo ----

check('undo: the same scope on the key the PATCH answered, the start shifted back; none after "this one and the ones after"', () => {
  // The item after a "single" move to Thursday: its info now reads the new day. Undo goes back 2 days.
  const moved = info({ start: '2026-10-22T09:00', end: '2026-10-22T10:00' });
  same(undoBody(moved, 'famcal|x', 'single', 2), { key: 'famcal|x', scope: 'single', changes: { start: '2026-10-20T09:00', end: '2026-10-20T10:00' } }, 'one-off');
  // An "all" move can change the key (the slot moves): the body is built on the answered key.
  const series = info({ start: '2026-10-22T17:00', end: '2026-10-22T18:00', series: { recurring: true, start: '2026-10-08T17:00', repeat: weekly(), rule: { choice: 'weekly' }, spec: weeklySpec(['TH']), first: false } });
  same(undoBody(series, 'famcal|swim#2026-10-22', 'all', 2), { key: 'famcal|swim#2026-10-22', scope: 'all', changes: { start: '2026-10-20T17:00', end: '2026-10-20T18:00' } }, 'series, all');
  const allDay = info({ start: '2026-10-24', end: '2026-10-25', allDay: true });
  same(undoBody(allDay, 'famcal|t', 'single', 4)?.changes, { start: '2026-10-20', end: '2026-10-21' }, 'all-day');
  same(undoBody(moved, 'famcal|x', 'single', -3)?.changes, { start: '2026-10-25T09:00', end: '2026-10-25T10:00' }, 'a move back is undone forward');
  assert(undoable('single') && undoable('all') && !undoable('following'), 'undoable');
});

check('undo: a series in another zone is shifted back in its zone too, so the time it had returns', () => {
  const fwd = info({ start: '2026-10-23T16:00', end: '2026-10-23T17:00', zone: NY, series: { recurring: true, start: '2026-10-02T16:00', repeat: weekly(), rule: { choice: 'weekly' }, spec: weeklySpec(['FR']), first: false } });
  const moved = asked(planMove(fwd, 3));
  const after = body(moved, fwd, 'single')?.changes;
  same(after, { start: '2026-10-26T15:00', end: '2026-10-26T16:00' }, 'forward');
  const now = info({ start: '2026-10-26T15:00', end: '2026-10-26T16:00', zone: NY, series: { recurring: true, start: '2026-10-02T16:00', repeat: weekly(), rule: { choice: 'weekly' }, spec: weeklySpec(['FR']), first: false } });
  same(undoBody(now, 'famcal|x', 'single', 3)?.changes, { start: '2026-10-23T16:00', end: '2026-10-23T17:00' }, 'back');
});

// ---- The optimistic item ----

check('store item: a timed item moves at the same time of day in its zone and as long; an all-day one by its days', () => {
  const timed = shiftItemDto(dto({ start: '2026-10-20T07:00:00.000Z', end: '2026-10-20T08:30:00.000Z', tz: IL }), 3, IL);
  same([timed.start, timed.end], ['2026-10-23T07:00:00.000Z', '2026-10-23T08:30:00.000Z'], 'timed');
  const dst = shiftItemDto(dto({ start: '2026-10-23T22:30:00.000Z', end: '2026-10-23T23:30:00.000Z', tz: IL }), 3, IL);
  // 01:30 Israel on 10-24 (IDT, +3) is 22:30Z; on 10-27 (IST, +2) 01:30 is 23:30Z the day before.
  same([dst.start, dst.end], ['2026-10-26T23:30:00.000Z', '2026-10-27T00:30:00.000Z'], 'over the fall-back');
  const google = shiftItemDto(dto({ source: 'google', tz: null, start: '2026-10-20T19:30:00+03:00', end: '2026-10-20T22:00:00+03:00' }), 1, IL);
  same([google.start, google.end], ['2026-10-21T16:30:00.000Z', '2026-10-21T19:00:00.000Z'], 'a Google item, in the user\'s zone');
  const day = shiftItemDto(dto({ allDay: true, start: '2026-10-20', end: '2026-10-23', tz: null }), -2, IL);
  same([day.start, day.end, day.key], ['2026-10-18', '2026-10-21', 'famcal|x'], 'all-day');
  assert(shiftItemDto(dto({ start: 'nonsense' }), 1, IL).start === 'nonsense', 'unreadable stays');
});

check('spanOnDay agrees with the server\'s daySpanOf on all-day, timed, overnight (the 06:00 tail), zero-length and DST-day items in three zones', () => {
  const zones = [IL, NY, 'America/Santiago'];
  const days: string[] = [];
  for (let d = new Date('2026-03-27T00:00:00Z'); d.toISOString() < '2026-04-10T00:00:00Z'; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  for (let d = new Date('2026-10-22T00:00:00Z'); d.toISOString() < '2026-11-04T00:00:00Z'; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  for (let d = new Date('2026-09-04T00:00:00Z'); d.toISOString() < '2026-09-10T00:00:00Z'; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  let compared = 0;
  for (const tz of zones) {
    const at = (local: string) => fromZonedTime(local, tz).toISOString();
    const items: Pick<ItemDTO, 'start' | 'end' | 'allDay'>[] = [
      { allDay: true, start: '2026-04-02', end: '2026-04-03' },
      { allDay: true, start: '2026-04-02', end: '2026-04-05' },
      { allDay: true, start: '2026-10-30', end: '2026-10-30' },
      { allDay: false, start: at('2026-03-28 09:00'), end: at('2026-03-28 10:00') },
      { allDay: false, start: at('2026-10-24 22:00'), end: at('2026-10-25 02:00') },
      { allDay: false, start: at('2026-10-24 22:00'), end: at('2026-10-25 06:00') },
      { allDay: false, start: at('2026-10-24 22:00'), end: at('2026-10-25 06:30') },
      { allDay: false, start: at('2026-10-31 20:00'), end: at('2026-11-02 08:00') },
      { allDay: false, start: at('2026-04-01 00:00'), end: at('2026-04-01 00:00') },
      { allDay: false, start: at('2026-04-02 23:59'), end: at('2026-04-02 23:59') },
      { allDay: false, start: at('2026-03-29 01:30'), end: at('2026-03-29 04:30') },
      { allDay: false, start: at('2026-09-06 23:30'), end: at('2026-09-07 01:30') },
      { allDay: false, start: at('2026-04-02 00:00'), end: at('2026-04-03 00:00') },
    ];
    for (const item of items) {
      for (const day of days) {
        const want = daySpanOf({ summary: 'x', start: item.start, end: item.end, calendarName: '', calendarId: '' }, day, tz);
        const got = spanOnDay(item, day, tz);
        const a = want === null ? 'off' : want === undefined ? 'inside' : want;
        const b = got === null ? 'off' : got.span === null ? 'inside' : got.span;
        if (a !== b) throw new Error(`${tz} ${item.start}..${item.end} on ${day}: daySpanOf ${a}, spanOnDay ${b}`);
        compared++;
      }
    }
  }
  assert(compared > 1000, `${compared} comparisons`);
});

// ---- The store while the save runs ----

/** A store with every day of [from, to) answered, each item listed on the days its span puts it on. */
function storeWith(items: { item: ItemDTO; days: [string, ItemDTO['span']][] }[], from = '2026-10-18', to = '2026-11-08') {
  const days: { date: string; items: ItemDTO[] }[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) < to; d.setUTCDate(d.getUTCDate() + 1)) days.push({ date: d.toISOString().slice(0, 10), items: [] });
  for (const { item, days: on } of items) for (const [date, span] of on) days.find((x) => x.date === date)?.items.push({ ...item, span });
  const response = {
    tz: IL, today: '2026-10-20', weekStart: 'sunday', hebrewDates: false, from, to,
    sources: { famcal: { status: 'ok' } }, calendars: [], partner: null, carryOvers: null, days,
  } as unknown as RangeResponse;
  return reduceStore(emptyStore(), { type: 'response', response, epoch: 0 });
}
const onDays = (store: ReturnType<typeof storeWith>, key: string) =>
  Array.from({ length: 21 }, (_, i) => new Date(Date.UTC(2026, 9, 18 + i)).toISOString().slice(0, 10)).flatMap((d) => {
    const found = dayItems(store, d).find((i) => i.key === key);
    return found ? [`${d}:${found.span ?? '-'}`] : [];
  });

check('store item: shiftItem takes the item off its days and lists it on the days it now belongs to, with that day\'s span; coverage and the other items stay', () => {
  const swim = dto({ key: 'famcal|swim', start: '2026-10-20T07:00:00.000Z', end: '2026-10-20T08:00:00.000Z' });
  const other = dto({ key: 'famcal|other', start: '2026-10-22T07:00:00.000Z', end: '2026-10-22T08:00:00.000Z' });
  // A trip from the 20th 22:00 to the 22nd 10:00 Israel time: the 20th (ends later), the 21st (spans), the 22nd (continues).
  const trip = dto({ key: 'famcal|trip', start: '2026-10-20T19:00:00.000Z', end: '2026-10-22T07:00:00.000Z' });
  const s0 = storeWith([
    { item: swim, days: [['2026-10-20', null]] },
    { item: other, days: [['2026-10-22', null]] },
    { item: trip, days: [['2026-10-20', 'endsLater'], ['2026-10-21', 'spansDay'], ['2026-10-22', 'continues']] },
  ]);
  const s1 = reduceStore(s0, { type: 'shiftItem', key: 'famcal|swim', days: 3 });
  same(onDays(s1, 'famcal|swim'), ['2026-10-23:-'], 'swim moved');
  same(dayItems(s1, '2026-10-22').map((i) => i.key), ['famcal|trip', 'famcal|other'], 'the others stay, in compareItems order');
  assert(dayStatus(s1, '2026-10-20') === 'answered' && dayStatus(s1, '2026-10-23') === 'answered', 'coverage kept');
  const s2 = reduceStore(s0, { type: 'shiftItem', key: 'famcal|trip', days: 2 });
  same(onDays(s2, 'famcal|trip'), ['2026-10-22:endsLater', '2026-10-23:spansDay', '2026-10-24:continues'], 'the trip, three days later');
  same(onDays(reduceStore(s2, { type: 'shiftItem', key: 'famcal|trip', days: -2 }), 'famcal|trip'), onDays(s0, 'famcal|trip'), 'shifted back it is where it was');
  same(onDays(reduceStore(s1, { type: 'shiftItem', key: 'famcal|swim', days: -3 }), 'famcal|swim'), ['2026-10-20:-'], 'swim back');
});

check('store item: shiftItem moves an all-day item by its days, an item to a day the store does not hold is only taken off its own, and an unknown key or no move change nothing', () => {
  const trip = dto({ key: 'famcal|trip', allDay: true, tz: null, start: '2026-10-20', end: '2026-10-23' });
  const s0 = storeWith([{ item: trip, days: [['2026-10-20', 'endsLater'], ['2026-10-21', 'spansDay'], ['2026-10-22', 'continues']] }]);
  same(onDays(reduceStore(s0, { type: 'shiftItem', key: 'famcal|trip', days: 4 }), 'famcal|trip'), ['2026-10-24:endsLater', '2026-10-25:spansDay', '2026-10-26:continues'], 'all-day');
  const near = storeWith([{ item: dto({ key: 'famcal|swim' }), days: [['2026-10-20', null]] }], '2026-10-18', '2026-10-25');
  same(onDays(reduceStore(near, { type: 'shiftItem', key: 'famcal|swim', days: 10 }), 'famcal|swim'), [], 'its target is outside the days the store holds');
  assert(reduceStore(s0, { type: 'shiftItem', key: 'famcal|nope', days: 2 }) === s0, 'an unknown key');
  assert(reduceStore(s0, { type: 'shiftItem', key: 'famcal|trip', days: 0 }) === s0, 'no move');
  assert(reduceStore(emptyStore(), { type: 'shiftItem', key: 'famcal|trip', days: 2 }).facts === null, 'an empty store');
});

check('store item: restoreItem puts the item back exactly as it was, wherever a refetch that landed in between left it (the relative shift back would go to the 17th)', () => {
  const whereIs = (st: ReturnType<typeof storeWith>, key: string) => Object.keys(st.days).sort().filter((d) => dayItems(st, d).some((i) => i.key === key)).map((d) => `${d}:-`);
  const swim = dto({ key: 'famcal|swim', start: '2026-10-20T07:00:00.000Z', end: '2026-10-20T08:00:00.000Z' });
  const loaded = () => storeWith([{ item: swim, days: [['2026-10-20', null]] }], '2026-10-11');
  const s0 = loaded();
  const copies = itemCopies(s0, 'famcal|swim');
  same(Object.keys(copies), ['2026-10-20'], 'the copies taken before the lift');
  // Dropped +3, then the refetch lands (the server still has it on the 20th), then the sheet is closed.
  let s = reduceStore(s0, { type: 'shiftItem', key: 'famcal|swim', days: 3 });
  same(whereIs(s, 'famcal|swim'), ['2026-10-23:-'], 'dropped');
  s = reduceStore(s, { type: 'response', response: { ...(storeResponse()), days: storeResponse().days }, epoch: 0 });
  same(whereIs(s, 'famcal|swim'), ['2026-10-20:-'], 'the refetch landed');
  same(whereIs(reduceStore(s, { type: 'shiftItem', key: 'famcal|swim', days: -3 }), 'famcal|swim'), ['2026-10-17:-'], 'the shift back (what was wrong)');
  same(whereIs(reduceStore(s, { type: 'restoreItem', key: 'famcal|swim', copies }), 'famcal|swim'), ['2026-10-20:-'], 'restored after the refetch');
  const dropped = reduceStore(s0, { type: 'shiftItem', key: 'famcal|swim', days: 3 });
  same(whereIs(reduceStore(dropped, { type: 'restoreItem', key: 'famcal|swim', copies }), 'famcal|swim'), ['2026-10-20:-'], 'restored with no refetch');
  assert(dayStatus(reduceStore(dropped, { type: 'restoreItem', key: 'famcal|swim', copies }), '2026-10-23') === 'answered', 'coverage kept');
  function storeResponse() {
    const days: { date: string; items: ItemDTO[] }[] = [];
    for (let d = new Date('2026-10-11T00:00:00Z'); d.toISOString().slice(0, 10) < '2026-11-08'; d.setUTCDate(d.getUTCDate() + 1)) {
      const date = d.toISOString().slice(0, 10);
      days.push({ date, items: date === '2026-10-20' ? [swim] : [] });
    }
    return { tz: IL, today: '2026-10-20', weekStart: 'sunday', hebrewDates: false, from: '2026-10-11', to: '2026-11-08', sources: { famcal: { status: 'ok' } }, calendars: [], partner: null, carryOvers: null, days } as unknown as RangeResponse;
  }
});

check('blocked: planMove runs the editor\'s checks on the moved form: a repeat that would end before it starts, a year a series can\'t start in', () => {
  const ends = info({ start: '2026-10-20T17:00', end: '2026-10-20T18:00', series: { recurring: true, start: '2026-10-06T17:00', repeat: { ...weekly(), ends: true }, rule: { choice: 'weekly', until: '2026-10-27' }, spec: { freq: 'weekly', interval: 1, byDay: ['TU'], until: '2026-10-27' }, first: false } });
  same(planMove(ends, 14), { kind: 'invalid', error: 'errRepeatEnd' }, 'past its end');
  assert(planMove(ends, 7).kind === 'ask', 'on its last day is fine');
  const early = info({ start: '2000-01-02', end: '2000-01-02', allDay: true, series: { recurring: true, start: '2000-01-02', repeat: weekly(), rule: { choice: 'weekly' }, spec: weeklySpec(['SU']), first: true } });
  same(planMove(early, -5), { kind: 'invalid', error: 'errYear' }, 'before 2000 for a series');
  assert(planMove(info({ start: '2000-01-02', end: '2000-01-02', allDay: true }), -5).kind === 'save', 'a one-off may');
  const untitled = info({ start: '2026-10-20T09:00', end: '2026-10-20T10:00' });
  untitled.occurrence.title = '';
  assert(planMove(untitled, 2).kind === 'save', 'a move does not need a title');
});

check('ghost: it follows the finger (centred on it, above it, inside the screen), whatever side of the row was pressed, in LTR and RTL', () => {
  const ghost = { width: 100, height: 40 };
  // A full-width row at the screen's left edge; the finger on its inline-end side (RTL: the right) or start side (LTR: the left).
  const origin = { left: 0, top: 300 };
  const at = (fingerX: number, move: { x: number; y: number }) => ghostTranslation(move, { x: fingerX, y: 320 }, origin, ghost, { width: 390, height: 800 });
  // Right-hand press (Hebrew title): the ghost's centre is on the finger, 14 px above.
  const rtl = at(350, { x: -100, y: 200 });
  same([origin.left + rtl.x + ghost.width / 2, origin.top + rtl.y + ghost.height + 14], [250, 520], 'RTL press, moved left and down');
  const ltr = at(40, { x: 120, y: -150 });
  same([origin.left + ltr.x + ghost.width / 2, origin.top + ltr.y + ghost.height + 14], [160, 170], 'LTR press, moved right and up');
  // Near the screen edges it stays on the screen.
  const edge = at(20, { x: -20, y: -330 });
  same([origin.left + edge.x, origin.top + edge.y], [4, 4], 'clamped at the corner');
  const right = at(380, { x: 0, y: 0 });
  same(origin.left + right.x + ghost.width, 386, 'clamped at the right edge');
  same(ghostTranslation({ x: 5, y: 6 }, null, origin, ghost), { x: 5, y: 6 }, 'no press known: the library\'s own');
});

check('hit test: the ghost\'s wrapper never hides the cell under the finger; a bar over a cell does; no stack means the rect test', () => {
  const el = (name: string, parent: HitElement | null = null, overlay = false): HitElement & { name: string; kids: HitElement[] } => {
    const self: HitElement & { name: string; kids: HitElement[] } = {
      name,
      kids: [],
      contains: (other) => other === self || self.kids.some((k) => k.contains(other)),
      closest: (selector) => (overlay && selector === `.${OVERLAY_CLASS}` ? self : parent ? parent.closest?.(selector) ?? null : null),
    };
    if (parent) (parent as unknown as { kids: HitElement[] }).kids.push(self);
    return self;
  };
  const cell1 = el('cell1');
  const cell2 = el('cell2');
  const chip = el('chip', cell1);
  const wrapper = el('wrapper', null, true);
  const ghost = el('ghost', wrapper);
  const bar = el('bar');
  const nodes: Record<string, HitElement> = { a: cell1, b: cell2 };
  const nodeOf = (id: string | number) => nodes[String(id)];
  const ids = (hits: { id: string }[]) => hits.map((h) => h.id).join();
  // The finger is over cell2 and the ghost is on top of it: cell2 is still the hit.
  assert(ids(visibleHits([{ id: 'b' }], nodeOf, [ghost, wrapper, cell2])) === 'b', 'the overlay is skipped');
  assert(ids(visibleHits([{ id: 'a' }], nodeOf, [wrapper, chip, cell1])) === 'a', 'a chip inside the cell is the cell');
  assert(ids(visibleHits([{ id: 'b' }], nodeOf, [bar, cell2])) === '', 'a sticky bar over a cell hides it');
  assert(ids(visibleHits([{ id: 'a' }, { id: 'b' }], nodeOf, [cell2])) === 'b', 'only the cell that holds the element under the point');
  assert(ids(visibleHits([{ id: 'b' }], nodeOf, null)) === 'b' && ids(visibleHits([{ id: 'b' }], nodeOf, [])) === 'b', 'no stack: the rects stand');
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'OK ' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
if (failed.length > 0) process.exit(1);

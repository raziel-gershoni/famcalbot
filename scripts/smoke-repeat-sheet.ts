// Smoke test for the Repeat sheet's model and words (editor upgrades spec §3, Task B): the
// form's repeat as a spec ('none' / 'custom' beside it), the sheet's operations (frequency,
// every N, weekday chips pinned to the start, the monthly options by start, the end), the
// request bodies, the restated spec on a fixed-day move, and the one wording function in
// en, he and ru (ICU plurals; a Russian ordinal agreeing with the weekday's gender; Hebrew
// ordinals). The sheet itself (the row, Back, the date sheet, the body it sends) is in
// smoke-calendar-home-render.
//
// Pure: no DOM, no network. next-intl's translator runs on the real messages.
//
// Run under both clocks; nothing may depend on the process timezone:
//   TZ=UTC npx tsx scripts/smoke-repeat-sheet.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-repeat-sheet.ts

import { createRequire } from 'module';
import {
  checkForm,
  repeatDayOf,
  createBody,
  editItemForm,
  isDirty,
  moveStart,
  restatedRepeat,
  scopePlan,
  setKind,
  updateBody,
  type EditorForm,
} from '../src/lib/calendar-view/editor-model';
import type { ItemEditInfoResponse, RepeatInfo, RepeatSpec } from '../src/lib/calendar-view/editor-types';
import {
  endKindOf,
  formRepeat,
  monthlyOptions,
  normalizeSpec,
  pickFrequency,
  repeatInput,
  sameRepeat,
  shownSpec,
  toGregorian,
  toggleDay,
  weekOrder,
  withCount,
  withEnd,
  withInterval,
  withMonthly,
  withUntil,
  type RepeatForm,
} from '../src/lib/calendar-view/repeat-model';
import { minYearFor } from '../src/lib/calendar-view/year-limits';
import { allOfThem, repeatWords } from '../src/lib/calendar-view/editor-model';
import { endOfInfo, infoText, specText, withEndText, type WordsContext } from '../app/[locale]/dashboard/repeat-words';
import en from '../messages/en.json';
import he from '../messages/he.json';
import ru from '../messages/ru.json';

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

const nodeRequire = createRequire(__filename);
const MESSAGES = { en, he, ru } as const;
type Locale = keyof typeof MESSAGES;
const LOCALES: Locale[] = ['en', 'he', 'ru'];
const errors: string[] = [];
const translator = (locale: Locale) => {
  const { createTranslator } = nodeRequire('next-intl');
  return createTranslator({ locale, messages: MESSAGES[locale], namespace: 'calendarHome', onError: (e: Error) => errors.push(e.message) });
};

const spec = (s: Partial<RepeatSpec> & Pick<RepeatSpec, 'freq'>): RepeatSpec => ({ interval: 1, ...s });

/** An edit info for a series opened on `day` (a Tuesday, 20 Oct 2026, unless said). */
function info(o: { tz?: string; zone?: string; time?: string; spec?: RepeatSpec; choice?: ItemEditInfoResponse['series']['rule']; fixedDays?: boolean; first?: boolean; day?: string; recurring?: boolean }): ItemEditInfoResponse {
  const day = o.day ?? '2026-10-20';
  return {
    kind: 'event',
    canEdit: true,
    canDelete: true,
    occurrence: { start: `${day}T${o.time ?? '17:00'}`, end: `${day}T18:00`, allDay: false, title: 'Swimming', location: '', description: '' },
    series: {
      recurring: o.recurring ?? true,
      start: `${day}T${o.time ?? '17:00'}`,
      repeat: { freq: 'weekly', interval: 1, byDay: [], ends: false },
      fixedDays: o.fixedDays ?? false,
      zone: o.zone ?? 'UTC',
      ...(o.choice ? { rule: o.choice } : {}),
      ...(o.spec ? { spec: o.spec } : {}),
      first: o.first ?? true,
    },
    tz: o.tz ?? 'UTC',
    calendar: { id: 'native:cal_me_7f3a', name: 'Family', color: null },
    forName: null,
    scopes: ['single', 'following', 'all'],
  };
}
const formOf = (i: ItemEditInfoResponse) => editItemForm(i);
/** The repeat an update would carry for a move on 'all' (a pick, not a restatement), or undefined. */
const pickedRepeatBody = (form: EditorForm, initial: EditorForm, i: ItemEditInfoResponse) => updateBody(form, initial, 'k', 'all', i)?.changes.repeat;
const withRepeat = (f: EditorForm, repeat: RepeatForm): EditorForm => ({ ...f, repeat });

async function main() {
  await check('R1 the form holds the repeat as a spec: a server spec opens with its whole weekly set, a choice-only info becomes a spec, a rule the sheet can\'t say stays custom, a one-off is none', () => {
    // 20 Oct 2026 is a Tuesday: the server lists TU among the days; the form keeps the others.
    const multi = formOf(info({ spec: spec({ freq: 'weekly', interval: 2, byDay: ['TU', 'SU'], until: '2027-03-01' }), fixedDays: true, choice: { choice: 'custom' } }));
    assertSame(multi.repeat, { freq: 'weekly', interval: 2, byDay: ['TU', 'SU'], until: '2027-03-01' }, 'the whole set, Monday first');
    assertSame(shownSpec(multi.repeat, multi.startDay), { freq: 'weekly', interval: 2, byDay: ['TU', 'SU'], until: '2027-03-01' }, 'the request lists the same');
    assertSame(formOf(info({ spec: spec({ freq: 'weekly', byDay: ['TU'] }), choice: { choice: 'weekly' } })).repeat, { freq: 'weekly', interval: 1 }, 'a single day is a plain weekly: it follows its start');
    assertSame(formOf(info({ choice: { choice: 'weekly' } })).repeat, { freq: 'weekly', interval: 1 }, 'a choice from an older server');
    assertSame(formOf(info({ choice: { choice: 'daily', until: '2026-10-27' } })).repeat, { freq: 'daily', interval: 1, until: '2026-10-27' }, 'its end');
    assertSame(formOf(info({ choice: { choice: 'hebrew', anchor: '2026-10-20' } })).repeat, { freq: 'hebrew', interval: 1 }, 'hebrew');
    assert(formOf(info({ choice: { choice: 'custom' } })).repeat === 'custom', 'a rule the sheet can\'t say');
    assert(formOf(info({ recurring: false, choice: { choice: 'none' } })).repeat === 'none', 'a one-off');
    // The request: a new item sends the spec as shown; custom and none send none.
    const base = formOf(info({ recurring: false, choice: { choice: 'none' } }));
    assertSame(createBody(withRepeat(base, spec({ freq: 'weekly', byDay: ['FR'] }))).repeat, { freq: 'weekly', interval: 1, byDay: ['TU', 'FR'] }, 'weekly lists the start\'s day among its days');
    assertSame(createBody(withRepeat(base, spec({ freq: 'monthly', monthly: 'weekday', count: 5 }))).repeat, { freq: 'monthly', interval: 1, monthly: 'weekday', count: 5 }, 'monthly weekday with its end');
    assert(createBody(withRepeat(base, 'custom')).repeat === 'none' && createBody(base).repeat === 'none', 'custom and none send none');
  });

  await check('R2 the weekday chips: the start\'s own day can\'t be toggled; the others toggle, the set is whole and Monday first; the order of the week follows the week start; a start move adds the new start\'s day to the set and moving back restores it, a plain weekly moves with its start', () => {
    const s = spec({ freq: 'weekly' });
    assertSame(toggleDay(s, 'TU', '2026-10-20'), s, 'the start\'s day stays as it is');
    const a = toggleDay(toggleDay(s, 'SU', '2026-10-20'), 'TH', '2026-10-20');
    assertSame(a.byDay, ['TU', 'TH', 'SU'], 'the whole set, Monday-first order');
    assertSame(toggleDay(a, 'SU', '2026-10-20').byDay, ['TU', 'TH'], 'toggled off');
    assert(toggleDay(toggleDay(s, 'SU', '2026-10-20'), 'SU', '2026-10-20').byDay === undefined, 'only the start\'s day: a plain weekly, no byDay');
    assertSame(normalizeSpec(spec({ freq: 'weekly', byDay: ['TU', 'WE', 'WE'] }), '2026-10-20').byDay, ['TU', 'WE'], 'merged and ordered, the start\'s day in');
    assertSame(normalizeSpec(spec({ freq: 'weekly', byDay: ['WE'] }), '2026-10-20').byDay, ['TU', 'WE'], 'the start\'s day is added');
    assertSame(weekOrder(0), ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'], 'Sunday first');
    assertSame(weekOrder(1), ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'], 'Monday first');
    assertSame(weekOrder(6), ['SA', 'SU', 'MO', 'TU', 'WE', 'TH', 'FR'], 'Saturday first');
    // A start move never edits the form: the shown set gains the new start's day and keeps the rest.
    const f = withRepeat(formOf(info({ recurring: false, choice: { choice: 'none' } })), spec({ freq: 'weekly', byDay: ['TU', 'TH'] }));
    const thu = moveStart(f, { startDay: '2026-10-22' });
    assertSame(shownSpec(thu.repeat, thu.startDay)?.byDay, ['TU', 'TH'], 'moved to Thursday: both days');
    const fri = moveStart(f, { startDay: '2026-10-23' });
    assertSame(shownSpec(fri.repeat, fri.startDay)?.byDay, ['TU', 'TH', 'FR'], 'moved to Friday: Friday joins');
    const back = moveStart(fri, { startDay: '2026-10-20' });
    assertSame(shownSpec(back.repeat, back.startDay)?.byDay, ['TU', 'TH'], 'and back: both days, nothing left behind');
    // A plain weekly (the set is just the start\'s day) follows its start.
    const plain = withRepeat(f, spec({ freq: 'weekly' }));
    assertSame(shownSpec(moveStart(plain, { startDay: '2026-10-22' }).repeat, '2026-10-22')?.byDay, ['TH'], 'a plain weekly moves with the start');
  });

  await check('R3 the monthly options by the start: the ordinal is ceil(day / 7), "last" only in the month\'s last seven days, and a "last" the start can\'t hold reads as the n-th weekday of the start', () => {
    assertSame(monthlyOptions('2026-10-14'), { ordinal: 2, last: false }, '14 Oct');
    assertSame(monthlyOptions('2026-10-07'), { ordinal: 1, last: false }, '7 Oct');
    assertSame(monthlyOptions('2026-10-08'), { ordinal: 2, last: false }, '8 Oct');
    assertSame(monthlyOptions('2026-10-24'), { ordinal: 4, last: false }, '24 Oct (31 days: the last seven start at the 25th)');
    assertSame(monthlyOptions('2026-10-25'), { ordinal: 4, last: true }, '25 Oct');
    assertSame(monthlyOptions('2026-10-31'), { ordinal: 5, last: true }, '31 Oct is the fifth and the last');
    assertSame(monthlyOptions('2027-02-22'), { ordinal: 4, last: true }, 'Feb 2027 has 28 days');
    assertSame(monthlyOptions('2027-02-21'), { ordinal: 3, last: false }, '21 Feb');
    assertSame(monthlyOptions('2028-02-23'), { ordinal: 4, last: true }, 'Feb 2028 has 29 days');
    assert(monthlyOptions('2026-02-31') === null && monthlyOptions('') === null, 'not a real day');
    const last = spec({ freq: 'monthly', monthly: 'last' });
    assert(normalizeSpec(last, '2026-10-27').monthly === 'last', 'kept in the last week');
    assert(normalizeSpec(last, '2026-10-20').monthly === 'weekday', 'out of it, the n-th weekday of the start');
    const f = withRepeat(formOf(info({ recurring: false, choice: { choice: 'none' }, day: '2026-10-27' })), last);
    const out = moveStart(f, { startDay: '2026-10-20' });
    assert((out.repeat as RepeatSpec).monthly === 'last' && shownSpec(out.repeat, out.startDay)?.monthly === 'weekday', 'a move leaves the form alone; what is sent and said is the n-th weekday');
    const within = moveStart(f, { startDay: '2026-10-29' });
    assert(shownSpec(within.repeat, within.startDay)?.monthly === 'last', 'a move within the last week keeps it');
    assert(shownSpec(moveStart(f, { startDay: '2026-10-2' }).repeat, '2026-10-2')?.monthly === 'last', 'a day being typed');
    assert(normalizeSpec(spec({ freq: 'weekly', monthly: 'weekday' }), '2026-10-20').monthly === undefined, 'monthly only on a monthly spec');
    assert(withMonthly(spec({ freq: 'monthly' }), 'weekday').monthly === 'weekday', 'the sheet\'s monthly pick');
    assert(normalizeSpec(spec({ freq: 'monthly' }), '2026-10-20').monthly === 'day', 'a monthly spec always has its choice');
  });

  await check('R4 the steppers and the end: every N clamps to 1..99, times to 1..999, one end at a time, a first "On date" four repeats on, a switch of frequency keeps N and the end; an end before the start is an error on the Repeat row', () => {
    assert(withInterval(spec({ freq: 'daily' }), 0).interval === 1 && withInterval(spec({ freq: 'daily' }), 500).interval === 99 && withInterval(spec({ freq: 'daily' }), 7).interval === 7, 'interval 1..99');
    assert(withCount(spec({ freq: 'daily' }), 0).count === 1 && withCount(spec({ freq: 'daily' }), 5000).count === 999, 'count 1..999');
    const d = spec({ freq: 'weekly', interval: 2 });
    assert(endKindOf(d) === 'never' && endKindOf(withEnd(d, 'count', '2026-10-20')) === 'count' && endKindOf(withEnd(d, 'until', '2026-10-20')) === 'until', 'the three ends');
    assertSame(withEnd(d, 'count', '2026-10-20').count, 5, 'a first count');
    assertSame(withEnd(d, 'until', '2026-10-20').until, '2026-12-15', 'four repeats of two weeks on');
    assertSame(withEnd(spec({ freq: 'daily' }), 'until', '2026-10-20').until, '2026-10-24', 'daily: four days');
    assertSame(withEnd(spec({ freq: 'yearly' }), 'until', '2026-10-20').until, '2030-10-19', 'yearly: four years (1460 days)');
    const counted = withEnd(d, 'count', '2026-10-20');
    assert(withEnd(counted, 'never', '2026-10-20').count === undefined && withEnd(counted, 'never', '2026-10-20').until === undefined, 'Never clears both');
    assert(withUntil(counted, '2027-01-01').count === undefined && withCount(withUntil(d, '2027-01-01'), 3).until === undefined, 'one end at a time');
    // A frequency switch keeps N and the end, resets the days.
    const from = spec({ freq: 'weekly', interval: 3, byDay: ['SU'], count: 4 });
    assertSame(pickFrequency(from, 'monthly', '2026-10-20'), { freq: 'monthly', interval: 3, monthly: 'day', count: 4 }, 'weekly to monthly');
    assertSame(pickFrequency(from, 'weekly', '2026-10-20'), from, 'the same frequency changes nothing');
    assert(pickFrequency(from, 'none', '2026-10-20') === 'none', 'never');
    assertSame(pickFrequency('none', 'daily', '2026-10-20'), { freq: 'daily', interval: 1 }, 'from never');
    assertSame(pickFrequency('custom', 'hebrew', '2026-10-20'), { freq: 'hebrew', interval: 1 }, 'from custom');
    assertSame(toGregorian(spec({ freq: 'hebrew', interval: 2, until: '2030-01-01' }), '2026-10-20'), { freq: 'yearly', interval: 2, until: '2030-01-01' }, 'hebrew falls back to yearly, keeping N and the end');
    // The end before the start.
    const f = withRepeat(formOf(info({ recurring: false, choice: { choice: 'none' } })), spec({ freq: 'daily', until: '2026-10-19' }));
    assertSame(checkForm({ ...f, title: 'x' }).repeat, 'errRepeatEnd', 'an end before the start');
    assert(checkForm({ ...f, title: 'x', repeat: spec({ freq: 'daily', until: '2026-10-20' }) }).repeat === undefined, 'the start\'s own day is fine');
    // The year floor goes by the spec.
    assert(minYearFor(spec({ freq: 'yearly' })) === 1900 && minYearFor(spec({ freq: 'hebrew' })) === 1900 && minYearFor(spec({ freq: 'weekly' })) === 2000, 'floor by the spec');
    assert(checkForm({ ...f, title: 'x', startDay: '1950-03-02', endDay: '1950-03-02', repeat: spec({ freq: 'yearly' }) }).start === undefined, '1950 yearly is fine');
    assert(checkForm({ ...f, title: 'x', startDay: '1950-03-02', endDay: '1950-03-02', repeat: spec({ freq: 'weekly' }) }).start === 'errYear', '1950 weekly is not');
  });

  await check('R5 a repeat is a change only when the spec says something else, relative to each start: moving a plain weekly or monthly series is not one; a pick, a stop and a custom rule left alone are', () => {
    const plain = formOf(info({ spec: spec({ freq: 'weekly', byDay: ['TU'] }), choice: { choice: 'weekly' } }));
    const plainMoved = moveStart(plain, { startDay: '2026-10-22' });
    assert(sameRepeat(plainMoved.repeat, plain.repeat, plainMoved.startDay) && isDirty(plainMoved, plain), 'a plain weekly moved to Thursday: only the start changed, the repeat is the same');
    assert(updateBody(plainMoved, plain, 'k', 'all')?.changes.repeat === undefined, 'and no repeat is sent');
    const nth = formOf(info({ spec: spec({ freq: 'monthly', monthly: 'weekday' }), choice: { choice: 'custom' }, day: '2026-10-13' }));
    assert(sameRepeat(moveStart(nth, { startDay: '2026-10-20' }).repeat, nth.repeat, '2026-10-20'), 'the second Tuesday moved to the third: the same spec');
    const D = '2026-10-20';
    assert(!sameRepeat(spec({ freq: 'daily' }), spec({ freq: 'daily', interval: 2 }), D) && !sameRepeat(spec({ freq: 'daily' }), 'none', D) && sameRepeat('custom', 'custom', D), 'interval and none differ');
    assert(!sameRepeat(spec({ freq: 'daily', until: '2026-10-27' }), spec({ freq: 'daily', count: 3 }), D), 'the end differs');
    assert(sameRepeat(spec({ freq: 'weekly', byDay: ['SU', 'TH'] }), spec({ freq: 'weekly', byDay: ['TH', 'SU', 'TU'] }), D), 'the order of the days, and the start\'s own day, are not a change');
    assert(!isDirty({ ...plain, repeat: { ...(plain.repeat as RepeatSpec), byDay: [...((plain.repeat as RepeatSpec).byDay ?? [])] } }, plain), 'an equal spec in a new object is not an edit');
    // updateBody: a pick sends the shown spec; custom left alone sends nothing; none sends 'none' with the occurrence's times.
    const picked = withRepeat(plain, spec({ freq: 'weekly', interval: 2, byDay: ['SA'], count: 6 }));
    assertSame(updateBody(picked, plain, 'k', 'following')?.changes, { repeat: { freq: 'weekly', interval: 2, byDay: ['TU', 'SA'], count: 6 } }, 'a pick');
    assert(updateBody(plain, plain, 'k', 'single') === null, 'untouched: nothing');
    const custom = formOf(info({ choice: { choice: 'custom' } }));
    assert(updateBody({ ...custom, title: 'Pool' }, custom, 'k', 'single')?.changes.repeat === undefined, 'a custom rule left alone is never sent');
    assertSame(updateBody(withRepeat(custom, 'none'), custom, 'k', 'following')?.changes.repeat, 'none', 'a stop');
    assertSame(repeatInput('custom', '2026-10-20'), 'none', 'custom as an input is none');
    // A server that reports a choice only: the same row, so nothing is sent on an untouched sheet.
    const old = formOf(info({ choice: { choice: 'monthly' } }));
    assert(updateBody(old, old, 'k', 'single') === null, 'a choice-only rule left alone');
    assert(formRepeat(spec({ freq: 'daily', interval: 3 }), '2026-10-20') !== null, 'formRepeat');
  });

  await check('R6 a day move on a series with fixed days restates the repeat: "this one and the ones after" sends the shown spec, which gains the new start\'s day and keeps the rest; a move onto a day the set already has offers only "Only this one" (the restated rule would be the stored one, which the server refuses); "only this one" sends none; a custom rule can\'t', () => {
    const weekly = info({ spec: spec({ freq: 'weekly', byDay: ['TU', 'TH'] }), choice: { choice: 'custom' }, fixedDays: true, first: false, day: '2026-10-20' });
    const initial = formOf(weekly);
    assertSame(initial.repeat, { freq: 'weekly', interval: 1, byDay: ['TU', 'TH'] }, 'opened on the Tuesday');
    const asks = { kind: 'sheet', choices: ['single', 'following'], note: 'dayMove' };
    // Tuesday moved to Thursday: a day the series already has. The restated rule is the stored one, so only this one is offered.
    const thu = moveStart(initial, { startDay: '2026-10-22' });
    assertSame(scopePlan(thu, initial, weekly), { kind: 'sheet', choices: ['single'], note: 'dayMove' }, 'Tuesday to Thursday: this one alone');
    assert(restatedRepeat(thu, initial, weekly) === null, 'and restates nothing');
    assert(updateBody(thu, initial, 'k', 'single', weekly)?.changes.repeat === undefined, 'only this one sends no repeat');
    // Tuesday moved to Wednesday: the shown spec is TU, WE, TH (the ruling\'s example, the server test at the same shape).
    const wed = moveStart(initial, { startDay: '2026-10-21' });
    assertSame(scopePlan(wed, initial, weekly), asks, 'Tuesday to Wednesday asks');
    assertSame(restatedRepeat(wed, initial, weekly), { freq: 'weekly', interval: 1, byDay: ['TU', 'WE', 'TH'] }, 'TU, WE, TH');
    // Away and back: the dates are as they were, so nothing is sent and nothing is asked.
    const home = moveStart(wed, { startDay: '2026-10-20' });
    assert(pickedRepeatBody(home, initial, weekly) === undefined && restatedRepeat(home, initial, weekly) === null, 'moved away and back: no repeat');
    assertSame(shownSpec(home.repeat, home.startDay)?.byDay, ['TU', 'TH'], 'both days kept');
    assertSame(updateBody({ ...home, title: 'Pool' }, initial, 'k', 'following', weekly)?.changes, { title: 'Pool' }, 'a title edit sends no repeat');
    // The second Tuesday moved to the third Tuesday: the same spec, the ordinal follows by itself.
    const nth = info({ spec: spec({ freq: 'monthly', monthly: 'weekday' }), choice: { choice: 'custom' }, fixedDays: true, first: false, day: '2026-10-13' });
    const nInitial = formOf(nth);
    const nMoved = moveStart(nInitial, { startDay: '2026-10-20' });
    assertSame(restatedRepeat(nMoved, nInitial, nth), { freq: 'monthly', interval: 1, monthly: 'weekday' }, 'monthly weekday restated');
    assert(restatedRepeat(nInitial, nInitial, nth) === null, 'no move, no restatement');
    assert(restatedRepeat({ ...nInitial, startTime: '18:00' }, nInitial, nth) === null, 'a new time restates nothing');
    // The last Tuesday moved out of the last week: it reads as the n-th weekday of the new start on both sides, so it is no silent pick; "following" restates it so.
    const lastInfo = info({ spec: spec({ freq: 'monthly', monthly: 'last' }), choice: { choice: 'custom' }, fixedDays: true, day: '2026-10-27' });
    const lInitial = formOf(lastInfo);
    const lMoved = moveStart(lInitial, { startDay: '2026-10-13' });
    assertSame(scopePlan(lMoved, lInitial, lastInfo), { kind: 'sheet', choices: ['single', 'following'] }, 'asks (from the first occurrence: no line), never a silent pick');
    assertSame(updateBody(lMoved, lInitial, 'k', 'following', lastInfo)?.changes.repeat, { freq: 'monthly', interval: 1, monthly: 'weekday' }, 'restated as the n-th weekday');
    assert(updateBody(lMoved, lInitial, 'k', 'single', lastInfo)?.changes.repeat === undefined, 'only this one sends none');
    // A single-day BYDAY series (the bot\'s every Tuesday, Google\'s): a plain weekly, restated on the new start.
    const one = info({ spec: spec({ freq: 'weekly', byDay: ['TU'] }), choice: { choice: 'weekly' }, fixedDays: true, first: false });
    const oInitial = formOf(one);
    assertSame(restatedRepeat(moveStart(oInitial, { startDay: '2026-10-22' }), oInitial, one), { freq: 'weekly', interval: 1, byDay: ['TH'] }, 'follows the start');
    // A custom rule moves this one alone; a plain weekly (not fixed) is no restatement.
    const custom = info({ choice: { choice: 'custom' }, fixedDays: true });
    const cInitial = formOf(custom);
    assertSame(scopePlan(moveStart(cInitial, { startDay: '2026-10-22' }), cInitial, custom), { kind: 'sheet', choices: ['single'], note: 'dayMove' }, 'custom: this one alone');
  });

  await check('R7 the one wording function, en: every N, the weekdays in the week-start order, the n-th and last weekday, the day of the month, yearly, Hebrew, and the end (until a date / N times)', () => {
    const t = translator('en');
    const ctx = (startDay: string, weekStart: 0 | 1 | 6 = 0, anchorDay?: string): WordsContext => ({ startDay, weekStart, ...(anchorDay ? { anchorDay } : {}) });
    const say = (s: RepeatSpec, c: WordsContext) => specText(t, 'en', s, c);
    assert(say(spec({ freq: 'daily' }), ctx('2026-10-20')) === 'Every day', 'daily');
    assert(say(spec({ freq: 'daily', interval: 3 }), ctx('2026-10-20')) === 'Every 3 days', 'every 3 days');
    assert(say(spec({ freq: 'weekly', byDay: ['TU'] }), ctx('2026-10-20')) === 'Every week on Tuesday', 'one day, named in full');
    assert(say(spec({ freq: 'weekly' }), ctx('2026-10-20')) === 'Every week on Tuesday', 'no days: the start\'s');
    assert(say(spec({ freq: 'weekly', interval: 2, byDay: ['TU', 'SU'], until: '2027-03-01' }), ctx('2026-10-20', 0)) === 'Every 2 weeks on Sun and Tue, until 1 Mar', 'the brief\'s example, Sunday first');
    assert(say(spec({ freq: 'weekly', interval: 2, byDay: ['TU', 'SU'], until: '2027-03-01' }), ctx('2026-10-20', 1)) === 'Every 2 weeks on Tue and Sun, until 1 Mar', 'Monday first');
    assert(say(spec({ freq: 'weekly', byDay: ['TU', 'TH', 'SU'] }), ctx('2026-10-20', 0)) === 'Every week on Sun, Tue and Thu', 'three days');
    assert(say(spec({ freq: 'monthly', monthly: 'day' }), ctx('2026-10-14')) === 'Every month on the 14th', 'the day');
    assert(say(spec({ freq: 'monthly', interval: 2, monthly: 'day' }), ctx('2026-10-22')) === 'Every 2 months on the 22nd', 'every 2 months');
    assert(say(spec({ freq: 'monthly', monthly: 'weekday', count: 5 }), ctx('2026-10-13')) === 'Every month on the second Tuesday, 5 times', 'the brief\'s example');
    assert(say(spec({ freq: 'monthly', monthly: 'weekday' }), ctx('2026-10-31')) === 'Every month on the fifth Saturday', 'the fifth');
    assert(say(spec({ freq: 'monthly', monthly: 'last' }), ctx('2026-10-27')) === 'Every month on the last Tuesday', 'the last');
    assert(say(spec({ freq: 'monthly', interval: 3, monthly: 'last', count: 1 }), ctx('2026-10-27')) === 'Every 3 months on the last Tuesday, once', 'once');
    assert(say(spec({ freq: 'monthly', monthly: 'last' }), ctx('2026-10-20')) === 'Every month on the 20th', 'a "last" the start can\'t hold reads as the day');
    assert(say(spec({ freq: 'yearly', interval: 2 }), ctx('2026-10-20')) === 'Every 2 years on 20 Oct', 'every 2 years');
    assert(say(spec({ freq: 'hebrew', interval: 2 }), ctx('2026-10-20', 0, '2027-01-23')) === 'Every 2 years on 15 Sh\'vat', `Hebrew: ${say(spec({ freq: 'hebrew', interval: 2 }), ctx('2026-10-20', 0, '2027-01-23'))}`);
    assert(say(spec({ freq: 'yearly', count: 3 }), ctx('2026-10-20')) === 'Every year on 20 Oct, 3 times', 'N times');
    // A rule the sheet can't say, from the server's info: the same words for its parts.
    const w = (repeat: ItemEditInfoResponse['series']['repeat']) => infoText(t, 'en', repeatWords(repeat, '2026-10-20T17:00'), 0);
    assert(w({ freq: 'weekly', interval: 1, byDay: ['MO', 'WE', 'FR'], ends: false }) === 'Every week on Mon, Wed and Fri', 'a bot\'s three days');
    assert(w({ freq: 'monthly', interval: 1, byDay: ['TU'], byDayOrdinals: [2], ends: false }) === 'Every month on the second Tuesday', '2TU');
    assert(w({ freq: 'monthly', interval: 2, byDay: ['SU'], byDayOrdinals: [-1], ends: false }) === 'Every 2 months on the last Sunday', '-1SU');
    assert(w({ freq: 'monthly', interval: 1, byDay: [], byMonthDay: [15], ends: false }) === 'Every month on the 15th', 'BYMONTHDAY=15');
    assert(w({ freq: 'weekly', interval: 2, byDay: [], ends: false }) === 'Every 2 weeks', 'every 2 weeks');
    assert(w({ freq: 'monthly', interval: 1, byDay: ['MO', 'TU'], byDayOrdinals: [1, 2], ends: false }) === 'Every month', 'two ordinals: the frequency alone');
    assert(withEndText(t, 'en', 'Every week', endOfInfo({ freq: 'weekly', interval: 1, byDay: [], ends: true, count: 4 })) === 'Every week, 4 times', 'its COUNT');
    assert(withEndText(t, 'en', 'Every week', endOfInfo({ freq: 'weekly', interval: 1, byDay: [], ends: true, until: '2026-12-01' })) === 'Every week, until 1 Dec', 'its UNTIL');
    assert(withEndText(t, 'en', 'Every week', endOfInfo({ freq: 'weekly', interval: 1, byDay: [], ends: true, count: 4 }, '2026-11-02')) === 'Every week, until 2 Nov', 'the rule\'s last day wins over a count');
    // The scope sheet's short name: the spec's words when it is richer than every day / every <weekday>, never for a series that ends.
    const rich = spec({ freq: 'weekly', interval: 2, byDay: ['TU', 'SU'] });
    const repeat: RepeatInfo = { freq: 'weekly', interval: 2, byDay: ['SU', 'TU'], ends: false };
    assertSame(allOfThem(repeat, '2026-10-20T17:00', rich), { key: 'rule', spec: rich, startDay: '2026-10-20' }, 'the rule');
    assertSame(allOfThem({ ...repeat, ends: true }, '2026-10-20T17:00', rich), { key: 'all' }, 'an ending series has none');
    assertSame(allOfThem({ freq: 'daily', interval: 1, byDay: [], ends: false }, '2026-10-20T17:00', spec({ freq: 'daily' })), { key: 'daily' }, 'every day stays');
    assertSame(allOfThem({ freq: 'weekly', interval: 1, byDay: ['TU'], ends: false }, '2026-10-20T17:00', spec({ freq: 'weekly', byDay: ['TU'] })), { key: 'weekday', weekday: 'tue' }, 'every Tuesday stays');
    assertSame(allOfThem(repeat, '2026-10-20T17:00', spec({ freq: 'weekly', interval: 2, byDay: ['TU'], until: '2027-01-01' })), { key: 'all' }, 'a spec with an end has none');
  });

  await check('R8 the wording in Russian: the ordinal agrees with the weekday\'s gender («каждый второй вторник», «каждую вторую среду», «каждое второе воскресенье»), plurals of N, the list of days, N times', () => {
    const t = translator('ru');
    const ctx = (startDay: string): WordsContext => ({ startDay, weekStart: 1 });
    const say = (s: RepeatSpec, c: WordsContext) => specText(t, 'ru', s, c);
    const nth = (n: 'weekday' | 'last') => spec({ freq: 'monthly', monthly: n });
    assert(say(nth('weekday'), ctx('2026-10-13')) === 'Каждый второй вторник месяца', 'masculine');
    assert(say(nth('weekday'), ctx('2026-10-14')) === 'Каждую вторую среду месяца', 'feminine');
    assert(say(nth('weekday'), ctx('2026-10-11')) === 'Каждое второе воскресенье месяца', 'neuter');
    assert(say(nth('weekday'), ctx('2026-10-02')) === 'Каждую первую пятницу месяца', 'first Friday');
    assert(say(nth('weekday'), ctx('2026-10-31')) === 'Каждую пятую субботу месяца', 'fifth Saturday');
    assert(say(nth('last'), ctx('2026-10-27')) === 'Каждый последний вторник месяца', 'last Tuesday');
    assert(say(nth('last'), ctx('2026-10-28')) === 'Каждую последнюю среду месяца', 'last Wednesday');
    assert(say(nth('last'), ctx('2026-10-25')) === 'Каждое последнее воскресенье месяца', 'last Sunday');
    assert(say(spec({ freq: 'monthly', interval: 2, monthly: 'weekday', count: 5 }), ctx('2026-10-13')) === 'Каждые 2 месяца, во второй вторник, 5 раз', 'every 2 months, 5 times');
    assert(say(spec({ freq: 'monthly', interval: 5, monthly: 'weekday' }), ctx('2026-10-14')) === 'Каждые 5 месяцев, во вторую среду', 'accusative, many');
    assert(say(spec({ freq: 'weekly', byDay: ['TU'] }), ctx('2026-10-20')) === 'Каждую неделю, во вторник', 'one day');
    assert(say(spec({ freq: 'weekly', byDay: ['SA'] }), ctx('2026-10-24')) === 'Каждую неделю, в субботу', 'one day, Saturday');
    assert(say(spec({ freq: 'weekly', interval: 2, byDay: ['TU', 'SU'], until: '2027-03-01' }), ctx('2026-10-20')) === 'Каждые 2 недели, по вт и вс, до 1 мар.', `a list: ${say(spec({ freq: 'weekly', interval: 2, byDay: ['TU', 'SU'], until: '2027-03-01' }), ctx('2026-10-20'))}`);
    assert(say(spec({ freq: 'daily', interval: 21 }), ctx('2026-10-20')) === 'Каждые 21 день' && say(spec({ freq: 'daily', interval: 5 }), ctx('2026-10-20')) === 'Каждые 5 дней', 'daily plurals');
    assert(say(spec({ freq: 'monthly', monthly: 'day' }), ctx('2026-10-14')) === 'Каждый месяц, 14-го числа', 'the day');
    assert(say(spec({ freq: 'yearly', interval: 2 }), ctx('2026-10-20')) === 'Каждые 2 года, 20 окт.', 'yearly');
    assert(say(spec({ freq: 'daily', count: 1 }), ctx('2026-10-20')) === 'Каждый день, 1 раз' && say(spec({ freq: 'daily', count: 3 }), ctx('2026-10-20')) === 'Каждый день, 3 раза' && say(spec({ freq: 'daily', count: 11 }), ctx('2026-10-20')) === 'Каждый день, 11 раз', 'times plurals');
    assert(say(spec({ freq: 'hebrew', interval: 2 }), { startDay: '2026-10-20', weekStart: 1, anchorDay: '2027-01-23' }) === 'Каждые 2 года 15 швата', 'Hebrew');
  });

  await check('R9 the wording in Hebrew: «ביום שלישי השני בכל חודש», the last one, a feminine Shabbat, plurals of N (two = a pair), the days as letters, N times, the Hebrew date in gematriya', () => {
    const t = translator('he');
    const ctx = (startDay: string, anchorDay?: string): WordsContext => ({ startDay, weekStart: 0, ...(anchorDay ? { anchorDay } : {}) });
    const say = (s: RepeatSpec, c: WordsContext) => specText(t, 'he', s, c);
    const nth = (n: 'weekday' | 'last') => spec({ freq: 'monthly', monthly: n });
    assert(say(nth('weekday'), ctx('2026-10-13')) === 'ביום שלישי השני בכל חודש', 'the second Tuesday');
    assert(say(nth('last'), ctx('2026-10-27')) === 'ביום שלישי האחרון בכל חודש', 'the last Tuesday');
    assert(say(nth('weekday'), ctx('2026-10-03')) === 'בשבת הראשונה בכל חודש', 'Shabbat is feminine');
    assert(say(nth('last'), ctx('2026-10-31')) === 'בשבת האחרונה בכל חודש', 'the last Shabbat');
    assert(say(nth('weekday'), ctx('2026-10-14')) === 'ביום רביעי השני בכל חודש', 'Wednesday');
    assert(say(spec({ freq: 'monthly', interval: 2, monthly: 'weekday' }), ctx('2026-10-13')) === 'ביום שלישי השני כל חודשיים', 'every two months');
    assert(say(spec({ freq: 'monthly', interval: 3, monthly: 'weekday', count: 5 }), ctx('2026-10-13')) === 'ביום שלישי השני כל 3 חודשים, 5 פעמים', 'every 3 months, 5 times');
    assert(say(spec({ freq: 'weekly', byDay: ['TU'] }), ctx('2026-10-20')) === 'כל שבוע ביום שלישי', 'one day');
    assert(say(spec({ freq: 'weekly', byDay: ['SA'] }), ctx('2026-10-24')) === 'כל שבוע בשבת', 'Shabbat');
    assert(say(spec({ freq: 'weekly', interval: 2, byDay: ['TU', 'SU'], until: '2027-03-01' }), ctx('2026-10-20')) === 'כל שבועיים בימים א׳ וג׳, עד 1 במרץ', `a list: ${say(spec({ freq: 'weekly', interval: 2, byDay: ['TU', 'SU'], until: '2027-03-01' }), ctx('2026-10-20'))}`);
    assert(say(spec({ freq: 'daily', interval: 2 }), ctx('2026-10-20')) === 'כל יומיים' && say(spec({ freq: 'daily', interval: 3 }), ctx('2026-10-20')) === 'כל 3 ימים', 'daily plurals');
    assert(say(spec({ freq: 'daily', count: 1 }), ctx('2026-10-20')) === 'כל יום, פעם אחת' && say(spec({ freq: 'daily', count: 2 }), ctx('2026-10-20')) === 'כל יום, פעמיים', 'times');
    assert(say(spec({ freq: 'monthly', monthly: 'day' }), ctx('2026-10-14')) === 'כל חודש ב-14', 'the day');
    assert(say(spec({ freq: 'hebrew', interval: 2 }), ctx('2026-10-20', '2027-01-23')) === 'כל שנתיים בט״ו בשבט', `Hebrew: ${say(spec({ freq: 'hebrew', interval: 2 }), ctx('2026-10-20', '2027-01-23'))}`);
  });

  await check('R10 the copy keeps its promises: every wording function call formats without an error in en, he and ru, and a kind switch to a Google calendar turns a Hebrew spec into a yearly one', () => {
    for (const locale of LOCALES) {
      const t = translator(locale);
      for (const startDay of ['2026-10-13', '2026-10-14', '2026-10-11', '2026-10-27', '2026-10-31']) {
        for (const monthly of ['day', 'weekday', 'last'] as const) {
          for (const interval of [1, 2, 5, 21]) {
            const text = specText(t, locale, spec({ freq: 'monthly', interval, monthly, count: interval }), { startDay, weekStart: 0 });
            assert(text.length > 0 && !/[{}]|undefined|missing/i.test(text), `${locale} ${startDay} ${monthly} ${interval}: ${show(text)}`);
          }
        }
      }
    }
    assert(errors.length === 0, `translator errors: ${errors.slice(0, 3).join('; ')}`);
    const cal = { id: 'native:c', name: 'F', color: null, main: true, mine: true };
    const base = editItemForm(info({ recurring: false, choice: { choice: 'none' } }));
    const reminder = { ...base, kind: 'reminder' as const, calendarId: cal.id, repeat: spec({ freq: 'hebrew', interval: 2 }) };
    assertSame(setKind({ ...reminder, calendarId: 'avi@gmail.com' }, 'event').repeat, { freq: 'yearly', interval: 2 }, 'Google: yearly');
  });

  await check('R11 the repeat is built and worded on the start\'s day in the series\' zone: a Tuesday 01:00 series in Jerusalem opened by a user in New York (Monday 19:00) is a plain weekly on Tuesday, not Mon and Tue; the ordinal, "last" and the end\'s minimum go by that day too', () => {
    const ny = info({ tz: 'America/New_York', zone: 'Asia/Jerusalem', time: '19:00', day: '2026-10-26', spec: spec({ freq: 'weekly', byDay: ['TU'] }), choice: { choice: 'weekly' } });
    const f = formOf(ny);
    assert(f.startDay === '2026-10-26', 'the form shows the user\'s Monday');
    assertSame(repeatDayOf(f, ny), '2026-10-27', 'the series\' day is the Tuesday');
    assertSame(f.repeat, { freq: 'weekly', interval: 1 }, 'a plain weekly: no Monday in its set');
    assert(updateBody({ ...f, title: 'Pool' }, f, 'k', 'single', ny)?.changes.repeat === undefined, 'a title edit sends no repeat');
    assertSame(updateBody(withRepeat(f, spec({ freq: 'weekly', interval: 2 })), f, 'k', 'following', ny)?.changes.repeat, { freq: 'weekly', interval: 2, byDay: ['TU'] }, 'a pick says Tuesday, not Monday and Tuesday');
    assertSame(repeatDayOf({ startDay: '2026-10-26', startTime: '19:00', allDay: true }, ny), '2026-10-26', 'all day is already the series\' day');
    assertSame(repeatDayOf(f, undefined), '2026-10-26', 'a new item: the form\'s day');
    const ends = withRepeat(f, spec({ freq: 'daily', until: '2026-10-26' }));
    assertSame(checkForm({ ...ends, title: 'x' }, ny).repeat, 'errRepeatEnd', 'an end the day before the series\' start day');
    assert(checkForm({ ...ends, title: 'x' }).repeat === undefined, 'the user\'s clock alone would let it through');
    // "Last Monday" for the user is the last Tuesday of the series (27 Oct is in the last week, 26 Oct is too; use 20/19 across a month end).
    const edge = info({ tz: 'America/New_York', zone: 'Asia/Jerusalem', time: '19:00', day: '2026-10-24', spec: spec({ freq: 'monthly', monthly: 'weekday' }), choice: { choice: 'custom' } });
    assertSame(shownSpec(formOf(edge).repeat, repeatDayOf(formOf(edge), edge)), { freq: 'monthly', interval: 1, monthly: 'weekday' }, 'the weekday spec stands');
    assertSame(monthlyOptions(repeatDayOf(formOf(edge), edge)), { ordinal: 4, last: true }, 'the series\' 25 Oct holds a "last"; the user\'s 24 Oct would not');
    // Cancel's discard question compares on that day too: the plain weekly and the Tuesday-only spec are one repeat there.
    const tuOnly = withRepeat(f, spec({ freq: 'weekly', byDay: ['TU'] }));
    assert(!isDirty(tuOnly, f, ny), 'on the series\' Tuesday a plain weekly and {TU} are the same');
    assert(isDirty(tuOnly, f), 'on the user\'s Monday they would differ');
  });

  await check('R12 leaving a rule the sheet can\'t say carries its end, and its interval for the same frequency; a pick from Never starts clean', () => {
    const seed = { freq: 'weekly' as const, interval: 2, until: '2026-12-01' };
    assertSame(pickFrequency('custom', 'weekly', '2026-10-20', seed), { freq: 'weekly', interval: 2, until: '2026-12-01' }, 'same frequency: N and the end');
    assertSame(pickFrequency('custom', 'daily', '2026-10-20', seed), { freq: 'daily', interval: 1, until: '2026-12-01' }, 'another frequency: the end only');
    assertSame(pickFrequency('custom', 'monthly', '2026-10-20', { freq: 'monthly', interval: 3, count: 4 }), { freq: 'monthly', interval: 3, monthly: 'day', count: 4 }, 'a count too');
    assertSame(pickFrequency('none', 'weekly', '2026-10-20', seed), { freq: 'weekly', interval: 1 }, 'from Never the seed is ignored');
    assertSame(pickFrequency('custom', 'weekly', '2026-10-20'), { freq: 'weekly', interval: 1 }, 'no seed');
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.name}${r.reason ? ` — ${r.reason}` : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed (process TZ=${process.env.TZ ?? 'default'})`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

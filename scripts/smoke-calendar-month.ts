// Smoke test for the Month's model (spec §7.4, §5's month windows, Rulings R11 and R12;
// Plan E Rulings 3–7; Task E5): src/lib/calendar-view/month.ts.
//
// Each month draws its own days, and the days of its rows outside it are blank (R12).
// A cell's slots are the bars first, by lane, then its one-day items; whose an item is
// follows the Agenda's rule, and a done reminder is struck through. Daily-repeating
// reminders are left out of the slots, the dots and the counts (R11, Ruling 5) but are
// listed for the selected day. A bar is an all-day item over its dates or a timed one
// the store lists on the next or the day before; at the month's edges its span marks
// decide, with daySpanOf's 06:00 rule, and the checks hold that against the server's
// own bucketing of the next month. Lanes are per week row, with spacers that keep a
// bar in line; a bar's title shows on the first day it is drawn in each row. A large
// square shows its lines, or one less and "+N" (Ruling 3); a day with more than fits lets
// its one-day items into a bar's empty lanes, then moves its bars up with their titles, so
// no square shows an empty line over "+N" (fitRow, per week row). A month is answered,
// loading or failed, and its notices carry the earliest failing day's reason, never a
// reconnect. Then the reach's ends (January 1900 … December 2100, not today's span), the
// focus kept inside it, the months to fetch (Ruling 7, Ruling 2), the bar's height, and the
// memo. The focus helpers' own rules are smoke-month-layout.ts's.
//
// The store is fed real answers for month windows: the fixtures are ReadItems, each
// month's days come from the server's toRangeDays (daySpanOf, as the route builds
// them), and they go through D3's reducer. Pure: no network, no database, no React.
//
// Run with the fake env from the plan, under three clocks (the output must not depend
// on the process timezone):
//   TZ=UTC npx tsx scripts/smoke-calendar-month.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-month.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-calendar-month.ts

import {
  PICKED_DOTS,
  buildMonth,
  canStepMonth,
  clampFocus,
  dayRows,
  fitRow,
  fitSlots,
  initialFocus,
  limitDots,
  loadingMonth,
  monthBarPx,
  monthModels,
  wantedFocusMonths,
  type MonthCell,
  type MonthFocus,
  type MonthModel,
  type MonthSlot,
} from '../src/lib/calendar-view/month';
import fs from 'fs';
import path from 'path';
import { fromZonedTime } from 'date-fns-tz';
import { monthGrid } from '../src/lib/calendar-view/grid';
import { reminderMark, whoseItem } from '../src/lib/calendar-view/agenda';
import {
  dayItems,
  dayStatus,
  emptyStore,
  homeNotices,
  reduceStore,
  type CalendarStore,
  type FamcalStatus,
  type GoogleStatus,
  type StoreAction,
} from '../src/lib/calendar-view/store';
import type { DayKey, RangeResponse, SourceName, WeekStart } from '../src/lib/calendar-view/types';
import { toCalendarDto, toRangeDays } from '../src/services/calendar-read/dto';
import type { CalendarRef, ReadItem } from '../src/services/calendar-read/types';
import type { UnifiedEvent } from '../src/services/calendar-provider/types';
import type { ReminderInfo } from '../src/types';
import { OVERNIGHT_CUTOFF_HOUR } from '../src/utils/day-events';

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

// ---- Fixtures: a FamCal user in Israel paired with Noa, Thursday 15 October 2026 ----

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const TODAY = '2026-10-15';
/** The clock the open marks are read at: 09:00 in Israel. */
const NOW = fromZonedTime('2026-10-15 09:00:00', IL);

/** A FamCal timed value: the UTC ISO string of a local wall time. */
const utc = (local: string, tz = IL) => fromZonedTime(local, tz).toISOString();

const OWN_CAL: CalendarRef = { id: 'native:cal-own', source: 'famcal', name: 'Raziel', color: '#039BE5', mine: true, inLegend: true };
const NOA_SHARED: CalendarRef = { id: 'native:cal-noa', source: 'famcal', name: 'Noa family', color: '#E67C73', mine: false, ownerName: 'Noa', inLegend: true };
const FAMILY_G: CalendarRef = { id: 'family@group.calendar.google.com', source: 'google', name: 'Family', color: '#7986CB', mine: true, inLegend: true };

type Extra = {
  kind?: 'event' | 'reminder';
  rrule?: string | null;
  state?: { doneAt: Date | null; snoozedUntil: Date | null };
  reminder?: ReminderInfo;
  calendar?: CalendarRef;
  tz?: string;
};

/** A FamCal ReadItem as readFamcal builds one. `eventId` 'series#instant' is a recurring instance. */
function famcal(eventId: string, title: string, start: string, end: string, extra: Extra = {}): ReadItem {
  const kind = extra.kind ?? 'event';
  const calendar = extra.calendar ?? OWN_CAL;
  const event: UnifiedEvent = {
    summary: title,
    start,
    end,
    calendarName: calendar.name,
    calendarId: calendar.id ?? 'native:cal-own',
    eventType: kind === 'reminder' ? 'reminder' : undefined,
    recurringEventId: eventId.includes('#') ? eventId.split('#')[0] : undefined,
    eventId,
    provider: 'native',
    instanceStartsAt: eventId.includes('#') ? eventId.split('#')[1] : undefined,
    timeZone: extra.tz ?? IL,
    ...(kind === 'reminder' ? { reminder: extra.reminder ?? { ownerIsViewer: true, creatorIsViewer: true } } : {}),
  };
  return {
    source: 'famcal',
    key: `famcal|${eventId}`,
    event,
    calendar,
    title,
    kind,
    seriesId: eventId.split('#')[0],
    originalStart: start.includes('T') ? start : null,
    recurring: !!extra.rrule,
    rrule: extra.rrule ?? null,
    hebrewRule: null,
    hebrewAnchor: null,
    ...(extra.state ? { state: extra.state } : {}),
  };
}

/** A zero-length FamCal reminder at a timed instant. */
const reminder = (eventId: string, title: string, at: string, extra: Extra = {}) => famcal(eventId, title, at, at, { kind: 'reminder', ...extra });

/** A Google ReadItem on the Family calendar. */
function google(id: string, title: string, start: string, end: string): ReadItem {
  const event: UnifiedEvent = { summary: title, start, end, calendarName: FAMILY_G.name, calendarId: FAMILY_G.id ?? '', eventType: 'default', eventId: id, provider: 'google' };
  return {
    source: 'google',
    key: `google|${FAMILY_G.id}|${id}`,
    event,
    calendar: FAMILY_G,
    title,
    kind: 'event',
    seriesId: null,
    originalStart: null,
    recurring: false,
    rrule: null,
    hebrewRule: null,
    hebrewAnchor: null,
    google: { birthday: false, htmlLink: null },
  };
}

/** A month's own days, [1st, 1st of the next month), worked out here rather than with grid.ts. */
function windowOf(month: string): { from: DayKey; to: DayKey } {
  const [y, m] = month.split('-').map(Number);
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10) };
}

const pad = (n: number) => String(n).padStart(2, '0');
const OCTOBER = Array.from({ length: 31 }, (_, i) => `2026-10-${pad(i + 1)}`);

type AnswerOpts = {
  month?: string;
  today?: DayKey;
  window?: { from: DayKey; to: DayKey };
  tz?: string;
  weekStart?: WeekStart;
  famcal?: FamcalStatus;
  google?: GoogleStatus;
};

/**
 * The route's answer for a window (a month's by default), with the days the server's
 * toRangeDays buckets. A FamCal user's answer, or a Google user's when `google` is given.
 * Only an ok source's items are in it, as on the server.
 */
function answer(items: ReadItem[], o: AnswerOpts): RangeResponse {
  const tz = o.tz ?? IL;
  const today = o.today ?? TODAY;
  const { from, to } = o.window ?? windowOf(o.month ?? '2026-10');
  const isGoogle = o.google !== undefined;
  const status = isGoogle ? o.google! : (o.famcal ?? { status: 'ok' as const });
  const source: SourceName = isGoogle ? 'google' : 'famcal';
  const kept = status.status === 'ok' ? items.filter((i) => i.source === source) : [];
  return {
    tz,
    today,
    weekStart: o.weekStart ?? 0,
    hebrewDates: true,
    from,
    to,
    sources: isGoogle ? { google: o.google } : { famcal: status as FamcalStatus },
    partner: isGoogle ? null : { name: 'Noa' },
    calendars: (isGoogle ? [FAMILY_G] : [OWN_CAL, NOA_SHARED]).map(toCalendarDto),
    days: toRangeDays(kept, from, to, tz, NOW, today),
  };
}

const respond = (response: RangeResponse, epoch = 0): StoreAction => ({ type: 'response', response, epoch });
const storeOf = (actions: StoreAction[]) => actions.reduce(reduceStore, emptyStore());

// The family's autumn, in Israel.
const daily = OCTOBER.map((d) => reminder(`vit#${utc(`${d} 08:00`)}`, 'Take vitamins', utc(`${d} 08:00`), { rrule: 'FREQ=DAILY' }));
const weekly = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'].map((d) =>
  reminder(`recycle#${utc(`${d} 21:00`)}`, 'Take out the recycling', utc(`${d} 21:00`), { rrule: 'FREQ=WEEKLY;BYDAY=MO' })
);
const ITEMS: ReadItem[] = [
  // Across September and October.
  famcal('trip', 'Sukkot trip', '2026-09-29', '2026-10-03'),
  famcal('shift', 'Night shift', utc('2026-09-30 20:00'), utc('2026-10-01 08:00')),
  // Whose and done, on Wednesday 14 October.
  famcal('gym', 'Gym', utc('2026-10-14 07:00'), utc('2026-10-14 08:00')),
  famcal('pilates', 'Pilates', utc('2026-10-14 19:00'), utc('2026-10-14 20:00'), { calendar: NOA_SHARED }),
  // A reminder goes by its owner, not its calendar: Noa's for the viewer on her calendar, the viewer's for Noa on theirs.
  reminder('plumber', 'Call the plumber', utc('2026-10-14 11:00'), { reminder: { ownerIsViewer: true, creatorIsViewer: false, creatorName: 'Noa' }, calendar: NOA_SHARED }),
  reminder('flowers', 'Buy flowers', utc('2026-10-14 12:00'), { reminder: { ownerIsViewer: false, creatorIsViewer: true, ownerName: 'Noa' } }),
  reminder('bill', 'Pay the bill', utc('2026-10-14 09:00'), { state: { doneAt: new Date(utc('2026-10-14 09:05')), snoozedUntil: null } }),
  // Bars inside October.
  famcal('sleepover', 'Kids sleepover', utc('2026-10-16 18:00'), utc('2026-10-17 10:00'), { calendar: NOA_SHARED }),
  famcal('conf', 'Conference', utc('2026-10-19 09:00'), utc('2026-10-21 17:00')),
  famcal('hack', 'Hackathon', utc('2026-10-20 10:00'), utc('2026-10-22 16:00')),
  famcal('party', 'Party at Dana', utc('2026-10-23 22:00'), utc('2026-10-24 02:00')),
  famcal('eilat', 'Eilat trip', '2026-10-25', '2026-10-30'),
  famcal('grandma', 'Grandma visits', '2026-10-27', '2026-10-29', { calendar: NOA_SHARED }),
  famcal('snorkel', 'Snorkeling', utc('2026-10-26 10:00'), utc('2026-10-26 12:00'), { calendar: NOA_SHARED }),
  // Across October and November.
  famcal('halloween', 'Halloween party', utc('2026-10-31 22:00'), utc('2026-11-01 02:00')),
  famcal('flight', 'Late flight', utc('2026-10-31 23:00'), utc('2026-11-01 07:30')),
  famcal('weekend', 'Family weekend', '2026-10-31', '2026-11-02'),
  // Lanes in November: the same dates go by key, the same start by length (the longer has the later key),
  // and an earlier start keeps its lane above a longer bar from the row's first day.
  famcal('twin-b', 'Twin B', '2026-11-09', '2026-11-11'),
  famcal('twin-a', 'Twin A', '2026-11-09', '2026-11-11'),
  famcal('long-a', 'Visit A', '2026-11-12', '2026-11-17'),
  famcal('long-b', 'Visit B', '2026-11-14', '2026-11-22'),
  famcal('expo', 'Expo', '2026-11-22', '2026-11-24'),
  famcal('tour', 'Bike tour', '2026-11-22', '2026-11-26'),
  ...daily,
  ...weekly,
];

const AUTUMN = ['2026-09', '2026-10', '2026-11'];
/** September, October and November answered, at week start `ws`. */
const autumn = (ws: WeekStart) => storeOf(AUTUMN.map((m) => respond(answer(ITEMS, { month: m, weekStart: ws }))));
const STORE_0 = autumn(0);
const STORE_1 = autumn(1);

const idOf = (key: string | null) => (key ?? '').replace(/^famcal\|/, '').replace(/#.*$/, '');
/**
 * A slot as a short string: kind:id, then * when the title shows, < and > for a bar
 * that goes on before and after, ~ for the partner's, x for done; a spacer is _.
 */
const show = (s: MonthSlot) =>
  s.kind === 'spacer'
    ? '_'
    : `${s.kind}:${idOf(s.key)}${s.showTitle ? '*' : ''}${s.continuesBefore ? '<' : ''}${s.continuesAfter ? '>' : ''}${s.mine ? '' : '~'}${s.done ? 'x' : ''}`;

function modelOf(store: CalendarStore, month: string): MonthModel {
  const model = buildMonth(store, month);
  assert(model !== null, `no model for ${month}`);
  return model;
}

function cellOf(model: MonthModel, day: DayKey): MonthCell {
  const cell = model.weeks.flat().find((c) => c.day === day && c.inMonth);
  assert(cell !== undefined, `no in-month cell ${day} in ${model.month}`);
  return cell;
}

/** Each listed day's slots as strings. */
function slotsOf(model: MonthModel, days: DayKey[]): Record<DayKey, string[]> {
  const out: Record<DayKey, string[]> = {};
  for (const d of days) out[d] = cellOf(model, d).slots.map(show);
  return out;
}

const keysOn = (store: CalendarStore, day: DayKey) => dayItems(store, day).map((i) => i.key);

const focus = (month: string, selected: DayKey): MonthFocus => ({ month, selected });
const slot = (kind: MonthSlot['kind'], id: string | null): MonthSlot => ({
  kind,
  key: id === null ? null : `famcal|${id}`,
  title: id,
  showTitle: kind !== 'spacer',
  mine: true,
  color: null,
  count: null,
  done: false,
  continuesBefore: false,
  continuesAfter: false,
  canEdit: false,
  repeatsEveryDay: false,
});
const chips = (n: number) => Array.from({ length: n }, (_, i) => slot('timed', `c${i}`));

async function main() {
  await check('whose, colour and done: the viewer\'s chips filled, the partner\'s outlined (whoseItem), each in its calendar\'s colour, a done reminder struck through; dots and counts follow; a spacer has no colour', () => {
    const oct = modelOf(STORE_0, '2026-10');
    const cell = cellOf(oct, '2026-10-14');
    assertJson(cell.slots.map(show), ['timed:gym*', 'timed:bill*x', 'timed:plumber*', 'timed:flowers*~', 'timed:pilates*~'], '14 October');
    assertJson(cell.dots.map((d) => d.mine), [true, true, true, false, false], 'dots');
    assert(cell.count === 5 && cell.fromPartner === 2, `count ${cell.count}, fromPartner ${cell.fromPartner}`);
    assert(oct.partner === 'Noa', `partner ${oct.partner}`);
    // Every drawn slot of the month against the Agenda's rules for the same item.
    for (const c of oct.weeks.flat().filter((x) => x.inMonth)) {
      const items = new Map(dayItems(STORE_0, c.day).map((i) => [i.key, i]));
      for (const s of c.slots) {
        if (s.kind === 'spacer') continue;
        const item = items.get(s.key ?? '');
        assert(item !== undefined, `${c.day}: ${s.key} is not a day item`);
        assert(s.mine === whoseItem(item, 'Noa').mine, `${c.day} ${s.key}: mine ${s.mine}`);
        assert(s.done === (reminderMark(item) === 'done'), `${c.day} ${s.key}: done ${s.done}`);
        assert(s.title === item.title, `${c.day} ${s.key}: title ${s.title}`);
        assert(s.color === item.calendar.color, `${c.day} ${s.key}: color ${s.color}`);
      }
      for (const s of c.slots) if (s.kind === 'spacer') assert(s.color === null, `${c.day}: a spacer with a colour`);
      const drawn = c.slots.filter((s) => s.kind !== 'spacer');
      assertJson(c.dots, drawn.map((s) => ({ mine: s.mine, color: s.color })), `${c.day} dots`);
      assert(c.count === drawn.length && c.fromPartner === drawn.filter((s) => !s.mine).length, `${c.day} counts`);
    }
  });

  await check('the Eilat trip (25–29 October): one bar along its week row at week start 0, its title on the 25th only; Grandma\'s visit in lane 1', () => {
    const oct = modelOf(STORE_0, '2026-10');
    assertJson(
      slotsOf(oct, ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']),
      {
        '2026-10-25': ['bar:eilat*>'],
        '2026-10-26': ['bar:eilat<>', 'timed:snorkel*~', 'timed:recycle*'],
        '2026-10-27': ['bar:eilat<>', 'bar:grandma*>~'],
        '2026-10-28': ['bar:eilat<>', 'bar:grandma<~'],
        '2026-10-29': ['bar:eilat<'],
        '2026-10-30': [],
      },
      'week start 0'
    );
  });

  await check('the Eilat trip across two week rows at week start 1: the title again at the second row\'s start', () => {
    const oct = modelOf(STORE_1, '2026-10');
    assertJson(
      slotsOf(oct, ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29']),
      {
        '2026-10-25': ['bar:eilat*>'],
        '2026-10-26': ['bar:eilat*<>', 'timed:snorkel*~', 'timed:recycle*'],
        '2026-10-27': ['bar:eilat<>', 'bar:grandma*>~'],
        '2026-10-28': ['bar:eilat<>', 'bar:grandma<~'],
        '2026-10-29': ['bar:eilat<'],
      },
      'week start 1'
    );
    assert(oct.weeks[3][6].day === '2026-10-25' && oct.weeks[4][0].day === '2026-10-26', 'the 25th ends a row and the 26th starts the next');
  });

  await check('lanes per week row: the same start goes by length, then key; an earlier start keeps its lane above a longer bar from the row\'s first day', () => {
    const nov = modelOf(STORE_0, '2026-11');
    assertJson(
      slotsOf(nov, ['2026-11-09', '2026-11-10', '2026-11-12', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-22', '2026-11-24']),
      {
        '2026-11-09': ['bar:twin-a*>', 'bar:twin-b*>'],
        '2026-11-10': ['bar:twin-a<', 'bar:twin-b<'],
        '2026-11-12': ['bar:long-a*>'],
        '2026-11-14': ['bar:long-a<>', 'bar:long-b*>'],
        '2026-11-15': ['bar:long-a*<>', 'bar:long-b*<>'],
        '2026-11-16': ['bar:long-a<', 'bar:long-b<>'],
        '2026-11-17': ['_', 'bar:long-b<>'],
        '2026-11-22': ['bar:tour*>', 'bar:expo*>'],
        '2026-11-24': ['bar:tour<>'],
      },
      'November at week start 0'
    );
  });

  await check('a bar continuing from the previous month into day 1: the all-day Sukkot trip and the timed night shift, with September\'s side', () => {
    const oct = modelOf(STORE_0, '2026-10');
    assertJson(slotsOf(oct, ['2026-10-01', '2026-10-02', '2026-10-03']), {
      '2026-10-01': ['bar:trip*<>', 'bar:shift*<'],
      '2026-10-02': ['bar:trip<'],
      '2026-10-03': [],
    }, 'October');
    const sep = modelOf(STORE_0, '2026-09');
    assertJson(slotsOf(sep, ['2026-09-28', '2026-09-29', '2026-09-30']), {
      '2026-09-28': [],
      '2026-09-29': ['bar:trip*>'],
      '2026-09-30': ['bar:trip<>', 'bar:shift*>'],
    }, 'September');
    // The row they share is blank on the other month's days (R12).
    for (const c of sep.weeks[4]) if (c.day >= '2026-10-01') assert(!c.inMonth && c.slots.length === 0, `${c.day} is blank in September`);
    for (const c of oct.weeks[0]) if (c.day < '2026-10-01') assert(!c.inMonth && c.slots.length === 0, `${c.day} is blank in October`);
  });

  await check('a Mon–Wed timed conference is one bar; Tuesday–Thursday\'s hackathon takes lane 1, with a spacer in lane 0 on Thursday', () => {
    const oct = modelOf(STORE_0, '2026-10');
    assertJson(
      slotsOf(oct, ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']),
      {
        '2026-10-18': [],
        '2026-10-19': ['bar:conf*>', 'timed:recycle*'],
        '2026-10-20': ['bar:conf<>', 'bar:hack*>'],
        '2026-10-21': ['bar:conf<', 'bar:hack<>'],
        '2026-10-22': ['_', 'bar:hack<'],
      },
      'week of the 18th'
    );
    const thursday = cellOf(oct, '2026-10-22');
    assert(thursday.count === 1 && thursday.dots.length === 1, 'the spacer is not an item');
  });

  await check('an overnight 22:00–02:00 item is a one-day chip, inside the month and on its last day; a sleepover until 10:00 is a bar', () => {
    const oct = modelOf(STORE_0, '2026-10');
    assertJson(slotsOf(oct, ['2026-10-16', '2026-10-17', '2026-10-23', '2026-10-24', '2026-10-31']), {
      '2026-10-16': ['bar:sleepover*>~'],
      '2026-10-17': ['bar:sleepover<~'],
      '2026-10-23': ['timed:party*'],
      '2026-10-24': [],
      '2026-10-31': ['bar:weekend*>', 'bar:flight*>', 'timed:halloween*'],
    }, 'October');
    const nov = modelOf(STORE_0, '2026-11');
    assertJson(slotsOf(nov, ['2026-11-01', '2026-11-02']), { '2026-11-01': ['bar:weekend*<', 'bar:flight*<'], '2026-11-02': [] }, 'November');
    assert(!keysOn(STORE_0, '2026-11-01').includes('famcal|halloween'), 'the server lists the party\'s tail on 1 November');
  });

  await check('at the month\'s edges the span marks agree with the next month\'s own answer (Israel, and New York\'s DST end on 1 November)', () => {
    const edge = (store: CalendarStore, a: string, b: string) => {
      const last = `${a}-${pad(new Date(Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)), 0)).getUTCDate())}`;
      const first = `${b}-01`;
      const after = cellOf(modelOf(store, a), last).slots.filter((s) => s.kind !== 'spacer');
      const before = cellOf(modelOf(store, b), first).slots.filter((s) => s.kind !== 'spacer');
      for (const s of after) {
        const listed = keysOn(store, first).includes(s.key ?? '');
        assert(s.continuesAfter === listed, `${last} ${s.key}: continuesAfter ${s.continuesAfter}, listed on ${first}: ${listed}`);
      }
      for (const s of before) {
        const listed = keysOn(store, last).includes(s.key ?? '');
        assert(s.continuesBefore === listed, `${first} ${s.key}: continuesBefore ${s.continuesBefore}, listed on ${last}: ${listed}`);
      }
      return after.length + before.length;
    };
    assert(edge(STORE_0, '2026-09', '2026-10') === 4 && edge(STORE_0, '2026-10', '2026-11') === 5, 'the edge fixtures');
    const nyItems = [
      famcal('ny-short', 'Ends 05:30', utc('2026-10-31 22:00', NY), utc('2026-11-01 05:30', NY), { tz: NY }),
      famcal('ny-six', 'Ends 06:00', utc('2026-10-31 22:00', NY), utc('2026-11-01 06:00', NY), { tz: NY }),
      famcal('ny-late', 'Ends 06:30', utc('2026-10-31 22:00', NY), utc('2026-11-01 06:30', NY), { tz: NY }),
      famcal('ny-long', 'Two nights', utc('2026-10-31 20:00', NY), utc('2026-11-02 09:00', NY), { tz: NY }),
    ];
    const ny = storeOf(['2026-10', '2026-11'].map((m) => respond(answer(nyItems, { month: m, tz: NY }))));
    assert(edge(ny, '2026-10', '2026-11') === 6, 'the New York fixtures');
    assertJson(cellOf(modelOf(ny, '2026-10'), '2026-10-31').slots.map(show), ['bar:ny-long*>', 'bar:ny-late*>', 'timed:ny-short*', 'timed:ny-six*'], '31 October in New York');
  });

  await check('a month reads only its own days: October\'s model is the same with September and November loaded or not; inside it, the store decides', () => {
    const alone = storeOf([respond(answer(ITEMS, { month: '2026-10' }))]);
    assertJson(buildMonth(alone, '2026-10'), buildMonth(STORE_0, '2026-10'), 'October alone and with its neighbours');
    // With only the Agenda's week in, the 22nd hasn't answered: the hackathon stops at the 21st until it does.
    const week = storeOf([respond(answer(ITEMS, { window: { from: TODAY, to: '2026-10-22' } }))]);
    assertJson(slotsOf(modelOf(week, '2026-10'), ['2026-10-20', '2026-10-21', '2026-10-22']), {
      '2026-10-20': ['bar:conf<>', 'bar:hack*>'],
      '2026-10-21': ['bar:conf<', 'bar:hack<'],
      '2026-10-22': [],
    }, 'the Agenda\'s week only');
  });

  await check('daily reminders are left out of the slots, the dots and the counts (R11, Ruling 5) but are in dayRows; a weekly one is drawn', () => {
    const oct = modelOf(STORE_0, '2026-10');
    for (const d of OCTOBER) {
      const cell = cellOf(oct, d);
      assert(!cell.slots.some((s) => idOf(s.key) === 'vit'), `${d}: the daily reminder is drawn`);
      const rows = dayRows(STORE_0, d);
      assert(rows.filter((r) => idOf(r.item.key) === 'vit').length === 1, `${d}: dayRows lacks the daily reminder`);
      assert(rows.length === keysOn(STORE_0, d).length, `${d}: dayRows lists every item`);
      assert(cell.count === rows.filter((r) => !r.item.repeatsDaily).length, `${d}: count ${cell.count}`);
    }
    const saturday = cellOf(oct, '2026-10-03');
    assertJson([saturday.slots, saturday.dots, saturday.count, saturday.fromPartner], [[], [], 0, 0], 'a day with only the daily reminder');
    const rows = dayRows(STORE_0, '2026-10-14');
    assertJson(rows.map((r) => `${idOf(r.item.key)}:${r.whose.mine ? 'mine' : r.whose.person}:${r.mark ?? '-'}`), [
      'gym:mine:-', 'vit:mine:later', 'bill:mine:done', 'plumber:mine:later', 'flowers:Noa:later', 'pilates:Noa:-',
    ], 'the picked day\'s rows (the Agenda\'s, daily reminder included)');
    assert(cellOf(oct, '2026-10-12').slots.map(show).join() === 'timed:recycle*', 'the weekly reminder on Monday the 12th');
  });

  await check('fitSlots (Ruling 3; lines are the total drawn, "+N" included): 3 lines: 3 → 3, 4 → 2 + "+2"; 2 lines: 3 → 1 + "+2"; spacers never counted; past the lines the one-day items fill a bar\'s empty lanes, then the bars move up with their titles, so no spacer shows over "+N"; limitDots: 3, then "+N"', () => {
    const view = (r: { shown: MonthSlot[]; more: number }) => `${r.shown.map(show).join(' ')} +${r.more}`;
    assert(view(fitSlots(chips(3), 3)) === 'timed:c0* timed:c1* timed:c2* +0', '3 in 3');
    assert(view(fitSlots(chips(4), 3)) === 'timed:c0* timed:c1* +2', '4 in 3');
    assert(view(fitSlots(chips(3), 2)) === 'timed:c0* +2', '3 in 2');
    assert(view(fitSlots(chips(2), 2)) === 'timed:c0* timed:c1* +0', '2 in 2');
    assert(view(fitSlots([], 3)) === ' +0', 'none');
    const withSpacer = [slot('spacer', null), slot('bar', 'b'), ...chips(2)];
    assert(view(fitSlots(withSpacer, 3)) === 'timed:c0* bar:b* timed:c1* +0', `a spacer and 3 items in 3: the first one-day item in the spacer: ${view(fitSlots(withSpacer, 3))}`);
    assert(view(fitSlots(withSpacer, 2)) === 'bar:b* +2', `a spacer and 3 items in 2: ${view(fitSlots(withSpacer, 2))}`);
    const deep = [slot('spacer', null), slot('spacer', null), slot('bar', 'b')];
    assert(view(fitSlots(deep, 3)) === '_ _ bar:b* +0', 'a lane-2 bar fits in 3');
    assert(view(fitSlots(deep, 2)) === 'bar:b* +0', `a lane-2 bar in 2: moved up to lane 0: ${view(fitSlots(deep, 2))}`);
    const untitled = [slot('spacer', null), { ...slot('bar', 'b'), showTitle: false }];
    assert(view(fitSlots(untitled, 1)) === 'bar:b* +0', `a bar that moves up shows its title: ${view(fitSlots(untitled, 1))}`);
    assert(view(fitSlots([...chips(1), slot('spacer', null)], 3)) === 'timed:c0* +0', 'a trailing spacer goes');
    const hiddenSpacer = [slot('bar', 'b0'), slot('bar', 'b1'), slot('spacer', null), slot('bar', 'b3')];
    assert(view(fitSlots(hiddenSpacer, 3)) === 'bar:b0* bar:b1* bar:b3* +0', `three bars in four lanes, in 3: ${view(fitSlots(hiddenSpacer, 3))}`);
    const four = [slot('bar', 'b0'), slot('spacer', null), slot('bar', 'b2'), ...chips(2)];
    assert(view(fitSlots(four, 3)) === 'bar:b0* bar:b2* +2', `two bars and two items in 3: bars first: ${view(fitSlots(four, 3))}`);
    const oct = modelOf(STORE_0, '2026-10');
    assert(view(fitSlots(cellOf(oct, '2026-10-14').slots, 3)) === 'timed:gym* timed:bill*x +3', 'the 14th in 3');
    assert(view(fitSlots(cellOf(oct, '2026-10-26').slots, 3)) === 'bar:eilat<> timed:snorkel*~ timed:recycle* +0', 'the 26th in 3');
    assert(view(fitSlots(cellOf(oct, '2026-10-26').slots, 2)) === 'bar:eilat<> +2', 'the 26th in 2');
    assertJson(limitDots([true, false, true]), { shown: [true, false, true], more: 0 }, '3 dots');
    assertJson(limitDots([true, false, true, false, true]), { shown: [true, false, true], more: 2 }, '5 dots');
    assertJson(limitDots(cellOf(oct, '2026-10-14').dots.map((d) => d.mine)), { shown: [true, true, true], more: 2 }, 'the 14th\'s dots');
  });

  await check('fitRow (Ruling 3) on three overlapping bars, Alpha 5–7, Beta 6–8 and Gamma 7–9 October: in 2 lines the 9th shows Gamma with its title, not "+1" under an empty line, and a bar drawn out of its lane or after a day that hid it shows its title; in 3 lines the three keep their lanes; over every row of the fixtures, in 1, 2, 3, 4 and 7 lines, no spacer over "+N", no "+N" while the items fit, no item lost and no bar drawn nameless', () => {
    const abg = storeOf([
      respond(answer([famcal('alpha', 'Alpha', '2026-10-05', '2026-10-08'), famcal('beta', 'Beta', '2026-10-06', '2026-10-09'), famcal('gamma', 'Gamma', '2026-10-07', '2026-10-10')], { month: '2026-10' })),
    ]);
    const row = modelOf(abg, '2026-10').weeks.find((w) => w.some((c) => c.day === '2026-10-05'));
    assert(row !== undefined, 'no row for 5 October');
    const view = (r: { shown: MonthSlot[]; more: number }) => `${r.shown.map(show).join(' ')}${r.more ? ` +${r.more}` : ''}`;
    const days = (limited: { shown: MonthSlot[]; more: number }[]) =>
      Object.fromEntries(row.map((c, i) => [c.day.slice(8), view(limited[i])] as const).filter(([d]) => ['05', '06', '07', '08', '09'].includes(d)));
    assertJson(days(fitRow(row, 2)), { '05': 'bar:alpha*>', '06': 'bar:alpha<> bar:beta*>', '07': 'bar:alpha< +2', '08': 'bar:beta*< bar:gamma*<>', '09': 'bar:gamma*<' }, 'in 2 lines');
    assertJson(days(fitRow(row, 3)), { '05': 'bar:alpha*>', '06': 'bar:alpha<> bar:beta*>', '07': 'bar:alpha< bar:beta<> bar:gamma*>', '08': '_ bar:beta< bar:gamma<>', '09': '_ _ bar:gamma<' }, 'in 3 lines');
    // A bar hidden behind "+N" one day and back in its own lane the next shows its title there.
    const cellWith = (day: DayKey, slots: MonthSlot[]): MonthCell => ({ day, inMonth: true, today: false, status: 'answered', slots, dots: [], count: 0, fromPartner: 0, hebrewMonthStart: false });
    const mid = (id: string) => ({ ...slot('bar', id), showTitle: false, continuesBefore: true, continuesAfter: true });
    const hidden = fitRow([cellWith('2026-10-05', [slot('bar', 'a'), slot('bar', 'b'), slot('bar', 'c'), slot('timed', 't')]), cellWith('2026-10-06', [slot('spacer', null), slot('spacer', null), mid('c')])], 3);
    assertJson(hidden.map(view), ['bar:a* bar:b* +2', '_ _ bar:c*<>'], 'C, hidden on the 5th, named on the 6th');
    const moved = fitRow([cellWith('2026-10-05', [slot('spacer', null), mid('b'), mid('c'), slot('timed', 't1'), slot('timed', 't2')]), cellWith('2026-10-06', [slot('spacer', null), slot('spacer', null), mid('c')])], 3);
    assertJson(moved.map(view), ['bar:b*<> bar:c*<> +2', '_ _ bar:c*<>'], 'C, moved up on the 5th, back in its lane on the 6th: named again');
    let rows = 0;
    const stores: [CalendarStore, string[]][] = [[STORE_0, AUTUMN], [STORE_1, AUTUMN], [abg, ['2026-10']]];
    for (const [store, months] of stores) {
      for (const m of months) {
        for (const week of modelOf(store, m).weeks) {
          for (const max of [1, 2, 3, 4, 7]) {
            rows++;
            const limited = fitRow(week, max);
            week.forEach((cell, i) => {
              const { shown, more } = limited[i];
              const real = cell.slots.filter((s) => s.kind !== 'spacer');
              const where = `${cell.day} at ${max}`;
              if (more > 0) assert(shown.every((s) => s.kind !== 'spacer') && shown.length === max - 1, `${where}: ${shown.map(show).join(' ')} +${more}`);
              assert(more === 0 || real.length > max, `${where}: "+${more}" while its ${real.length} items fit`);
              assert(shown.filter((s) => s.kind !== 'spacer').length + more === real.length, `${where}: an item lost`);
              shown.forEach((s, k) => {
                if (s.kind === 'bar' && !s.showTitle) assert(limited[i - 1]?.shown[k]?.key === s.key, `${where}: ${s.key} has no title, and the day before didn't draw it there`);
              });
            });
          }
        }
      }
    }
    assert(rows >= 75, `only ${rows} rows checked`);
  });

  await check('a month\'s cells: its week rows from the week start, blank outside it (R12), today, and each day\'s status', () => {
    const oct = modelOf(STORE_0, '2026-10');
    assertJson(oct.weeks.map((w) => w.map((c) => c.day)), monthGrid('2026-10', 0), 'the rows');
    for (const c of oct.weeks.flat()) {
      assert(c.inMonth === c.day.startsWith('2026-10-'), `${c.day} inMonth`);
      if (!c.inMonth) assertJson([c.today, c.status, c.slots, c.dots, c.count, c.hebrewMonthStart], [false, 'answered', [], [], 0, false], `${c.day} blank`);
      else assert(c.status === dayStatus(STORE_0, c.day), `${c.day} status`);
    }
    assertJson(oct.weeks.flat().filter((c) => c.today).map((c) => c.day), [TODAY], 'today');
    assert(modelOf(STORE_1, '2026-10').weeks[0][0].day === '2026-09-28', 'week start 1 starts on Monday');
    const first = storeOf(['2026-09', '2026-10'].map((m) => respond(answer(ITEMS, { month: m, today: '2026-10-01' }))));
    const blank = modelOf(first, '2026-09').weeks[4].find((c) => c.day === '2026-10-01');
    assert(blank !== undefined && !blank.inMonth && !blank.today, 'today in another month\'s row is a blank, not today');
    assert(cellOf(modelOf(first, '2026-10'), '2026-10-01').today, 'and today in its own month');
  });

  await check('a month\'s status: loading while any day is, answered once every day is, failed otherwise', () => {
    const week = storeOf([respond(answer(ITEMS, { window: { from: TODAY, to: '2026-10-22' } }))]);
    const loading = modelOf(week, '2026-10');
    assert(loading.status === 'loading', `with the Agenda's week only: ${loading.status}`);
    assert(cellOf(loading, '2026-10-15').status === 'answered' && cellOf(loading, '2026-10-14').status === 'loading', 'the cells');
    assertJson(loading.notices, [], 'no notice while loading');
    assert(modelOf(STORE_0, '2026-10').status === 'answered', 'answered');
    const weekFailed = storeOf([respond(answer([], { window: { from: TODAY, to: '2026-10-22' }, famcal: { status: 'error' } }))]);
    const partly = modelOf(weekFailed, '2026-10');
    assert(partly.status === 'loading', `the week failed, the rest not asked yet: ${partly.status}`);
    assertJson(partly.notices, [{ source: 'famcal', kind: 'failed', failure: { kind: 'error', source: 'famcal', reason: null } }], 'its failure already shows');
    const failed = storeOf([respond(answer(ITEMS, { window: { from: TODAY, to: '2026-10-22' } })), respond(answer([], { month: '2026-10', famcal: { status: 'error' } }))]);
    const model = modelOf(failed, '2026-10');
    assert(model.status === 'failed', `an error on the month after the week's ok: ${model.status}`);
    assert(cellOf(model, '2026-10-15').status === 'answered' && cellOf(model, '2026-10-01').status === 'failed', 'the week keeps its data');
  });

  await check('notices: failed with the earliest failing day\'s reason (not the latest failure), busy, error and calendars gone; FamCal\'s error; reconnect none; partial', () => {
    const gWeek = (window: { from: DayKey; to: DayKey }, g: GoogleStatus) => respond(answer([], { window, google: g }));
    // October: busy from the 1st, calendars gone from the 25th; the latest failure is November's error.
    const mixed = storeOf([
      gWeek({ from: TODAY, to: '2026-10-22' }, { status: 'error', reason: 'transient' }),
      { type: 'windowFailed', from: '2026-10-01', to: '2026-11-01', sources: ['google'], kind: 'busy', epoch: 0 },
      gWeek({ from: '2026-10-25', to: '2026-11-01' }, { status: 'error', reason: 'calendars_gone' }),
      { type: 'windowFailed', from: '2026-11-01', to: '2026-12-01', sources: ['google'], kind: 'error', epoch: 0 },
    ]);
    assert(mixed.lastFailure.google?.kind === 'error', 'the latest failure is November\'s error');
    assertJson(modelOf(mixed, '2026-10').notices, [{ source: 'google', kind: 'failed', failure: { kind: 'busy', source: 'google' } }], 'October (busy from the 1st)');
    assertJson(modelOf(mixed, '2026-11').notices, [{ source: 'google', kind: 'failed', failure: { kind: 'error', source: 'google', reason: null } }], 'November');
    const gone = storeOf([gWeek(windowOf('2026-10'), { status: 'error', reason: 'calendars_gone' })]);
    assertJson(modelOf(gone, '2026-10').notices, [{ source: 'google', kind: 'failed', failure: { kind: 'calendarsGone', source: 'google' } }], 'calendars gone');
    const famcalError = storeOf([respond(answer([], { month: '2026-10', famcal: { status: 'error' } }))]);
    assertJson(modelOf(famcalError, '2026-10').notices, [{ source: 'famcal', kind: 'failed', failure: { kind: 'error', source: 'famcal', reason: null } }], 'FamCal');
    const reconnect = storeOf([gWeek(windowOf('2026-10'), { status: 'reconnect', reason: 'token' })]);
    const rModel = modelOf(reconnect, '2026-10');
    assert(rModel.status === 'failed' && homeNotices(reconnect).reconnect === 'token', 'failed, with the Reconnect banner');
    assertJson(rModel.notices, [], 'no notice for a reconnect');
    const partial = storeOf([respond(answer([google('lunch', 'Lunch', '2026-10-15T12:00:00+03:00', '2026-10-15T13:00:00+03:00')], { month: '2026-10', google: { status: 'ok', partial: { failed: 1, truncated: 0 } } }))]);
    const pModel = modelOf(partial, '2026-10');
    assert(pModel.status === 'answered', `partial is answered: ${pModel.status}`);
    assertJson(pModel.notices, [{ source: 'google', kind: 'partial', failure: null }], 'partial');
    assertJson(cellOf(pModel, '2026-10-15').slots.map((s) => `${s.kind}:${s.title}`), ['timed:Lunch'], 'a Google chip');
    // Two Google events without an id share a key; on consecutive days they are still two one-day chips.
    const noId = storeOf([respond(answer([google('', 'Swim', '2026-10-20T07:00:00+03:00', '2026-10-20T08:00:00+03:00'), google('', 'Swim', '2026-10-21T07:00:00+03:00', '2026-10-21T08:00:00+03:00')], { month: '2026-10', google: { status: 'ok' } }))]);
    assertJson(slotsOf(modelOf(noId, '2026-10'), ['2026-10-20', '2026-10-21']), { '2026-10-20': ['timed:google|family@group.calendar.google.com|*'], '2026-10-21': ['timed:google|family@group.calendar.google.com|*'] }, 'id-less events');
    assertJson(modelOf(STORE_0, '2026-10').notices, [], 'all answered');
  });

  await check('hebrewMonthStart on Hebrew day 1 and on the month\'s first cell: October 2026, and July 2030 (three Hebrew months)', () => {
    const starts = (m: MonthModel) => m.weeks.flat().filter((c) => c.hebrewMonthStart).map((c) => c.day);
    assertJson(starts(modelOf(STORE_0, '2026-10')), ['2026-10-01', '2026-10-12'], 'October 2026 (1 Cheshvan is the 12th)');
    assertJson(starts(modelOf(STORE_0, '2026-11')), ['2026-11-01', '2026-11-11'], 'November 2026 (1 Kislev is the 11th)');
    assertJson(starts(modelOf(STORE_0, '2030-07')), ['2030-07-01', '2030-07-02', '2030-07-31'], 'July 2030 (1 Tamuz and 1 Av)');
  });

  await check('canStepMonth at both ends of the reach (1900-01 … 2100-12, owner 2026-11-17), not of today\'s span; clampFocus after a day change (forward and back) keeps the month and the selected day inside the reach, today\'s included', () => {
    assert(canStepMonth('2025-10', -1, TODAY) && canStepMonth('2028-04', 1, TODAY) && canStepMonth('2018-07', -1, TODAY), 'past today\'s span');
    assert(!canStepMonth('1900-01', -1, TODAY) && canStepMonth('1900-01', 1, TODAY), 'the first month');
    assert(canStepMonth('2100-12', -1, TODAY) && !canStepMonth('2100-12', 1, TODAY), 'the last month');
    assert(!canStepMonth('bad', 1, TODAY) && !canStepMonth('1900-01', 1, 'bad'), 'a bad month or today');
    // Midnight to 1 November: the focus stays wherever it is inside the reach.
    const NEXT = '2026-11-01';
    const old = focus('2025-10', '2025-10-07');
    assert(clampFocus(old, NEXT) === old, 'a month before today\'s span stays');
    assertJson(clampFocus(focus('1899-12', '1899-12-07'), NEXT), focus('1900-01', NEXT), 'off the reach\'s start: the first month, and today for a day outside the reach');
    assertJson(clampFocus(focus('2101-01', '2026-10-20'), NEXT), focus('2100-12', '2026-10-20'), 'off the reach\'s end: the last month, the day kept');
    const yesterday = focus('2026-10', TODAY);
    assert(clampFocus(yesterday, NEXT) === yesterday, 'the selected day stays, though it was today');
    const later = focus('2028-04', '2028-04-09');
    assert(clampFocus(later, '2026-09-30') === later, 'today moved back: a month after today\'s span stays');
    assertJson(clampFocus(focus('bad', 'bad'), NEXT), focus('2026-11', NEXT), 'a bad focus: today');
  });

  await check('wantedFocusMonths (Ruling 7, Ruling 2): the month in view first (else the focus month), the selected day\'s month next, then the months near it nearest first, the later on a tie, its two neighbours always (the pane reports in view ±1); in the reach only, each once', () => {
    const windows = (w: { from: string; to: string }[]) => w.map((x) => `${x.from}..${x.to}`);
    const oct = focus('2026-10', TODAY);
    assertJson(windows(wantedFocusMonths(oct, [], null, TODAY)), ['2026-10-01..2026-11-01', '2026-11-01..2026-12-01', '2026-09-01..2026-10-01'], 'a month\'s own days');
    const short = (w: { from: string }[]) => w.map((x) => x.from.slice(0, 7));
    assertJson(short(wantedFocusMonths(oct, ['2026-09', '2026-10', '2026-11', '2026-12'], '2026-10', TODAY)), ['2026-10', '2026-11', '2026-09', '2026-12'], 'near, nearest first');
    assertJson(short(wantedFocusMonths(focus('2026-12', '2026-12-01'), ['2027-01', '2027-02'], '2026-12', TODAY)), ['2026-12', '2027-01', '2026-11', '2027-02'], 'the month in view comes first, with its neighbours');
    assertJson(short(wantedFocusMonths(oct, ['2026-11', '2026-12', '2027-01'], '2026-12', TODAY)), ['2026-12', '2026-10', '2027-01', '2026-11'], 'the selected day\'s month second, however far the pane is');
    assertJson(short(wantedFocusMonths(focus('2028-04', '2028-04-01'), [], null, TODAY)), ['2028-04', '2028-05', '2028-03'], 'past today\'s span');
    assertJson(short(wantedFocusMonths(focus('2100-12', '2100-12-01'), [], null, TODAY)), ['2100-12', '2100-11'], 'at the reach\'s last month');
    assertJson(short(wantedFocusMonths(focus('1900-01', '1900-01-01'), ['1899-12', '1900-01', '1900-02'], '1900-01', TODAY)), ['1900-01', '1900-02'], 'outside the reach dropped');
    assertJson(short(wantedFocusMonths(oct, ['2026-12', '2026-11'], null, TODAY)), ['2026-10', '2026-11', '2026-09', '2026-12'], 'near months by distance from the focus month, with it and its neighbours');
    assertJson(short(wantedFocusMonths(oct, ['2026-11', 'bad', '2026-11'], null, TODAY)), ['2026-10', '2026-11', '2026-09'], 'junk and repeats dropped');
    assertJson(wantedFocusMonths(oct, [], null, 'bad'), [], 'a bad today');
  });

  await check('the bar\'s height (the split\'s chrome) and the dots a small square shows', () => {
    assertJson([monthBarPx(false), monthBarPx(true), PICKED_DOTS], [72, 76, 3], 'the bar with its weekday row, without and with the Hebrew line; 3 dots');
  });

  await check('monthModels: one function per store, one model per month; a new store builds afresh and the old one keeps its own', () => {
    const get = monthModels(STORE_0);
    assert(monthModels(STORE_0) === get, 'the same function for the same store');
    const oct = get('2026-10');
    assert(oct !== null && get('2026-10') === oct, 'the same model');
    assertJson(oct, buildMonth(STORE_0, '2026-10'), 'the memo holds buildMonth\'s model');
    assert(buildMonth(STORE_0, '2026-10') !== oct, 'buildMonth itself builds a new one');
    const next = reduceStore(STORE_0, respond(answer(ITEMS, { month: '2026-12' })));
    assert(next !== STORE_0 && monthModels(next) !== get, 'a new store, a new function');
    assert(monthModels(next)('2026-10') !== oct && get('2026-10') === oct, 'built afresh; the old store keeps its own');
    const none = monthModels(emptyStore());
    assert(none('2026-10') === null && none('2026-10') === null, 'null before facts');
  });

  await check('loadingMonth: 4/5/6-row months at either week start: own days loading (today only in the month), the rest answered and blank, the 1st marked', () => {
    // Feb 2027 is 4 rows from Monday, Oct 2026 is 5 from Sunday, Aug 2026 is 6 from Sunday.
    for (const [month, ws, rows] of [['2027-02', 1, 4], ['2026-10', 0, 5], ['2026-08', 0, 6]] as const) {
      const m = loadingMonth(month, ws, `${month}-02`);
      assert(m.month === month && m.status === 'loading' && m.notices.length === 0 && m.partner === null, `${month}: ${JSON.stringify([m.status, m.notices, m.partner])}`);
      assert(m.weeks.length === rows && m.weeks.every((w) => w.length === 7), `${month}/${ws}: ${m.weeks.length} rows`);
      for (const c of m.weeks.flat()) {
        const inMonth = c.day.startsWith(month);
        assert(c.inMonth === inMonth && c.status === (inMonth ? 'loading' : 'answered'), `${c.day}: ${c.status}`);
        assert(c.today === (c.day === `${month}-02`) && c.count === 0 && c.fromPartner === 0 && c.slots.length === 0 && c.dots.length === 0, `${c.day}: today/count`);
        if (c.day === `${month}-01`) assert(c.hebrewMonthStart, `${c.day}: the 1st is a month start`);
        if (!inMonth) assert(!c.hebrewMonthStart && !c.today, `${c.day}: outside`);
      }
    }
    // Today in another month flags no cell.
    assert(loadingMonth('2026-10', 0, '2026-11-02').weeks.flat().every((c) => !c.today), 'today outside the month');
  });

  await check('null before the first answer and for a malformed month', () => {
    assert(buildMonth(emptyStore(), '2026-10') === null, 'no facts');
    assert(buildMonth(STORE_0, '2026-13') === null && buildMonth(STORE_0, '') === null && buildMonth(STORE_0, '2026-1') === null, 'malformed');
  });

  await check('the same models, windows, focus and fitted rows on five device clocks', () => {
    const snapshot = () =>
      JSON.stringify([
        AUTUMN.map((m) => buildMonth(STORE_0, m)),
        buildMonth(STORE_1, '2026-10'),
        wantedFocusMonths(initialFocus(TODAY) as MonthFocus, ['2026-09', '2026-11'], '2026-10', TODAY),
        clampFocus(focus('2101-01', '2026-09-20'), TODAY),
        fitRow(modelOf(STORE_0, '2026-10').weeks[2], 2),
      ]);
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const reference = snapshot();
      for (const tz of ['Asia/Jerusalem', 'Pacific/Kiritimati', 'America/Santiago', 'America/Los_Angeles']) {
        process.env.TZ = tz;
        assert(snapshot() === reference, `the output differs with the clock in ${tz}`);
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  await check('month.ts is client-safe and pure: it loads only src/lib/calendar-view and @hebcal/hdate, reads no clock, and its 06:00 is daySpanOf\'s', () => {
    const view = path.resolve(__dirname, '..', 'src', 'lib', 'calendar-view');
    const root = path.join(view, 'month.ts');
    const loaded = new Set<string>();
    const walk = (id: string) => {
      for (const child of require.cache[id]?.children ?? []) {
        if (loaded.has(child.id)) continue;
        loaded.add(child.id);
        walk(child.id);
      }
    };
    assert(require.cache[root] !== undefined, `${root} is not in require.cache: the check would be empty`);
    walk(root);
    assert(loaded.has(path.join(view, 'store.ts')) && loaded.has(path.join(view, 'grid.ts')), 'the walk found no calendar-view module: the check would be empty');
    const outside = [...loaded].filter((p) => !p.startsWith(view + path.sep) && !/[\\/]node_modules[\\/]@hebcal[\\/](hdate|locales)[\\/]/.test(p));
    assertJson(outside, [], 'modules outside src/lib/calendar-view and @hebcal/hdate');
    assert(!loaded.has(path.join(view, 'home-client.ts')), 'home-client.ts is loaded: RangeWindow must be a type-only import');
    const code = fs.readFileSync(root, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const banned of [/new Date\(/, /Date\.now/, /\bwindow\./, /\bdocument\./, /localStorage|sessionStorage/, /@hebcal\/core/, /fetch\(/]) {
      assert(!banned.test(code), `month.ts uses ${banned}`);
    }
    assert(code.includes(`const OVERNIGHT_CUTOFF = '${pad(OVERNIGHT_CUTOFF_HOUR)}:00';`), `month.ts's cutoff is not daySpanOf's ${OVERNIGHT_CUTOFF_HOUR}:00`);
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

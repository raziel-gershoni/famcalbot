// The Month's model (spec §7.4, §5's month windows, Rulings R11 and R12; Plan E
// Rulings 3–7; responsive home release 2): what the Month draws, worked out from the
// client store. Pure and client-safe: it imports the store, the Agenda's whose and
// reminder rules, the grid, the day format, the Hebrew day-1 test, the RangeWindow type
// and month-layout's line limit, and nothing else. The views (MonthPane, MonthSquares,
// DayPanel) format dates and copy and size the squares; this file decides each cell's
// chips and bars, its dots and counts, each month's status and notices (and the selected
// day's, with the words both say), the bar's height,
// the focus (the month sought and the selected day), the reach's ends and which months
// to fetch, and fits a square's lines.
//
// - A month draws its own days; the days of its rows outside it are blank (R12).
// - A cell's slots: the bars first, by lane, then its one-day items (all-day before
//   timed, as compareItems orders them). Whose an item is follows the Agenda's rule
//   (filled for the viewer's, outlined for the partner's); a done reminder is struck through.
// - Daily-repeating reminders are left out of the slots, the dots and the counts
//   (R11, Ruling 5); the picked day's list (dayRows) still has them.
// - A bar is an item drawn across days: an all-day item over its dates, or a timed
//   one that the store lists on the next or the day before. At the month's edges the
//   neighbouring day is another month's, so its span marks decide, with daySpanOf's
//   06:00 rule: last night's tail ending by 06:00 is not listed on the next day, so an
//   overnight 22:00–02:00 item is a one-day chip, on the month's last day too.
// - Lanes are per week row, lane 0 being the top slot. Bars take the lowest free lane in
//   this order: the day the bar starts in the row, all-day before timed, the earlier
//   start, the longer, then key. A day with a bar in lane n and nothing in a lane above
//   it keeps a spacer there, so the bar stays in line across its days. A bar's title
//   shows on the first day it is drawn in each row: where it starts, at day 1 when it
//   continues from the month before, and at each week row's start.
// - A day with more than fits (Ruling 3) first lets its one-day items into the empty
//   lanes above a bar; if that is still too many, the spacers go and the bars move up,
//   each with its title, then "+N". So a cell never shows an empty line over "+N", and a
//   bar that is drawn out of its lane, or after a day that hid it, says what it is
//   (fitRow, per week row).
// - Nothing here throws: a malformed month gives null, and a malformed day leaves the
//   layout as it is.

import { reminderMark, whoseItem, type AgendaRow } from './agenda';
import { allDayLastDay, formatTime, instantDay } from './format';
import {
  addMonths,
  monthFirstDay,
  monthGrid,
  monthLastDay,
  monthOf,
  monthWindow,
  type MonthKey,
} from './grid';
import { isHebrewMonthStart } from './hebrew-date';
import type { RangeWindow } from './home-client';
import {
  addDaysToKey,
  dayFailure,
  dayItems,
  dayStatus,
  failedSources,
  isPartialDay,
  type CalendarStore,
  type DayStatus,
  type SourceFailure,
} from './store';
import type { DayKey, ItemDTO, SourceName, WeekStart } from './types';
import { SQUARE_MAX_LINES } from './month-layout';
import { MONTH_REACH } from './year-limits';

/** Dots a small square shows, then "+N". */
export const PICKED_DOTS = 3;

/** The month bar's row: it holds the 44 px chevrons, title and Today, with 2 px either side. */
const BAR_ROW_PX = 48;
/** The bar's row with the Hebrew months' line under the title: 22 + 16 px of text, 7 px either side. */
const BAR_ROW_HEBREW_PX = 52;
/** The weekday row under the bar, its bottom border included. */
const WEEKDAY_ROW_PX = 24;

/** The pane's month bar with its weekday row (the split's chrome). The pane sets this height exactly. */
export function monthBarPx(hebrewDates: boolean): number {
  return (hebrewDates ? BAR_ROW_HEBREW_PX : BAR_ROW_PX) + WEEKDAY_ROW_PX;
}

export type SlotKind = 'bar' | 'allDay' | 'timed' | 'spacer';

export interface MonthSlot {
  kind: SlotKind;
  /** The item's key; null for a spacer (it keeps a bar's lane in line). */
  key: string | null;
  /** The item's title (null when it has none); null for a spacer. */
  title: string | null;
  /** One-day items always; a bar on the first day it is drawn in its week row. */
  showTitle: boolean;
  /** Filled (the viewer's) or outlined (the partner's), by whoseItem. */
  mine: boolean;
  /** The item's calendar colour (spec 2026-10-19 §3.3); null for a spacer, a masked calendar or none. */
  color: string | null;
  /** The Hebrew anniversary count (>= 1) shown as a pill after the title; null for none and for a spacer. */
  count: number | null;
  /** A done reminder: struck through. */
  done: boolean;
  /** A bar that goes on from the day before / to the day after (flat edges). */
  continuesBefore: boolean;
  continuesAfter: boolean;
  /** The item's ItemDTO.canEdit and repeatsEveryDay: whether the chip lifts to be dragged (drag-model's liftVerdict). */
  canEdit: boolean;
  repeatsEveryDay: boolean;
}

export interface MonthCell {
  day: DayKey;
  /**
   * false: a day of another month in this month's rows, drawn blank and aria-hidden
   * (R12). A blank cell carries nothing: today false, status 'answered', no slots.
   */
  inMonth: boolean;
  today: boolean;
  status: DayStatus;
  /** Every slot, bars by lane first; a large square fits them to its lines (fitRow). Empty on a blank cell. */
  slots: MonthSlot[];
  /** A small square's dots: each drawn item's, in slot order, spacers left out. */
  dots: MonthDot[];
  /** Drawn items (Ruling 5: daily reminders not counted), and how many of them aren't the viewer's. */
  count: number;
  fromPartner: number;
  /** Hebrew day 1, or the month's first day: the cells that name the Hebrew month (Ruling 3). */
  hebrewMonthStart: boolean;
}

/** One of a small square's dots: filled (the viewer's) or a ring (the partner's), in the calendar's colour. */
export interface MonthDot {
  mine: boolean;
  color: string | null;
}

/**
 * A pill over the grid (Ruling 4), and a row of the selected day's list when that day failed
 * (dayNotices). A reconnect never makes one: the Reconnect banner says it.
 */
export interface MonthNotice {
  source: SourceName;
  kind: 'failed' | 'partial';
  /** failed: the earliest failing day's failure (busy, calendars gone or an error); partial: null. */
  failure: SourceFailure | null;
}

export interface MonthModel {
  month: MonthKey;
  /** The month's week rows from the week start (4–6), seven cells each. */
  weeks: MonthCell[][];
  /** answered once every day of the month is; loading while any day is; failed otherwise. */
  status: DayStatus;
  /** At most one failed and one partial notice per source, FamCal first. */
  notices: MonthNotice[];
  /** The partner's name, for the cells' "N from <partner>". */
  partner: string | null;
}

/**
 * The 06:00 rule's hour as a wall time, as daySpanOf's OVERNIGHT_CUTOFF_HOUR
 * (src/utils/day-events.ts): a tail ending at or before it on the next day belongs to
 * last night. A server module, so it is restated here, and the smoke checks the two agree.
 */
const OVERNIGHT_CUTOFF = '06:00';

const SPACER: MonthSlot = Object.freeze({
  kind: 'spacer',
  key: null,
  title: null,
  showTitle: false,
  mine: false,
  color: null,
  count: null,
  done: false,
  continuesBefore: false,
  continuesAfter: false,
  canEdit: false,
  repeatsEveryDay: false,
}) as MonthSlot;

/** An item as one cell draws it: whose and done, and whether it goes on before and after the day. */
interface Drawn {
  item: ItemDTO;
  mine: boolean;
  done: boolean;
  before: boolean;
  after: boolean;
}

/** A bar's days in one week row: from column `first` to `last`, in lane `lane`. */
interface Run {
  key: string;
  item: ItemDTO;
  first: number;
  last: number;
  lane: number;
  cells: Map<number, Drawn>;
}

/** The same occurrence on `day`: its key, and its start (a key alone could repeat if an id is missing). */
function listedOn(store: CalendarStore, item: ItemDTO, day: DayKey): boolean {
  return dayItems(store, day).some((other) => other.key === item.key && other.start === item.start);
}

/**
 * Whether a timed item listed on `day` with an endsLater or spansDay mark is listed on
 * the next day too: it is unless it ends there by 06:00 (daySpanOf's overnight rule).
 */
function goesOnNextDay(item: ItemDTO, day: DayKey, tz: string): boolean {
  if (item.span !== 'endsLater' && item.span !== 'spansDay') return false;
  const next = addDaysToKey(day, 1);
  const endDay = instantDay(item.end, tz);
  if (endDay === null) return false;
  if (endDay !== next) return endDay > next;
  return formatTime(item.end, tz, 'en') > OVERNIGHT_CUTOFF;
}

function drawnOn(store: CalendarStore, day: DayKey, first: DayKey, last: DayKey, tz: string, partner: string | null): Drawn[] {
  const out: Drawn[] = [];
  for (const item of dayItems(store, day)) {
    if (item.repeatsDaily) continue;
    let before: boolean;
    let after: boolean;
    if (item.allDay) {
      before = item.start < day;
      after = allDayLastDay(item) > day;
    } else {
      before = day === first ? item.span === 'continues' || item.span === 'spansDay' : listedOn(store, item, addDaysToKey(day, -1));
      after = day === last ? goesOnNextDay(item, day, tz) : listedOn(store, item, addDaysToKey(day, 1));
    }
    out.push({ item, mine: whoseItem(item, partner).mine, done: reminderMark(item) === 'done', before, after });
  }
  return out;
}

const isBar = (d: Drawn) => d.before || d.after;

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** An item's start or end to sort by; an all-day 'yyyy-MM-dd' reads as UTC midnight, as compareItems does. */
function sortInstant(value: string): number {
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * The order bars take their lanes in a week row: the day it starts being drawn in the
 * row, then all-day before timed, the earlier start (so a bar that came from an earlier
 * row keeps its place above one that starts on the row's first day), the longer, the key.
 */
function compareRuns(a: Run, b: Run): number {
  if (a.first !== b.first) return a.first - b.first;
  if (a.item.allDay !== b.item.allDay) return a.item.allDay ? -1 : 1;
  const start = sortInstant(a.item.start) - sortInstant(b.item.start);
  if (start !== 0) return start;
  const end = sortInstant(b.item.end) - sortInstant(a.item.end);
  if (end !== 0) return end;
  return compareKeys(a.key, b.key);
}

/** The bars of one week row, each in its lane (the lowest free one, in compareRuns order). */
function rowRuns(cols: readonly (Drawn[] | null)[]): Run[] {
  const runs: Run[] = [];
  const open = new Map<string, Run>();
  cols.forEach((drawn, col) => {
    for (const d of drawn ?? []) {
      if (!isBar(d)) continue;
      const run = open.get(d.item.key);
      if (run && run.last === col - 1) {
        run.last = col;
        run.cells.set(col, d);
      } else {
        const fresh: Run = { key: d.item.key, item: d.item, first: col, last: col, lane: 0, cells: new Map([[col, d]]) };
        runs.push(fresh);
        open.set(d.item.key, fresh);
      }
    }
  });
  runs.sort(compareRuns);
  const used: boolean[][] = [];
  for (const run of runs) {
    let lane = 0;
    const busy = (l: number) => {
      for (let c = run.first; c <= run.last; c++) if (used[l]?.[c]) return true;
      return false;
    };
    while (busy(lane)) lane++;
    run.lane = lane;
    used[lane] ??= [];
    for (let c = run.first; c <= run.last; c++) used[lane][c] = true;
  }
  return runs;
}

function slotOf(d: Drawn, kind: SlotKind, showTitle: boolean): MonthSlot {
  const bar = kind === 'bar';
  return {
    kind,
    key: d.item.key,
    title: d.item.title,
    showTitle,
    mine: d.mine,
    color: d.item.calendar.color,
    count: d.item.anniversary ?? null,
    done: d.done,
    continuesBefore: bar && d.before,
    continuesAfter: bar && d.after,
    canEdit: d.item.canEdit,
    repeatsEveryDay: d.item.repeatsEveryDay,
  };
}

function blankCell(day: DayKey): MonthCell {
  return { day, inMonth: false, today: false, status: 'answered', slots: [], dots: [], count: 0, fromPartner: 0, hebrewMonthStart: false };
}

/** A month with no model yet: its own days loading, the rest blank (R12). */
export function loadingMonth(month: MonthKey, weekStart: WeekStart, today: DayKey): MonthModel {
  const first = monthFirstDay(month);
  const weeks = monthGrid(month, weekStart).map((row) =>
    row.map((day): MonthCell => {
      const inMonth = monthOf(day) === month;
      return {
        ...blankCell(day),
        inMonth,
        today: inMonth && day === today,
        status: inMonth ? 'loading' : 'answered',
        hebrewMonthStart: inMonth && (day === first || isHebrewMonthStart(day)),
      };
    }),
  );
  return { month, weeks, status: 'loading', notices: [], partner: null };
}

function buildRow(store: CalendarStore, row: readonly DayKey[], month: MonthKey, first: DayKey, last: DayKey, today: DayKey, tz: string, partner: string | null): MonthCell[] {
  const cols = row.map((day) => (monthOf(day) === month ? drawnOn(store, day, first, last, tz, partner) : null));
  const runs = rowRuns(cols);
  return row.map((day, col) => {
    const drawn = cols[col];
    if (drawn === null) return blankCell(day);
    // Lanes 0 … the day's deepest bar: a spacer where no bar of the day is.
    const lanes: MonthSlot[] = [];
    for (const run of runs) {
      const d = run.cells.get(col);
      if (!d) continue;
      while (lanes.length <= run.lane) lanes.push(SPACER);
      lanes[run.lane] = slotOf(d, 'bar', col === run.first);
    }
    const singles = drawn.filter((d) => !isBar(d)).map((d) => slotOf(d, d.item.allDay ? 'allDay' : 'timed', true));
    const slots = [...lanes, ...singles];
    const dots = slots.filter((s) => s.kind !== 'spacer').map((s): MonthDot => ({ mine: s.mine, color: s.color }));
    return {
      day,
      inMonth: true,
      today: day === today,
      status: dayStatus(store, day),
      slots,
      dots,
      count: dots.length,
      fromPartner: dots.filter((dot) => !dot.mine).length,
      hebrewMonthStart: day === first || isHebrewMonthStart(day),
    };
  });
}

/**
 * The Month for `month` ('yyyy-MM'): its week rows from the week start, every cell's
 * slots, dots and counts, the month's status and its notices. null before the first
 * answer pins the facts, and for a malformed month.
 */
export function buildMonth(store: CalendarStore, month: MonthKey): MonthModel | null {
  const facts = store.facts;
  if (!facts) return null;
  const rows = monthGrid(month, facts.weekStart);
  if (rows.length === 0) return null;
  const first = monthFirstDay(month);
  const last = monthLastDay(month);
  const partner = store.partner?.name ?? null;
  const weeks = rows.map((row) => buildRow(store, row, month, first, last, facts.today, facts.tz, partner));

  const days = weeks.flat().filter((cell) => cell.inMonth);
  const statuses = days.map((cell) => cell.status);
  const status: DayStatus = statuses.every((s) => s === 'answered') ? 'answered' : statuses.includes('loading') ? 'loading' : 'failed';

  const notices: MonthNotice[] = [];
  for (const source of facts.sources) {
    const failedDay = days.find((cell) => failedSources(store, cell.day).includes(source));
    const failed = failedDay ? failedNotice(store, failedDay.day, source) : null;
    if (failed) notices.push(failed);
    if (source === 'google' && days.some((cell) => isPartialDay(store, cell.day))) notices.push({ source, kind: 'partial', failure: null });
  }
  return { month, weeks, status, notices, partner };
}

/**
 * `source`'s failed notice on a day it failed on: the day's failure, else the source's latest,
 * else a plain error; null for a reconnect (the Reconnect banner says it).
 */
function failedNotice(store: CalendarStore, day: DayKey, source: SourceName): MonthNotice | null {
  const failure: SourceFailure = dayFailure(store, day, source) ?? store.lastFailure[source] ?? { kind: 'error', source, reason: null };
  return failure.kind === 'reconnect' ? null : { source, kind: 'failed', failure };
}

/**
 * The selected day's failed notices, one per source that failed on it (FamCal first): the
 * day's list says why it is empty and offers Retry for that month even when the month is out
 * of view (its pill is then off screen). None for a day answered or loading, nor a reconnect.
 */
export function dayNotices(store: CalendarStore, day: DayKey): MonthNotice[] {
  const out: MonthNotice[] = [];
  for (const source of failedSources(store, day)) {
    const notice = failedNotice(store, day, source);
    if (notice) out.push(notice);
  }
  return out;
}

/**
 * A notice's words and action, as message keys (the pane's pills and the day list's rows say
 * the same): partial → "Some calendars didn't load"; calendars gone → "Your calendars aren't
 * available" with Choose again; busy → "Busy…"; else "Couldn't load this month"; Retry for all
 * but calendars gone.
 */
export function noticeCopy(notice: MonthNotice): { text: string; action: string; chooseAgain: boolean } {
  const gone = notice.kind === 'failed' && notice.failure?.kind === 'calendarsGone';
  const text = notice.kind === 'partial' ? 'state.partial' : gone ? 'state.calendarsGone' : notice.failure?.kind === 'busy' ? 'state.busy' : 'month.failed';
  return { text, action: gone ? 'actions.chooseAgain' : 'actions.retry', chooseAgain: gone };
}

const models = new WeakMap<CalendarStore, (month: MonthKey) => MonthModel | null>();

/**
 * buildMonth for one store, memoized: the same store gives the same function, and the
 * function gives the same model for the same month. A new store (any answer) starts
 * afresh, so a model never outlives the store it was built from.
 */
export function monthModels(store: CalendarStore): (month: MonthKey) => MonthModel | null {
  let get = models.get(store);
  if (!get) {
    const cache = new Map<MonthKey, MonthModel | null>();
    get = (month: MonthKey) => {
      if (!cache.has(month)) cache.set(month, buildMonth(store, month));
      return cache.get(month) ?? null;
    };
    models.set(store, get);
  }
  return get;
}

function withoutTrailingSpacers(slots: readonly MonthSlot[]): MonthSlot[] {
  let end = slots.length;
  while (end > 0 && slots[end - 1].kind === 'spacer') end--;
  return slots.slice(0, end);
}

/** The dots a small square shows: PICKED_DOTS, then "+N" for the rest. */
export function limitDots<T>(dots: readonly T[]): { shown: T[]; more: number } {
  return { shown: dots.slice(0, PICKED_DOTS), more: Math.max(0, dots.length - PICKED_DOTS) };
}

/** A day's rows as the Agenda lists them, daily reminders included: the selected day's list. */
export function dayRows(store: CalendarStore, day: DayKey): AgendaRow[] {
  const partner = store.partner?.name ?? null;
  return dayItems(store, day).map((item) => ({ item, whose: whoseItem(item, partner), mark: reminderMark(item), origin: day }));
}

/**
 * The months the Month reaches (owner 2026-11-17, "infinite scroll"): MONTH_REACH, the years an
 * item may start in, whatever today is; null for a malformed today. The pane holds a span of
 * them (grid.ts).
 */
function windowOf(today: DayKey): { first: MonthKey; last: MonthKey } | null {
  return monthOf(today) ? MONTH_REACH : null;
}

function inWindow(month: MonthKey, ends: { first: MonthKey; last: MonthKey }): boolean {
  return addMonths(month, 0) !== '' && month >= ends.first && month <= ends.last;
}

/** year × 12 + month index of a valid 'yyyy-MM'. */
function monthNumber(month: MonthKey): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

// ---- One Month screen (release 2): the focus, and fitting a square's lines ----

/**
 * Where the one Month screen is: `month` is the month the pane was last sent to
 * (opening, Today, a jump, leaving the tab); `selected` the day the list shows.
 */
export interface MonthFocus {
  month: MonthKey;
  selected: DayKey;
}

/** The opening focus: today's month with today selected; null for a malformed today. */
export function initialFocus(today: DayKey): MonthFocus | null {
  const month = monthOf(today);
  return month ? { month, selected: today } : null;
}

/** A tap on a day: that day selected, the month unchanged. The same object for the same day. */
export function selectDay(f: MonthFocus, day: DayKey): MonthFocus {
  return f.selected === day ? f : { month: f.month, selected: day };
}

/** The Today button: today's month, today selected. The same object when already there. */
export function focusToday(f: MonthFocus, today: DayKey): MonthFocus {
  const next = initialFocus(today);
  if (!next) return f;
  return f.month === next.month && f.selected === next.selected ? f : next;
}

/** A jump to a date: its month, the day selected. The same object when already there. */
export function focusJump(f: MonthFocus, day: DayKey): MonthFocus {
  const month = monthOf(day);
  if (!month) return f;
  return f.month === month && f.selected === day ? f : { month, selected: day };
}

/** The pane sent to a month (a chevron, leaving the tab): the selection kept. The same object when already there. */
export function focusMonth(f: MonthFocus, month: MonthKey): MonthFocus {
  return f.month === month || addMonths(month, 0) === '' ? f : { month, selected: f.selected };
}

/** Whether a chevron can move one month: false past the reach's ends (January 1900, December 2100). */
export function canStepMonth(month: MonthKey, delta: -1 | 1, today: DayKey): boolean {
  const ends = windowOf(today);
  const next = addMonths(month, delta);
  return ends !== null && next !== '' && inWindow(next, ends);
}

/**
 * After today moves (midnight, other facts): the focus kept inside the reach. A malformed
 * month goes to today's, one past an end to that end; a selected day outside the reach
 * (or malformed) becomes today. The same object when nothing changes.
 */
export function clampFocus(f: MonthFocus, today: DayKey): MonthFocus {
  const ends = windowOf(today);
  if (!ends) return f;
  let month = f.month;
  if (addMonths(month, 0) === '') month = monthOf(today) as MonthKey;
  else if (month < ends.first) month = ends.first;
  else if (month > ends.last) month = ends.last;
  const selectedMonth = monthOf(f.selected);
  const selected = selectedMonth !== null && inWindow(selectedMonth, ends) ? f.selected : today;
  return month === f.month && selected === f.selected ? f : { month, selected };
}

/**
 * The Month windows to fetch now (Ruling 7, Ruling 2), most wanted first, each once and
 * inside the reach: the anchor (`inView` when valid, else the focus month), then the
 * selected day's month when it is another, then browse's pool (`near` and the anchor's
 * two neighbours) nearest the anchor first, the later month first on a tie.
 */
export function wantedFocusMonths(f: MonthFocus, near: readonly MonthKey[], inView: MonthKey | null, today: DayKey): RangeWindow[] {
  const ends = windowOf(today);
  if (!ends) return [];
  const valid = (m: MonthKey | null): m is MonthKey => m !== null && inWindow(m, ends);
  const anchor = inView !== null && addMonths(inView, 0) !== '' ? inView : f.month;
  if (addMonths(anchor, 0) === '') return [];
  const at = monthNumber(anchor);
  const pool = [...near, addMonths(anchor, 1), addMonths(anchor, -1)]
    .filter(valid)
    .map((m) => ({ m, d: monthNumber(m) - at }))
    .sort((a, b) => Math.abs(a.d) - Math.abs(b.d) || b.d - a.d)
    .map((x) => x.m);
  const out: RangeWindow[] = [];
  const seen = new Set<MonthKey>();
  for (const m of [anchor, monthOf(f.selected), ...pool]) {
    if (!valid(m) || seen.has(m)) continue;
    seen.add(m);
    out.push(monthWindow(m));
  }
  return out;
}

/**
 * The slots a large square shows in `lines` lines (Ruling 3; the total drawn, "+N" included;
 * clamped to 1 to SQUARE_MAX_LINES). Up to `lines` every slot shows, spacers and all, so each
 * bar stays in its lane. Past it:
 * - the day's one-day items move up into the spacers above its bars (the bars keep their
 *   lanes); if all fits then, all shows;
 * - else the spacers go and the bars move up: a bar that leaves its lane shows its title
 *   (it no longer lines up with its other days); if all fits then, all shows;
 * - else the first `lines - 1` items show, bars first, and "+N" in the last line, N being
 *   the items left out.
 * So a spacer never shows over "+N", and "+N" never shows while the items would fit.
 * Trailing spacers never show.
 */
export function fitSlots(slots: readonly MonthSlot[], lines: number): { shown: MonthSlot[]; more: number } {
  const limit = Number.isFinite(lines) ? Math.max(1, Math.min(SQUARE_MAX_LINES, Math.floor(lines))) : 1;
  const items = withoutTrailingSpacers(slots);
  if (items.length <= limit) return { shown: items, more: 0 };
  const singles = items.filter((s) => s.kind !== 'bar' && s.kind !== 'spacer');
  const packed = withoutTrailingSpacers([
    ...items.filter((s) => s.kind === 'bar' || s.kind === 'spacer').map((s) => (s.kind === 'spacer' && singles.length > 0 ? (singles.shift() as MonthSlot) : s)),
    ...singles,
  ]);
  if (packed.length <= limit) return { shown: packed, more: 0 };
  const real: MonthSlot[] = [];
  items.forEach((s, lane) => {
    if (s.kind === 'spacer') return;
    real.push(s.kind === 'bar' && real.length !== lane && !s.showTitle ? { ...s, showTitle: true } : s);
  });
  if (real.length <= limit) return { shown: real, more: 0 };
  const keep = limit - 1;
  return { shown: real.slice(0, keep), more: real.length - keep };
}

/** A week row's cells as the square shows them: fitSlots for each in-month cell, then a bar the day before did not draw in the same slot shows its title. */
export function fitRow(cells: readonly MonthCell[], lines: number): { shown: MonthSlot[]; more: number }[] {
  const out = cells.map((cell) => (cell.inMonth ? fitSlots(cell.slots, lines) : { shown: [], more: 0 }));
  for (let col = 1; col < out.length; col++) {
    const before = out[col - 1].shown;
    out[col].shown = out[col].shown.map((s, i) => (s.kind === 'bar' && !s.showTitle && before[i]?.key !== s.key ? { ...s, showTitle: true } : s));
  }
  return out;
}

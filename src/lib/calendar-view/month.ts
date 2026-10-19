// The Month's model (spec §7.4, §5's month windows, Rulings R11 and R12; Plan E
// Rulings 3–7): what the Month draws, worked out from the client store. Pure and
// client-safe: it imports the store, the Agenda's whose and reminder rules, the grid,
// the day format, the Hebrew day-1 test and the RangeWindow type, and nothing else. The
// views (MonthBrowse, MonthPicked) format dates and copy and fit the slots to the
// screen; this file decides each cell's chips and bars, its dots and counts, each
// month's status and notices, the heights the browse lays its months out with, the
// layout's navigation and which months to fetch.
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
//   (limitRow, per week row).
// - Nothing here throws: a malformed month gives null, and a malformed day leaves the
//   layout as it is.

import { reminderMark, whoseItem, type AgendaRow } from './agenda';
import { allDayLastDay, formatTime, instantDay } from './format';
import {
  MONTHS_AHEAD,
  MONTHS_BACK,
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

export type MonthLayout = 'browse' | 'picked';

/** Where the Month is: the layout, its month (browse: the month to bring under the bar), and the picked day. */
export interface MonthUi {
  layout: MonthLayout;
  month: MonthKey;
  /** Set exactly when picked: a day of `month`. */
  selected: DayKey | null;
}

/** A browse cell's height (Ruling 3): the head line, the 13 px Hebrew month line and 3 slots of 18 px. */
export const BROWSE_CELL_PX = 92;
/** A picked cell's height (spec §7.4: 46–48 px). */
export const PICKED_CELL_PX = 48;
/** Slots in a browse cell (Ruling 3). */
export const BROWSE_SLOTS = 3;
/** Chips a browse cell shows at most on a narrow screen (Ruling 3). */
export const BROWSE_CHIPS_NARROW = 2;
/** A narrow screen: this wide or narrower (`(max-width: 360px)`). */
export const NARROW_MAX_PX = 360;
/** Dots a picked cell shows, then "+N". */
export const PICKED_DOTS = 3;
/**
 * The picked day's first row (one of D's ItemRows with its meta line): entering picked
 * keeps it on screen when the screen is tall enough (pickedScrollTop).
 */
export const PICKED_FIRST_ROW_PX = 64;

/** A month title's padding (14 px above, 6 below, as the mockup's month titles). */
const TITLE_PAD_PX = 20;
/** One line of a title: the month name (or the bar's, beside the 44 px Today button). */
const TITLE_LINE_PX = 22;
/** The Hebrew months' line under a title, in smaller muted text. */
const HEBREW_LINE_PX = 16;
/** The sticky bar's row: it holds the 44 px Today button, with 2 px either side. */
const BAR_ROW_PX = 48;
/** The sticky bar's row with the Hebrew line: 22 + 16 px of text, 7 px either side. */
const BAR_ROW_HEBREW_PX = 52;
/** The weekday row under the bar, its bottom border included. */
const WEEKDAY_ROW_PX = 24;

/**
 * A month's title block in browse: the `h2`'s month line and, when on, its Hebrew
 * months' line, each one line with an ellipsis. The view sets this height exactly.
 */
export function monthTitlePx(hebrewDates: boolean): number {
  return TITLE_PAD_PX + TITLE_LINE_PX + (hebrewDates ? HEBREW_LINE_PX : 0);
}

/**
 * The browse's sticky bar with its weekday row. The view sets this height exactly; the
 * titles' scroll-margin-top is this plus the safe areas, which the bar sits under.
 */
export function monthBarPx(hebrewDates: boolean): number {
  return (hebrewDates ? BAR_ROW_HEBREW_PX : BAR_ROW_PX) + WEEKDAY_ROW_PX;
}

/** A month's block in browse: its title and `rows` week rows. */
export function monthBlockPx(rows: number, hebrewDates: boolean): number {
  const whole = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 0;
  return monthTitlePx(hebrewDates) + whole * BROWSE_CELL_PX;
}

/** Each month's top, from the top of the list of months: 0, then the blocks above it added up. */
export function monthOffsets(months: readonly MonthKey[], weekStart: WeekStart, hebrewDates: boolean): number[] {
  const out: number[] = [];
  let top = 0;
  for (const month of months) {
    out.push(top);
    top += monthBlockPx(monthGrid(month, weekStart).length, hebrewDates);
  }
  return out;
}

/**
 * The months a band of the list shows, as indexes into `offsets` (both in the list's
 * coordinates): `first` is the month whose block holds `top` (the one under the
 * sticky bar when `top` is the bar's bottom), `last` the last one that starts above
 * `bottom`. Clamped to the list: a band above it gives the first month, below it the
 * last. An empty list gives { first: 0, last: -1 }.
 */
export function monthsInViewport(offsets: readonly number[], top: number, bottom: number): { first: number; last: number } {
  const n = offsets.length;
  if (n === 0) return { first: 0, last: -1 };
  let first = 0;
  while (first + 1 < n && offsets[first + 1] <= top) first++;
  let last = first;
  while (last + 1 < n && offsets[last + 1] < bottom) last++;
  return { first, last };
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
  /** A done reminder: struck through. */
  done: boolean;
  /** A bar that goes on from the day before / to the day after (flat edges). */
  continuesBefore: boolean;
  continuesAfter: boolean;
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
  /** Every slot, bars by lane first; the view limits them (limitSlots). Empty on a blank cell. */
  slots: MonthSlot[];
  /** Picked's dots: each drawn item's, in slot order, spacers left out. */
  dots: MonthDot[];
  /** Drawn items (Ruling 5: daily reminders not counted), and how many of them aren't the viewer's. */
  count: number;
  fromPartner: number;
  /** Hebrew day 1, or the month's first day: the cells that name the Hebrew month (Ruling 3). */
  hebrewMonthStart: boolean;
}

/** One of picked's dots: filled (the viewer's) or a ring (the partner's), in the calendar's colour. */
export interface MonthDot {
  mine: boolean;
  color: string | null;
}

/** A pill over the grid (Ruling 4). A reconnect never makes one: the Reconnect banner says it. */
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
  done: false,
  continuesBefore: false,
  continuesAfter: false,
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
    done: d.done,
    continuesBefore: bar && d.before,
    continuesAfter: bar && d.after,
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
    if (failedDay) {
      const failure: SourceFailure = dayFailure(store, failedDay.day, source) ?? store.lastFailure[source] ?? { kind: 'error', source, reason: null };
      if (failure.kind !== 'reconnect') notices.push({ source, kind: 'failed', failure });
    }
    if (source === 'google' && days.some((cell) => isPartialDay(store, cell.day))) notices.push({ source, kind: 'partial', failure: null });
  }
  return { month, weeks, status, notices, partner };
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

/**
 * The slots a browse cell shows (Ruling 3). Up to `maxChips` (BROWSE_SLOTS, or
 * BROWSE_CHIPS_NARROW on a narrow screen) every slot shows, spacers and all, so each bar
 * stays in its lane. Past it:
 * - the day's one-day items move up into the spacers above its bars (the bars keep their
 *   lanes); if all fits then, all shows;
 * - else the spacers go and the bars move up: a bar that leaves its lane shows its title
 *   (it no longer lines up with its other days); if all fits then, all shows;
 * - else the first min(maxChips, BROWSE_SLOTS - 1) items show, bars first, and "+N" in
 *   the next slot, N being the items left out.
 * So a spacer never shows over "+N", and "+N" never shows while the items would fit.
 * Trailing spacers never show.
 */
export function limitSlots(slots: readonly MonthSlot[], maxChips: number): { shown: MonthSlot[]; more: number } {
  const limit = Number.isFinite(maxChips) ? Math.max(1, Math.min(BROWSE_SLOTS, Math.floor(maxChips))) : BROWSE_SLOTS;
  const items = withoutTrailingSpacers(slots);
  if (items.length <= limit) return { shown: items, more: 0 };
  // The one-day items into the bars' empty lanes.
  const singles = items.filter((s) => s.kind !== 'bar' && s.kind !== 'spacer');
  const packed = withoutTrailingSpacers([
    ...items.filter((s) => s.kind === 'bar' || s.kind === 'spacer').map((s) => (s.kind === 'spacer' && singles.length > 0 ? (singles.shift() as MonthSlot) : s)),
    ...singles,
  ]);
  if (packed.length <= limit) return { shown: packed, more: 0 };
  // No spacers: a bar that moves up shows its title.
  const real: MonthSlot[] = [];
  items.forEach((s, lane) => {
    if (s.kind === 'spacer') return;
    real.push(s.kind === 'bar' && real.length !== lane && !s.showTitle ? { ...s, showTitle: true } : s);
  });
  if (real.length <= limit) return { shown: real, more: 0 };
  const keep = Math.min(limit, BROWSE_SLOTS - 1);
  return { shown: real.slice(0, keep), more: real.length - keep };
}

function withoutTrailingSpacers(slots: readonly MonthSlot[]): MonthSlot[] {
  let end = slots.length;
  while (end > 0 && slots[end - 1].kind === 'spacer') end--;
  return slots.slice(0, end);
}

/**
 * A week row's cells as browse shows them: limitSlots for each in-month cell (a blank
 * one shows nothing), then a bar that the day before did not draw in the same slot (it
 * was hidden behind "+N" there, or drawn in another slot) shows its title, so no bar is
 * drawn nameless.
 */
export function limitRow(cells: readonly MonthCell[], maxChips: number): { shown: MonthSlot[]; more: number }[] {
  const out = cells.map((cell) => (cell.inMonth ? limitSlots(cell.slots, maxChips) : { shown: [], more: 0 }));
  for (let col = 1; col < out.length; col++) {
    const before = out[col - 1].shown;
    out[col].shown = out[col].shown.map((s, i) => (s.kind === 'bar' && !s.showTitle && before[i]?.key !== s.key ? { ...s, showTitle: true } : s));
  }
  return out;
}

/** The dots a picked cell shows: PICKED_DOTS, then "+N" for the rest. */
export function limitDots<T>(dots: readonly T[]): { shown: T[]; more: number } {
  return { shown: dots.slice(0, PICKED_DOTS), more: Math.max(0, dots.length - PICKED_DOTS) };
}

/**
 * Where entering picked scrolls the page (Ruling 6), in document px: the top (0), so the
 * header, the tabs, the bar, the month and the start of the day's list show together;
 * when the screen is too short for that (a 6-row month under two banners on a 375 × 667
 * phone), just far enough down that the day's header and its first row
 * (PICKED_FIRST_ROW_PX) show, and never past the picked layout's own top, so its bar
 * stays on screen. `layoutTop` and `dayHeadBottom` are where the layout starts and the
 * day's header ends in the document; `viewport` is the screen's height. 0 for anything
 * that isn't a finite number, or no screen.
 */
export function pickedScrollTop(layoutTop: number, dayHeadBottom: number, viewport: number): number {
  if (!Number.isFinite(layoutTop) || !Number.isFinite(dayHeadBottom) || !Number.isFinite(viewport) || viewport <= 0) return 0;
  const short = dayHeadBottom + PICKED_FIRST_ROW_PX - viewport;
  return short <= 0 ? 0 : Math.round(Math.min(short, Math.max(0, layoutTop)));
}

/** A day's rows as the Agenda lists them, daily reminders included: the picked day's list. */
export function dayRows(store: CalendarStore, day: DayKey): AgendaRow[] {
  const partner = store.partner?.name ?? null;
  return dayItems(store, day).map((item) => ({ item, whose: whoseItem(item, partner), mark: reminderMark(item) }));
}

/** The window's first and last months around `today` (spec §7.4), or null for a malformed day. */
function windowOf(today: DayKey): { first: MonthKey; last: MonthKey } | null {
  const month = monthOf(today);
  if (!month) return null;
  return { first: addMonths(month, -MONTHS_BACK), last: addMonths(month, MONTHS_AHEAD) };
}

function inWindow(month: MonthKey, ends: { first: MonthKey; last: MonthKey }): boolean {
  return addMonths(month, 0) !== '' && month >= ends.first && month <= ends.last;
}

/** The day picked selects in `month`: today in today's month, else the 1st. */
function dayToSelect(month: MonthKey, today: DayKey): DayKey {
  return month === monthOf(today) ? today : monthFirstDay(month);
}

/**
 * Where the Month opens (spec §7.4 Memory): browse on today's month, or, when the
 * remembered layout is picked, picked on today.
 */
export function initialMonthUi(saved: MonthLayout | null, today: DayKey): MonthUi {
  const month = monthOf(today);
  return saved === 'picked' && month ? { layout: 'picked', month, selected: today } : { layout: 'browse', month, selected: null };
}

/** A tap on a day: picked, on that day and its month. The same UI back when nothing changes. */
export function pickDay(ui: MonthUi, day: DayKey): MonthUi {
  const month = monthOf(day);
  if (!month) return ui;
  if (ui.layout === 'picked' && ui.selected === day && ui.month === month) return ui;
  return { layout: 'picked', month, selected: day };
}

/** "All months", the BackButton, Android's back: browse, with the picked month under the bar. */
export function backToBrowse(ui: MonthUi): MonthUi {
  return ui.layout === 'browse' && ui.selected === null ? ui : { layout: 'browse', month: ui.month, selected: null };
}

/** Whether a chevron can move one month: false past the window's ends (spec §7.4). */
export function canStep(ui: MonthUi, delta: -1 | 1, today: DayKey): boolean {
  const ends = windowOf(today);
  const next = addMonths(ui.month, delta);
  return ends !== null && next !== '' && inWindow(next, ends);
}

/** A chevron: the month before or after, selecting the 1st, or today in today's month. The same UI at the window's ends. */
export function stepMonth(ui: MonthUi, delta: -1 | 1, today: DayKey): MonthUi {
  if (!canStep(ui, delta, today)) return ui;
  const month = addMonths(ui.month, delta);
  return ui.layout === 'picked' ? { layout: 'picked', month, selected: dayToSelect(month, today) } : { layout: 'browse', month, selected: null };
}

/** The Today pill (picked: today selected) or button (browse: today's month). The same UI when already there. */
export function pickToday(ui: MonthUi, today: DayKey): MonthUi {
  const month = monthOf(today);
  if (!month) return ui;
  if (ui.layout === 'picked') return ui.month === month && ui.selected === today ? ui : { layout: 'picked', month, selected: today };
  return ui.month === month && ui.selected === null ? ui : { layout: 'browse', month, selected: null };
}

/**
 * After today moves (midnight, other facts): the UI kept, but inside the new window.
 * A month past an end moves to that end, and picked then selects its 1st (or today in
 * today's month); a malformed month goes to today's. A picked day stays picked, even
 * when it was today. The same UI when nothing changes.
 */
export function clampMonthUi(ui: MonthUi, today: DayKey): MonthUi {
  const ends = windowOf(today);
  if (!ends) return ui;
  let month = ui.month;
  if (addMonths(month, 0) === '') month = monthOf(today);
  else if (month < ends.first) month = ends.first;
  else if (month > ends.last) month = ends.last;
  if (ui.layout === 'picked') {
    if (month === ui.month && ui.selected !== null && monthOf(ui.selected) === month) return ui;
    return { layout: 'picked', month, selected: dayToSelect(month, today) };
  }
  return month === ui.month && ui.layout === 'browse' && ui.selected === null ? ui : { layout: 'browse', month, selected: null };
}

/** year × 12 + month index of a valid 'yyyy-MM'. */
function monthNumber(month: MonthKey): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

/**
 * The Month windows to fetch now (spec §5, Ruling 7), most wanted first, each once and
 * inside the window, as the loader's getMonths wants them:
 * - picked: the picked month, then the month after it, then the month before;
 * - browse: the month in view (`inView`, or `ui.month` before browse reports one) and
 *   its two neighbours, Ruling 7's fallback, with the months near the viewport (`near`,
 *   from the IntersectionObserver). The neighbours are always in: on Telegram's web
 *   clients the app runs in a cross-origin iframe, where the observer ignores its
 *   rootMargin and reports only the months on screen. Nearest to the month in view
 *   first, and the later month first when two are as near.
 */
export function wantedMonths(ui: MonthUi, near: readonly MonthKey[], inView: MonthKey | null, today: DayKey): RangeWindow[] {
  const ends = windowOf(today);
  if (!ends) return [];
  const valid = (m: MonthKey | null): m is MonthKey => m !== null && inWindow(m, ends);
  const anchor = ui.layout === 'browse' && inView !== null && addMonths(inView, 0) !== '' ? inView : ui.month;
  if (addMonths(anchor, 0) === '') return [];
  let months: MonthKey[];
  if (ui.layout === 'picked') {
    months = [anchor, addMonths(anchor, 1), addMonths(anchor, -1)];
  } else {
    const pool = [anchor, ...near, addMonths(anchor, 1), addMonths(anchor, -1)];
    const at = monthNumber(anchor);
    months = pool
      .filter(valid)
      .map((m) => ({ m, d: monthNumber(m) - at }))
      .sort((a, b) => Math.abs(a.d) - Math.abs(b.d) || b.d - a.d)
      .map((x) => x.m);
  }
  const out: RangeWindow[] = [];
  const seen = new Set<MonthKey>();
  for (const m of months) {
    if (!valid(m) || seen.has(m)) continue;
    seen.add(m);
    out.push(monthWindow(m));
  }
  return out;
}

'use client';

// The Month's browse layout (spec §7.4 Browse, §5's month windows, §7.7, §7.8; Rulings
// R11 and R12; Plan E Rulings 3, 4, 6, 7 and 8): the window's months stacked
// vertically, iOS style, under a sticky bar. Presentational: the container (E8's
// MonthView, under CalendarHome) owns the store and the fetches, builds each month's
// model with month.ts (E5) and hands it here through getMonth.
//
// - The sticky bar sits under the safe areas and whatever sticks above it (the
//   container's header and tab bar: --ch-top-h on .ch-home, 0px without it). It shows
//   the month in view with its year, that month's Hebrew months when Hebrew dates are
//   on, a Today button while no part of today's month is on screen, and then the
//   weekday row from the week start.
// - Every month renders at its known height (monthBlockPx), so nothing above the
//   viewport ever changes height: iOS's WKWebView has no scroll anchoring. The months
//   near the viewport draw their grids. The rest show their title and an empty box of
//   the same height.
// - A cell has four parts (Ruling 3): the Gregorian day with the Hebrew day at the
//   head line's end; the Hebrew month's short name under it, on Hebrew day 1 and on the
//   month's first cell; 3 slots of chips and bars, or 2 and "+N" (at most 2 chips on a
//   360 px screen), as month.ts's limitRow fits each week row (a day that overflows
//   moves its bars up, named, and never shows an empty line over "+N"). A loading cell
//   shows a placeholder and a failed one is dimmed, so a day never looks free before it
//   is answered (§5).
// - A month's failure is a pill centred over its dimmed cells, and a partial answer a
//   pill at its top (Ruling 4). Neither changes the month's height.
// - One button per day of the month, whose label reads the whole cell ("Thursday, 15
//   October, 4 Cheshvan, 3 items, 1 from Noa"). The chips, the blank cells and the
//   weekday row are aria-hidden.
// - On mount the start month's title goes just under the bar; with peek, half a week
//   row of the month before shows above it. A passive scroll listener, at most once a
//   frame, reports the month in view. One IntersectionObserver, about a viewport beyond
//   the screen, reports the months near it; without one, near is the month in view and
//   its two neighbours (Ruling 7). When the window's first month, the week start or the
//   Hebrew line changes, or the list moves in the page while scrolled into it (a banner
//   or a row coming or going above the Month, the header's zone line: iOS's WKWebView
//   has no scroll anchoring), the month in view stays where it was on screen.
// - MonthBrowse reads the layout when it mounts, so the container mounts it only while
//   it is displayed.
// - No ancestor of the sticky bar clips with overflow: hidden (the root clips with
//   overflow-x: clip); logical properties only; nothing under 11 px; taps at least
//   44 px; no hover styles.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formatDayLong, formatMonthTitle, formatWeekdayHeader } from '@/src/lib/calendar-view/format';
import { monthGrid, monthOf, weekdayOrder, type MonthKey } from '@/src/lib/calendar-view/grid';
import { hebrewCellLabel, hebrewCellMonth, hebrewDayLabel, hebrewMonthHeader, isHebrewMonthStart } from '@/src/lib/calendar-view/hebrew-date';
import { holidayTitles, retryFailedHolidays, useHolidays } from '@/src/lib/calendar-view/holidays-client';
import {
  BROWSE_CELL_PX,
  BROWSE_CHIPS_NARROW,
  BROWSE_SLOTS,
  NARROW_MAX_PX,
  limitRow,
  loadingMonth,
  monthBarPx,
  monthBlockPx,
  monthOffsets,
  monthTitlePx,
  monthsInViewport,
  type MonthCell,
  type MonthModel,
  type MonthNotice,
  type MonthSlot,
} from '@/src/lib/calendar-view/month';
import type { DayKey, Holiday, SourceName, WeekStart } from '@/src/lib/calendar-view/types';
import { calendarMark } from './ItemRow';

export interface MonthBrowseProps {
  /** The window, oldest first: monthSpan(today), 12 months back to 18 ahead. */
  months: readonly MonthKey[];
  today: DayKey;
  weekStart: WeekStart;
  hebrewDates: boolean;
  /** monthModels(store): a month's model, or null (its cells then read as loading). */
  getMonth: (month: MonthKey) => MonthModel | null;
  /** Read on mount: that month's title under the sticky bar; peek adds half a week row of the month before (the opening position). */
  start: { month: MonthKey; peek: boolean };
  /** The months within about a viewport of the screen (IntersectionObserver), oldest first; coalesced, and only when they change. */
  onNearMonths: (months: MonthKey[]) => void;
  /** The month under the sticky bar, as the user scrolls; only when it changes. */
  onMonthInView: (month: MonthKey) => void;
  /** A tap on a day: the container opens picked on it. */
  onPickDay: (day: DayKey) => void;
  /** Retry on a month's failed or partial pill. */
  onRetryMonth: (month: MonthKey, source: SourceName) => void;
  /** "Choose again" on a calendars-gone pill: the existing select-calendars page. */
  onChooseCalendars: () => void;
}

/**
 * Half a week row. The opening position shows this much of the month before above the
 * start month's title, and the month in view is read this far below the bar, so the
 * opening position reads as the start month.
 */
const PEEK_PX = BROWSE_CELL_PX / 2;
/** About one viewport above and below the screen: the months that count as near (Ruling 7). */
const NEAR_MARGIN = '100% 0px';
const NARROW_QUERY = `(max-width: ${NARROW_MAX_PX}px)`;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** A media query's list, or null where there is no window or no matchMedia. */
function mediaList(query: string): MediaQueryList | null {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
  } catch {
    return null;
  }
}

function subscribeNarrow(onChange: () => void): () => void {
  const list = mediaList(NARROW_QUERY);
  if (!list) return () => {};
  try {
    if (typeof list.addEventListener === 'function') {
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    }
    // Safari before 14 has only the older pair.
    list.addListener(onChange);
    return () => list.removeListener(onChange);
  } catch {
    return () => {};
  }
}
const isNarrow = () => mediaList(NARROW_QUERY)?.matches === true;
const notNarrow = () => false;
const reducedMotion = () => mediaList(REDUCED_MOTION_QUERY)?.matches === true;

/** Runs `run` on the next frame (a timer where there is no requestAnimationFrame); returns its cancel. */
function nextFrame(run: () => void): () => void {
  if (typeof window.requestAnimationFrame === 'function') {
    const id = window.requestAnimationFrame(run);
    return () => window.cancelAnimationFrame(id);
  }
  const id = window.setTimeout(run, 16);
  return () => window.clearTimeout(id);
}

type Motion = 'instant' | 'smooth';

/** Scrolls the document (spec §7.1: no inner scroller). A browser that rejects the options object gets the plain form. */
function scrollPage(top: number, behavior: Motion) {
  const y = Math.max(0, Math.round(top));
  try {
    window.scrollTo({ top: y, behavior });
  } catch {
    try {
      window.scrollTo(0, y);
    } catch {
      // The page stays where it is.
    }
  }
}

/**
 * The document offset that puts `title` just under the sticky bar, as its
 * scroll-margin-top says (the safe areas plus the bar), less `peek`. Without a
 * scroll-margin-top to read, the bar's own height stands in.
 */
function titleScrollTop(title: HTMLElement, fallbackMargin: number, peek: number): number {
  let margin = Number.NaN;
  try {
    margin = parseFloat(window.getComputedStyle(title).scrollMarginTop);
  } catch {
    // Read below.
  }
  if (!Number.isFinite(margin) || margin <= 0) margin = fallbackMargin;
  return window.scrollY + title.getBoundingClientRect().top - margin - peek;
}

function viewportHeight(): number {
  return window.innerHeight || document.documentElement?.clientHeight || 0;
}

/** The month at `index` and its two neighbours, inside the window. */
function around(months: readonly MonthKey[], index: number): MonthKey[] {
  return index < 0 ? [] : months.slice(Math.max(0, index - 1), index + 2);
}

/** Where the window opens: the start month, else today's month, else the first. */
function startIndexOf(months: readonly MonthKey[], month: MonthKey, today: DayKey): number {
  const at = months.indexOf(month);
  if (at >= 0) return at;
  const todays = months.indexOf(monthOf(today));
  return todays >= 0 ? todays : 0;
}

function blockPx(month: MonthKey, weekStart: WeekStart, hebrewDates: boolean): number {
  return monthBlockPx(monthGrid(month, weekStart).length, hebrewDates);
}

/**
 * One chip or bar, a spacer's empty line: filled for the viewer's, outlined for the
 * partner's, in the calendar's colour (spec 2026-10-19 §3.3), or E4's tokens without one.
 * The chip keeps the grid's direction, so a bar's logical joins (is-before, is-after)
 * meet the next day in Hebrew too; only the title is isolated (<bdi>), so a Hebrew title
 * in English, or an English one in Hebrew, reads in its own direction.
 */
export function Slot({ slot, noTitle }: { slot: MonthSlot; noTitle: string }) {
  if (slot.kind === 'spacer') return <span className="ch-mb-slot" />;
  const cal = calendarMark(slot.color);
  const look = slot.kind === 'timed' ? (slot.mine ? 'is-mine-timed' : 'is-partner-timed') : slot.mine ? 'is-mine-solid' : 'is-partner-solid';
  const className = [
    'ch-mb-chip',
    `is-${slot.kind}`,
    look,
    slot.continuesBefore ? 'is-before' : '',
    slot.continuesAfter ? 'is-after' : '',
    slot.done ? 'is-done' : '',
    slot.showTitle && slot.count ? 'has-count' : '',
  ]
    .filter(Boolean)
    .join(' ') + cal.className;
  const title = slot.showTitle ? (slot.title && slot.title.trim() !== '' ? slot.title : noTitle) : '';
  return (
    <span className="ch-mb-slot">
      <span className={className} style={cal.style}>
        {title ? <bdi className={slot.count ? 'ch-mb-chip-title' : undefined}>{title}</bdi> : null}
        {title && slot.count ? <span className="ch-mb-count" aria-hidden="true">{slot.count}</span> : null}
      </span>
    </span>
  );
}

interface CellProps {
  cell: MonthCell;
  partner: string | null;
  hebrewDates: boolean;
  /** The slots the cell shows and the items left for "+N" (limitRow). */
  shown: readonly MonthSlot[];
  more: number;
  /** calendarHome.hebrewMonthGenitive, Russian only (the label's Hebrew day, Ruling R9). */
  genitive: readonly string[] | undefined;
  /** calendarHome.hebrewMonthShort (the cell's Hebrew month line). */
  shortMonths: readonly string[] | undefined;
  /** The day's Hebrew holidays, highest priority first (none while Hebrew dates are off or the month hasn't landed). */
  holidays: readonly Holiday[] | undefined;
  noTitle: string;
  onPickDay: (day: DayKey) => void;
}

function Cell({ cell, partner, hebrewDates, shown, more, genitive, shortMonths, holidays, noTitle, onPickDay }: CellProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  if (!cell.inMonth) return <div className="ch-mb-cell is-blank" aria-hidden="true" />;

  // A day still loading never looks free: a placeholder in the next free slot.
  const placeholder = cell.status === 'loading' && more === 0 && shown.length < BROWSE_SLOTS;
  const hebrewDay = hebrewDates ? hebrewCellLabel(cell.day, locale, false) : '';
  const hebrewMonth = hebrewDates && cell.hebrewMonthStart ? hebrewCellMonth(cell.day, locale, shortMonths) : '';
  // The second line holds the Hebrew month's name on its first day (Rosh Chodesh is implied),
  // unless that day is a yom tov (1 Tishrei shows Rosh Hashana); every other day it holds
  // the day's highest-priority holiday. The month's first cell, when it isn't Hebrew day 1,
  // gives its name up to a holiday.
  const holiday = holidays?.[0];
  const showHoliday = holiday !== undefined && (!hebrewMonth || !isHebrewMonthStart(cell.day) || holiday.chag);
  const line = showHoliday ? holiday.brief : hebrewMonth;

  const parts = [formatDayLong(cell.day, locale)];
  if (hebrewDates) {
    const full = hebrewDayLabel(cell.day, locale, genitive);
    if (full) parts.push(full);
    if (holidays && holidays.length > 0) parts.push(holidayTitles(holidays, locale));
  }
  if (cell.count > 0) {
    parts.push(t('month.cellItems', { count: cell.count }));
    if (cell.fromPartner > 0 && partner) parts.push(t('month.cellFromPartner', { count: cell.fromPartner, name: partner }));
  }
  if (cell.status === 'loading') parts.push(t('month.cellLoading'));
  else if (cell.status === 'failed') parts.push(t('month.cellFailed'));
  else if (cell.count === 0) parts.push(t('month.cellNothing'));

  const className = ['ch-mb-cell', cell.today ? 'is-today' : '', cell.status === 'loading' ? 'is-loading' : '', cell.status === 'failed' ? 'is-failed' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={className} aria-label={parts.join(', ')} aria-current={cell.today ? 'date' : undefined} onClick={() => onPickDay(cell.day)}>
      <span className="ch-mb-head" aria-hidden="true">
        <span className="ch-mb-day" dir="ltr">
          {Number(cell.day.slice(8, 10))}
        </span>
        {hebrewDay ? <span className="ch-mb-hday">{hebrewDay}</span> : null}
      </span>
      <span className={showHoliday && holiday.chag ? 'ch-mb-hmonth has-chag' : 'ch-mb-hmonth'} dir={showHoliday ? 'auto' : undefined} aria-hidden="true">
        {line}
      </span>
      <span className="ch-mb-slots" aria-hidden="true">
        {shown.map((slot, i) => (
          <Slot key={i} slot={slot} noTitle={noTitle} />
        ))}
        {more > 0 ? (
          <span className="ch-mb-slot">
            <span className="ch-mb-more">{t('month.more', { count: more })}</span>
          </span>
        ) : null}
        {placeholder ? (
          <span className="ch-mb-slot">
            <span className="ch-mb-ghost" />
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** A month's notice (Ruling 4): busy, calendars gone or an error, or a partial answer. */
function NoticePill({ notice, month, onRetryMonth, onChooseCalendars }: { notice: MonthNotice; month: MonthKey; onRetryMonth: MonthBrowseProps['onRetryMonth']; onChooseCalendars: () => void }) {
  const t = useTranslations('calendarHome');
  const gone = notice.kind === 'failed' && notice.failure?.kind === 'calendarsGone';
  const text =
    notice.kind === 'partial' ? t('state.partial') : gone ? t('state.calendarsGone') : notice.failure?.kind === 'busy' ? t('state.busy') : t('month.failed');
  return (
    <div className="ch-mb-pill">
      <span className="ch-mb-pill-text">{text}</span>
      <button type="button" className="ch-btn ch-mb-pill-action" onClick={gone ? onChooseCalendars : () => onRetryMonth(month, notice.source)}>
        {gone ? t('actions.chooseAgain') : t('actions.retry')}
      </button>
    </div>
  );
}

interface MonthGridProps {
  month: MonthKey;
  model: MonthModel | null;
  weekStart: WeekStart;
  today: DayKey;
  hebrewDates: boolean;
  narrow: boolean;
  onPickDay: (day: DayKey) => void;
  onRetryMonth: MonthBrowseProps['onRetryMonth'];
  onChooseCalendars: () => void;
}

/** A near month's grid and its notices. Memoized: a scroll that changes only the bar leaves it alone. */
const MonthGrid = memo(function MonthGrid({ month, model, weekStart, today, hebrewDates, narrow, onPickDay, onRetryMonth, onChooseCalendars }: MonthGridProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  // A model drawn from another week start (a store not yet dropped after the facts
  // changed) would not fit this month's block: until the new one comes, it reads as loading.
  const fits = model !== null && model.weeks[0]?.[0]?.day === monthGrid(month, weekStart)[0]?.[0];
  const weeks = model && fits ? model.weeks : loadingMonth(month, weekStart, today).weeks;
  const genitive = hebrewDates && locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined;
  const shortMonths = hebrewDates ? (t.raw('hebrewMonthShort') as string[]) : undefined;
  const holidays = useHolidays([month], locale, hebrewDates);
  const noTitle = t('row.noTitle');
  const notices = model && fits ? model.notices : [];
  const failed = notices.filter((n) => n.kind === 'failed');
  const partial = notices.filter((n) => n.kind === 'partial');
  const maxChips = narrow ? BROWSE_CHIPS_NARROW : BROWSE_SLOTS;
  return (
    <div className="ch-mb-body" style={{ blockSize: weeks.length * BROWSE_CELL_PX }}>
      {partial.length > 0 ? (
        <div className="ch-mb-overlay is-top">
          {partial.map((n) => (
            <NoticePill key={`partial-${n.source}`} notice={n} month={month} onRetryMonth={onRetryMonth} onChooseCalendars={onChooseCalendars} />
          ))}
        </div>
      ) : null}
      {failed.length > 0 ? (
        <div className="ch-mb-overlay is-centre">
          {failed.map((n) => (
            <NoticePill key={`failed-${n.source}`} notice={n} month={month} onRetryMonth={onRetryMonth} onChooseCalendars={onChooseCalendars} />
          ))}
        </div>
      ) : null}
      <div className="ch-mb-grid">
        {weeks.map((row) => {
          const limited = limitRow(row, maxChips);
          return (
            <div key={row[0]?.day ?? ''} className="ch-mb-row">
              {row.map((cell, col) => (
                <Cell
                  key={cell.day}
                  cell={cell}
                  partner={model && fits ? model.partner : null}
                  hebrewDates={hebrewDates}
                  shown={limited[col].shown}
                  more={limited[col].more}
                  genitive={genitive}
                  shortMonths={shortMonths}
                  holidays={holidays[cell.day]}
                  noTitle={noTitle}
                  onPickDay={onPickDay}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
});

export function MonthBrowse(props: MonthBrowseProps) {
  const { months, today, weekStart, hebrewDates, getMonth } = props;
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, notNarrow);
  const offsets = useMemo(() => monthOffsets(months, weekStart, hebrewDates), [months, weekStart, hebrewDates]);
  // Each month's rows, title and Hebrew range, once per window, week start, language and
  // Hebrew line: not again on every report of the month in view or the near months.
  const thisYear = today.slice(0, 4);
  const heads = useMemo(
    () =>
      months.map((month) => ({
        month,
        rows: monthGrid(month, weekStart).length,
        title: formatMonthTitle(month, locale, month.slice(0, 4) !== thisYear),
        hebrew: hebrewDates ? hebrewMonthHeader(month, locale) : '',
      })),
    [months, weekStart, locale, hebrewDates, thisYear],
  );

  // The opening position, read once: `start` is only for the mount.
  const [opening] = useState(() => {
    const index = startIndexOf(months, props.start.month, today);
    return { month: months[index] ?? '', peek: props.start.peek, index };
  });
  /** The months whose grids render, beyond the month in view and its neighbours. */
  const [near, setNear] = useState<readonly MonthKey[]>(() => around(months, opening.index));
  const [inView, setInView] = useState<MonthKey>(opening.month);
  const [showToday, setShowToday] = useState(() => monthOf(today) !== opening.month);

  const listRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const titles = useRef(new Map<MonthKey, HTMLElement>());
  const sections = useRef(new Map<MonthKey, HTMLElement>());
  /** The month in view at the last measure, and how far the bar's bottom was below its top. */
  const anchor = useRef<{ month: MonthKey; delta: number } | null>(null);
  const reported = useRef<{ inView: MonthKey | null; near: string | null }>({ inView: null, near: null });
  /** Whether an IntersectionObserver reports the near months (else the scroll measure does). */
  const observing = useRef(false);
  const cancelFrame = useRef<(() => void) | null>(null);
  // The latest props and offsets, for the listeners and callbacks (synced before any other effect reads them).
  const live = useRef({ props, offsets });
  useLayoutEffect(() => {
    live.current = { props, offsets };
  });

  const reportNear = useCallback((list: MonthKey[]) => {
    const key = list.join(',');
    if (reported.current.near === key) return;
    reported.current.near = key;
    setNear(list);
    live.current.props.onNearMonths(list);
  }, []);

  /** Reads where the page is: the month in view, the Today button, and the near months without an observer. */
  const measure = useCallback(() => {
    const list = listRef.current;
    const bar = barRef.current;
    const { props: p, offsets: tops } = live.current;
    if (!list || !bar || p.months.length === 0) return;
    const listTop = list.getBoundingClientRect().top;
    const top = bar.getBoundingClientRect().bottom - listTop;
    const bottom = viewportHeight() - listTop;
    const { first } = monthsInViewport(tops, top + PEEK_PX, bottom);
    const month = p.months[first];
    anchor.current = { month, delta: top - tops[first] };
    setInView(month);
    if (reported.current.inView !== month) {
      // A month whose holidays failed is asked again on the next month change (not on the first report).
      if (reported.current.inView !== null) retryFailedHolidays();
      reported.current.inView = month;
      p.onMonthInView(month);
    }
    const at = p.months.indexOf(monthOf(p.today));
    const end = at >= 0 ? tops[at] + blockPx(p.months[at], p.weekStart, p.hebrewDates) : 0;
    setShowToday(at >= 0 && !(tops[at] < bottom && end > top));
    if (!observing.current) reportNear(around(p.months, first));
  }, [reportNear]);

  /** One measure per frame, however many scroll events come. */
  const requestMeasure = useCallback(() => {
    if (cancelFrame.current) return;
    cancelFrame.current = nextFrame(() => {
      cancelFrame.current = null;
      measure();
    });
  }, [measure]);

  // The opening position: the start month's title under the bar, with the peek.
  useLayoutEffect(() => {
    const title = titles.current.get(opening.month);
    if (title) scrollPage(titleScrollTop(title, monthBarPx(live.current.props.hebrewDates), opening.peek ? PEEK_PX : 0), 'instant');
  }, [opening]);

  // The window's first month, the week start or the Hebrew line changed (every offset
  // moved), or the list moved in the page (a banner or a row came or went above the
  // Month, the header's zone line; iOS's WKWebView has no scroll anchoring to make up
  // for it): the month in view is put back where it was under the bar. At the page's
  // top the bar sits on the list (nothing is under it), so nothing scrolls then: a row
  // above shows where it comes.
  const layoutKey = `${months[0] ?? ''}|${weekStart}|${hebrewDates ? 1 : 0}`;
  const laidOut = useRef<{ key: string; listTop: number | null }>({ key: layoutKey, listTop: null });
  useLayoutEffect(() => {
    const list = listRef.current;
    const bar = barRef.current;
    if (!list || !bar) return;
    const listTop = window.scrollY + list.getBoundingClientRect().top;
    const last = laidOut.current;
    laidOut.current = { key: layoutKey, listTop };
    const relaid = last.key !== layoutKey;
    const moved = last.listTop !== null && Math.abs(listTop - last.listTop) >= 1;
    if (!relaid && !moved) return;
    const was = anchor.current;
    const { props: p, offsets: tops } = live.current;
    if (was && p.months.length > 0) {
      let at = p.months.indexOf(was.month);
      if (at < 0) at = was.month < p.months[0] ? 0 : p.months.length - 1;
      const block = blockPx(p.months[at], p.weekStart, p.hebrewDates);
      const want = tops[at] + Math.min(Math.max(was.delta, -PEEK_PX), block - 1);
      const now = bar.getBoundingClientRect().bottom - list.getBoundingClientRect().top;
      if (Math.abs(want - now) >= 1) scrollPage(window.scrollY + want - now, 'instant');
    }
    requestMeasure();
  });

  // The scroll listener: passive, one measure a frame. The first measure follows the opening scroll.
  useEffect(() => {
    const options: AddEventListenerOptions = { passive: true };
    window.addEventListener('scroll', requestMeasure, options);
    window.addEventListener('resize', requestMeasure, options);
    requestMeasure();
    return () => {
      window.removeEventListener('scroll', requestMeasure, options);
      window.removeEventListener('resize', requestMeasure, options);
      cancelFrame.current?.();
      cancelFrame.current = null;
    };
  }, [requestMeasure]);

  // The near months: one observer on every month, about a viewport beyond the screen,
  // its reports gathered into one call a frame.
  const monthsKey = months.join(',');
  useEffect(() => {
    const Observer = typeof window.IntersectionObserver === 'function' ? window.IntersectionObserver : null;
    if (!Observer) return;
    const intersecting = new Map<MonthKey, boolean>();
    let cancel: (() => void) | null = null;
    const flush = () => {
      cancel = null;
      reportNear(live.current.props.months.filter((m) => intersecting.get(m) === true));
    };
    let observer: IntersectionObserver;
    try {
      observer = new Observer(
        (entries) => {
          for (const entry of entries) {
            const month = entry.target.getAttribute('data-month');
            if (month) intersecting.set(month, entry.isIntersecting);
          }
          if (!cancel) cancel = nextFrame(flush);
        },
        { rootMargin: NEAR_MARGIN },
      );
    } catch {
      return;
    }
    observing.current = true;
    for (const el of sections.current.values()) observer.observe(el);
    return () => {
      observing.current = false;
      observer.disconnect();
      cancel?.();
    };
  }, [monthsKey, reportNear]);

  const goToday = useCallback(() => {
    const p = live.current.props;
    const title = titles.current.get(monthOf(p.today));
    if (title) scrollPage(titleScrollTop(title, monthBarPx(p.hebrewDates), 0), reducedMotion() ? 'instant' : 'smooth');
  }, []);
  const pickDay = useCallback((day: DayKey) => live.current.props.onPickDay(day), []);
  const retryMonth = useCallback((month: MonthKey, source: SourceName) => live.current.props.onRetryMonth(month, source), []);
  const chooseCalendars = useCallback(() => live.current.props.onChooseCalendars(), []);

  const at = months.indexOf(inView);
  const drawn = new Set<MonthKey>([...near, ...around(months, at)]);
  const rootStyle = {
    '--ch-mb-bar': `${monthBarPx(hebrewDates)}px`,
    '--ch-mb-title': `${monthTitlePx(hebrewDates)}px`,
    '--ch-mb-cell': `${BROWSE_CELL_PX}px`,
  } as CSSProperties;

  return (
    <section className="ch-mb" dir={locale === 'he' ? 'rtl' : 'ltr'} style={rootStyle}>
      <style>{MONTH_BROWSE_CSS}</style>
      <div className="ch-mb-bar" ref={barRef}>
        <div className="ch-mb-bar-row">
          <p className="ch-mb-bar-text" aria-hidden="true">
            <span className="ch-mb-bar-month">{formatMonthTitle(inView, locale, true)}</span>
            {hebrewDates ? <span className="ch-mb-bar-hebrew">{hebrewMonthHeader(inView, locale)}</span> : null}
          </p>
          {showToday ? (
            <button type="button" className="ch-mb-today" onClick={goToday}>
              {t('month.today')}
            </button>
          ) : null}
        </div>
        <div className="ch-mb-weekdays" aria-hidden="true">
          {weekdayOrder(weekStart).map((weekday) => (
            <span key={weekday} className="ch-mb-weekday">
              {formatWeekdayHeader(weekday, locale)}
            </span>
          ))}
        </div>
      </div>
      <div className="ch-mb-months" ref={listRef}>
        {heads.map(({ month, rows, title, hebrew }) => (
          <div
            key={month}
            className="ch-mb-month"
            data-month={month}
            style={{ blockSize: monthBlockPx(rows, hebrewDates) }}
            ref={(el) => {
              if (el) sections.current.set(month, el);
              else sections.current.delete(month);
            }}
          >
            <h2
              className="ch-mb-title"
              ref={(el) => {
                if (el) titles.current.set(month, el);
                else titles.current.delete(month);
              }}
            >
              <span className="ch-mb-title-month">{title}</span>
              {hebrewDates ? (
                <>
                  <span className="ch-visually-hidden">, </span>
                  <span className="ch-mb-title-hebrew">{hebrew}</span>
                </>
              ) : null}
            </h2>
            {drawn.has(month) ? (
              <MonthGrid
                month={month}
                model={getMonth(month)}
                weekStart={weekStart}
                today={today}
                hebrewDates={hebrewDates}
                narrow={narrow}
                onPickDay={pickDay}
                onRetryMonth={retryMonth}
                onChooseCalendars={chooseCalendars}
              />
            ) : (
              <div className="ch-mb-body ch-mb-far" style={{ blockSize: rows * BROWSE_CELL_PX }} aria-hidden="true" />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The browse's styles. They read the tokens HOME_THEME_CSS (./home-theme.ts) puts on
 * .ch-home, D's and E4's, the three heights MonthBrowse sets on its root from
 * month.ts: --ch-mb-bar (monthBarPx), --ch-mb-title (monthTitlePx) and --ch-mb-cell
 * (BROWSE_CELL_PX), and --ch-top-h, the height of what sticks above the bar (the
 * container's header and tab bar; 0px without it). The fixed parts add up to them: the bar is its row and the 24 px
 * weekday row; a title is 14 px + 22 px (+ 16 px with the Hebrew line) + 6 px; a cell
 * is its 1 px rule, 3 px, the 18 px head, the 13 px Hebrew month line and three 18 px
 * slots, within 92 px. overflow: hidden only on text leaves (the ellipsis); the root
 * clips with overflow-x: clip, which keeps the bar sticky.
 */
export const MONTH_BROWSE_CSS = `
.ch-mb {
  padding-block-end: calc(24px + max(env(safe-area-inset-bottom, 0px), var(--tg-safe-area-inset-bottom, 0px)));
  overflow-x: clip;
}
.ch-mb-bar {
  position: sticky;
  top: calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px) + var(--ch-top-h, 0px));
  z-index: 3;
  display: flex;
  flex-direction: column;
  block-size: var(--ch-mb-bar);
  background: var(--ch-bg);
}
.ch-mb-bar-row {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 0;
  padding-inline: 16px;
}
.ch-mb-bar-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin: 0;
}
.ch-mb-bar-month {
  font-size: 17px;
  font-weight: 600;
  line-height: 22px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-mb-bar-hebrew {
  font-size: 13px;
  line-height: 16px;
  color: var(--ch-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-mb-today {
  flex: none;
  min-width: 44px;
  min-height: 44px;
  margin: 0;
  padding-block: 0;
  padding-inline: 16px;
  border: 1px solid var(--ch-pill-line);
  border-radius: 22px;
  background: var(--ch-pill-bg);
  color: var(--ch-pill-text);
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.2;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-mb-today:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 2px;
}
.ch-mb-cell:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: -2px;
}
.ch-mb-weekdays {
  display: grid;
  flex: none;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  block-size: 24px;
  padding-inline: 6px;
  border-block-end: 1px solid var(--ch-separator);
  font-size: 12px;
  line-height: 23px;
  color: var(--ch-muted);
  text-align: center;
}
.ch-mb-month {
  display: flex;
  flex-direction: column;
}
.ch-mb-title {
  flex: none;
  block-size: var(--ch-mb-title);
  margin: 0;
  padding-block: 14px 6px;
  padding-inline: 16px;
  scroll-margin-top: calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px) + var(--ch-top-h, 0px) + var(--ch-mb-bar));
  color: var(--ch-month-title);
  font-size: 15px;
  font-weight: 600;
}
.ch-mb-title-month {
  display: block;
  line-height: 22px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-mb-title-hebrew {
  display: block;
  font-size: 12px;
  font-weight: 400;
  line-height: 16px;
  color: var(--ch-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-mb-body {
  position: relative;
  flex: none;
}
.ch-mb-grid {
  margin-inline: 6px;
}
.ch-mb-row {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  block-size: var(--ch-mb-cell);
}
.ch-mb-cell {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  min-width: 0;
  block-size: var(--ch-mb-cell);
  margin: 0;
  padding-block: 3px 0;
  padding-inline: 2px;
  border: 0;
  border-block-start: 1px solid var(--ch-separator);
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: start;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-mb-cell.is-blank {
  border-block-start-color: transparent;
  cursor: default;
}
button.ch-mb-cell:active {
  background: var(--ch-surface);
}
.ch-mb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2px;
  block-size: 18px;
  padding-inline: 2px;
}
.ch-mb-day {
  min-inline-size: 18px;
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
  text-align: center;
}
.ch-mb-cell.is-today .ch-mb-day {
  padding-inline: 4px;
  border-radius: 9px;
  background: var(--ch-today);
  color: var(--ch-today-text);
  font-weight: 600;
}
.ch-mb-hday {
  font-size: 11px;
  line-height: 18px;
  color: var(--ch-muted);
  white-space: nowrap;
}
.ch-mb-hmonth {
  display: block;
  block-size: 13px;
  padding-inline: 2px;
  font-size: 11px;
  line-height: 13px;
  color: var(--ch-muted);
  text-align: end;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-mb-hmonth.has-chag {
  color: var(--ch-accent);
}
.ch-mb-slots {
  display: block;
}
.ch-mb-slot {
  display: block;
  block-size: 18px;
  padding-block-start: 2px;
  container-type: inline-size;
}
.ch-mb-chip {
  display: block;
  block-size: 16px;
  padding-inline: 3px;
  border: 1px solid transparent;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  line-height: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-mb-chip.has-count {
  display: flex;
  align-items: center;
  gap: 3px;
}
.ch-mb-chip-title {
  display: block;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-mb-count {
  display: none;
  flex: none;
  padding-inline: 4px;
  border-radius: 6px;
  background: color-mix(in srgb, currentColor 18%, transparent);
  font-size: 11px;
  line-height: 14px;
  font-variant-numeric: tabular-nums;
}
@container (min-width: 64px) {
  .ch-mb-count {
    display: inline-block;
  }
}
.ch-mb-chip.is-mine-timed {
  background: var(--ch-mine-soft);
  color: var(--ch-mine-soft-text);
}
.ch-mb-chip.is-mine-solid {
  background: var(--ch-mine-solid);
  color: var(--ch-mine-solid-text);
}
.ch-mb-chip.is-partner-timed {
  border-color: var(--ch-partner-line);
  background: var(--ch-bg);
  color: var(--ch-partner-line-text);
}
.ch-mb-chip.is-partner-solid {
  border-color: var(--ch-partner-line);
  background: var(--ch-partner-soft);
  color: var(--ch-partner-soft-text);
}
.ch-mb-chip.has-cal.is-mine-timed,
.ch-mb-chip.has-cal.is-mine-solid {
  background: var(--cal-fill);
  color: var(--cal-text);
}
.ch-mb-chip.has-cal.is-partner-timed,
.ch-mb-chip.has-cal.is-partner-solid {
  border-color: var(--cal-line);
  background: var(--ch-bg);
  color: var(--cal-text);
}
.ch-mb-chip.is-before {
  margin-inline-start: -2px;
  border-inline-start-width: 0;
  border-start-start-radius: 0;
  border-end-start-radius: 0;
}
.ch-mb-chip.is-after {
  margin-inline-end: -2px;
  border-inline-end-width: 0;
  border-start-end-radius: 0;
  border-end-end-radius: 0;
}
.ch-mb-chip.is-done {
  text-decoration: line-through;
}
.ch-mb-more {
  display: block;
  padding-inline: 3px;
  font-size: 11px;
  line-height: 16px;
  color: var(--ch-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-mb-ghost {
  display: block;
  block-size: 12px;
  margin-block-start: 2px;
  border-radius: 4px;
  background: var(--ch-surface);
  animation: ch-mb-pulse 1.4s ease-in-out infinite;
}
.ch-mb-cell.is-failed {
  background: var(--ch-surface);
}
.ch-mb-cell.is-failed .ch-mb-day {
  color: var(--ch-muted);
}
.ch-mb-cell.is-failed .ch-mb-hmonth,
.ch-mb-cell.is-failed .ch-mb-slots {
  opacity: 0.5;
}
.ch-mb-overlay {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-block: 8px;
  padding-inline: 16px;
  pointer-events: none;
}
.ch-mb-overlay.is-centre {
  justify-content: center;
}
.ch-mb-pill {
  display: flex;
  align-items: center;
  gap: 4px;
  max-inline-size: 100%;
  min-height: 44px;
  padding-inline: 14px 0;
  border: 1px solid var(--ch-outline);
  border-radius: 22px;
  background: var(--ch-section);
  color: var(--ch-text);
  box-shadow: 0 2px 8px rgba(18, 18, 32, 0.12);
  font-size: 14px;
  line-height: 1.3;
  pointer-events: auto;
}
.ch-mb-pill-text {
  min-width: 0;
  padding-block: 6px;
}
.ch-mb-pill-action {
  flex: none;
  border-radius: 22px;
  background: transparent;
}
@keyframes ch-mb-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
@media (prefers-reduced-motion: reduce) {
  .ch-mb-ghost {
    animation: none;
  }
}
`;

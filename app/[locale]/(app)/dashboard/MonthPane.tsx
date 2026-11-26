'use client';

// The one Month screen's month pane (responsive home, release 2; spec §1–§2, decision 2;
// plan Rulings 5, 6 and 7): the bar, the weekday row and a scroller of whole months. It is
// the wide layout's month pane and the upright split's month area alike. Presentational: the
// container (MonthView, under CalendarHome) owns the store, the span, the selection and the
// fetches, and hands each month's model here through getMonth.
//
// - Every month is exactly one scroller tall and snaps (scroll-snap-type: y mandatory), so a
//   scroll position is index × height: the month in view is the one under the scroller's
//   middle (month-layout.ts's monthAtScroll), read at most once a frame on `scroll`. Only the
//   month in view and its two neighbours draw their squares (MonthSquares); the rest are
//   empty boxes of the same height.
// - The bar: ‹ the title › at the start, an empty gap (release 3's Gregorian | Hebrew switch
//   goes there), Today at the end while the selected day or the month in view isn't today's
//   (Ruling 6). The title is the month in view with its year and, with Hebrew dates, its
//   Hebrew months under it; it opens the jump to a date. The bar's row and the weekday row are
//   monthBarPx tall. The chevrons scroll a month (and are drop targets while an item is
//   lifted: DragLayer's dwell calls step, Ruling 5); they never change the selection, and are
//   disabled past the reach (January 1900, December 2100).
// - The pane never selects a day by itself: a tap on a square, Today and the jump go to the
//   container, which selects and, for Today and the jump, moves `seek`.
// - seek: on mount the scroller is put at the month sought at once; a new seq scrolls to its
//   month, smoothly when it is the next or the previous one and motion is allowed, else at
//   once. A month the span doesn't hold yet waits for the span.
// - The span (grid.ts; owner 2026-11-17, "infinite scroll"), as browse had it: within
//   SPAN_EDGE months of the last month, onNeedMonths('after') at once; near the first,
//   onNeedMonths('before') only once no scroll event has come for SCROLL_IDLE_MS (on iOS a
//   scroll set during a fling stops the fling); each end once per span. Months added above
//   are made up for before paint, so the month in view stays (no scroll anchoring of the
//   browser's: overflow-anchor is off). A step past an end asks for the months first and
//   scrolls once they come.
// - A resize (a rotation, Telegram's expand, the split's handle animating): one
//   ResizeObserver on the scroller puts the month in view back at index × the new height in
//   its callback, with no React render (a scroll event that sees the new height first, before
//   the observer in the same frame, does the same before it reads the month); the squares'
//   size class follows SETTLE_MS after the last resize (the first measure at once). With
//   scrollerPx (the split sets the scroller's height) the squares size from it, not from the
//   measure, so the split's animation never re-renders them per frame (Ruling 7).
// - Mobile Mini App rules: taps of 44 px or more (the squares aside, MonthSquares), nothing
//   under 11 px, logical properties only, the chevrons flipped in RTL (.ch-flip), no hover,
//   the theme's tokens. MONTH_SQUARES_CSS is rendered here, once.

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formatMonthTitle, formatWeekdayHeader } from '@/src/lib/calendar-view/format';
import { addMonths, monthGrid, monthOf, nearSpanEdge, weekdayOrder, type MonthKey } from '@/src/lib/calendar-view/grid';
import { hebrewMonthHeader } from '@/src/lib/calendar-view/hebrew-date';
import { retryFailedHolidays } from '@/src/lib/calendar-view/holidays-client';
import { canStepMonth, loadingMonth, monthBarPx, type MonthModel } from '@/src/lib/calendar-view/month';
import { SETTLE_MS, monthAtScroll, squareSize, type SquareSize } from '@/src/lib/calendar-view/month-layout';
import type { DayKey, SourceName, WeekStart } from '@/src/lib/calendar-view/types';
import { useNavDrop } from './DragSurface';
import { MONTH_SQUARES_CSS, MonthSquaresGrid } from './MonthSquares';

/** The pane's imperative side: a month back or forward (the chevrons, and a lifted item resting on one). */
export interface MonthPaneHandle {
  step(delta: -1 | 1): void;
}

export interface MonthPaneProps {
  /** The span, oldest first (grid.ts spanMonths), memoized. */
  months: readonly MonthKey[];
  today: DayKey;
  weekStart: WeekStart;
  hebrewDates: boolean;
  /** monthModels(store): a month's model, or null (it then draws as loading). */
  getMonth: (month: MonthKey) => MonthModel | null;
  /** The day the list shows: pressed in its square. */
  selected: DayKey;
  /** Scroll here on mount (at once) and whenever seq changes. */
  seek: { month: MonthKey; seq: number };
  /** The split sets the scroller's height (splitHeights); null: the scroller fills the pane (wide). */
  scrollerPx: number | null;
  /** A tap on a square (the selected one included). */
  onSelectDay: (day: DayKey) => void;
  /** The month under the scroller's middle, when it changes. */
  onMonthInView: (month: MonthKey) => void;
  /** The drawn months (the month in view and its neighbours), when they change. */
  onNearMonths: (months: MonthKey[]) => void;
  /** The month in view came near an end of the span it can still grow at, or a step went past one. */
  onNeedMonths: (edge: 'before' | 'after') => void;
  /** Today: the container selects today and seeks its month. */
  onToday: () => void;
  /** A tap on the title: the jump to a date. */
  onJump?: () => void;
  /** Retry on a month's failed or partial pill. */
  onRetryMonth: (month: MonthKey, source: SourceName) => void;
  /** "Choose again" on a calendars-gone pill: the existing select-calendars page. */
  onChooseCalendars: () => void;
  /** React 19's ref prop: step. */
  ref?: Ref<MonthPaneHandle>;
}

/** How long the scroller must go without a scroll event before months are added above. */
export const SCROLL_IDLE_MS = 150;
/** The weekday row under the bar's row, its bottom border included: monthBarPx is the two. */
const WEEKDAYS_PX = 24;
/** The squares' grid's inline padding, both sides (MONTH_SQUARES_CSS's .ch-sq-body). */
const GRID_PAD_PX = 12;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

let motionWarned = false;

/** Whether the person asked for less motion; false where there is no matchMedia (logged once if it throws). */
function reducedMotion(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches === true;
  } catch (err) {
    if (!motionWarned) {
      motionWarned = true;
      console.warn('[month pane] matchMedia failed:', err);
    }
    return false;
  }
}

/** Runs `run` on the next frame (a timer where there is no requestAnimationFrame); returns its cancel. */
function nextFrame(run: () => void): () => void {
  if (typeof window.requestAnimationFrame === 'function') {
    const id = window.requestAnimationFrame(run);
    return () => window.cancelAnimationFrame(id);
  }
  const id = setTimeout(run, 16);
  return () => clearTimeout(id);
}

/**
 * The scroller's height for scroll positions: its exact (fractional) height, as each month box is
 * 100% of it and sits at index × it. clientHeight is rounded to a whole pixel, and index × a rounded
 * height drifts up to half a pixel a month, a sliver of the neighbour where a programmatic scroll
 * doesn't snap. clientHeight where the box disagrees by a pixel or more (no layout box; a transform).
 */
function heightOf(el: HTMLElement): number {
  const exact = el.getBoundingClientRect().height;
  return Math.abs(exact - el.clientHeight) < 1 ? exact : el.clientHeight;
}

/** The month at `index` and its two neighbours, inside the span. */
function around(months: readonly MonthKey[], index: number): MonthKey[] {
  return index < 0 ? [] : months.slice(Math.max(0, index - 1), index + 2);
}

/** Where the pane opens: the month sought, else today's month, else the span's first. */
function startMonth(months: readonly MonthKey[], seek: MonthKey, today: DayKey): MonthKey {
  if (months.includes(seek)) return seek;
  const todays = monthOf(today);
  return todays && months.includes(todays) ? todays : (months[0] ?? '');
}

/** The month's model when it fits this week start, else the loading one (a day never looks free before it is answered). */
function modelFor(getMonth: MonthPaneProps['getMonth'], month: MonthKey, weekStart: WeekStart, today: DayKey): MonthModel {
  const model = getMonth(month);
  const first = monthGrid(month, weekStart)[0]?.[0];
  return model && first !== undefined && model.weeks[0]?.[0]?.day === first ? model : loadingMonth(month, weekStart, today);
}

/** A month chevron: a button, and a drop target while an item is lifted (resting on it turns the month). */
function NavButton({ side, label, disabled, onClick }: { side: 'prev' | 'next'; label: string; disabled: boolean; onClick: () => void }) {
  const target = useNavDrop(side);
  return (
    <button {...target.props} type="button" className={`ch-pane-chev${target.over ? ' is-drop-nav' : ''}`} aria-label={label} disabled={disabled} onClick={onClick}>
      <Chevron back={side === 'prev'} />
    </button>
  );
}

/** A chevron: back (towards the start) or forward. Flipped in RTL by .ch-flip. */
function Chevron({ back }: { back: boolean }) {
  return (
    <svg className="ch-flip" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={back ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
    </svg>
  );
}

/** The squares' size for a month of 4, 5 or 6 weeks in a scroller `height` × `width` px (the grid's padding aside). */
function squareSizes(height: number, width: number): Record<number, SquareSize> {
  const cell = (width - GRID_PAD_PX) / 7;
  return { 4: squareSize(height / 4, cell), 5: squareSize(height / 5, cell), 6: squareSize(height / 6, cell) };
}

type Size = { width: number; height: number };
const realSize = (size: Size | null): size is Size => size !== null && size.width > 0 && size.height > 0;

export function MonthPane(props: MonthPaneProps) {
  const { months, today, weekStart, hebrewDates, getMonth, selected, seek, scrollerPx, ref } = props;
  const t = useTranslations('calendarHome');
  const locale = useLocale();

  const [inView, setInView] = useState<MonthKey>(() => startMonth(months, seek.month, today));
  /** The scroller's size the squares are drawn for (settled); null until measured. */
  const [measured, setMeasured] = useState<Size | null>(null);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // The latest props, for the listeners and callbacks (synced before any other effect reads them).
  const live = useRef<MonthPaneProps>(props);
  /** The month in view at the last read, and how far into it the scroller was: what a resize and months added above keep. */
  const view = useRef<{ month: MonthKey; offset: number }>({ month: inView, offset: 0 });
  const reported = useRef<{ inView: MonthKey | null; near: string | null }>({ inView: null, near: null });
  /** The span's end each edge was last asked to grow at (once per end), and whether the month in view is near the first. */
  const grown = useRef<{ before: MonthKey | null; after: MonthKey | null }>({ before: null, after: null });
  const nearFirst = useRef(false);
  /** The month a smooth scroll is on its way to: a second step goes on from it, not from the month still in view. */
  const aim = useRef<MonthKey | null>(null);
  /** A step past the span's end, waiting for the months it asked for. */
  const pendingStep = useRef<MonthKey | null>(null);
  /** The size the squares use now (the measured state's twin, for the observer). */
  const sized = useRef<Size | null>(null);
  /** The scroller's height when the position was last put at index × height (the opening, a scroll to a month, a resize, months added above). */
  const alignedAt = useRef(0);
  const seekDone = useRef(seek.seq);
  const laidMonths = useRef(months);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelFrame = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    live.current = props;
  });

  /** The month in view put back at index × `h` (a resize); nothing to keep when it isn't in the span. */
  const realign = useCallback((el: HTMLDivElement, h: number) => {
    alignedAt.current = h;
    const at = live.current.months.indexOf(view.current.month);
    if (!(h > 0) || at < 0) return;
    const top = at * h;
    if (el.scrollTop !== top) el.scrollTop = top;
    view.current = { month: view.current.month, offset: 0 };
  }, []);

  /** Reads where the scroller is: the month in view, the near months, the span's ends. */
  const measure = useCallback(() => {
    const el = scrollerRef.current;
    const p = live.current;
    const n = p.months.length;
    if (!el || n === 0) return;
    const h = heightOf(el);
    if (!(h > 0)) return;
    // The height changed since the position was last put right and the ResizeObserver hasn't run
    // yet (a scroll event comes first in a frame of the split's animation or a window resize):
    // scrollTop is still index × the old height and would read a neighbour, so the month in view
    // goes back where it belongs first (what the observer does), and the read below finds it.
    if (h !== alignedAt.current) realign(el, h);
    const top = el.scrollTop;
    const at = monthAtScroll(top, h, n);
    const month = p.months[at];
    view.current = { month, offset: top - at * h };
    if (aim.current === month) aim.current = null;
    setInView(month);
    if (reported.current.inView !== month) {
      // A month whose holidays failed is asked again on the next month change (not on the first report).
      if (reported.current.inView !== null) retryFailedHolidays();
      reported.current.inView = month;
      p.onMonthInView(month);
    }
    const near = around(p.months, at);
    const key = near.join(',');
    if (reported.current.near !== key) {
      reported.current.near = key;
      p.onNearMonths(near);
    }
    const span = { first: p.months[0], last: p.months[n - 1] };
    if (nearSpanEdge(span, month, 'after') && grown.current.after !== span.last) {
      grown.current.after = span.last;
      p.onNeedMonths('after');
    }
    nearFirst.current = nearSpanEdge(span, month, 'before');
  }, [realign]);

  /** The scroller has stopped: months above, when the month in view is near the first. */
  const settle = useCallback(() => {
    idle.current = null;
    aim.current = null;
    const p = live.current;
    if (!nearFirst.current || p.months.length === 0 || grown.current.before === p.months[0]) return;
    grown.current.before = p.months[0];
    p.onNeedMonths('before');
  }, []);
  const restartIdle = useCallback(() => {
    if (idle.current !== null) clearTimeout(idle.current);
    idle.current = setTimeout(settle, SCROLL_IDLE_MS);
  }, [settle]);

  /** One measure per frame, however many scroll events come. */
  const requestMeasure = useCallback(() => {
    if (cancelFrame.current) return;
    cancelFrame.current = nextFrame(() => {
      cancelFrame.current = null;
      measure();
    });
  }, [measure]);

  /** To the month at `index`: smoothly, or at once and read straight away (the bar and the squares follow before paint). */
  const scrollToIndex = useCallback(
    (index: number, smooth: boolean) => {
      const el = scrollerRef.current;
      if (!el) return;
      const h = heightOf(el);
      alignedAt.current = h;
      const top = index * h;
      if (smooth) {
        try {
          el.scrollTo({ top, behavior: 'smooth' });
          return;
        } catch (err) {
          console.warn('[month pane] smooth scroll failed, scrolling at once:', err);
        }
      }
      el.scrollTop = top;
      measure();
    },
    [measure],
  );

  const step = useCallback(
    (delta: -1 | 1) => {
      const p = live.current;
      const base = aim.current ?? view.current.month;
      if (!canStepMonth(base, delta, p.today)) return;
      const target = addMonths(base, delta);
      const at = p.months.indexOf(target);
      if (at < 0) {
        // Past the span's end: the months first, the scroll when they come (the layout effect below).
        const edge = delta > 0 ? 'after' : 'before';
        pendingStep.current = target;
        grown.current[edge] = edge === 'after' ? p.months[p.months.length - 1] : p.months[0];
        p.onNeedMonths(edge);
        return;
      }
      const smooth = !reducedMotion();
      aim.current = smooth ? target : null;
      scrollToIndex(at, smooth);
      if (smooth) restartIdle();
    },
    [scrollToIndex, restartIdle],
  );
  useImperativeHandle(ref, () => ({ step }), [step]);

  /** The squares' size from now on. */
  const applySize = useCallback((size: Size) => {
    sized.current = size;
    setMeasured((was) => (was && was.width === size.width && was.height === size.height ? was : size));
  }, []);

  // The opening: the month sought at once, and the squares measured at once (both before paint).
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const at = live.current.months.indexOf(view.current.month);
    const h = heightOf(el);
    alignedAt.current = h;
    if (at >= 0 && h > 0) el.scrollTop = at * h;
    const size = { width: el.clientWidth, height: el.clientHeight };
    if (realSize(size)) applySize(size);
  }, [applySize]);

  // The span changed: months added above are made up for (the month in view stays where it
  // was), and a step that waited for the months goes on.
  useLayoutEffect(() => {
    const was = laidMonths.current;
    laidMonths.current = months;
    if (was[0] === months[0] && was.length === months.length) return;
    const el = scrollerRef.current;
    if (!el) return;
    const h = heightOf(el);
    const added = was.length > 0 ? months.indexOf(was[0]) : -1;
    if (added > 0 && h > 0) {
      const at = months.indexOf(view.current.month);
      el.scrollTop = at >= 0 ? at * h + view.current.offset : el.scrollTop + added * h;
      alignedAt.current = h;
    }
    const target = pendingStep.current;
    const to = target === null ? -1 : months.indexOf(target);
    if (target !== null && to >= 0) {
      pendingStep.current = null;
      const smooth = !reducedMotion();
      aim.current = smooth ? target : null;
      scrollToIndex(to, smooth);
    }
    requestMeasure();
  }, [months, scrollToIndex, requestMeasure]);

  // A new seek: its month, smoothly when it is the next or the previous one, else at once.
  useLayoutEffect(() => {
    if (seek.seq === seekDone.current) return;
    const at = live.current.months.indexOf(seek.month);
    if (at < 0) return;
    seekDone.current = seek.seq;
    const from = live.current.months.indexOf(view.current.month);
    if (from >= 0 && Math.abs(at - from) === 1 && !reducedMotion()) {
      aim.current = seek.month;
      scrollToIndex(at, true);
      restartIdle();
      return;
    }
    aim.current = null;
    view.current = { month: seek.month, offset: 0 };
    scrollToIndex(at, false);
  }, [seek.seq, seek.month, months, scrollToIndex, restartIdle]);

  // A resize: the month in view back where it belongs at once (no render), the squares' size
  // after it settles (the first real measure at once).
  const onResize = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    realign(el, heightOf(el));
    if (settleTimer.current !== null) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    const size = { width: el.clientWidth, height: el.clientHeight };
    const now = sized.current;
    if (now && now.width === size.width && now.height === size.height) return;
    if (!realSize(now)) {
      if (realSize(size)) applySize(size);
      return;
    }
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      const box = scrollerRef.current;
      if (box) applySize({ width: box.clientWidth, height: box.clientHeight });
    }, SETTLE_MS);
  }, [applySize, realign]);

  // The scroll listener (passive, one measure a frame, the idle timer for months above) and the
  // one ResizeObserver; the first measure follows the opening.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const options: AddEventListenerOptions = { passive: true };
    const onScroll = () => {
      requestMeasure();
      restartIdle();
    };
    el.addEventListener('scroll', onScroll, options);
    let observer: ResizeObserver | null = null;
    if (typeof window.ResizeObserver === 'function') {
      try {
        observer = new window.ResizeObserver(onResize);
        observer.observe(el);
      } catch (err) {
        console.warn('[month pane] ResizeObserver failed, following the window instead:', err);
        observer = null;
      }
    }
    // Without an observer (an old WebView), the window's resizes stand in.
    if (!observer) window.addEventListener('resize', onResize, options);
    requestMeasure();
    restartIdle();
    return () => {
      el.removeEventListener('scroll', onScroll, options);
      if (observer) observer.disconnect();
      else window.removeEventListener('resize', onResize, options);
      cancelFrame.current?.();
      cancelFrame.current = null;
      if (idle.current !== null) clearTimeout(idle.current);
      idle.current = null;
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
      settleTimer.current = null;
    };
  }, [requestMeasure, restartIdle, onResize]);

  const selectDay = useCallback((day: DayKey) => live.current.onSelectDay(day), []);
  const retryMonth = useCallback((month: MonthKey, source: SourceName) => live.current.onRetryMonth(month, source), []);
  const chooseCalendars = useCallback(() => live.current.onChooseCalendars(), []);
  const goToday = useCallback(() => live.current.onToday(), []);
  const jump = useCallback(() => live.current.onJump?.(), []);
  const prev = useCallback(() => step(-1), [step]);
  const next = useCallback(() => step(1), [step]);

  // The squares' size per month height (4, 5 or 6 weeks), from the split's height when it sets one.
  const width = measured === null ? 0 : measured.width;
  const height = scrollerPx !== null ? scrollerPx : measured === null ? 0 : measured.height;
  const sizes = useMemo(() => squareSizes(height, width), [height, width]);

  const drawn = new Set(around(months, months.indexOf(inView)));
  const title = formatMonthTitle(inView, locale, true);
  const showToday = selected !== today || inView !== monthOf(today);
  const rootStyle = { '--ch-pane-bar': `${monthBarPx(hebrewDates) - WEEKDAYS_PX}px` } as CSSProperties;

  return (
    <section className="ch-pane" dir={locale === 'he' ? 'rtl' : 'ltr'} style={rootStyle}>
      <style>{MONTH_SQUARES_CSS}</style>
      <style>{MONTH_PANE_CSS}</style>
      <div className="ch-pane-bar">
        <NavButton side="prev" label={t('month.previous')} disabled={!canStepMonth(inView, -1, today)} onClick={prev} />
        <button type="button" className="ch-pane-title" onClick={jump} aria-haspopup="dialog" aria-label={t('month.jumpLabel', { month: title })}>
          <span className="ch-pane-title-text" aria-live="polite">
            <span className="ch-pane-title-line">
              <span className="ch-pane-title-month">{title}</span>
              <svg className="ch-pane-title-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </span>
            {hebrewDates ? <span className="ch-pane-title-hebrew">{hebrewMonthHeader(inView, locale)}</span> : null}
          </span>
        </button>
        <NavButton side="next" label={t('month.next')} disabled={!canStepMonth(inView, 1, today)} onClick={next} />
        <span className="ch-pane-gap" />
        {showToday ? (
          <button type="button" className="ch-pane-today" onClick={goToday}>
            <span className="ch-pane-today-pill">{t('month.today')}</span>
          </button>
        ) : null}
      </div>
      <div className="ch-pane-weekdays" aria-hidden="true">
        {weekdayOrder(weekStart).map((weekday) => (
          <span key={weekday}>{formatWeekdayHeader(weekday, locale)}</span>
        ))}
      </div>
      <div className="ch-pane-scroller" ref={scrollerRef} style={scrollerPx === null ? undefined : { blockSize: `${scrollerPx}px`, flex: 'none' }}>
        {months.map((month) => {
          if (!drawn.has(month)) return <div key={month} className="ch-pane-month" data-month={month} />;
          const model = modelFor(getMonth, month, weekStart, today);
          return (
            <div key={month} className="ch-pane-month" data-month={month}>
              <MonthSquaresGrid
                model={model}
                month={month}
                today={today}
                selected={selected}
                hebrewDates={hebrewDates}
                size={sizes[model.weeks.length] ?? squareSize(height / model.weeks.length, (width - GRID_PAD_PX) / 7)}
                onSelectDay={selectDay}
                onRetryMonth={retryMonth}
                onChooseCalendars={chooseCalendars}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The pane's styles, on the tokens APP_THEME_CSS (components/app-ui/theme.ts) puts on .ch-app
 * (D's, and E4's --ch-pill-* and --ch-disabled). The pane is a column: the bar's row
 * (--ch-pane-bar, which the pane sets from monthBarPx: 48 px, 52 with the Hebrew line) and the
 * 24 px weekday row add up to monthBarPx, then the scroller fills what is left (flex: 1), or is
 * the split's height (set inline). The scroller snaps on whole months, each 100% of it, keeps
 * its scroll to itself (overscroll-behavior: contain) and leaves months added above to the pane
 * (overflow-anchor: none). The chevrons are 44 × 44, the title and Today at least 44 tall.
 * Logical properties only; nothing under 11 px; no hover; overflow: hidden only on the title's
 * text leaves (the ellipsis) and the scroller's inline axis.
 */
export const MONTH_PANE_CSS = `
.ch-pane {
  display: flex;
  flex-direction: column;
  min-block-size: 0;
  min-inline-size: 0;
}
.ch-pane-bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
  block-size: var(--ch-pane-bar);
  padding-inline: 4px 12px;
}
.ch-pane-chev {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  inline-size: 44px;
  block-size: 44px;
  min-width: 44px;
  min-height: 44px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--ch-text);
  cursor: pointer;
  touch-action: manipulation;
}
.ch-pane-chev:disabled {
  color: var(--ch-disabled);
  cursor: default;
}
.ch-pane-chev svg {
  flex: none;
  inline-size: 22px;
  block-size: 22px;
}
.ch-pane-chev.is-drop-nav {
  background: var(--ch-pill-bg);
  outline: 2px solid var(--ch-accent);
  outline-offset: -2px;
}
.ch-pane-title {
  display: flex;
  flex: 0 1 auto;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  min-height: 44px;
  margin: 0;
  padding-block: 0;
  padding-inline: 4px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: start;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-pane-title-text {
  display: block;
  min-width: 0;
}
.ch-pane-title-line {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.ch-pane-title-month {
  font-size: 17px;
  font-weight: 600;
  line-height: 22px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-pane-title-chev {
  flex: none;
  color: var(--ch-muted);
}
.ch-pane-title-hebrew {
  display: block;
  font-size: 13px;
  line-height: 16px;
  color: var(--ch-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-pane-gap {
  flex: 1;
  min-width: 0;
}
.ch-pane-today {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  font-family: inherit;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-pane-today-pill {
  display: inline-flex;
  align-items: center;
  block-size: 32px;
  padding-inline: 14px;
  border: 1px solid var(--ch-pill-line);
  border-radius: 16px;
  background: var(--ch-pill-bg);
  color: var(--ch-pill-text);
  font-size: 14px;
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
}
.ch-pane-chev:focus-visible,
.ch-pane-title:focus-visible,
.ch-pane-today:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: -2px;
}
.ch-pane-weekdays {
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
.ch-pane-scroller {
  flex: 1 1 0;
  min-block-size: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  overflow-anchor: none;
  scroll-snap-type: y mandatory;
}
.ch-pane-month {
  block-size: 100%;
  scroll-snap-align: start;
}
`;

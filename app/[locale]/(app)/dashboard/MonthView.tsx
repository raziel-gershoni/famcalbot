'use client';

// The Month tab (responsive home release 2, spec §1–§4; Rulings 1–10): one screen, the month
// and the selected day's list together. Presentational: CalendarHome owns the store, the
// fetches, the focus (the month sought and the selected day), the split's memory, and
// Telegram's BackButton and swipes. This file lays the parts out and measures the room.
//
// - The region (.ch-mv) is the rest of the viewport under the header and the tab bar
//   (--ch-top-h) and the safe areas above, down to the screen's bottom edge, and clips: the
//   page never scrolls on the Month, only the pane's months and the day's list do (two inner
//   scrollers). The bottom safe area (the home indicator) is inside it: the list scrolls under
//   it and pads its own end by it, the wide pane's months end above it, and the grown split's
//   peek stays clear of it (a hidden probe measures it with the region).
// - Wide (WIDE_QUERY: 600 px or wider and landscape): the pane and the day's list side by side,
//   2fr 1fr, the pane first in reading order, so on the right in Hebrew. The pane fills the
//   region's height, so no split height (scrollerPx null).
// - Upright: the split. The pane on top, its scroller as tall as splitHeights says for the
//   region measured (collapsed or grown), then the handle, then the list filling the rest. The
//   scroller's height animates over 200 ms (none under prefers-reduced-motion). Grown, a tap on
//   a square selects it and collapses, and the list is a peek whose tap collapses.
// - The region is measured before the pane mounts (a layout effect, before paint), so the pane
//   opens on the split's real height; one ResizeObserver on the region follows it after (the
//   window's resize where there is none).
// - The banners and "N calendars aren't available · Choose again" go at the top of the list's
//   scroller (spec §1), above the day's header; a source that failed on the selected day is a
//   row under the header, with Retry for that day's month (its pill may be off screen).
// - A row tapped in the list opens D's ItemSheet: the container holds the selection (its
//   BackButton closes the sheet), and the sheet shows the row as the latest answer has it, else
//   as it was tapped. The jump to a date is the editor's date sheet. Both sit outside the region.
// - Drag to move (editor upgrades spec §4): with `drag`, the region and the sheets sit in a
//   DragLayer (DragSurface), so the list's rows and the large squares' chips lift and drop on
//   any square; resting on a chevron scrolls the pane a month (Ruling 5). The Agenda has none.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { MIN_YEAR_BIRTH } from '@/src/lib/calendar-view/year-limits';
import { sameItemRow, type AgendaRow } from '@/src/lib/calendar-view/agenda';
import { monthOf, type MonthKey } from '@/src/lib/calendar-view/grid';
import type { MonthSplit } from '@/src/lib/calendar-view/home-storage';
import { monthBarPx, type MonthFocus, type MonthModel, type MonthNotice } from '@/src/lib/calendar-view/month';
import { GRID_PAD_PX, WIDE_QUERY, splitHeights } from '@/src/lib/calendar-view/month-layout';
import type { DayStatus } from '@/src/lib/calendar-view/store';
import type { DayKey, SourceName, WeekStart } from '@/src/lib/calendar-view/types';
import { useMediaQuery } from '@/src/lib/calendar-view/use-media';
import { DatePickerSheet } from './DatePickerSheet';
import { DayPanel } from './DayPanel';
import { DragLayer, type DragLayerProps } from './DragSurface';
import { ItemSheet, type SheetActions } from './ItemSheet';
import { MonthPane, type MonthPaneHandle } from './MonthPane';
import { SPLIT_HANDLE_CSS, SplitHandle } from './SplitHandle';

/** Drag to move: the DragLayer's props but its month turn, which MonthView gives the pane (Ruling 5). */
export type MonthDrag = Omit<DragLayerProps, 'children' | 'onNav'>;

export interface MonthViewProps {
  /** The facts the Month draws with: the pinned ones, or the last ones through a store drop. */
  today: DayKey;
  tz: string;
  weekStart: WeekStart;
  hebrewDates: boolean;
  /** Show the selected day's Daf Yomi page (CalendarHomeProps.dafYomi). */
  dafYomi?: boolean;
  /** The span's months, oldest first (grid.ts spanMonths), memoized. */
  months: readonly MonthKey[];
  /** monthModels(store): a month's model, or null (it then draws as loading). */
  getMonth: (month: MonthKey) => MonthModel | null;
  /** The month the pane was last sent to, and the day the list shows. */
  focus: MonthFocus;
  /** Where the pane goes: its month on mount, and again on each new seq (Today, the jump). */
  seek: { month: MonthKey; seq: number };
  /** The upright split: collapsed or the month grown (the device's memory). */
  split: MonthSplit;
  onSplit: (next: MonthSplit) => void;
  /** The selected day's list: dayRows(store, day), dayStatus(store, day) and dayNotices(store, day). */
  dayRows: { rows: AgendaRow[]; status: DayStatus; notices: MonthNotice[] };
  /** homeNotices(store).unavailableCalendars: chosen Google calendars that are gone. */
  unavailableCalendars: number;
  /** The home's banners (HomeBanners), at the top of the list on the Month (spec §1). */
  banners: ReactNode;
  /** The row whose item sheet is open, or null. The container holds it. */
  selected: AgendaRow | null;
  /** A tap on a row: open its sheet (the row), or close it (null). */
  onSelect: (row: AgendaRow | null) => void;
  /** The open sheet's reminder actions (the container owns the request). */
  sheetActions?: SheetActions;
  /** A tap on a square: that day selected. */
  onSelectDay: (day: DayKey) => void;
  /** The pane's reports, for the container's wanted months and the span. */
  onMonthInView: (month: MonthKey) => void;
  onNearMonths: (months: MonthKey[]) => void;
  onNeedMonths: (edge: 'before' | 'after') => void;
  /** The bar's Today: today selected and its month sought. */
  onToday: () => void;
  /** A tap on the month's name: the jump to a date. */
  onJump?: () => void;
  /** Retry on a month's pill: the container asks that month's window again. */
  onRetryMonth: (month: MonthKey, source: SourceName) => void;
  /** "Choose again": the existing select-calendars page. */
  onChooseCalendars: () => void;
  /** The jump's sheet while it is open: the day it opens on, the day picked, and its close. The container holds it (its BackButton closes it). */
  jump?: { value: DayKey; onPick: (day: DayKey) => void; onClose: () => void } | null;
  /** Drag to move; absent: nothing lifts. */
  drag?: MonthDrag;
}

/** The region's size and its bottom safe area (the probe's height). */
type Box = { h: number; w: number; inset: number };

/** The open sheet's item as the selected day's latest rows have it (a refetch may have changed it), else as it was tapped. */
function latestRow(rows: readonly AgendaRow[], selected: AgendaRow): AgendaRow {
  return sameItemRow(rows, selected) ?? selected;
}

function StateIcon() {
  return (
    <svg className="ch-icon ch-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </svg>
  );
}

/** "N calendars aren't available · Choose again", once, at the top of the list (Ruling 4, spec §1). DayPanel brings AGENDA_CSS. */
function UnavailableRow({ count, onChooseCalendars }: { count: number; onChooseCalendars: () => void }) {
  const t = useTranslations('calendarHome');
  return (
    <div className="ch-states">
      <div className="ch-state" role="status">
        <StateIcon />
        <span className="ch-state-text">{t('state.unavailable', { count })}</span>
        <button type="button" className="ch-btn ch-state-action" onClick={onChooseCalendars}>
          {t('actions.chooseAgain')}
        </button>
      </div>
    </div>
  );
}

/**
 * The jump to a date (owner 2026-11-17): the editor's date sheet over the reach's years (1900 …
 * 2100), opening in Gregorian on the selected day or the month in view, with the Gregorian |
 * Hebrew switch while the home shows Hebrew dates.
 */
function JumpSheet({ value, onPick, onClose, today, weekStart, hebrewDates }: NonNullable<MonthViewProps['jump']> & Pick<MonthViewProps, 'today' | 'weekStart' | 'hebrewDates'>) {
  const t = useTranslations('calendarHome');
  return (
    <DatePickerSheet
      label={t('month.jumpSheet')}
      value={value}
      today={today}
      weekStart={weekStart}
      hebrewDates={hebrewDates}
      mode="gregorian"
      minYear={MIN_YEAR_BIRTH}
      onPick={onPick}
      onClose={onClose}
      card
    />
  );
}

export function MonthView(props: MonthViewProps) {
  const { drag, jump, selected, dayRows, today, tz, weekStart, hebrewDates, onSelect, sheetActions } = props;
  const paneRef = useRef<MonthPaneHandle | null>(null);
  const onNav = useCallback((delta: -1 | 1) => paneRef.current?.step(delta), []);
  const sheetRow = selected ? latestRow(dayRows.rows, selected) : null;
  const view = (
    <>
      <MonthRegion {...props} paneRef={paneRef} />
      {sheetRow ? <ItemSheet row={sheetRow} today={today} tz={tz} onClose={() => onSelect(null)} actions={sheetActions} /> : null}
      {jump ? <JumpSheet {...jump} today={today} weekStart={weekStart} hebrewDates={hebrewDates} /> : null}
    </>
  );
  return drag ? (
    <DragLayer {...drag} onNav={onNav}>
      {view}
    </DragLayer>
  ) : (
    view
  );
}

/** The region: measured, then the pane, the handle (upright) and the day's list. */
function MonthRegion({
  today,
  tz,
  weekStart,
  hebrewDates,
  dafYomi,
  months,
  getMonth,
  focus,
  seek,
  split,
  onSplit,
  dayRows,
  unavailableCalendars,
  banners,
  onSelect,
  onSelectDay,
  onMonthInView,
  onNearMonths,
  onNeedMonths,
  onToday,
  onJump,
  onRetryMonth,
  onChooseCalendars,
  paneRef,
}: MonthViewProps & { paneRef: RefObject<MonthPaneHandle | null> }) {
  const wide = useMediaQuery(WIDE_QUERY);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const insetRef = useRef<HTMLSpanElement | null>(null);
  /** The region's size; null until measured (the pane and the list wait for it, before paint). */
  const [box, setBox] = useState<Box | null>(null);

  const measure = useCallback(() => {
    const el = regionRef.current;
    if (!el) return;
    const next = { h: el.clientHeight, w: el.clientWidth, inset: insetRef.current?.clientHeight ?? 0 };
    setBox((was) => (was && was.h === next.h && was.w === next.w && was.inset === next.inset ? was : next));
  }, []);

  // The first measure, before paint.
  useLayoutEffect(() => {
    measure();
  }, [measure]);

  // Then one ResizeObserver on the region (a rotation, Telegram's expand, the header's height)
  // and the probe (Telegram's safe area arriving); where there is none (an old WebView), the
  // window's resizes stand in.
  useEffect(() => {
    const el = regionRef.current;
    if (!el) return;
    let observer: ResizeObserver | null = null;
    if (typeof window.ResizeObserver === 'function') {
      try {
        observer = new window.ResizeObserver(measure);
        observer.observe(el);
        if (insetRef.current) observer.observe(insetRef.current);
      } catch (err) {
        console.warn('[month view] ResizeObserver failed, following the window instead:', err);
        observer = null;
      }
    }
    if (observer) return () => observer.disconnect();
    window.addEventListener('resize', measure, { passive: true });
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const grown = !wide && split === 'grown';
  const heights = box && !wide ? splitHeights(box.h, monthBarPx(hebrewDates), (box.w - GRID_PAD_PX) / 7, grown, box.inset) : null;
  const scrollerPx = heights && heights.scrollerPx > 0 ? heights.scrollerPx : null;

  // Grown, a tap on a square selects it and collapses, so the person sees that day's list.
  const selectDay = useCallback(
    (day: DayKey) => {
      onSelectDay(day);
      if (grown) onSplit('split');
    },
    [onSelectDay, onSplit, grown],
  );
  const collapse = useCallback(() => onSplit('split'), [onSplit]);
  // Retry on the list's failed row: the selected day's month, for that source.
  const selectedDay = focus.selected;
  const retryDay = useCallback((source: SourceName) => onRetryMonth(monthOf(selectedDay), source), [onRetryMonth, selectedDay]);

  const className = wide ? 'ch-mv is-wide' : grown ? 'ch-mv is-split is-grown' : 'ch-mv is-split';
  return (
    <div className={className} ref={regionRef}>
      <style>{MONTH_VIEW_CSS}</style>
      <span className="ch-mv-inset" ref={insetRef} aria-hidden="true" />
      {box ? (
        <>
          <MonthPane
            ref={paneRef}
            months={months}
            today={today}
            weekStart={weekStart}
            hebrewDates={hebrewDates}
            getMonth={getMonth}
            selected={focus.selected}
            seek={seek}
            scrollerPx={scrollerPx}
            onSelectDay={selectDay}
            onMonthInView={onMonthInView}
            onNearMonths={onNearMonths}
            onNeedMonths={onNeedMonths}
            onToday={onToday}
            onJump={onJump}
            onRetryMonth={onRetryMonth}
            onChooseCalendars={onChooseCalendars}
          />
          {wide ? null : (
            <>
              <style>{SPLIT_HANDLE_CSS}</style>
              <SplitHandle grown={grown} onToggle={onSplit} />
            </>
          )}
          <DayPanel
            day={focus.selected}
            today={today}
            tz={tz}
            hebrewDates={hebrewDates}
            dafYomi={dafYomi}
            rows={dayRows.rows}
            status={dayRows.status}
            notices={dayRows.notices}
            onRetry={retryDay}
            onChooseCalendars={onChooseCalendars}
            top={
              banners || unavailableCalendars > 0 ? (
                <>
                  {banners}
                  {unavailableCalendars > 0 ? <UnavailableRow count={unavailableCalendars} onChooseCalendars={onChooseCalendars} /> : null}
                </>
              ) : undefined
            }
            peek={grown}
            onPeek={collapse}
            onOpenItem={onSelect}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * The region's styles, on the home's tokens. The region is the stable viewport less the header
 * and the tab bar (--ch-top-h, published by HomeTop) and the safe areas above it, down to the
 * screen's bottom edge, and clips; inside it a column (upright: the pane at the split's height,
 * the handle, the list filling the rest) or a 2fr 1fr grid (wide: the pane and the list, each
 * the region's height, the list's start edge a separator). The bottom safe area: the list pads
 * its own end by it (DAY_PANEL_CSS), the wide pane by it too (its scroller ends above it, still
 * whole months tall), and .ch-mv-inset, a hidden probe out of the flow, is as tall as it, so the
 * grown split keeps its peek clear of it. The handle's 44 px touch area reaches 22 px over the
 * list's top (never over the pane's last week row), so it sits above it (z-index 1). The split's
 * height change animates on the pane's scroller (its inline block-size is what changes), none
 * under reduced motion. The parts bring their own styles (the pane the squares' and its own,
 * the list the Agenda's rows and its own; the handle's is rendered with it here). Logical
 * properties only; no hover; overflow only on the region (the pane's and the list's scrollers
 * are their own).
 */
export const MONTH_VIEW_CSS = `
.ch-mv {
  position: relative;
  display: flex;
  flex-direction: column;
  block-size: calc(var(--tg-viewport-stable-height, 100dvh) - var(--ch-top-h, 0px) - var(--tg-safe-area-inset-top, 0px) - var(--tg-content-safe-area-inset-top, 0px));
  min-block-size: 0;
  overflow: hidden;
}
.ch-mv-inset {
  position: absolute;
  inset-block-start: 0;
  inset-inline-start: 0;
  inline-size: 0;
  block-size: max(env(safe-area-inset-bottom, 0px), var(--tg-safe-area-inset-bottom, 0px));
  visibility: hidden;
  pointer-events: none;
}
.ch-mv.is-split > .ch-pane {
  flex: none;
}
.ch-mv.is-split > .ch-dp {
  flex: 1 1 0;
  block-size: auto;
  min-block-size: 0;
}
.ch-mv.is-split > .ch-handle {
  z-index: 1;
}
.ch-mv .ch-pane-scroller {
  transition: block-size 200ms ease-out;
}
.ch-mv.is-wide {
  display: grid;
  grid-template-columns: 2fr 1fr;
  grid-template-rows: minmax(0, 1fr);
}
.ch-mv.is-wide > .ch-pane,
.ch-mv.is-wide > .ch-dp {
  min-block-size: 0;
  block-size: 100%;
}
.ch-mv.is-wide > .ch-pane {
  padding-block-end: max(env(safe-area-inset-bottom, 0px), var(--tg-safe-area-inset-bottom, 0px));
}
.ch-mv.is-wide > .ch-dp {
  border-inline-start: 1px solid var(--ch-separator);
}
@media (prefers-reduced-motion: reduce) {
  .ch-mv .ch-pane-scroller {
    transition: none;
  }
}
`;

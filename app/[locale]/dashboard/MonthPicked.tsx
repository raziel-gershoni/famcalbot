'use client';

// The Month's picked layout (spec §7.4 "Tap a day → picked", §7.7, §7.8; Rulings R11
// and R12; Plan E Rulings 4, 5, 6 and 8; the approved MonthPicked.dc.html): one month,
// compact, with the picked day's list under it. Presentational: MonthView (E8) holds
// the layout (month.ts's MonthUi), builds the model with monthModels, passes the day's
// rows (dayRows) and status (dayStatus), and owns Telegram's BackButton and the item
// sheet. From top to bottom:
// - the bar: "All months" (back to browse) and, while a day other than today is
//   selected, the Today pill;
// - the nav: the previous and next chevrons, disabled at the window's ends, around the
//   month's title with its year and, when on, its Hebrew months, read out when it
//   changes (aria-live="polite");
// - the month's notices as rows (failed, busy, calendars gone, partial), with Retry or
//   Choose again. Never a reconnect: the Reconnect banner says it;
// - the weekday row from the week start, then the compact grid: one 48 px button per
//   day of the month, with the Gregorian day, the Hebrew day at 11 px (with the month's
//   short name on Hebrew day 1 and on the month's first day), and up to 3 dots, filled
//   for the viewer's items and a ring for the partner's, in the calendar's colour
//   (spec 2026-10-19 §3.3), then "+N". Daily reminders get
//   no dot (Ruling 5). A loading day shows a placeholder and a failed one is dimmed, so
//   a day looks free only once it is answered;
// - the day: "Today · Thursday, 15 October" (or the weekday and date) with the Hebrew
//   day, then the Agenda's rows (D's ItemRow), daily reminders included. "Nothing
//   planned" shows only once the day is answered and empty; placeholders while it
//   loads; nothing when it failed (the notice above says why).
//
// On mount the page scrolls to the top, so the header, the tabs, the bar, the month and
// the start of the list fit in one screen, and focus goes to the selected day (Ruling 6,
// spec §7.7). On a screen too short for all of that (a 6-row month under the trial and
// location banners on a 375 × 667 phone), it scrolls only as far down as shows the day's
// header and its first row, never past this layout's bar (month.ts's pickedScrollTop).
// When the control that had focus goes away (the Today pill once today is selected, a
// chevron that is disabled at the window's end), focus moves to the selected day as
// well, never to the page.
//
// Each day's button reads like browse's: "Thursday, 15 October, 4 Cheshvan, 3 items,
// 1 from Noa", or "nothing planned", "loading" or "couldn't load" in place of the counts
// (E1's parts, joined with ", "). aria-pressed marks the selected day and
// aria-current="date" today. Blank cells, the days of the months around it, are
// aria-hidden.
//
// Mobile Mini App rules: taps of 44 px or more, nothing under 11 px, logical properties
// only, the chevrons flipped in RTL (.ch-flip), no hover styles. The rows' styles are D's
// AGENDA_CSS, rendered here as well, because the Agenda isn't mounted on the Month tab
// (they also style the item sheet MonthView opens over this layout).

import { useCallback, useEffect, useRef, type MutableRefObject, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { AgendaRow } from '@/src/lib/calendar-view/agenda';
import { formatDayLong, formatMonthTitle, formatWeekdayHeader } from '@/src/lib/calendar-view/format';
import { weekdayOrder, type MonthKey } from '@/src/lib/calendar-view/grid';
import { hebrewCellLabel, hebrewDayLabel, hebrewMonthHeader } from '@/src/lib/calendar-view/hebrew-date';
import { hasChag, holidayTitles, useHolidays } from '@/src/lib/calendar-view/holidays-client';
import { PICKED_CELL_PX, limitDots, pickedScrollTop, type MonthCell, type MonthModel } from '@/src/lib/calendar-view/month';
import type { DayStatus } from '@/src/lib/calendar-view/store';
import type { DayKey, SourceName, WeekStart } from '@/src/lib/calendar-view/types';
import { AGENDA_CSS } from './AgendaView';
import { PlaceholderRows } from './DayList';
import { ItemRow, calendarMark, useItemTitle, type ItemRowProps } from './ItemRow';
import { useDayDrop, useItemDrag, useNavDrop } from './DragSurface';

export interface MonthPickedProps {
  /** The picked month's model (monthModels(store)(ui.month)). */
  model: MonthModel;
  /** The selected day: a day of model.month. */
  selected: DayKey;
  today: DayKey;
  tz: string;
  weekStart: WeekStart;
  hebrewDates: boolean;
  /** canStep(ui, -1, today) and canStep(ui, 1, today): false at the window's ends. */
  canPrev: boolean;
  canNext: boolean;
  /** The selected day's rows (dayRows: the Agenda's, daily reminders included) and its status (dayStatus). */
  rows: AgendaRow[];
  dayStatus: DayStatus;
  /** A tap on another day. Never called with the day already selected. */
  onSelectDay: (day: DayKey) => void;
  onPrev: () => void;
  onNext: () => void;
  /** The Today pill: today selected, in today's month. */
  onToday: () => void;
  /** "All months": back to browse, with this month under the bar. */
  onAllMonths: () => void;
  /** A tap on a row: open its item sheet. */
  onOpenItem: (row: AgendaRow) => void;
  /** Retry on a notice: ask the month again, for that source. */
  onRetryMonth: (month: MonthKey, source: SourceName) => void;
  /** "Choose again" (calendars gone): the existing select-calendars page. */
  onChooseCalendars: () => void;
}

/** A row of the picked day's list, lifted from that day (drag to move; the Agenda's rows never are, so the library stays in the Month's chunk). */
function LiftableRow(props: ItemRowProps) {
  const { item } = props.row;
  const title = useItemTitle(item);
  const lift = useItemDrag({ key: item.key, title, canEdit: item.canEdit, repeatsEveryDay: item.repeatsEveryDay }, props.day);
  return <ItemRow {...props} lift={lift} />;
}

/** A day of the compact grid: a button, and a drop target while an item is lifted (drag to move). */
function PickedCell({
  cell,
  selected,
  selectedRef,
  label,
  onSelect,
  children,
}: {
  cell: MonthCell;
  selected: boolean;
  selectedRef: MutableRefObject<HTMLButtonElement | null>;
  label: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  const target = useDayDrop(cell.day);
  const dropRef = target.props.ref as ((node: HTMLElement | null) => void) | undefined;
  // Stable, so the library's node registration is not redone on every render.
  const setRef = useCallback(
    (node: HTMLButtonElement | null) => {
      if (selected) selectedRef.current = node;
      dropRef?.(node);
    },
    [selected, selectedRef, dropRef],
  );
  const state = cell.status === 'loading' ? ' is-loading' : cell.status === 'failed' ? ' is-failed' : '';
  return (
    <button
      ref={setRef}
      type="button"
      className={`ch-mp-cell${cell.today ? ' is-today' : ''}${state}${target.over ? ' is-drop' : ''}`}
      aria-label={label}
      aria-pressed={selected}
      aria-current={cell.today ? 'date' : undefined}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}

/** A month chevron: a button, and a drop target while an item is lifted (600 ms over it turns the month). */
function NavButton({ side, label, disabled, onClick }: { side: 'prev' | 'next'; label: string; disabled: boolean; onClick: () => void }) {
  const target = useNavDrop(side);
  return (
    <button {...target.props} type="button" className={`ch-mp-chev${target.over ? ' is-drop-nav' : ''}`} aria-label={label} disabled={disabled} onClick={onClick}>
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

/** The notice's icon, as the Agenda's state rows draw it. */
function StateIcon() {
  return (
    <svg className="ch-icon ch-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </svg>
  );
}

type NoticeRow = { key: string; text: string; action: string; onAction: () => void };

/**
 * The month's notices (Ruling 4) as the Agenda's state rows: failed with an error →
 * "Couldn't load this month", busy → "Busy…", calendars gone → "Your calendars aren't
 * available" with Choose again, partial → "Some calendars didn't load"; each of the
 * others with Retry for its source. A reconnect never makes a row.
 */
function NoticeRows({ model, onRetryMonth, onChooseCalendars }: Pick<MonthPickedProps, 'model' | 'onRetryMonth' | 'onChooseCalendars'>) {
  const t = useTranslations('calendarHome');
  const rows: NoticeRow[] = [];
  for (const notice of model.notices) {
    const retry = () => onRetryMonth(model.month, notice.source);
    const key = `${notice.kind}-${notice.source}`;
    if (notice.kind === 'partial') {
      rows.push({ key, text: t('state.partial'), action: t('actions.retry'), onAction: retry });
      continue;
    }
    const failure = notice.failure;
    if (failure?.kind === 'reconnect') continue;
    if (failure?.kind === 'calendarsGone') rows.push({ key, text: t('state.calendarsGone'), action: t('actions.chooseAgain'), onAction: onChooseCalendars });
    else if (failure?.kind === 'busy') rows.push({ key, text: t('state.busy'), action: t('actions.retry'), onAction: retry });
    else rows.push({ key, text: t('month.failed'), action: t('actions.retry'), onAction: retry });
  }
  if (rows.length === 0) return null;
  return (
    <div className="ch-states ch-mp-states">
      {rows.map((row) => (
        <div key={row.key} className="ch-state" role="status">
          <StateIcon />
          <span className="ch-state-text">{row.text}</span>
          <button type="button" className="ch-btn ch-state-action" onClick={row.onAction}>
            {row.action}
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * A day's accessible name, as browse's cells read (E1's parts joined with ", "): the
 * weekday and date, the Hebrew day when it's on, then the drawn items and how many are
 * the partner's, then "loading" / "couldn't load", or "nothing planned" when answered and empty.
 */
function useCellLabel(partner: string | null, hebrewDates: boolean): (cell: MonthCell) => string {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  // calendarHome.hebrewMonthGenitive: only Russian reads it (Ruling R9).
  const genitive = hebrewDates && locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined;
  return (cell) => {
    const parts = [formatDayLong(cell.day, locale)];
    if (hebrewDates) parts.push(hebrewDayLabel(cell.day, locale, genitive));
    if (cell.count > 0) {
      parts.push(t('month.cellItems', { count: cell.count }));
      if (cell.fromPartner > 0 && partner) parts.push(t('month.cellFromPartner', { count: cell.fromPartner, name: partner }));
    }
    if (cell.status !== 'answered') parts.push(cell.status === 'loading' ? t('month.cellLoading') : t('month.cellFailed'));
    else if (cell.count === 0) parts.push(t('month.cellNothing'));
    return parts.filter((part) => part !== '').join(', ');
  };
}

/** A day's marks: up to PICKED_DOTS dots (filled: the viewer's; a ring: the partner's), then "+N"; a placeholder while it loads. */
function Marks({ cell }: { cell: MonthCell }) {
  const t = useTranslations('calendarHome');
  if (cell.count === 0 && cell.status === 'loading') return <span className="ch-mp-ghost" />;
  const { shown, more } = limitDots(cell.dots);
  return (
    <>
      {shown.map((dot, i) => {
        const cal = calendarMark(dot.color);
        return <span key={i} className={`ch-mp-dot ${dot.mine ? 'is-mine' : 'is-partner'}${cal.className}`} style={cal.style} />;
      })}
      {more > 0 ? (
        <span className="ch-mp-more" dir="ltr">
          {t('month.moreShort', { count: more })}
        </span>
      ) : null}
    </>
  );
}

/** Which control a tap left focus on, if it may go away (the Today pill) or be disabled (a chevron at an end). */
type Refocus = 'today' | 'prev' | 'next' | null;

/**
 * Where entering picked scrolls the page (Ruling 6, pickedScrollTop): from where the
 * layout starts, less its scroll margin (the safe areas it stops under), and where the
 * day's header ends, in the document, and the screen's height. The top (0) wherever the
 * page can't be measured.
 */
function enterTop(layout: HTMLElement | null, dayHead: HTMLElement | null): number {
  try {
    if (!layout || !dayHead || typeof layout.getBoundingClientRect !== 'function' || typeof dayHead.getBoundingClientRect !== 'function') return 0;
    const y = window.scrollY || 0;
    let margin = 0;
    try {
      const style = window.getComputedStyle(layout);
      margin = Number.parseFloat(style.scrollMarginBlockStart || style.scrollMarginTop) || 0;
    } catch {
      // No scroll margin to read: the layout goes to the very top.
    }
    return pickedScrollTop(layout.getBoundingClientRect().top + y - margin, dayHead.getBoundingClientRect().bottom + y, window.innerHeight || 0);
  } catch {
    return 0;
  }
}

export function MonthPicked({
  model,
  selected,
  today,
  tz,
  weekStart,
  hebrewDates,
  canPrev,
  canNext,
  rows,
  dayStatus,
  onSelectDay,
  onPrev,
  onNext,
  onToday,
  onAllMonths,
  onOpenItem,
  onRetryMonth,
  onChooseCalendars,
}: MonthPickedProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const label = useCellLabel(model.partner, hebrewDates);
  const selectedCell = useRef<HTMLButtonElement | null>(null);
  const layout = useRef<HTMLElement | null>(null);
  const dayHead = useRef<HTMLHeadingElement | null>(null);
  const refocus = useRef<Refocus>(null);

  // Entering picked (Ruling 6, spec §7.7): the page to the top (or, on a short screen, as
  // far down as shows the day's header and first row), focus on the selected day.
  useEffect(() => {
    window.scrollTo(0, enterTop(layout.current, dayHead.current));
    selectedCell.current?.focus({ preventScroll: true });
  }, []);

  // After a tap on Today or a chevron: when that control is gone or disabled, focus goes
  // to the selected day rather than to the page.
  useEffect(() => {
    const from = refocus.current;
    refocus.current = null;
    if (from === 'today' || (from === 'prev' && !canPrev) || (from === 'next' && !canNext)) {
      selectedCell.current?.focus({ preventScroll: true });
    }
  }, [selected, canPrev, canNext]);

  // calendarHome.hebrewMonthGenitive (Russian only) and hebrewMonthShort (14 names each, D2's HEBREW_MONTHS order).
  const genitive = hebrewDates && locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined;
  const shortMonths = hebrewDates ? (t.raw('hebrewMonthShort') as string[]) : undefined;
  const range = hebrewDates ? hebrewMonthHeader(model.month, locale) : '';
  const date = formatDayLong(selected, locale);
  const dayTitle = selected === today ? t('month.dayToday', { date }) : date;
  const dayHebrew = hebrewDates ? hebrewDayLabel(selected, locale, genitive) : '';
  const dayHolidays = useHolidays([selected.slice(0, 7)], locale, hebrewDates)[selected];
  const loading = dayStatus === 'loading';

  return (
    <section className="ch-mp" dir={locale === 'he' ? 'rtl' : 'ltr'} ref={layout}>
      <style>{AGENDA_CSS}</style>
      <style>{MONTH_PICKED_CSS}</style>
      <div className="ch-mp-bar">
        <button type="button" className="ch-mp-back" onClick={onAllMonths}>
          <Chevron back />
          <span>{t('month.allMonths')}</span>
        </button>
        {selected !== today ? (
          <button
            type="button"
            className="ch-mp-today"
            onClick={() => {
              refocus.current = 'today';
              onToday();
            }}
          >
            <span className="ch-mp-today-pill">{t('month.today')}</span>
          </button>
        ) : null}
      </div>
      <div className="ch-mp-nav">
        <NavButton
          side="prev"
          label={t('month.previous')}
          disabled={!canPrev}
          onClick={() => {
            refocus.current = 'prev';
            onPrev();
          }}
        />
        <h2 className="ch-mp-title" aria-live="polite">
          <span className="ch-mp-month">{formatMonthTitle(model.month, locale, true)}</span>
          {range ? <span className="ch-mp-range">{range}</span> : null}
        </h2>
        <NavButton
          side="next"
          label={t('month.next')}
          disabled={!canNext}
          onClick={() => {
            refocus.current = 'next';
            onNext();
          }}
        />
      </div>
      <NoticeRows model={model} onRetryMonth={onRetryMonth} onChooseCalendars={onChooseCalendars} />
      <div className="ch-mp-weekdays" aria-hidden="true">
        {weekdayOrder(weekStart).map((weekday) => (
          <span key={weekday}>{formatWeekdayHeader(weekday, locale)}</span>
        ))}
      </div>
      <div className="ch-mp-grid">
        {model.weeks.flat().map((cell) => {
          if (!cell.inMonth) return <span key={`blank-${cell.day}`} className="ch-mp-cell ch-mp-blank" aria-hidden="true" />;
          const isSelected = cell.day === selected;
          return (
            <PickedCell
              key={cell.day}
              cell={cell}
              selected={isSelected}
              selectedRef={selectedCell}
              label={label(cell)}
              onSelect={() => {
                if (!isSelected) onSelectDay(cell.day);
              }}
            >
              <span className="ch-mp-num" aria-hidden="true">
                {Number(cell.day.slice(8, 10))}
              </span>
              {hebrewDates ? (
                <span className="ch-mp-heb" aria-hidden="true">
                  {hebrewCellLabel(cell.day, locale, cell.hebrewMonthStart, shortMonths)}
                </span>
              ) : null}
              <span className="ch-mp-marks" aria-hidden="true">
                <Marks cell={cell} />
              </span>
            </PickedCell>
          );
        })}
      </div>
      <section className="ch-mp-list" aria-labelledby="ch-mp-day" aria-busy={loading || undefined}>
        <h3 className="ch-mp-day" id="ch-mp-day" ref={dayHead}>
          <span className="ch-mp-day-label">{dayTitle}</span>
          {dayHebrew ? (
            <>
              {' '}
              <span className="ch-mp-day-hebrew">{dayHebrew}</span>
            </>
          ) : null}
          {dayHolidays && dayHolidays.length > 0 ? (
            <>
              {' '}
              <span className={hasChag(dayHolidays) ? 'ch-day-holiday is-chag' : 'ch-day-holiday'}>
                <bdi>{holidayTitles(dayHolidays)}</bdi>
              </span>
            </>
          ) : null}
        </h3>
        {rows.length > 0 ? (
          <ul className="ch-list" role="list">
            {rows.map((row) => (
              <LiftableRow key={row.item.key} row={row} day={selected} tz={tz} onOpen={onOpenItem} />
            ))}
          </ul>
        ) : null}
        {rows.length === 0 && dayStatus === 'answered' ? <p className="ch-mp-nothing">{t('agenda.nothingPlanned')}</p> : null}
        {loading ? <PlaceholderRows count={rows.length > 0 ? 1 : 2} /> : null}
      </section>
    </section>
  );
}

/**
 * The picked layout's styles. They read the tokens APP_THEME_CSS (components/app-ui/theme.ts) puts
 * on .ch-app (D's, and E4's --ch-dot-*, --ch-today*, --ch-selected*, --ch-pill-* and
 * --ch-disabled), and D's AGENDA_CSS supplies the rows, the notices' state rows, the
 * placeholders and the pulse. A cell is PICKED_CELL_PX tall: its 1 px top line, 2 px,
 * the 24 px day, the 12 px Hebrew line and 1 px, then the 8 px marks. Logical properties
 * only; nothing under 11 px; every tap at least 44 px; no hover; overflow: hidden only on
 * the Hebrew line, a leaf, for its ellipsis.
 */
export const MONTH_PICKED_CSS = `
.ch-mp {
  padding-block-end: calc(24px + max(env(safe-area-inset-bottom, 0px), var(--tg-safe-area-inset-bottom, 0px)));
  scroll-margin-block-start: calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px));
}
.ch-mp-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-block: 6px 0;
  margin-inline: 8px;
}
.ch-mp-back {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-height: 44px;
  min-width: 44px;
  margin: 0;
  padding-block: 0;
  padding-inline: 4px 10px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--ch-accent);
  font-family: inherit;
  font-size: 15px;
  font-weight: 500;
  line-height: 1.2;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-mp-today {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  min-width: 44px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  font-family: inherit;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-mp-today-pill {
  display: inline-flex;
  align-items: center;
  block-size: 36px;
  padding-inline: 14px;
  border: 1px solid var(--ch-pill-line);
  border-radius: 18px;
  background: var(--ch-pill-bg);
  color: var(--ch-pill-text);
  font-size: 14px;
  font-weight: 500;
  line-height: 1.2;
}
.ch-mp-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  margin-block: 0 2px;
  margin-inline: 8px;
}
.ch-mp-chev {
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
.ch-mp-chev:disabled {
  color: var(--ch-disabled);
  cursor: default;
}
.ch-mp-back svg,
.ch-mp-chev svg {
  flex: none;
  inline-size: 22px;
  block-size: 22px;
}
.ch-mp-back:focus-visible,
.ch-mp-today:focus-visible,
.ch-mp-chev:focus-visible,
.ch-mp-cell:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: -2px;
}
.ch-mp-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 17px;
  font-weight: 400;
  text-align: center;
}
.ch-mp-month {
  display: block;
  font-size: 17px;
  font-weight: 600;
  line-height: 22px;
}
.ch-mp-range {
  display: block;
  font-size: 13px;
  line-height: 18px;
  color: var(--ch-muted);
}
.ch-mp-states {
  margin-block: 8px 4px;
}
.ch-mp-weekdays {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  padding-block: 6px 4px;
  padding-inline: 6px;
  border-block-end: 1px solid var(--ch-separator);
  font-size: 12px;
  line-height: 16px;
  color: var(--ch-muted);
  text-align: center;
}
.ch-mp-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  margin-inline: 6px;
}
.ch-mp-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 0;
  block-size: ${PICKED_CELL_PX}px;
  min-height: 44px;
  margin: 0;
  padding-block: 2px 0;
  padding-inline: 0;
  border: 0;
  border-block-start: 1px solid var(--ch-separator);
  background: transparent;
  color: var(--ch-text);
  font-family: inherit;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-mp-blank {
  border-block-start-color: transparent;
  cursor: default;
}
.ch-mp-num {
  display: flex;
  align-items: center;
  justify-content: center;
  inline-size: 24px;
  block-size: 24px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.ch-mp-cell.is-today .ch-mp-num {
  color: var(--ch-accent);
  font-weight: 600;
}
.ch-mp-cell.is-failed .ch-mp-num {
  color: var(--ch-muted);
}
.ch-mp-cell[aria-pressed='true'] .ch-mp-num {
  background: var(--ch-selected);
  color: var(--ch-selected-text);
  font-weight: 600;
}
.ch-mp-cell.is-today[aria-pressed='true'] .ch-mp-num {
  background: var(--ch-today);
  color: var(--ch-today-text);
}
.ch-mp-heb {
  display: block;
  max-inline-size: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 12px;
  color: var(--ch-muted);
}
.ch-mp-marks {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  block-size: 8px;
  margin-block-start: 1px;
}
.ch-mp-dot {
  flex: none;
  inline-size: 6px;
  block-size: 6px;
  border-radius: 3px;
}
.ch-mp-dot.is-mine {
  background: var(--ch-dot-mine);
}
.ch-mp-dot.is-partner {
  border: 1.5px solid var(--ch-dot-partner);
}
.ch-mp-dot.has-cal.is-mine {
  background: var(--cal-line);
}
.ch-mp-dot.has-cal.is-partner {
  border-color: var(--cal-line);
}
.ch-mp-more {
  font-size: 11px;
  line-height: 8px;
  color: var(--ch-muted);
}
.ch-mp-ghost {
  inline-size: 16px;
  block-size: 6px;
  border-radius: 3px;
  background: var(--ch-outline);
  animation: ch-pulse 1.4s ease-in-out infinite;
}
.ch-mp-day {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 8px;
  margin-block: 16px 2px;
  margin-inline: 16px;
  font-size: 14px;
  font-weight: 400;
  line-height: 1.35;
}
.ch-mp-day-label {
  font-weight: 600;
}
.ch-mp-day-label::first-letter {
  text-transform: uppercase;
}
.ch-mp-day-hebrew {
  color: var(--ch-muted);
}
.ch-mp-nothing {
  margin-block: 8px 0;
  margin-inline: 16px;
  padding: 14px;
  border-radius: 12px;
  background: var(--ch-surface);
  color: var(--ch-muted);
  font-size: 14px;
}
`;

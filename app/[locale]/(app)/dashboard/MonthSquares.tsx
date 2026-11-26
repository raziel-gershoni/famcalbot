'use client';

// The one Month screen's day squares (responsive home, release 2; spec §4, decisions 2 and
// 3; Plan E Rulings 3 and 4; Rulings R11 and R12; release 2 Ruling 1): one month's weeks,
// sharing its block's height (grid-template-rows: repeat(<weeks>, 1fr)), each day of the
// month one button whose size class (month-layout.ts's squareSize, measured by the pane)
// decides what it draws. Presentational: the pane builds the model and measures the size.
// The parts are copied from the two Month screens this replaces, not rewritten:
//
// - small (under 60 px high or 44 wide): the tapped-day screen's cell (release 1). The day, the Hebrew day (with
//   the Hebrew month's short name on Hebrew day 1 and on the month's first day) and the
//   dots: up to 3, filled for the viewer's items and a ring for the partner's, in the
//   calendar's colour, then "+N". Size container queries keep it whole from 48 px down to
//   about 30 (a sideways phone): an 18 px day under 48, the day and the Hebrew day on one
//   line under 42.
// - medium (under 82 px high): the small square plus All months' holiday line between
//   the Hebrew day and the dots, by browse's rule: the day's highest-priority holiday's
//   brief (a yom tov in the accent); where browse would name the Hebrew month instead (the
//   portion never beats it), the line is empty, as the Hebrew day already names it. The
//   line is always there, so a row's days line up.
// - large: All months' cell (release 1). The head line (the day, the Hebrew day at its end), the
//   line (the holiday by the same rule, or the Hebrew month's short name when due), then
//   month.ts's fitRow over the week for the size's lines: chips and bars (bars joined
//   across days, named on their first day in each week row), "+N more" as the last line
//   when more items exist than fit, and the anniversary count pill when the chip is wide
//   enough (a container query on the slot). Big squares (110 × 100 and more) draw 13 px
//   chips in 21 px slots under a taller head.
//
// Daily-repeating reminders are left out of every square (R11): month.ts keeps them out of
// the slots, the dots and the counts. A loading day shows a placeholder and a failed one
// is dimmed, so a day never looks free before it is answered (§5), and a month's failure
// is a pill centred over it, a partial answer a pill at its top (All months' pills, Ruling
// 1). Every square is a drop target while an item is lifted (drag to move), and a chip in
// a large square lifts as browse's chips did; the drop outline is DRAG_CSS's .is-drop.
//
// Each square's label reads the whole day as browse's cells did ("Thursday, 15 October, 4
// Cheshvan, Shmini Atzeret, 3 items, 1 from Noa"; "loading", "couldn't load" or "nothing
// planned"); aria-current="date" marks today and aria-pressed the selected day; the parts
// inside, the blank days of the rows around the month and the pills' overlay box are
// aria-hidden or plain. A tap on a square selects its day, also the day already selected
// (the grown split collapses on it).
//
// Mobile Mini App rules: nothing under 11 px, logical properties only, no hover styles, the
// theme's tokens only. The squares are the one tap under 44 px (spec §1: rows as short as
// 36 px, and about 30 sideways); the pills' buttons keep 44. MONTH_SQUARES_CSS is rendered
// once by the pane, not by each month.

import { memo, type CSSProperties } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formatDayLong } from '@/src/lib/calendar-view/format';
import type { MonthKey } from '@/src/lib/calendar-view/grid';
import { hebrewCellLabel, hebrewCellMonth, hebrewDayLabel, isHebrewMonthStart } from '@/src/lib/calendar-view/hebrew-date';
import { holidayTitles, isPortion, useHolidays } from '@/src/lib/calendar-view/holidays-client';
import { fitRow, limitDots, noticeCopy, type MonthCell, type MonthModel, type MonthNotice, type MonthSlot } from '@/src/lib/calendar-view/month';
import { GRID_PAD_PX, type SquareSize } from '@/src/lib/calendar-view/month-layout';
import type { DayKey, Holiday, SourceName } from '@/src/lib/calendar-view/types';
import { calendarMark } from './ItemRow';
import { useDayDrop, useItemDrag } from './DragSurface';

export interface MonthSquaresGridProps {
  /** The month's model: monthModels(store)(month), or loadingMonth while it has none. */
  model: MonthModel;
  month: MonthKey;
  /** The home's today (the model's cells carry it as cell.today). */
  today: DayKey;
  /** The day the list shows: pressed when it is a day of this month. */
  selected: DayKey;
  hebrewDates: boolean;
  /** squareSize of the month's measured squares: what each one draws. */
  size: SquareSize;
  /** A tap on a day, the selected one included. */
  onSelectDay: (day: DayKey) => void;
  /** Retry on the month's failed or partial pill. */
  onRetryMonth: (month: MonthKey, source: SourceName) => void;
  /** "Choose again" on a calendars-gone pill: the existing select-calendars page. */
  onChooseCalendars: () => void;
}

/**
 * One slot of a large square: a spacer's empty line, or a chip or bar day. Filled for the
 * viewer's, outlined for the partner's, in the calendar's colour (spec 2026-10-19 §3.3), or
 * E4's tokens without one. The chip keeps the grid's direction, so a bar's logical joins
 * (is-before, is-after) meet the next day in Hebrew too; only the title is isolated
 * (<bdi>), so a Hebrew title in English, or an English one in Hebrew, reads in its own
 * direction. With a day, it lifts (drag to move; inert outside a DragLayer).
 */
export function SquareChip({ slot, noTitle, day }: { slot: MonthSlot; noTitle: string; day?: DayKey }) {
  if (slot.kind === 'spacer' || !slot.key) return <span className="ch-sq-slot" />;
  return <Chip slot={slot} noTitle={noTitle} day={day} />;
}

/** A chip or bar day; the chip is the drag handle, so a press on the square's empty part still taps. */
function Chip({ slot, noTitle, day }: { slot: MonthSlot; noTitle: string; day?: DayKey }) {
  const lift = useItemDrag({ key: slot.key ?? '', title: slot.title && slot.title.trim() !== '' ? slot.title : noTitle, canEdit: slot.canEdit, repeatsEveryDay: slot.repeatsEveryDay }, day ?? '');
  const cal = calendarMark(slot.color);
  const look = slot.kind === 'timed' ? (slot.mine ? 'is-mine-timed' : 'is-partner-timed') : slot.mine ? 'is-mine-solid' : 'is-partner-solid';
  const className =
    [
      'ch-sq-chip',
      `is-${slot.kind}`,
      look,
      slot.continuesBefore ? 'is-before' : '',
      slot.continuesAfter ? 'is-after' : '',
      slot.done ? 'is-done' : '',
      slot.showTitle && slot.count ? 'has-count' : '',
    ]
      .filter(Boolean)
      .join(' ') +
    cal.className +
    (day ? lift.className : '');
  const title = slot.showTitle ? (slot.title && slot.title.trim() !== '' ? slot.title : noTitle) : '';
  return (
    <span className="ch-sq-slot">
      <span className={className} style={cal.style} {...(day ? lift.props : {})}>
        {title ? <bdi className={slot.count ? 'ch-sq-chip-title' : undefined}>{title}</bdi> : null}
        {title && slot.count ? (
          <span className="ch-sq-count" aria-hidden="true">
            {slot.count}
          </span>
        ) : null}
      </span>
    </span>
  );
}

/** A small or medium square's marks: up to 3 dots (filled: the viewer's; a ring: the partner's), then "+N"; a placeholder while it loads. */
function Dots({ cell }: { cell: MonthCell }) {
  const t = useTranslations('calendarHome');
  if (cell.count === 0 && cell.status === 'loading') return <span className="ch-sq-dot-ghost" />;
  const { shown, more } = limitDots(cell.dots);
  return (
    <>
      {shown.map((dot, i) => {
        const cal = calendarMark(dot.color);
        return <span key={i} className={`ch-sq-dot ${dot.mine ? 'is-mine' : 'is-partner'}${cal.className}`} style={cal.style} />;
      })}
      {more > 0 ? (
        <span className="ch-sq-plus" dir="ltr">
          {t('month.moreShort', { count: more })}
        </span>
      ) : null}
    </>
  );
}

export interface SquareProps {
  cell: MonthCell;
  /** The partner's name, for the label's "N from <partner>". */
  partner: string | null;
  hebrewDates: boolean;
  size: SquareSize;
  /** The day the list shows. */
  selected: boolean;
  /** A large square's slots and the items left for "+N" (fitRow); empty and 0 otherwise. */
  shown: readonly MonthSlot[];
  more: number;
  /** calendarHome.hebrewMonthGenitive, Russian only (the label's Hebrew day, Ruling R9). */
  genitive: readonly string[] | undefined;
  /** calendarHome.hebrewMonthShort (the Hebrew month's short name). */
  shortMonths: readonly string[] | undefined;
  /** The day's Hebrew holidays, highest priority first (none while Hebrew dates are off or the month hasn't landed). */
  holidays: readonly Holiday[] | undefined;
  noTitle: string;
  onSelectDay: (day: DayKey) => void;
}

/** A day of the month's rows: a blank day of another month holds nothing and takes no drop; a day of the month is LiveSquare. */
export function Square(props: SquareProps) {
  return props.cell.inMonth ? <LiveSquare {...props} /> : <span className="ch-sq is-blank" aria-hidden="true" />;
}

function LiveSquare({ cell, partner, hebrewDates, size, selected, shown, more, genitive, shortMonths, holidays, noTitle, onSelectDay }: SquareProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  // The day is a drop target while an item is lifted (drag to move): the outline is the day under the finger.
  const target = useDayDrop(cell.day);

  const large = size.kind === 'large';
  const hebrewMonth = hebrewDates && cell.hebrewMonthStart ? hebrewCellMonth(cell.day, locale, shortMonths) : '';
  // The line holds the Hebrew month's name on its first day (Rosh Chodesh is implied),
  // unless that day is a yom tov (1 Tishrei shows Rosh Hashana); every other day it holds
  // the day's highest-priority holiday. The month's first day, when it isn't Hebrew day 1,
  // gives its name up to a holiday.
  const holiday = holidays?.[0];
  // The weekly portion (a Saturday's) is no holiday here: the month name keeps the month's first day.
  const showHoliday = holiday !== undefined && (!hebrewMonth || (!isHebrewMonthStart(cell.day) && !isPortion(holiday)) || holiday.chag);
  // Small and medium squares name the month on their Hebrew day, so their line is the holiday alone.
  const line = showHoliday ? holiday.brief : large ? hebrewMonth : '';

  const parts = [formatDayLong(cell.day, locale)];
  if (hebrewDates) {
    const full = hebrewDayLabel(cell.day, locale, genitive);
    if (full) parts.push(full);
    if (holidays && holidays.length > 0) parts.push(holidayTitles(holidays));
  }
  if (cell.count > 0) {
    parts.push(t('month.cellItems', { count: cell.count }));
    if (cell.fromPartner > 0 && partner) parts.push(t('month.cellFromPartner', { count: cell.fromPartner, name: partner }));
  }
  if (cell.status === 'loading') parts.push(t('month.cellLoading'));
  else if (cell.status === 'failed') parts.push(t('month.cellFailed'));
  else if (cell.count === 0) parts.push(t('month.cellNothing'));

  const className = ['ch-sq', cell.today ? 'is-today' : '', cell.status === 'loading' ? 'is-loading' : '', cell.status === 'failed' ? 'is-failed' : '', target.over ? 'is-drop' : '']
    .filter(Boolean)
    .join(' ');
  const lineEl =
    large || size.kind === 'medium' ? (
      <span className={showHoliday && holiday.chag ? 'ch-sq-line has-chag' : 'ch-sq-line'} dir={showHoliday ? 'auto' : undefined} aria-hidden="true">
        {line}
      </span>
    ) : null;
  const day = (
    <span className="ch-sq-num" dir="ltr">
      {Number(cell.day.slice(8, 10))}
    </span>
  );

  if (!large) {
    return (
      <button {...target.props} type="button" className={className} aria-label={parts.join(', ')} aria-pressed={selected} aria-current={cell.today ? 'date' : undefined} onClick={() => onSelectDay(cell.day)}>
        <span className="ch-sq-top" aria-hidden="true">
          {day}
          {hebrewDates ? <span className="ch-sq-heb">{hebrewCellLabel(cell.day, locale, cell.hebrewMonthStart, shortMonths)}</span> : null}
        </span>
        {lineEl}
        <span className="ch-sq-marks" aria-hidden="true">
          <Dots cell={cell} />
        </span>
      </button>
    );
  }

  // A day still loading never looks free: a placeholder in the next free line.
  const placeholder = cell.status === 'loading' && more === 0 && shown.length < size.lines;
  const hebrewDay = hebrewDates ? hebrewCellLabel(cell.day, locale, false) : '';
  return (
    <button {...target.props} type="button" className={className} aria-label={parts.join(', ')} aria-pressed={selected} aria-current={cell.today ? 'date' : undefined} onClick={() => onSelectDay(cell.day)}>
      <span className="ch-sq-head" aria-hidden="true">
        {day}
        {hebrewDay ? <span className="ch-sq-hday">{hebrewDay}</span> : null}
      </span>
      {lineEl}
      <span className="ch-sq-slots" aria-hidden="true">
        {shown.map((slot, i) => (
          <SquareChip key={i} slot={slot} noTitle={noTitle} day={cell.day} />
        ))}
        {more > 0 ? (
          <span className="ch-sq-slot">
            <span className="ch-sq-more">{t('month.more', { count: more })}</span>
          </span>
        ) : null}
        {placeholder ? (
          <span className="ch-sq-slot">
            <span className="ch-sq-ghost" />
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** A month's notice (Ruling 4): busy, calendars gone or an error, or a partial answer. */
function NoticePill({ notice, month, onRetryMonth, onChooseCalendars }: { notice: MonthNotice; month: MonthKey; onRetryMonth: MonthSquaresGridProps['onRetryMonth']; onChooseCalendars: () => void }) {
  const t = useTranslations('calendarHome');
  const copy = noticeCopy(notice);
  return (
    <div className="ch-sq-pill">
      <span className="ch-sq-pill-text">{t(copy.text)}</span>
      <button type="button" className="ch-btn ch-sq-pill-action" onClick={copy.chooseAgain ? onChooseCalendars : () => onRetryMonth(month, notice.source)}>
        {t(copy.action)}
      </button>
    </div>
  );
}

const NO_SLOTS: readonly MonthSlot[] = [];

/** A month's squares and its pills. Memoized: a scroll that changes only the pane's bar leaves it alone. */
export const MonthSquaresGrid = memo(function MonthSquaresGrid({ model, month, selected, hebrewDates, size, onSelectDay, onRetryMonth, onChooseCalendars }: MonthSquaresGridProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const genitive = hebrewDates && locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined;
  const shortMonths = hebrewDates ? (t.raw('hebrewMonthShort') as string[]) : undefined;
  const holidays = useHolidays([month], locale, hebrewDates);
  const noTitle = t('row.noTitle');
  const failed = model.notices.filter((n) => n.kind === 'failed');
  const partial = model.notices.filter((n) => n.kind === 'partial');
  const large = size.kind === 'large';
  const gridClass = `ch-sq-grid is-${size.kind}${large && size.big ? ' is-big' : ''}`;
  const rows: CSSProperties = { gridTemplateRows: `repeat(${model.weeks.length}, 1fr)` };
  return (
    <div className="ch-sq-body" dir={locale === 'he' ? 'rtl' : 'ltr'}>
      {partial.length > 0 ? (
        <div className="ch-sq-overlay is-top">
          {partial.map((n) => (
            <NoticePill key={`partial-${n.source}`} notice={n} month={month} onRetryMonth={onRetryMonth} onChooseCalendars={onChooseCalendars} />
          ))}
        </div>
      ) : null}
      {failed.length > 0 ? (
        <div className="ch-sq-overlay is-centre">
          {failed.map((n) => (
            <NoticePill key={`failed-${n.source}`} notice={n} month={month} onRetryMonth={onRetryMonth} onChooseCalendars={onChooseCalendars} />
          ))}
        </div>
      ) : null}
      <div className={gridClass} style={rows}>
        {model.weeks.map((row) => {
          const fitted = large ? fitRow(row, size.lines) : null;
          return row.map((cell, col) => (
            <Square
              key={cell.day}
              cell={cell}
              partner={model.partner}
              hebrewDates={hebrewDates}
              size={size}
              selected={cell.day === selected}
              shown={fitted?.[col].shown ?? NO_SLOTS}
              more={fitted?.[col].more ?? 0}
              genitive={genitive}
              shortMonths={shortMonths}
              holidays={holidays[cell.day]}
              noTitle={noTitle}
              onSelectDay={onSelectDay}
            />
          ));
        })}
      </div>
    </div>
  );
});

/**
 * The squares' styles. They read the tokens APP_THEME_CSS (components/app-ui/theme.ts) puts on
 * .ch-app: D's, and E4's --ch-dot-*, --ch-today*, --ch-selected* and the calendar colours'
 * --cal-fill, --cal-text and --cal-line. The heights add up to month-layout.ts's:
 * - large: a square's 1 px rule, 3 px, the 18 px head and the 13 px line are SQUARE_USED_PX
 *   (35), then SQUARE_SLOT_PX (18) slots; big: 21 px head and 16 px line, SQUARE_USED_BIG_PX
 *   (41), and 21 px slots holding 13 px chips;
 * - small: the 1 px rule, 2 px, the 24 px day, the 12 px Hebrew day, 1 px and the 8 px marks
 *   (48, picked's cell); under 48 px (a size container query) an 18 px day (42); under 42 the
 *   day and the Hebrew day on one line (30). Medium adds a 12 px line (60, its floor).
 * The square is a size container that clips: its rows share the month's height, whatever
 * it holds. overflow: hidden otherwise only on text leaves (the ellipsis). Logical
 * properties only; nothing under 11 px; no hover; the drop outline is DRAG_CSS's .is-drop.
 */
export const MONTH_SQUARES_CSS = `
.ch-sq-body {
  position: relative;
  block-size: 100%;
  padding-inline: ${GRID_PAD_PX / 2}px;
}
.ch-sq-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  block-size: 100%;
}
.ch-sq {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
  margin: 0;
  padding-block: 2px 0;
  padding-inline: 0;
  border: 0;
  border-block-start: 1px solid var(--ch-separator);
  background: transparent;
  color: var(--ch-text);
  font-family: inherit;
  text-align: start;
  cursor: pointer;
  touch-action: manipulation;
  overflow: hidden;
  container-type: size;
}
.ch-sq.is-blank {
  border-block-start-color: transparent;
  cursor: default;
}
button.ch-sq:active {
  background: var(--ch-surface);
}
.ch-sq:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: -2px;
}
.ch-sq-grid.is-large .ch-sq {
  align-items: stretch;
  justify-content: flex-start;
  padding-block: 3px 0;
  padding-inline: 2px;
}
.ch-sq-top {
  display: flex;
  flex-direction: column;
  align-items: center;
  max-inline-size: 100%;
  min-width: 0;
}
.ch-sq-num {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  inline-size: 24px;
  block-size: 24px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.ch-sq-grid.is-large .ch-sq-num {
  display: block;
  inline-size: auto;
  min-inline-size: 18px;
  block-size: 18px;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
  text-align: center;
}
.ch-sq.is-failed {
  background: var(--ch-surface);
}
.ch-sq.is-failed .ch-sq-num {
  color: var(--ch-muted);
}
.ch-sq.is-failed .ch-sq-line,
.ch-sq.is-failed .ch-sq-slots {
  opacity: 0.5;
}
.ch-sq.is-today .ch-sq-num {
  background: var(--ch-today);
  color: var(--ch-today-text);
  font-weight: 600;
}
.ch-sq[aria-pressed='true'] .ch-sq-num {
  background: var(--ch-selected);
  color: var(--ch-selected-text);
  font-weight: 600;
}
.ch-sq.is-today[aria-pressed='true'] .ch-sq-num {
  background: var(--ch-today);
  color: var(--ch-today-text);
}
.ch-sq-grid.is-large .ch-sq.is-today .ch-sq-num,
.ch-sq-grid.is-large .ch-sq[aria-pressed='true'] .ch-sq-num {
  padding-inline: 4px;
}
.ch-sq-heb {
  display: block;
  min-width: 0;
  max-inline-size: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 12px;
  color: var(--ch-muted);
}
.ch-sq-marks {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 3px;
  block-size: 8px;
  margin-block-start: 1px;
}
.ch-sq-dot {
  flex: none;
  inline-size: 6px;
  block-size: 6px;
  border-radius: 3px;
}
.ch-sq-dot.is-mine {
  background: var(--ch-dot-mine);
}
.ch-sq-dot.is-partner {
  border: 1.5px solid var(--ch-dot-partner);
}
.ch-sq-dot.has-cal.is-mine {
  background: var(--cal-line);
}
.ch-sq-dot.has-cal.is-partner {
  border-color: var(--cal-line);
}
.ch-sq-plus {
  font-size: 11px;
  line-height: 8px;
  color: var(--ch-muted);
}
.ch-sq-dot-ghost {
  inline-size: 16px;
  block-size: 6px;
  border-radius: 3px;
  background: var(--ch-outline);
  animation: ch-sq-pulse 1.4s ease-in-out infinite;
}
@container (max-height: 47px) {
  .ch-sq-grid.is-small .ch-sq-num {
    inline-size: auto;
    min-inline-size: 18px;
    block-size: 18px;
    padding-inline: 3px;
    border-radius: 9px;
    font-size: 13px;
  }
}
@container (max-height: 41px) {
  .ch-sq-grid.is-small .ch-sq-top {
    flex-direction: row;
    gap: 3px;
  }
}
.ch-sq-line {
  display: block;
  flex: none;
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
.ch-sq-line.has-chag {
  color: var(--ch-accent);
}
.ch-sq-grid.is-medium .ch-sq-line {
  align-self: stretch;
  block-size: 12px;
  line-height: 12px;
  text-align: center;
}
.ch-sq-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 2px;
  block-size: 18px;
  padding-inline: 2px;
}
.ch-sq-hday {
  font-size: 11px;
  line-height: 18px;
  color: var(--ch-muted);
  white-space: nowrap;
}
.ch-sq-slots {
  display: block;
}
.ch-sq-slot {
  display: block;
  block-size: 18px;
  padding-block-start: 2px;
  container-type: inline-size;
}
.ch-sq-chip {
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
.ch-sq-chip.has-count {
  display: flex;
  align-items: center;
  gap: 3px;
}
.ch-sq-chip-title {
  display: block;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-sq-count {
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
  .ch-sq-count {
    display: inline-block;
  }
}
.ch-sq-chip.is-mine-timed {
  background: var(--ch-mine-soft);
  color: var(--ch-mine-soft-text);
}
.ch-sq-chip.is-mine-solid {
  background: var(--ch-mine-solid);
  color: var(--ch-mine-solid-text);
}
.ch-sq-chip.is-partner-timed {
  border-color: var(--ch-partner-line);
  background: var(--ch-bg);
  color: var(--ch-partner-line-text);
}
.ch-sq-chip.is-partner-solid {
  border-color: var(--ch-partner-line);
  background: var(--ch-partner-soft);
  color: var(--ch-partner-soft-text);
}
.ch-sq-chip.has-cal.is-mine-timed,
.ch-sq-chip.has-cal.is-mine-solid {
  background: var(--cal-fill);
  color: var(--cal-text);
}
.ch-sq-chip.has-cal.is-partner-timed,
.ch-sq-chip.has-cal.is-partner-solid {
  border-color: var(--cal-line);
  background: var(--ch-bg);
  color: var(--cal-text);
}
.ch-sq-chip.is-before {
  margin-inline-start: -2px;
  border-inline-start-width: 0;
  border-start-start-radius: 0;
  border-end-start-radius: 0;
}
.ch-sq-chip.is-after {
  margin-inline-end: -2px;
  border-inline-end-width: 0;
  border-start-end-radius: 0;
  border-end-end-radius: 0;
}
.ch-sq-chip.is-done {
  text-decoration: line-through;
}
.ch-sq-more {
  display: block;
  padding-inline: 3px;
  font-size: 11px;
  line-height: 16px;
  color: var(--ch-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-sq-ghost {
  display: block;
  block-size: 12px;
  margin-block-start: 2px;
  border-radius: 4px;
  background: var(--ch-surface);
  animation: ch-sq-pulse 1.4s ease-in-out infinite;
}
.ch-sq-grid.is-big .ch-sq-head {
  block-size: 21px;
}
.ch-sq-grid.is-big .ch-sq-num {
  min-inline-size: 21px;
  block-size: 21px;
  border-radius: 11px;
  font-size: 15px;
  line-height: 21px;
}
.ch-sq-grid.is-big .ch-sq-hday {
  font-size: 12px;
  line-height: 21px;
}
.ch-sq-grid.is-big .ch-sq-line {
  block-size: 16px;
  font-size: 12px;
  line-height: 16px;
}
.ch-sq-grid.is-big .ch-sq-slot {
  block-size: 21px;
}
.ch-sq-grid.is-big .ch-sq-chip {
  block-size: 19px;
  font-size: 13px;
  line-height: 17px;
}
.ch-sq-grid.is-big .ch-sq-count {
  font-size: 12px;
  line-height: 17px;
}
.ch-sq-grid.is-big .ch-sq-more {
  font-size: 13px;
  line-height: 19px;
}
.ch-sq-grid.is-big .ch-sq-ghost {
  block-size: 15px;
}
.ch-sq-overlay {
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
.ch-sq-overlay.is-centre {
  justify-content: center;
}
.ch-sq-pill {
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
.ch-sq-pill-text {
  min-width: 0;
  padding-block: 6px;
}
.ch-sq-pill-action {
  flex: none;
  border-radius: 22px;
  background: transparent;
}
@keyframes ch-sq-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
@media (prefers-reduced-motion: reduce) {
  .ch-sq-ghost,
  .ch-sq-dot-ghost {
    animation: none;
  }
}
`;

'use client';

// The date sheet (editor upgrades spec §1): the home's month grid in small, in a bottom sheet.
// It serves the editor's start and end, a repeat's "until" and the Hebrew yearly repeat.
//
// - A page is one month, Gregorian or (with the Gregorian | Hebrew switch, only while the home
//   shows Hebrew dates) Hebrew. Every cell carries both calendars; the switch changes which
//   leads, never a second grid. The body is always 6 rows high, so paging never moves the sheet.
// - A tap on a day picks it and closes. Days past a limit (the year floor, an end not before its
//   start) are greyed and can't be picked.
// - Tapping the title swaps the grid for month and year wheels; Done returns to the grid on that
//   month. Today picks today.
// - The grid is role="grid" with one focus stop (roving tabindex): arrows by day and week,
//   PageUp and PageDown by month, Home and End to the week's ends, Enter or Space picks. Focus
//   lands on the chosen day and goes back to the pill on close (BottomSheet restores it).
// - All the logic is picker-model.ts; this file draws it. Rendered in place by PillRow.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  canStep,
  cellText,
  clampDay,
  clampPage,
  dayAriaLabel,
  footerText,
  hebrewMonthIn,
  isDayKey,
  isDisabledDay,
  limitsFor,
  moveDay,
  pageCells,
  pageOf,
  pageOfWheels,
  pageTitle,
  selectionOf,
  stepPage,
  wheelMonths,
  wheelYears,
  yearLabel,
  type DayMove,
  type PickerMode,
  type PickerPage,
  type WheelSelection,
} from '@/src/lib/calendar-view/picker-model';
import { formatWeekdayHeader } from '@/src/lib/calendar-view/format';
import { weekdayOrder } from '@/src/lib/calendar-view/grid';
import type { WeekStart } from '@/src/lib/calendar-view/types';
import { hapticSelection } from '@/src/lib/telegram-ui';
import { BottomSheet } from '@/components/app-ui/BottomSheet';
import { Segmented } from '@/components/app-ui/form-kit';
import { PICKER_CSS, Wheel, WheelPickerWrapper } from './picker-kit';

export interface DatePickerSheetProps {
  /** The sheet's accessible name ("Start date"). */
  label: string;
  /** The current day, yyyy-MM-dd; anything else opens on today with nothing chosen. */
  value: string;
  /** The server's today. */
  today: string;
  weekStart: WeekStart;
  /** The home shows Hebrew dates: the cells' second line and the Gregorian | Hebrew switch. */
  hebrewDates: boolean;
  /** The calendar the sheet opens in; a Hebrew yearly repeat opens in Hebrew. */
  mode: PickerMode;
  /** The earliest year (year-limits.ts minYearFor) and, for an end or an "until", the day it may not precede. */
  minYear: number;
  min?: string | null;
  onPick: (day: string) => void;
  onClose: () => void;
}

/** A chevron: back (towards the start) or forward; flipped in RTL. */
function Arrow({ back }: { back: boolean }) {
  return (
    <svg className="ch-picker-flip" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={back ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
    </svg>
  );
}

const KEY_MOVES: Record<string, DayMove> = {
  ArrowUp: 'prevWeek',
  ArrowDown: 'nextWeek',
  PageUp: 'prevMonth',
  PageDown: 'nextMonth',
  Home: 'weekStart',
  End: 'weekEnd',
};

export function DatePickerSheet({ label, value, today, weekStart, hebrewDates, mode: startMode, minYear, min = null, onPick, onClose }: DatePickerSheetProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const rtl = locale === 'he';
  const limits = useMemo(() => limitsFor(minYear, min), [minYear, min]);
  const chosen = isDayKey(value) ? value : '';
  const anchor = clampDay(chosen || (isDayKey(today) ? today : limits.min), limits);
  const genitive = locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined;
  const shortMonths = t.raw('hebrewMonthShort') as string[];

  const [mode, setMode] = useState<PickerMode>(startMode);
  const [page, setPage] = useState<PickerPage>(() => clampPage(pageOf(startMode, anchor) as PickerPage, limits));
  const [focusDay, setFocusDay] = useState(anchor);
  // The way the last page turn went (1 forward, -1 back), for the slide; 0 on open.
  const [slide, setSlide] = useState(0);
  const [wheels, setWheels] = useState<WheelSelection | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const focusWanted = useRef(true);

  // Focus lands on the chosen day on open, and follows the keyboard.
  useEffect(() => {
    if (!focusWanted.current || wheels) return;
    focusWanted.current = false;
    // After this commit's effects: the sheet moves focus to its panel in an effect of its own, which runs after this one.
    queueMicrotask(() => grid.current?.querySelector<HTMLElement>(`[data-day="${focusDay}"]`)?.focus({ preventScroll: true }));
  });

  const goTo = (next: PickerPage, day: string, direction: number) => {
    setPage(next);
    setFocusDay(day);
    setSlide(direction);
  };

  const step = (direction: 1 | -1) => {
    if (!canStep(page, direction, limits)) return;
    hapticSelection();
    // The same day number on the next page (its last day when it is shorter), as PageDown does.
    const target = moveDay(focusDay, direction === 1 ? 'nextMonth' : 'prevMonth', page, weekStart, limits);
    goTo(stepPage(page, direction), target, direction);
  };

  const switchMode = (next: PickerMode) => {
    if (next === mode) return;
    const target = pageOf(next, focusDay) as PickerPage;
    setMode(next);
    setWheels(null);
    goTo(clampPage(target, limits), focusDay, 0);
  };

  const pick = (day: string) => {
    if (isDisabledDay(day, limits)) return;
    hapticSelection();
    onPick(day);
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const day = (e.target as HTMLElement).getAttribute('data-day');
    if (!day) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(day);
      return;
    }
    // In a right-to-left grid the first column is on the right: the left arrow is the next day.
    const move: DayMove | undefined = e.key === 'ArrowLeft' ? (rtl ? 'nextDay' : 'prevDay') : e.key === 'ArrowRight' ? (rtl ? 'prevDay' : 'nextDay') : KEY_MOVES[e.key];
    if (!move) return;
    e.preventDefault();
    const target = moveDay(day, move, page, weekStart, limits);
    if (target === day) return;
    focusWanted.current = true;
    const next = target >= page.first && target <= page.last ? page : (pageOf(mode, target) as PickerPage);
    goTo(next, target, next === page ? slide : target > page.last ? 1 : -1);
  };

  // ---- Jump far: month and year wheels ----
  const openWheels = () => {
    hapticSelection();
    setWheels(selectionOf(page));
  };
  const closeWheels = () => {
    if (!wheels) return;
    const next = pageOfWheels(mode, wheels, limits);
    focusWanted.current = true;
    setWheels(null);
    goTo(next, clampDay(next.first, limits), 0);
  };
  const setWheelYear = (year: number) => {
    if (!wheels) return;
    // Adar I or II moved to a common year lands on Adar (and Adar in a leap year on Adar II).
    setWheels({ month: mode === 'hebrew' ? hebrewMonthIn(wheels.month, year) : wheels.month, year });
  };

  // The wheels' lists are built once per input: a fresh array makes the library re-snap a spinning wheel.
  const wheelYearNow = wheels?.year;
  const monthOptions = useMemo(() => (wheelYearNow === undefined ? [] : wheelMonths(mode, wheelYearNow, locale)), [mode, wheelYearNow, locale]);
  const yearOptions = useMemo(() => wheelYears(mode, limits).map((y) => ({ value: String(y), label: yearLabel(mode, y, locale) })), [mode, limits, locale]);

  // Choosing a Hebrew date reads the Hebrew date out, whatever the home shows.
  const showHebrew = hebrewDates || mode === 'hebrew';
  const title = pageTitle(page, locale, hebrewDates);
  const rows = pageCells(page, weekStart);
  const order = weekdayOrder(weekStart);
  const showSwitch = hebrewDates || startMode === 'hebrew';
  const shownDay = chosen || focusDay;
  const todayDisabled = !isDayKey(today) || isDisabledDay(today, limits);

  return (
    <>
      <style>{PICKER_CSS}</style>
      <BottomSheet label={label} closeLabel={t('editor.cancel')} onClose={onClose}>
        <div className="ch-picker">
          <div className="ch-picker-head">
            <button type="button" className={`ch-picker-nav${wheels ? ' is-hidden' : ''}`} aria-label={t('picker.prevMonth')} disabled={!!wheels || !canStep(page, -1, limits)} onClick={() => step(-1)}>
              <Arrow back />
            </button>
            <button type="button" className="ch-picker-title" aria-label={t('picker.chooseMonth')} aria-expanded={wheels !== null} onClick={() => (wheels ? closeWheels() : openWheels())}>
              <span className="ch-picker-title-main" aria-live="polite" dir="auto">
                {title.title}
              </span>
              {title.subtitle ? (
                <span className="ch-picker-title-sub" dir="auto">
                  {title.subtitle}
                </span>
              ) : null}
            </button>
            <button type="button" className={`ch-picker-nav${wheels ? ' is-hidden' : ''}`} aria-label={t('picker.nextMonth')} disabled={!!wheels || !canStep(page, 1, limits)} onClick={() => step(1)}>
              <Arrow back={false} />
            </button>
          </div>
          {showSwitch ? (
            <Segmented<PickerMode>
              label={label}
              value={mode}
              options={[
                { value: 'gregorian', text: t('picker.gregorian') },
                { value: 'hebrew', text: t('picker.hebrew') },
              ]}
              onChange={switchMode}
            />
          ) : null}
          <div className="ch-picker-body">
            {wheels ? (
              <WheelPickerWrapper className="ch-wheels">
                <Wheel
                  label={t('picker.chooseMonth')}
                  options={monthOptions}
                  value={wheels.month}
                  onChange={(month) => setWheels({ ...wheels, month })}
                />
                <Wheel
                  label={t('picker.year')}
                  options={yearOptions}
                  value={String(wheels.year)}
                  onChange={(year) => setWheelYear(Number(year))}
                />
              </WheelPickerWrapper>
            ) : (
              <>
                <div className="ch-picker-weekdays" aria-hidden="true">
                  {order.map((w) => (
                    <span key={w} className="ch-picker-weekday">
                      {formatWeekdayHeader(w, locale)}
                    </span>
                  ))}
                </div>
                <div
                  key={`${mode}-${page.first}`}
                  ref={grid}
                  className="ch-picker-grid"
                  role="grid"
                  aria-label={title.title}
                  style={{ ['--ch-picker-slide' as string]: slide }}
                  onKeyDown={onGridKey}
                >
                  {rows.map((row, r) => (
                    <div key={r} className="ch-picker-row" role="row">
                      {row.map((day, c) => {
                        if (day === null) return <span key={c} className="ch-picker-blank" role="gridcell" aria-hidden="true" />;
                        const text = cellText(day, mode, locale, hebrewDates, shortMonths);
                        const disabled = isDisabledDay(day, limits);
                        return (
                          <button
                            key={c}
                            type="button"
                            role="gridcell"
                            data-day={day}
                            className={`ch-picker-cell${day === today ? ' is-today' : ''}`}
                            tabIndex={day === focusDay ? 0 : -1}
                            aria-label={dayAriaLabel(day, locale, showHebrew, genitive)}
                            aria-selected={day === chosen}
                            aria-current={day === today ? 'date' : undefined}
                            aria-disabled={disabled || undefined}
                            onClick={() => pick(day)}
                          >
                            <span className="ch-picker-num" dir="auto">
                              {text.primary}
                            </span>
                            {text.secondary ? (
                              <span className="ch-picker-sub" dir="auto">
                                {text.secondary}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          {wheels ? (
            <button type="button" className="ch-btn ch-btn-primary ch-picker-done" onClick={closeWheels}>
              {t('picker.done')}
            </button>
          ) : (
            <div className="ch-picker-foot">
              <p className="ch-picker-chosen" dir="auto">
                {footerText(shownDay, locale, showHebrew, genitive)}
              </p>
              <button type="button" className="ch-btn" disabled={todayDisabled} onClick={() => pick(today)}>
                {t('picker.today')}
              </button>
            </div>
          )}
        </div>
      </BottomSheet>
    </>
  );
}

'use client';

// The editor's part of the form kit (home editing spec §4): the date and time pills (buttons that
// open the picker sheets) and EDITOR_FORM_CSS, the CSS of what only the editor's flow draws: its
// header and body (.ch-editor-*), the pills and the scope sheet (.ch-scope*). A screen renders it after
// FORM_CSS (components/app-ui/form-kit.tsx, the generic kit), which also draws the swatch dot of a calendar's
// colour (.ch-swatch-dot). Times are always left to right, as the Agenda's are.

import { Suspense, lazy, useId } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { FieldError } from '@/components/app-ui/form-kit';
import { formatPillDate } from '@/src/lib/calendar-view/format';
import { hebrewFullDate } from '@/src/lib/calendar-view/hebrew-date';
import type { PickerMode } from '@/src/lib/calendar-view/picker-model';
import type { WeekStart } from '@/src/lib/calendar-view/types';
import { MIN_YEAR_SERIES } from '@/src/lib/calendar-view/year-limits';

// The pickers are a chunk of their own (the wheel library comes with them): a chunk that fails to
// load falls to the home's error boundary, like the Month's.
const loadDatePicker = () => import('./DatePickerSheet');
const loadTimePicker = () => import('./TimePickerSheet');
const DatePickerSheet = lazy(() => loadDatePicker().then((m) => ({ default: m.DatePickerSheet })));
const TimePickerSheet = lazy(() => loadTimePicker().then((m) => ({ default: m.TimePickerSheet })));

/**
 * Starts loading both sheets, so the first tap on a pill has nothing to wait for. The editor calls
 * it when it opens. A failure is logged and left to the tap, which falls to the home's boundary.
 */
export function preloadPickers(): void {
  for (const load of [loadDatePicker, loadTimePicker]) {
    load().catch((err) => console.error('[picker] a sheet chunk failed to preload', err));
  }
}

export const EDITOR_FORM_CSS = `
.ch-editor-head {
  flex: none;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 4px;
  padding: calc(8px + var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px)) 8px 4px;
}
.ch-editor-cancel {
  justify-self: start;
  min-block-size: 44px;
  min-inline-size: 44px;
  padding: 0 10px;
  border: 0;
  background: transparent;
  color: var(--ch-accent);
  font: inherit;
  font-size: 16px;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-editor-cancel:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 2px;
}
.ch-editor-title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  text-align: center;
}
.ch-editor-body {
  flex: 1;
  min-block-size: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.ch-pill {
  flex: none;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-block-size: 44px;
  min-inline-size: 0;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: var(--ch-surface);
  color: var(--ch-text);
  font: inherit;
  font-size: 15px;
  text-align: center;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-pill-sub {
  font-size: 11px;
  line-height: 1.2;
  color: var(--ch-muted);
}
.ch-pill:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 1px;
}
.ch-pill[data-invalid='true'] {
  outline: 2px solid var(--ch-danger);
}
.ch-scope {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ch-scope-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.ch-scope-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0 0 4px;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-scope-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ch-scope-choice {
  inline-size: 100%;
  min-block-size: 48px;
  white-space: normal;
}
.ch-scope-choice:disabled {
  opacity: 0.6;
  cursor: default;
}
.ch-scope-choice.is-danger {
  color: var(--ch-danger);
}
.ch-app[data-theme='dark'] .ch-pill {
  background: var(--ch-separator);
}
`;

export interface PillRowProps {
  label: string;
  dateLabel: string;
  timeLabel: string;
  day: string;
  time: string;
  /** False hides the time pill (all day). */
  showTime: boolean;
  onDay: (day: string) => void;
  onTime: (time: string) => void;
  error?: string | null;
  /** The calendar the date sheet opens in: a Hebrew yearly repeat opens it in Hebrew (default Gregorian). */
  mode?: PickerMode;
  /** The earliest day the sheet lets through: an end may not precede its start. */
  min?: string | null;
  /** The earliest year (year-limits.ts minYearFor); 2000 when the row doesn't say. */
  minYear?: number;
  /** The home shows Hebrew dates: the pill's second line and the sheet's Gregorian | Hebrew switch. */
  hebrewDates?: boolean;
  /** The server's today and the week's first day, for the sheet. */
  today?: string;
  weekStart?: WeekStart;
  /** Minutes between the time wheel's stops (5 in the editor). */
  timeStep?: number;
  /** Which sheet is open: the container owns that (the editor closes an open picker before it cancels, and locks swipes while one is open). */
  open: 'date' | 'time' | null;
  onOpen: (open: 'date' | 'time' | null) => void;
}

/** A label with its date pill and, unless hidden, its time pill. A tap opens the date or time sheet. */
export function PillRow({
  label,
  dateLabel,
  timeLabel,
  day,
  time,
  showTime,
  onDay,
  onTime,
  error,
  mode = 'gregorian',
  min = null,
  minYear = MIN_YEAR_SERIES,
  hebrewDates = false,
  today = '',
  weekStart = 0,
  timeStep = 5,
  open,
  onOpen,
}: PillRowProps) {
  const errorId = useId();
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const setOpen = onOpen;
  const dateText = formatPillDate(day, locale);
  const hebrewText = hebrewDates && dateText ? hebrewFullDate(day, locale, locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined) : '';
  return (
    <div>
      <div className="ch-form-row">
        <span className="ch-form-label">
          <span>{label}</span>
        </span>
        <button
          type="button"
          className="ch-pill"
          data-pill="date"
          data-value={day}
          aria-label={`${dateLabel}, ${dateText || '-'}`}
          aria-haspopup="dialog"
          data-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onClick={() => setOpen('date')}
        >
          <span dir="auto">{dateText || '-'}</span>
          {hebrewText ? (
            <span className="ch-pill-sub" dir="auto">
              {hebrewText}
            </span>
          ) : null}
        </button>
        {showTime ? (
          <button
            type="button"
            className="ch-pill"
            data-pill="time"
            data-value={time}
            dir="ltr"
            aria-label={`${timeLabel}, ${time || '-'}`}
            aria-haspopup="dialog"
            data-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onClick={() => setOpen('time')}
          >
            {time || '-'}
          </button>
        ) : null}
      </div>
      {error ? <FieldError id={errorId} error={error} /> : null}
      {open === 'date' ? (
        <Suspense fallback={null}>
          <DatePickerSheet
            label={dateLabel}
            value={day}
            today={today}
            weekStart={weekStart}
            hebrewDates={hebrewDates}
            mode={mode}
            minYear={minYear}
            min={min}
            onPick={(next) => {
              setOpen(null);
              onDay(next);
            }}
            onClose={() => setOpen(null)}
          />
        </Suspense>
      ) : null}
      {open === 'time' ? (
        <Suspense fallback={null}>
          <TimePickerSheet
            label={timeLabel}
            value={time}
            step={timeStep}
            onPick={(next) => {
              setOpen(null);
              onTime(next);
            }}
            onClose={() => setOpen(null)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

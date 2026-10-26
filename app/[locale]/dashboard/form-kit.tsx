'use client';

// The home's form kit (home editing spec §4), for the editor now and F1's screens later:
// grouped cards, a text field, a switch row, a segmented control, a value row with a
// native <select> over it, date and time pills (buttons that open the picker sheets), a radio
// pair and a sticky Save bar. The classes are ch-form-*; FORM_CSS draws them from the
// home's tokens.
//
// Every target is at least 44 px, with logical properties, no :hover and nothing under
// 11 px. A switch row is one button, role="switch", whole row the target. The select sits
// over its row at no opacity, so the row looks like the mockups' value row and a tap
// opens the platform's own picker. Times are always left to right, as the Agenda's are.

import { Suspense, lazy, useId, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
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

export const FORM_CSS = `
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
.ch-form-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 16px 20px;
}
.ch-form-card {
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  background: var(--ch-section);
  overflow: hidden;
}
.ch-form-card > * + * {
  border-block-start: 1px solid var(--ch-separator);
}
.ch-form-field {
  display: block;
  inline-size: 100%;
  min-block-size: 48px;
  padding: 0 14px;
  border: 0;
  background: transparent;
  color: var(--ch-text);
  font: inherit;
  font-size: 16px;
  outline: none;
}
.ch-form-field-title {
  font-size: 17px;
}
.ch-form-field::placeholder {
  color: var(--ch-muted);
}
.ch-form-notes {
  min-block-size: 96px;
  padding-block: 12px;
  resize: none;
  line-height: 1.4;
}
.ch-form-card:focus-within {
  outline: 2px solid var(--ch-accent);
  outline-offset: 0;
}
.ch-form-card .ch-form-error {
  padding: 0 14px 8px;
}
.ch-form-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-block-size: 48px;
  padding: 2px 14px;
  font-size: 16px;
}
.ch-form-label {
  flex: 1;
  /* A label never shrinks below its longest word: a long value wraps (below) instead of painting over it. */
  min-inline-size: min-content;
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: start;
}
.ch-form-hint {
  font-size: 13px;
  color: var(--ch-muted);
}
.ch-form-value {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  color: var(--ch-muted);
  min-inline-size: 0;
}
.ch-form-value-text {
  /* Up to two lines, then an ellipsis. The box sits at the row's end; its lines start on the text's own side
     (dir="auto"): Chromium drops the clamp's ellipsis on end-aligned text. */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  text-align: start;
  overflow-wrap: anywhere;
}
.ch-form-chevron {
  flex: none;
  inline-size: 16px;
  block-size: 16px;
  color: var(--ch-muted);
}
[dir='rtl'] .ch-form-chevron {
  transform: scaleX(-1);
}
.ch-form-select {
  position: absolute;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  font-size: 16px;
}
.ch-form-select:focus-visible {
  opacity: 1;
  outline: 2px solid var(--ch-accent);
  outline-offset: -2px;
  color: var(--ch-text);
  background: var(--ch-section);
}
.ch-swatch-dot {
  flex: none;
  inline-size: 10px;
  block-size: 10px;
  border-radius: 5px;
  background: var(--ch-outline);
}
button.ch-form-row {
  inline-size: 100%;
  box-sizing: border-box;
  border: 0;
  background: transparent;
  color: var(--ch-text);
  font-family: inherit;
  text-align: start;
  cursor: pointer;
  touch-action: manipulation;
}
button.ch-form-row:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: -2px;
}
.ch-switch {
  flex: none;
  position: relative;
  inline-size: 51px;
  block-size: 31px;
  border-radius: 16px;
  background: var(--ch-outline);
}
.ch-switch::after {
  content: '';
  position: absolute;
  inset-block-start: 2px;
  inset-inline-start: 2px;
  inline-size: 27px;
  block-size: 27px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  transition: inset-inline-start 120ms ease-out;
}
.ch-switch.is-on {
  background: var(--ch-button);
}
.ch-switch.is-on::after {
  inset-inline-start: 22px;
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
.ch-choice {
  inline-size: 100%;
  box-sizing: border-box;
  border: 0;
  background: transparent;
  color: var(--ch-text);
  font-family: inherit;
  text-align: start;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-choice:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: -2px;
}
.ch-choice[aria-checked='true'] {
  font-weight: 600;
}
.ch-choice-check {
  flex: none;
  inline-size: 20px;
  block-size: 20px;
  color: var(--ch-accent);
}
.ch-step-row {
  flex-wrap: wrap;
  row-gap: 0;
}
.ch-step-row > .ch-form-label {
  flex: none;
}
.ch-stepper {
  flex: none;
  display: inline-flex;
  align-items: center;
}
.ch-step {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: 44px;
  block-size: 44px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ch-accent);
  cursor: pointer;
  touch-action: manipulation;
}
.ch-step[aria-disabled='true'] {
  color: var(--ch-muted);
  opacity: 0.5;
  cursor: default;
}
.ch-step:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: -2px;
}
.ch-step svg {
  inline-size: 18px;
  block-size: 18px;
}
.ch-step-value {
  min-inline-size: 2.5ch;
  text-align: center;
  font-size: 17px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.ch-step-unit {
  flex: 1;
  min-inline-size: 0;
  text-align: start;
  overflow-wrap: anywhere;
}
.ch-segmented {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px;
  padding: 3px;
  border-radius: 12px;
  background: var(--ch-tab-track);
}
.ch-segment {
  min-block-size: 44px;
  padding: 0 6px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--ch-muted);
  font: inherit;
  font-size: 15px;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-segment[aria-checked='true'] {
  background: var(--ch-tab-on);
  box-shadow: var(--ch-tab-shadow);
  color: var(--ch-tab-on-text);
  font-weight: 600;
}
.ch-segment:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 1px;
}
.ch-form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ch-form-group-label {
  padding-inline-start: 4px;
  font-size: 13px;
  color: var(--ch-muted);
}
.ch-radio-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.ch-radio {
  min-block-size: 44px;
  padding: 0 10px;
  border: 1.5px solid var(--ch-outline);
  border-radius: 12px;
  background: transparent;
  color: var(--ch-text);
  font: inherit;
  font-size: 15px;
  cursor: pointer;
  touch-action: manipulation;
  overflow-wrap: anywhere;
}
.ch-radio[aria-checked='true'] {
  border-color: var(--ch-button);
  background: var(--ch-mine-soft);
  color: var(--ch-mine-soft-text);
  font-weight: 600;
}
.ch-radio:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 2px;
}
.ch-form-error {
  margin: 0;
  padding-inline: 4px;
  font-size: 13px;
  color: var(--ch-danger);
}
.ch-form-fixed {
  margin: 0;
  padding-inline: 4px;
  font-size: 14px;
  color: var(--ch-muted);
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
.ch-save-bar {
  flex: none;
  padding: 12px 16px calc(12px + max(env(safe-area-inset-bottom, 0px), var(--tg-safe-area-inset-bottom, 0px)));
  border-block-start: 1px solid var(--ch-separator);
  background: var(--ch-surface);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ch-save-bar .ch-form-error {
  text-align: center;
}
.ch-save {
  inline-size: 100%;
  min-block-size: 50px;
  font-size: 16px;
  font-weight: 600;
}
.ch-form-spinner {
  flex: none;
  inline-size: 14px;
  block-size: 14px;
  border: 2px solid currentColor;
  border-inline-end-color: transparent;
  border-radius: 50%;
  animation: ch-form-spin 0.8s linear infinite;
}
@keyframes ch-form-spin {
  to {
    transform: rotate(360deg);
  }
}
.ch-save:disabled {
  opacity: 0.6;
  cursor: default;
}
.ch-home[data-theme='dark'] .ch-save-bar {
  background: var(--ch-bg);
}
.ch-home[data-theme='dark'] .ch-pill {
  background: var(--ch-separator);
}
`;

/** A group of rows on one card. */
export function FormCard({ children }: { children: ReactNode }) {
  return <div className="ch-form-card">{children}</div>;
}

/** What a field says about its error: the inline text under it, tied to the field. */
function FieldError({ id, error }: { id: string; error: string | null }) {
  return error ? (
    <p id={id} className="ch-form-error" role="alert">
      {error}
    </p>
  ) : null;
}

export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** The title's larger type. */
  large?: boolean;
  multiline?: boolean;
}

/** A single-line field (or notes), labelled for assistive tech; it sits on a FormCard. */
export function TextField({ label, value, onChange, placeholder, large, multiline, error }: TextFieldProps & { error?: string | null }) {
  const errorId = useId();
  const common = {
    className: `ch-form-field${large ? ' ch-form-field-title' : ''}${multiline ? ' ch-form-notes' : ''}`,
    'aria-label': label,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? errorId : undefined,
    placeholder,
    dir: 'auto' as const,
    value,
  };
  return (
    <>
      {multiline ? (
        <textarea {...common} rows={3} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input {...common} type="text" enterKeyHint="done" autoComplete="off" onChange={(e) => onChange(e.target.value)} />
      )}
      {error ? <FieldError id={errorId} error={error} /> : null}
    </>
  );
}

/** One row of a card: its label (and hint) and what follows. */
export function FormRow({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="ch-form-row">
      <span className="ch-form-label">
        <span>{label}</span>
        {hint ? <span className="ch-form-hint">{hint}</span> : null}
      </span>
      {children}
    </div>
  );
}

/** A switch row: the whole row is the button. */
export function SwitchRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="ch-form-row" onClick={() => onChange(!checked)}>
      <span className="ch-form-label">
        <span>{label}</span>
        {hint ? <span className="ch-form-hint">{hint}</span> : null}
      </span>
      <span className={`ch-switch${checked ? ' is-on' : ''}`} aria-hidden="true" />
    </button>
  );
}

function Chevron() {
  return (
    <svg className="ch-form-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function Check() {
  return (
    <svg className="ch-choice-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/** A row that opens a sheet, shaped like a value row (the label, the value, a chevron); the inline error sits under it. */
export function ButtonRow({ label, hint, value, onClick, error }: { label: string; hint?: string; value: string; onClick: () => void; error?: string | null }) {
  const id = useId();
  return (
    <>
      <button type="button" className="ch-form-row" aria-haspopup="dialog" aria-describedby={error ? `${id}-error` : undefined} onClick={onClick}>
        <span className="ch-form-label">
          <span>{label}</span>
          {hint ? <span className="ch-form-hint">{hint}</span> : null}
        </span>
        <span className="ch-form-value">
          <span className="ch-form-value-text" dir="auto">
            {value}
          </span>
        </span>
        <Chevron />
      </button>
      {error ? <FieldError id={`${id}-error`} error={error} /> : null}
    </>
  );
}

export interface RadioCardOption {
  value: string;
  text: string;
}

/** A card of radio rows, one chosen (a check at its end): the whole row is the target. */
export function RadioCard({ label, value, options, onChange }: { label: string; value: string | null; options: RadioCardOption[]; onChange: (value: string) => void }) {
  return (
    <div className="ch-form-card" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className="ch-form-row ch-choice" data-value={o.value} onClick={() => onChange(o.value)}>
          <span className="ch-form-label">
            <span dir="auto">{o.text}</span>
          </span>
          {o.value === value ? <Check /> : null}
        </button>
      ))}
    </div>
  );
}

/** "Every [-] 2 [+] weeks": a number with 44 px buttons at both ends, clamped to min..max; the label before, the unit after. */
export function StepperRow({
  label,
  unit,
  value,
  min,
  max,
  onChange,
  decLabel,
  incLabel,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  decLabel: string;
  incLabel: string;
}) {
  return (
    <div className="ch-form-row ch-step-row" role="group" aria-label={`${label} ${value} ${unit}`}>
      <span className="ch-form-label">
        <span>{label}</span>
      </span>
      <span className="ch-stepper" dir="ltr">
        <button type="button" className="ch-step" aria-label={decLabel} aria-disabled={value <= min || undefined} onClick={() => value > min && onChange(value - 1)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" focusable="false">
            <path d="M5 12h14" />
          </svg>
        </button>
        <output className="ch-step-value" aria-live="polite">
          {value}
        </output>
        <button type="button" className="ch-step" aria-label={incLabel} aria-disabled={value >= max || undefined} onClick={() => value < max && onChange(value + 1)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" focusable="false">
            <path d="M5 12h14M12 5v14" />
          </svg>
        </button>
      </span>
      <span className="ch-step-unit" dir="auto">
        {unit}
      </span>
    </div>
  );
}

export interface SelectOption {
  value: string;
  text: string;
  /** A calendar's colour, drawn as a dot beside the value. */
  color?: string | null;
}

/** A value row: the label, the chosen value and a chevron, with a native <select> over the row. */
export function ValueRow({ label, hint, value, options, onChange, error }: { label: string; hint?: string; value: string; options: SelectOption[]; onChange: (value: string) => void; error?: string | null }) {
  const id = useId();
  const chosen = options.find((o) => o.value === value) ?? options[0];
  const dot = chosen?.color && /^#[0-9a-f]{3,8}$/i.test(chosen.color) ? chosen.color : null;
  return (
    <>
      <label className="ch-form-row">
        <span className="ch-form-label">
          <span>{label}</span>
          {hint ? <span className="ch-form-hint">{hint}</span> : null}
        </span>
        <span className="ch-form-value">
          {chosen?.color !== undefined ? <span className="ch-swatch-dot" style={dot ? { background: dot } : undefined} aria-hidden="true" /> : null}
          <span className="ch-form-value-text" dir="auto">
            {chosen?.text ?? ''}
          </span>
        </span>
        <Chevron />
        <select className="ch-form-select" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.text}
            </option>
          ))}
        </select>
      </label>
      {error ? <FieldError id={`${id}-error`} error={error} /> : null}
    </>
  );
}

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

export interface ChoiceOption<T extends string> {
  value: T;
  text: string;
}

/** A segmented control of two or more choices (the Event | Reminder switch; the Repeat sheet's Ends). */
export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: ChoiceOption<T>[]; onChange: (value: T) => void }) {
  return (
    <div className="ch-segmented" role="radiogroup" aria-label={label} style={options.length > 2 ? { gridTemplateColumns: `repeat(${options.length}, 1fr)` } : undefined}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className="ch-segment" onClick={() => onChange(o.value)}>
          {o.text}
        </button>
      ))}
    </div>
  );
}

/** A labelled row of radio buttons, two or three across (a reminder's For: Me | Noa | Both of us). */
export function RadioPair<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: ChoiceOption<T>[]; onChange: (value: T) => void }) {
  return (
    <div className="ch-form-group">
      <span className="ch-form-group-label">{label}</span>
      <div className="ch-radio-pair" role="radiogroup" aria-label={label} style={options.length > 2 ? { gridTemplateColumns: `repeat(${options.length}, 1fr)` } : undefined}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className="ch-radio" onClick={() => onChange(o.value)}>
            <bdi>{o.text}</bdi>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The sticky Save bar: the error above the button, the button disabled while a save is in flight. */
export function SaveBar({ label, busy, error, onSave }: { label: string; busy: boolean; error: string | null; onSave: () => void }) {
  return (
    <div className="ch-save-bar">
      {error ? (
        <p className="ch-form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="button" className="ch-btn ch-btn-primary ch-save" disabled={busy} aria-busy={busy || undefined} onClick={onSave}>
        {busy ? <span className="ch-form-spinner" aria-hidden="true" /> : null}
        {label}
      </button>
    </div>
  );
}

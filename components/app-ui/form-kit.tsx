'use client';

// The app's form kit (home editing spec §4; the shared layer of F1): grouped cards, a text
// field, a switch row, a button row that opens a sheet, a value row with a native <select>
// over it, radio and stepper rows, a segmented control, a radio pair, a row of day chips and
// a Save bar (sticky on a screen that scrolls).
// The classes are ch-form-*; FORM_CSS draws them from the app's tokens (./theme.ts). It also draws CopyField's
// (./CopyField.tsx: ch-copy-field*) and dims a disabled row button (button.ch-form-row:disabled).
// A calendar's colour: .ch-swatch-dot is the dot beside a name (.is-lg: 12 px; in a list row's title it sits
// before the name), and ColorSwatches is the picker (a radiogroup of 44 px swatches, a check on the chosen one; its
// classes are .ch-color-swatch*: the home's Agenda has a .ch-swatch of its own, and smoke-app-ui keeps the kit's names apart).
//
// What only the editor's flow draws (its header and body, the date and time pills, the scope
// sheet and the calendar swatch ValueRow shows beside a calendar's name) is in
// app/[locale]/dashboard/form-kit.tsx with EDITOR_FORM_CSS, which a screen renders after FORM_CSS.
//
// Every target is at least 44 px, with logical properties, no :hover and nothing under
// 11 px. A list row (./ListRow.tsx: ch-list-row*) is a button row with a title, a quiet line, tags and a chevron.
// A switch row is one button, role="switch", whole row the target. The select sits
// over its row at no opacity, so the row looks like the mockups' value row and a tap
// opens the platform's own picker. Times are always left to right, as the Agenda's are.
//
// Client-safe: nothing here reaches a server module, and the labels come in already translated.

import { useId, type ReactNode } from 'react';

export const FORM_CSS = `
.ch-form-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 16px 20px;
}
.ch-form-page-grouped {
  gap: 6px;
}
.ch-form-page-grouped .ch-form-row {
  padding-block: 8px;
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
.ch-form-field:disabled {
  opacity: 0.6;
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
.ch-form-hint.is-danger {
  color: var(--ch-danger);
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
.ch-list-row {
  padding-block: 10px;
}
.ch-form-page-grouped .ch-list-row {
  padding-block: 10px;
}
.ch-list-title {
  font-size: 16px;
  overflow-wrap: anywhere;
}
.ch-list-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-block-start: 3px;
}
.ch-swatch-dot {
  flex: none;
  inline-size: 10px;
  block-size: 10px;
  border-radius: 5px;
  background: var(--ch-outline);
}
.ch-swatch-dot.is-lg {
  inline-size: 12px;
  block-size: 12px;
  border-radius: 6px;
}
.ch-list-title .ch-swatch-dot {
  display: inline-block;
  margin-inline-end: 8px;
  vertical-align: middle;
}
.ch-color-swatches {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  justify-items: center;
  padding: 4px 6px;
}
.ch-color-swatch {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: 44px;
  block-size: 44px;
  padding: 0;
  border: 0;
  border-radius: 12px;
  background: transparent;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-color-swatch:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: -2px;
}
.ch-color-swatch:disabled {
  opacity: 0.6;
  cursor: default;
}
.ch-color-swatch-dot {
  display: flex;
  align-items: center;
  justify-content: center;
  inline-size: 28px;
  block-size: 28px;
  border-radius: 50%;
  background: var(--ch-outline);
  box-shadow: 0 0 0 1px var(--ch-outline);
}
.ch-color-swatch-check {
  display: flex;
  align-items: center;
  justify-content: center;
  inline-size: 18px;
  block-size: 18px;
  border-radius: 50%;
  background: var(--ch-selected);
  color: var(--ch-selected-text);
}
.ch-color-swatch-check svg {
  inline-size: 12px;
  block-size: 12px;
}
button.ch-danger-row {
  color: var(--ch-danger);
}
button.ch-action-row {
  color: var(--ch-accent);
}
button.ch-form-row:disabled {
  opacity: 0.6;
  cursor: default;
}
.ch-copy-field {
  display: flex;
  align-items: center;
  gap: 8px;
  min-block-size: 44px;
  padding-block: 8px;
  padding-inline: 14px 8px;
}
.ch-copy-field-input {
  flex: 1;
  min-inline-size: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ch-text);
  font: inherit;
  font-size: 16px;
  text-overflow: ellipsis;
  outline: none;
  -webkit-user-select: all;
  user-select: all;
}
.ch-copy-field-btn {
  color: var(--ch-accent);
}
.ch-switch {
  flex: none;
  position: relative;
  inline-size: 51px;
  block-size: 31px;
  border-radius: 16px;
  background: var(--ch-outline);
  box-shadow: inset 0 0 0 1.5px var(--ch-done);
}
.ch-switch::after {
  content: '';
  position: absolute;
  inset-block-start: 2px;
  inset-inline-start: 2px;
  inline-size: 27px;
  block-size: 27px;
  border-radius: 50%;
  background: var(--ch-switch-thumb);
  box-shadow: var(--ch-switch-thumb-shadow);
  transition: inset-inline-start 120ms ease-out;
}
.ch-switch.is-on {
  background: var(--ch-button);
  box-shadow: none;
}
.ch-switch.is-on::after {
  inset-inline-start: 22px;
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
.ch-form-chips {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 10px 12px;
}
.ch-form-chips > .ch-form-hint,
.ch-form-chips > .ch-form-fixed {
  padding-inline: 4px;
}
.ch-daychips {
  display: flex;
  gap: 2px;
  padding: 4px;
}
.ch-daychip {
  flex: 1;
  min-inline-size: 0;
  min-block-size: 44px;
  padding: 0;
  border: 1.5px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--ch-text);
  font: inherit;
  font-size: 15px;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-daychip[aria-pressed='true'] {
  border-color: var(--ch-button);
  background: var(--ch-mine-soft);
  color: var(--ch-mine-soft-text);
  font-weight: 600;
}
.ch-daychip[aria-disabled='true'] {
  cursor: default;
  opacity: 0.75;
}
.ch-daychip:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 1px;
}
@media (prefers-reduced-motion: no-preference) {
  .ch-daychip {
    transition: background-color 120ms ease-out, border-color 120ms ease-out;
  }
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
.ch-form-count {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding-inline: 4px;
  font-size: 13px;
  color: var(--ch-muted);
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
.ch-save-bar-sticky {
  position: sticky;
  inset-block-end: 0;
  border-block-start: 1px solid var(--ch-separator);
}
.ch-save-status {
  margin: 0;
  font-size: 13px;
  color: var(--ch-muted);
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
.ch-btn-danger {
  background: var(--ch-danger);
  color: var(--ch-bg);
}
.ch-sheet:not(.ch-sheet-full) .ch-form-card {
  background: var(--ch-surface);
  /* Where a theme's section and secondary colours are one, the card would vanish into the sheet: the switch's off outline keeps it. */
  box-shadow: inset 0 0 0 1px var(--ch-done);
}
.ch-sheet:not(.ch-sheet-full) .ch-save-bar,
.ch-app[data-theme='dark'] .ch-sheet:not(.ch-sheet-full) .ch-save-bar {
  padding: 0;
  border-block-start: 0;
  background: transparent;
}
.ch-sheet-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ch-sheet-question {
  margin: 0;
  font-size: 15px;
}
.ch-sheet-stack.is-roomy .ch-form-row {
  padding-block: 8px;
}
.ch-working {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ch-app[data-theme='dark'] .ch-save-bar {
  background: var(--ch-bg);
}
`;

/** A group of rows on one card. */
export function FormCard({ children }: { children: ReactNode }) {
  return <div className="ch-form-card">{children}</div>;
}

/** What a field says about its error: the inline text under it, tied to the field. */
export function FieldError({ id, error }: { id: string; error: string | null }) {
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
  /** The most the field takes: the platform stops typing there. */
  maxLength?: number;
  /** A multiline field's height in lines (3 without it). */
  rows?: number;
  /** The id of text that describes the field (a count); the error's id, when there is one, follows it. */
  describedBy?: string;
  /** The field takes no input (its screen is working); the kit dims it. */
  disabled?: boolean;
}

/** A single-line field (or notes), labelled for assistive tech; it sits on a FormCard. */
export function TextField({ label, value, onChange, placeholder, large, multiline, maxLength, rows, describedBy, disabled, error }: TextFieldProps & { error?: string | null }) {
  const errorId = useId();
  const common = {
    className: `ch-form-field${large ? ' ch-form-field-title' : ''}${multiline ? ' ch-form-notes' : ''}`,
    'aria-label': label,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': [describedBy, error ? errorId : undefined].filter(Boolean).join(' ') || undefined,
    placeholder,
    dir: 'auto' as const,
    value,
    disabled,
  };
  return (
    <>
      {multiline ? (
        <textarea {...common} rows={rows ?? 3} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input {...common} type="text" enterKeyHint="done" autoComplete="off" maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />
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

/**
 * A switch row: the whole row is the button. `note` is a second hint line (what is used of a limit);
 * `disabled` keeps the row focusable and announced (aria-disabled) but a tap changes nothing.
 */
export function SwitchRow({
  label,
  hint,
  note,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  note?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      className="ch-form-row"
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
    >
      <span className="ch-form-label">
        <span>{label}</span>
        {hint ? <span className="ch-form-hint">{hint}</span> : null}
        {note ? <span className="ch-form-hint">{note}</span> : null}
      </span>
      <span className={`ch-switch${checked ? ' is-on' : ''}`} aria-hidden="true" />
    </button>
  );
}

/** The chevron at the end of a row that leads somewhere (it flips in RTL: .ch-form-chevron). */
export function Chevron() {
  return (
    <svg className="ch-form-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function Check({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/** A row that opens a sheet, shaped like a value row (the label, the value, a chevron); the inline error sits under it. `valueDir="ltr"` keeps a time or a number left to right. */
export function ButtonRow({ label, hint, value, onClick, error, valueDir }: { label: string; hint?: string; value: string; onClick: () => void; error?: string | null; valueDir?: 'ltr' }) {
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
            {valueDir === 'ltr' ? <bdi dir="ltr">{value}</bdi> : value}
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
export function RadioCard({ label, value, options, onChange, disabled }: { label: string; value: string | null; options: RadioCardOption[]; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <div className="ch-form-card" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className="ch-form-row ch-choice" data-value={o.value} disabled={disabled} onClick={() => onChange(o.value)}>
          <span className="ch-form-label">
            <span dir="auto">{o.text}</span>
          </span>
          {o.value === value ? <Check className="ch-choice-check" /> : null}
        </button>
      ))}
    </div>
  );
}

export interface ColorSwatchOption {
  value: string;
  /** The colour the swatch is drawn in. */
  color: string;
  /** The colour's name in the page's language: the swatch's accessible name (a colour is never told by colour alone). */
  text: string;
}

const HEX = /^#[0-9a-f]{3,8}$/i;

/**
 * A colour picker: a radiogroup of swatches, one chosen (a check on it). Each swatch is a 44 px button (Tab goes through
 * them, there is no roving focus), the dot 28 px in its colour; they wrap onto as many lines as the width needs.
 */
export function ColorSwatches({ label, value, options, onChange, disabled }: { label: string; value: string | null; options: ColorSwatchOption[]; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <div className="ch-color-swatches" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} aria-label={o.text} className="ch-color-swatch" disabled={disabled} onClick={() => onChange(o.value)}>
          <span className="ch-color-swatch-dot" style={HEX.test(o.color) ? { background: o.color } : undefined} aria-hidden="true">
            {o.value === value ? (
              <span className="ch-color-swatch-check">
                <Check />
              </span>
            ) : null}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * "Every [-] 2 [+] weeks": a number with 44 px buttons at both ends, clamped to min..max; the label before, the unit after.
 * `step` (1 unless given) is how much a tap moves it: an offset of minutes goes by 5.
 */
export function StepperRow({
  label,
  unit,
  value,
  min,
  max,
  step = 1,
  onChange,
  decLabel,
  incLabel,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step?: number;
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
        <button type="button" className="ch-step" aria-label={decLabel} aria-disabled={value <= min || undefined} onClick={() => value > min && onChange(Math.max(min, value - step))}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" focusable="false">
            <path d="M5 12h14" />
          </svg>
        </button>
        <output className="ch-step-value" aria-live="polite">
          {value}
        </output>
        <button type="button" className="ch-step" aria-label={incLabel} aria-disabled={value >= max || undefined} onClick={() => value < max && onChange(Math.min(max, value + step))}>
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

/** A value row: the label, the chosen value and a chevron, with a native <select> over the row. `valueDir="ltr"` keeps a time left to right. */
export function ValueRow({
  label,
  hint,
  value,
  options,
  onChange,
  error,
  valueDir,
}: {
  label: string;
  hint?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  error?: string | null;
  valueDir?: 'ltr';
}) {
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
            {valueDir === 'ltr' ? <bdi dir="ltr">{chosen?.text ?? ''}</bdi> : (chosen?.text ?? '')}
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

/**
 * The Save bar: the error (or a status such as "Saved") above the button, the button disabled while a save is
 * in flight or when there is nothing to save. `sticky` pins it to the bottom of a screen that scrolls.
 */
export function SaveBar({
  label,
  busy,
  error,
  onSave,
  status,
  disabled,
  sticky,
}: {
  label: string;
  busy: boolean;
  error: string | null;
  onSave: () => void;
  status?: string | null;
  disabled?: boolean;
  sticky?: boolean;
}) {
  return (
    <div className={sticky ? 'ch-save-bar ch-save-bar-sticky' : 'ch-save-bar'}>
      {error ? (
        <p className="ch-form-error" role="alert">
          {error}
        </p>
      ) : null}
      {status ? (
        <p className="ch-save-status" role="status">
          {status}
        </p>
      ) : null}
      <button type="button" className="ch-btn ch-btn-primary ch-save" disabled={busy || disabled} aria-busy={busy || undefined} onClick={onSave}>
        {busy ? <span className="ch-form-spinner" aria-hidden="true" /> : null}
        {label}
      </button>
    </div>
  );
}

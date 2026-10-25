'use client';

// What the date and time sheets share (editor upgrades spec §1): their CSS, the wheel (the
// library's, with the ARIA it leaves out) and the scope a page outside the home brings.
//
// - PICKER_CSS draws the sheets from the home's tokens only: the sheet on --ch-section, the
//   chosen day --ch-selected / --ch-selected-text, today's number --ch-accent, the second date
//   line --ch-muted at 11px, the wheel band --ch-surface. Logical properties, no hover, nothing
//   under 11 px, targets of 44 px or more. The library's own rules (index.css of
//   @ncdai/react-wheel-picker 1.2.3, MIT) are inlined so the page needs no stylesheet import.
// - Wheel: the library sets no ARIA, so after each render the wrapper makes the focusable
//   element a spinbutton (aria-label, aria-valuetext, aria-valuenow over the list) and hides the
//   rotated copies of the options from a screen reader. The library already handles arrows,
//   Home/End and type-ahead on that element.
// - PickerScope: Settings is outside `.ch-home`, so its picker brings the scope (HOME_THEME_CSS,
//   data-theme, dir). Inside the home the sheets render in place and inherit it.

import { useEffect, useRef, type ReactNode } from 'react';
import { useLocale } from 'next-intl';
import { WheelPicker, WheelPickerWrapper, type WheelPickerOption } from '@ncdai/react-wheel-picker';
import { hapticSelection, useColorScheme } from '@/src/lib/telegram-ui';
import { FORM_CSS } from './form-kit';
import { HOME_THEME_CSS } from './home-theme';

/** The wheel's item height, and the number of options on its ring: a ring of 20 at 44 px is about 280 px tall, the grid's six rows. */
export const WHEEL_ITEM_PX = 44;
export const WHEEL_VISIBLE = 20;

export const PICKER_CSS = `
[data-rwp-wrapper] ul{margin:0;padding:0;list-style:none}
[data-rwp-wrapper] li{margin:0;padding:0}
[data-rwp-wrapper]{position:relative;overflow:hidden;display:flex;width:100%;align-items:stretch;justify-content:space-between;perspective:2000px;-webkit-user-select:none;user-select:none}
[data-rwp]{position:relative;overflow:hidden;flex:1;cursor:default;-webkit-mask-image:linear-gradient(to bottom,transparent 0%,black 20%,black 80%,transparent 100%);mask-image:linear-gradient(to bottom,transparent 0%,black 20%,black 80%,transparent 100%)}
[data-rwp]:focus-visible{outline:none}
[data-rwp-highlight-wrapper]{position:absolute;overflow:hidden;top:50%;width:100%;transform:translateY(-50%);font-size:1rem;font-weight:500}
[data-rwp-highlight-list]{position:absolute;width:100%}
[data-rwp-options]{position:absolute;top:50%;left:0;display:block;width:100%;height:0;margin:0 auto;-webkit-font-smoothing:subpixel-antialiased;will-change:transform;backface-visibility:hidden;transform-style:preserve-3d}
[data-rwp-option]{position:absolute;top:0;left:0;width:100%;-webkit-font-smoothing:subpixel-antialiased;will-change:visibility;font-size:.875rem}
[data-rwp-option],[data-rwp-highlight-item]{display:flex;align-items:center;justify-content:center}
[data-rwp-option][data-disabled],[data-rwp-highlight-item][data-disabled]{pointer-events:none}
.ch-picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ch-picker-head {
  display: grid;
  grid-template-columns: 44px 1fr 44px;
  align-items: center;
  gap: 4px;
}
.ch-picker-nav {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: 44px;
  block-size: 44px;
  padding: 0;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--ch-accent);
  cursor: pointer;
  touch-action: manipulation;
}
.ch-picker-nav:disabled {
  color: var(--ch-disabled);
  cursor: default;
}
.ch-picker-nav:focus-visible,
.ch-picker-title:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 1px;
}
.ch-picker-nav.is-hidden {
  visibility: hidden;
}
.ch-home[dir='rtl'] .ch-picker-flip {
  transform: scaleX(-1);
}
.ch-picker-title {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-block-size: 44px;
  justify-content: center;
  padding: 2px 8px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--ch-month-title);
  font: inherit;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-picker-title-main {
  font-size: 17px;
  font-weight: 600;
  line-height: 1.25;
}
.ch-picker-title-sub {
  font-size: 11px;
  line-height: 1.2;
  color: var(--ch-muted);
}
.ch-picker-body {
  block-size: 288px;
  overflow: hidden;
}
.ch-picker-weekdays,
.ch-picker-row {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
}
.ch-picker-weekdays {
  margin-block-end: 2px;
}
.ch-picker-weekday {
  text-align: center;
  font-size: 12px;
  line-height: 24px;
  color: var(--ch-muted);
}
.ch-picker-grid {
  animation: ch-picker-slide 120ms ease-out;
}
@keyframes ch-picker-slide {
  from { transform: translateX(calc(var(--ch-picker-slide, 0) * 14px)); opacity: 0.4; }
  to { transform: none; opacity: 1; }
}
.ch-home[dir='rtl'] .ch-picker-grid {
  animation-name: ch-picker-slide-rtl;
}
@keyframes ch-picker-slide-rtl {
  from { transform: translateX(calc(var(--ch-picker-slide, 0) * -14px)); opacity: 0.4; }
  to { transform: none; opacity: 1; }
}
.ch-picker-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  inline-size: 100%;
  min-block-size: 48px;
  padding: 0;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--ch-text);
  font: inherit;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-picker-blank {
  min-block-size: 48px;
}
.ch-picker-num {
  font-size: 16px;
  font-weight: 500;
  line-height: 1.25;
}
.ch-picker-sub {
  max-inline-size: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 1.2;
  color: var(--ch-muted);
}
.ch-picker-cell.is-today .ch-picker-num {
  color: var(--ch-accent);
  font-weight: 700;
}
.ch-picker-cell[aria-selected='true'] {
  background: var(--ch-selected);
  color: var(--ch-selected-text);
}
.ch-picker-cell[aria-selected='true'] .ch-picker-num,
.ch-picker-cell[aria-selected='true'] .ch-picker-sub {
  color: var(--ch-selected-text);
}
.ch-picker-cell[aria-disabled='true'] {
  cursor: default;
}
.ch-picker-cell[aria-disabled='true'] .ch-picker-num,
.ch-picker-cell[aria-disabled='true'] .ch-picker-sub {
  color: var(--ch-disabled);
}
.ch-picker-cell:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: -2px;
}
.ch-picker-foot {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 8px;
  min-block-size: 48px;
}
.ch-picker-foot .ch-btn:disabled {
  color: var(--ch-disabled);
  cursor: default;
}
.ch-picker-chosen {
  margin: 0;
  font-size: 13px;
  line-height: 1.35;
  color: var(--ch-muted);
}
.ch-picker-done {
  inline-size: 100%;
  min-block-size: 48px;
}
.ch-wheels {
  block-size: 288px;
  gap: 8px;
}
.ch-wheel {
  flex: 1;
  min-inline-size: 0;
  display: flex;
}
.ch-wheel [data-rwp] {
  inline-size: 100%;
  color: var(--ch-muted);
  font-size: 17px;
  align-self: center;
}
.ch-wheel [data-rwp-option] {
  font-size: 17px;
}
.ch-wheel-band {
  border-radius: 10px;
  background: var(--ch-surface);
  color: var(--ch-text);
}
.ch-wheel-item {
  font-size: 17px;
  font-weight: 600;
}
.ch-wheel [data-rwp]:focus-visible .ch-wheel-band {
  outline: 2px solid var(--ch-accent);
}
.ch-wheel-colon {
  align-self: center;
  flex: none;
  font-size: 20px;
  font-weight: 600;
  color: var(--ch-text);
}
`;

/** An option of a wheel: the value it holds and the text it shows. */
export type WheelOption = WheelPickerOption<string>;

export interface WheelProps {
  /** The wheel's accessible name ("Hour"). */
  label: string;
  options: WheelOption[];
  value: string;
  onChange: (value: string) => void;
  /** Loops past the ends (the hours and minutes). */
  infinite?: boolean;
}

/** The slice of an element applyWheelAria needs (a real one, or a stand-in in a test). */
export interface AriaTarget {
  setAttribute: (name: string, value: string) => void;
  querySelectorAll: (selector: string) => Iterable<{ setAttribute: (name: string, value: string) => void }>;
}

/**
 * Makes the wheel's focusable element a spinbutton: its name, the chosen text, its place in the
 * list. The rotated copies of the options and the highlight band repeat what the value text says,
 * so a screen reader skips them.
 */
export function applyWheelAria(el: AriaTarget | null, o: { label: string; text: string; index: number; count: number }): void {
  if (!el) return;
  el.setAttribute('role', 'spinbutton');
  el.setAttribute('aria-label', o.label);
  el.setAttribute('aria-valuetext', o.text);
  el.setAttribute('aria-valuenow', String(o.index));
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', String(o.count - 1));
  for (const child of el.querySelectorAll('[data-rwp-options], [data-rwp-highlight-wrapper]')) child.setAttribute('aria-hidden', 'true');
}

/** One wheel with the ARIA the library leaves out. Lay several out in a WheelPickerWrapper. */
export function Wheel({ label, options, value, onChange, infinite = false }: WheelProps) {
  const root = useRef<HTMLDivElement>(null);
  const shown = options.find((o) => o.value === value);
  const text = typeof shown?.label === 'string' ? shown.label : value;
  const index = Math.max(0, options.findIndex((o) => o.value === value));

  // The library renders the focusable element and gives it no role; the names follow the value.
  useEffect(() => {
    applyWheelAria(root.current?.querySelector<HTMLElement>('[data-rwp]') ?? null, { label, text, index, count: options.length });
  });

  return (
    <div ref={root} className="ch-wheel">
      <WheelPicker
        options={options}
        value={value}
        onValueChange={(next) => {
          hapticSelection();
          onChange(next);
        }}
        infinite={infinite}
        visibleCount={WHEEL_VISIBLE}
        optionItemHeight={WHEEL_ITEM_PX}
        classNames={{ highlightWrapper: 'ch-wheel-band', highlightItem: 'ch-wheel-item' }}
      />
    </div>
  );
}

export { WheelPickerWrapper };

/**
 * The home's scope for a sheet shown outside it (Settings): the tokens, the scheme the device
 * is in and the page's direction. Zero height; the sheet in it is position: fixed.
 */
export function PickerScope({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const locale = useLocale();
  return (
    <div className="ch-home" data-theme={scheme} dir={locale === 'he' ? 'rtl' : 'ltr'} lang={locale}>
      <style>{HOME_THEME_CSS}</style>
      <style>{FORM_CSS}</style>
      {children}
    </div>
  );
}

'use client';

// The Month's split handle (spec 2026-11-19 §3, plan Task 5): the bar between the month and the
// day's list on an upright window. A real button: a tap or Enter/Space toggles the split and the
// grown month, a drag down grows the month, a drag up shrinks it. It is never a drag source (an item
// lifted from a list is the drag library's; this is not), and only it carries touch-action: none so
// the finger moves the bar, not the page.
//
// The bar takes 22 px (HANDLE_PX); its touch area reaches 22 px below it (HANDLE_TOUCH_PX: padding
// plus a negative margin at its end, so the layout still gives it 22 px), 44 px in all, the home's
// tap floor. Nothing reaches above the bar: there it would cover the month's last week row (a tap on
// a square would resize the split, a drop there would miss); below it is the list's top.
//
// Pointer events with capture: on release, a move under HANDLE_TAP_PX is a tap (toggle), a longer
// one down grows, up shrinks. A click within CLICK_AFTER_UP_MS of a pointer gesture's release is
// that gesture's own (already answered), so it never toggles twice; any other click (the keyboard's,
// an assistive technology's, also after a drag that sent no click) toggles.

import { useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { useTranslations } from 'next-intl';
import { HANDLE_PX, HANDLE_TAP_PX, HANDLE_TOUCH_PX } from '@/src/lib/calendar-view/month-layout';

export interface SplitHandleProps {
  /** True while the month is grown (the list is a peek). */
  grown: boolean;
  onToggle: (next: 'split' | 'grown') => void;
}

/** A click this soon after a pointer gesture's release is that gesture's own click (a drag may send none). */
const CLICK_AFTER_UP_MS = 1000;

export function SplitHandle({ grown, onToggle }: SplitHandleProps) {
  const t = useTranslations('calendarHome');
  const startY = useRef<number | null>(null);
  // When a pointer gesture ended (its event's timeStamp): the click the browser sends after it is already answered.
  const upAt = useRef<number | null>(null);

  const toggle = () => onToggle(grown ? 'split' : 'grown');

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    upAt.current = null;
    startY.current = event.clientY;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch (err) {
      // A pointer that is already gone: the gesture still ends in pointerup or pointercancel.
      console.warn('[month] split handle: pointer capture failed:', err instanceof Error ? err.message : String(err));
    }
  };
  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const from = startY.current;
    startY.current = null;
    if (from === null) return;
    upAt.current = event.timeStamp;
    const dy = event.clientY - from;
    if (dy > HANDLE_TAP_PX) {
      if (!grown) onToggle('grown');
    } else if (dy < -HANDLE_TAP_PX) {
      if (grown) onToggle('split');
    } else {
      toggle();
    }
  };
  const onPointerCancel = () => {
    startY.current = null;
    upAt.current = null;
  };
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    const up = upAt.current;
    upAt.current = null;
    if (up !== null && event.timeStamp >= up && event.timeStamp - up < CLICK_AFTER_UP_MS) return;
    toggle();
  };
  const onKeyDown = (_event: KeyboardEvent<HTMLButtonElement>) => {
    upAt.current = null;
  };

  return (
    <button
      type="button"
      className="ch-handle"
      aria-expanded={grown}
      aria-label={grown ? t('month.showSmaller') : t('month.showBigger')}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <span className="ch-handle-pill" aria-hidden="true" />
    </button>
  );
}

/** The handle's styles: 22 px of bar, its 44 px tap area reaching below it only; tokens only, logical properties. */
export const SPLIT_HANDLE_CSS = `
.ch-handle {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: content-box;
  inline-size: 100%;
  block-size: ${HANDLE_PX}px;
  padding-block: 0 ${HANDLE_TOUCH_PX}px;
  padding-inline: 0;
  margin-block: 0 -${HANDLE_TOUCH_PX}px;
  border: 0;
  background: transparent;
  color: var(--ch-muted);
  cursor: pointer;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
}
.ch-handle-pill {
  inline-size: 36px;
  block-size: 5px;
  border-radius: 3px;
  background: currentColor;
  opacity: 0.55;
}
.ch-handle:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: -2px;
  border-radius: 8px;
}
`;

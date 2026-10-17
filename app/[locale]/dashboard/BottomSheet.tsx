'use client';

// The home's bottom sheet (the approved mockups' sheet): a scrim, a panel from the
// bottom with a grab bar, and a Close button at its end, which is the browser's stand-in
// for Telegram's BackButton. Used by the item sheet (D5); D6's send sheet and menu can
// use it too. It doesn't touch Telegram's BackButton itself: one owner decides what that
// button does (the container, CalendarHome).
//
// - A dialog (role="dialog", aria-modal) with its own label. Focus moves into the panel
//   when it opens and back to whatever had it (the tapped row) when it closes.
// - Escape, a tap on the scrim and the Close button all call onClose.
// - Rendered in place, not in a portal, so it inherits the home's tokens and direction.
//   It is position: fixed: no ancestor of the home may set transform or filter.

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface BottomSheetProps {
  /** The dialog's accessible name. */
  label: string;
  /** The Close button's text. */
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}

type Focusable = { focus?: (options?: { preventScroll?: boolean }) => void };

export function BottomSheet({ label, closeLabel, onClose, children }: BottomSheetProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as Focusable | null;
    panel.current?.focus({ preventScroll: true });
    return () => {
      if (previous && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onClose();
  };

  return (
    <div className="ch-sheet-layer">
      <div className="ch-sheet-backdrop" aria-hidden="true" onClick={onClose} />
      <div ref={panel} className="ch-sheet" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="ch-sheet-grab" aria-hidden="true" />
        {children}
        <button type="button" className="ch-btn ch-sheet-close" onClick={onClose}>
          {closeLabel}
        </button>
      </div>
    </div>
  );
}

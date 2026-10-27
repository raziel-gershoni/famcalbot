'use client';

// The app's bottom sheet (the approved mockups' sheet): a scrim, a panel from the
// bottom with a grab bar, and a Close button at its end, which is the browser's stand-in
// for Telegram's BackButton. Used by the item sheet (D5); D6's send sheet and menu can
// use it too. It doesn't touch Telegram's BackButton itself: one owner decides what that
// button does (the screen's, AppScreen's onBack, which the container sets).
//
// - A dialog (role="dialog", aria-modal) with its own label. Focus moves into the panel
//   when it opens and back to whatever had it (the tapped row) when it closes.
// - It keeps focus while open (Plan E: over the Month's picked layout the page behind it
//   is some 30 day buttons and two chevrons, each of which would change the day): Tab
//   and Shift+Tab go round its own controls, and focus that lands outside it (a
//   keyboard's or a screen reader's) comes back to the panel.
// - Escape (wherever focus is), a tap on the scrim and the Close button all call onClose,
//   unless `closeDisabled` (a sheet that must not close while it works: a disconnect in
//   flight): then the Close button is disabled and the other two do nothing.
// - `variant="full"` (the editor): the panel fills the screen, with no grab bar and no Close
//   button of its own, since its content brings a Cancel in a header and a Save bar. The
//   rest (the dialog, the focus, Escape, the scrim) is the same.
// - Rendered in place, not in a portal, so it inherits the app's tokens (.ch-app) and direction.
//   It is position: fixed: no ancestor of a screen may set transform or filter.

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface BottomSheetProps {
  /** The dialog's accessible name. */
  label: string;
  /** The Close button's text. */
  closeLabel: string;
  onClose: () => void;
  /** 'full' fills the screen and brings its own controls (the editor). Default 'sheet'. */
  variant?: 'sheet' | 'full';
  /** The sheet cannot be closed now: the Close button is disabled, and Escape and the scrim do nothing. */
  closeDisabled?: boolean;
  children: ReactNode;
}

type Focusable = { focus?: (options?: { preventScroll?: boolean }) => void };
type TreeNode = { parentNode: TreeNode | null };

/** Whether `node` is `root` or inside it (a walk up the tree: the target of any event). */
function inside(root: TreeNode, node: unknown): boolean {
  for (let n = node as TreeNode | null; n; n = n.parentNode) if (n === root) return true;
  return false;
}

/** What a keyboard reaches by Tab: enabled controls, links with an href, and anything with a tabindex of 0 or more. */
export const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex^="-"])';

/** The panel's tabbable controls, in document order. */
function controlsIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE));
}

/** The mounted sheets, oldest first: only the last one owns the focus trap and Escape. */
const openSheets: object[] = [];

export function BottomSheet({ label, closeLabel, onClose, variant = 'sheet', closeDisabled = false, children }: BottomSheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const requestClose = () => {
    if (!closeDisabled) onClose();
  };
  const close = useRef(requestClose);
  useEffect(() => {
    close.current = requestClose;
  });

  // Focus in on open, out on close; while open, focus that lands outside comes back and
  // Escape closes the sheet wherever focus is. The listeners go before focus goes back.
  // With two sheets open the top one owns both, or each would pull focus from the other.
  useEffect(() => {
    const previous = document.activeElement as Focusable | null;
    const el = panel.current;
    const token = {};
    openSheets.push(token);
    const onTop = () => openSheets[openSheets.length - 1] === token;
    el?.focus({ preventScroll: true });
    const onFocusIn = (e: Event) => {
      if (el && onTop() && !inside(el as unknown as TreeNode, e.target)) el.focus({ preventScroll: true });
    };
    const onDocumentKey = (e: Event) => {
      const key = (e as unknown as { key?: string }).key;
      if (key === 'Escape' && el && onTop() && !inside(el as unknown as TreeNode, e.target)) close.current();
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onDocumentKey);
    return () => {
      openSheets.splice(openSheets.indexOf(token), 1);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onDocumentKey);
      if (previous && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      requestClose();
      return;
    }
    if (e.key !== 'Tab' || !panel.current) return;
    // Tab goes round the sheet's own controls.
    const controls = controlsIn(panel.current);
    const active = document.activeElement;
    if (controls.length === 0) {
      e.preventDefault();
      return;
    }
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (e.shiftKey && (active === first || active === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="ch-sheet-layer">
      <div className="ch-sheet-backdrop" aria-hidden="true" onClick={requestClose} />
      <div ref={panel} className={variant === 'full' ? 'ch-sheet ch-sheet-full' : 'ch-sheet'} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
        {variant === 'full' ? null : <div className="ch-sheet-grab" aria-hidden="true" />}
        {children}
        {variant === 'full' ? null : (
          <button type="button" className="ch-btn ch-sheet-close" disabled={closeDisabled} onClick={requestClose}>
            {closeLabel}
          </button>
        )}
      </div>
    </div>
  );
}

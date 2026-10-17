'use client';

// The home's bottom sheet (the approved mockups' sheet): a scrim, a panel from the
// bottom with a grab bar, and a Close button at its end, which is the browser's stand-in
// for Telegram's BackButton. Used by the item sheet (D5); D6's send sheet and menu can
// use it too. It doesn't touch Telegram's BackButton itself: one owner decides what that
// button does (the container, CalendarHome).
//
// - A dialog (role="dialog", aria-modal) with its own label. Focus moves into the panel
//   when it opens and back to whatever had it (the tapped row) when it closes.
// - It keeps focus while open (Plan E: over the Month's picked layout the page behind it
//   is some 30 day buttons and two chevrons, each of which would change the day): Tab
//   and Shift+Tab go round its own controls, and focus that lands outside it (a
//   keyboard's or a screen reader's) comes back to the panel.
// - Escape (wherever focus is), a tap on the scrim and the Close button all call onClose.
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
type TreeNode = { parentNode: TreeNode | null; childNodes?: ArrayLike<TreeNode>; nodeType?: number };

/** Whether `node` is `root` or inside it (a walk up the tree: the target of any event). */
function inside(root: TreeNode, node: unknown): boolean {
  for (let n = node as TreeNode | null; n; n = n.parentNode) if (n === root) return true;
  return false;
}

/** The panel's controls a keyboard reaches, in document order: enabled buttons, links, inputs, and anything with a tabindex of 0 or more. */
function controlsIn(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (node: TreeNode) => {
    for (const child of Array.from(node.childNodes ?? [])) {
      if (child.nodeType !== 1) continue;
      const el = child as unknown as HTMLElement;
      const tag = el.localName;
      const tabIndex = el.getAttribute('tabindex');
      const reachable =
        tabIndex !== null
          ? Number(tabIndex) >= 0
          : (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea')
            ? !el.hasAttribute('disabled')
            : tag === 'a' && el.hasAttribute('href');
      if (reachable) out.push(el);
      walk(child);
    }
  };
  walk(root as unknown as TreeNode);
  return out;
}

export function BottomSheet({ label, closeLabel, onClose, children }: BottomSheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  // Focus in on open, out on close; while open, focus that lands outside comes back and
  // Escape closes the sheet wherever focus is. The listeners go before focus goes back.
  useEffect(() => {
    const previous = document.activeElement as Focusable | null;
    const el = panel.current;
    el?.focus({ preventScroll: true });
    const onFocusIn = (e: Event) => {
      if (el && !inside(el as unknown as TreeNode, e.target)) el.focus({ preventScroll: true });
    };
    const onDocumentKey = (e: Event) => {
      const key = (e as unknown as { key?: string }).key;
      if (key === 'Escape' && el && !inside(el as unknown as TreeNode, e.target)) close.current();
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onDocumentKey);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onDocumentKey);
      if (previous && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
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

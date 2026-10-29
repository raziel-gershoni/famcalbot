'use client';

// How the panel moves (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Design > Navigation): one page with an
// in-page stack of views and no routes of its own.
//
// - `useViewStack()` is the stack: it starts on the root, `push` opens a view over the current one, `pop` goes back to the one
//   under it (and never off the root), and `resetTo` puts a known stack in place of it (after a delete: the root and the people).
// - A sheet that is open comes before the view in Back. A screen's sheets register a closer while they are open
//   (`useBackClose`); the shell's Back asks the registry (`closeTop`) first and only then pops. A sheet that must not close now
//   (a request is running) registers a closer that does nothing, so Back does nothing either.
//
// The shell owns the registry and provides it; the views and their sheets never call Telegram's BackButton (AppScreen's).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/** The views of the panel: the Overview, the people list, one person (by their database id), and the sub-screens. */
export type AdminView = { kind: 'root' } | { kind: 'users' } | { kind: 'user'; id: number } | { kind: 'feedback' } | { kind: 'blocked' } | { kind: 'activity' };

const ROOT: AdminView = { kind: 'root' };

export function useViewStack() {
  const [stack, setStack] = useState<AdminView[]>([ROOT]);
  const push = useCallback((view: AdminView) => setStack((s) => [...s, view]), []);
  const pop = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  /** Replace the stack with these views, but only while the view on top is still `top` (a move made since is not undone). */
  const resetTo = useCallback((views: AdminView[], top: AdminView) => setStack((s) => (s[s.length - 1] === top ? views : s)), []);
  return { current: stack[stack.length - 1], below: stack[stack.length - 2] as AdminView | undefined, depth: stack.length, push, pop, resetTo };
}

type Closer = () => void;

export interface SheetBack {
  /** A sheet is open: its closer goes on the stack, and the function returned takes it off. */
  register: (close: Closer) => () => void;
  /** Close the sheet that opened last. False when no sheet is open (Back is the view's). */
  closeTop: () => boolean;
}

export function useSheetBackRegistry(): SheetBack {
  const closers = useRef<Closer[]>([]);
  return useMemo(
    () => ({
      register: (close) => {
        closers.current.push(close);
        return () => {
          const at = closers.current.lastIndexOf(close);
          if (at >= 0) closers.current.splice(at, 1);
        };
      },
      closeTop: () => {
        const top = closers.current[closers.current.length - 1];
        if (!top) return false;
        top();
        return true;
      },
    }),
    [],
  );
}

export const SheetBackContext = createContext<SheetBack | null>(null);

/** While the caller is mounted (a sheet is open), Back calls `close`: the latest one, whatever rendered last. */
export function useBackClose(close: () => void): void {
  const registry = useContext(SheetBackContext);
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  });
  useEffect(() => registry?.register(() => latest.current()), [registry]);
}

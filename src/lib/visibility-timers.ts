/**
 * Timers that wait while the tab is hidden (spec 2026-11-02 web sign-in §2.14). A browser tab left open
 * in the background must not keep Neon awake: the Calendars screen's copy poll and the home's day check
 * ask the server, so while document.visibilityState is 'hidden' they stop and take up again on show.
 *
 * Pure: the clock, the visibility and the "next time it shows" subscription come in as `deps`, so a smoke
 * can drive them. DOM_VISIBILITY is the real browser; with no `document` (the server, a smoke) the tab is
 * never hidden, so everything behaves as a plain timer.
 */

export interface VisibilityDeps {
  /** True while the tab is in the background. */
  isHidden: () => boolean;
  /** Calls `cb` once, the next time the tab shows; the returned function takes it back. */
  onceVisible: (cb: () => void) => () => void;
  /** A timer; the returned function cancels it. */
  setTimer: (run: () => void, ms: number) => () => void;
}

export const DOM_VISIBILITY: VisibilityDeps = {
  isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  onceVisible: (cb) => {
    if (typeof document === 'undefined') {
      cb();
      return () => {};
    }
    const onChange = () => {
      if (document.visibilityState === 'hidden') return;
      document.removeEventListener('visibilitychange', onChange);
      cb();
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  },
  setTimer: (run, ms) => {
    const id = setTimeout(run, ms);
    return () => clearTimeout(id);
  },
};

/** Runs `run` now when the tab shows, else once it next shows. Returns the cancel. */
export function afterShown(run: () => void, deps: VisibilityDeps = DOM_VISIBILITY): () => void {
  if (!deps.isHidden()) {
    run();
    return () => {};
  }
  return deps.onceVisible(run);
}

/**
 * Calls `run` every `ms` while the tab shows. A tick that finds the tab hidden does not run and sets no
 * further timer; the poll takes up again, one full `ms` after the tab shows (the screen's own
 * visibilitychange handler has already refreshed by then). Returns the stop.
 */
export function startVisiblePoll(run: () => void, ms: number, deps: VisibilityDeps = DOM_VISIBILITY): () => void {
  let stopped = false;
  let cancel = () => {};
  const arm = () => {
    cancel = deps.setTimer(() => {
      if (stopped) return;
      if (deps.isHidden()) {
        cancel = afterShown(arm, deps);
        return;
      }
      run();
      arm();
    }, ms);
  };
  arm();
  return () => {
    stopped = true;
    cancel();
  };
}

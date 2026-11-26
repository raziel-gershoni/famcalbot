'use client';

// One media query as a React boolean (responsive home, release 2): useSyncExternalStore
// over matchMedia, with the guards release 1's All months had: no window, no matchMedia or a
// throwing call reads false (logged once), the older addListener pair where there is no
// addEventListener. The server renders false.

import { useCallback, useSyncExternalStore } from 'react';

let warned = false;

function warnOnce(err: unknown): void {
  if (warned) return;
  warned = true;
  console.warn('[media] matchMedia failed:', err);
}

/** A media query's list, or null where there is no window, no matchMedia or the call throws. */
function mediaList(query: string): MediaQueryList | null {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
  } catch (err) {
    warnOnce(err);
    return null;
  }
}

const never = () => false;

/** Whether `query` matches now, following its changes. False on the server and where matchMedia is missing. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      const list = mediaList(query);
      if (!list) return () => {};
      try {
        if (typeof list.addEventListener === 'function') {
          list.addEventListener('change', onChange);
          return () => list.removeEventListener('change', onChange);
        }
        // Safari before 14 has only the older pair.
        list.addListener(onChange);
        return () => list.removeListener(onChange);
      } catch (err) {
        warnOnce(err);
        return () => {};
      }
    },
    [query],
  );
  const snapshot = useCallback(() => mediaList(query)?.matches === true, [query]);
  return useSyncExternalStore(subscribe, snapshot, never);
}

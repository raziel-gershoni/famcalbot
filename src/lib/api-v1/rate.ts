// The Jewish times API's rate limit (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.6, open point B): 300
// requests a minute per key, in fixed one-minute windows, in this process's memory (the pattern of src/lib/page-limit.ts).
//
// - No Redis: Railway runs one process, and Upstash would cost a command per request. A restart starts the counts over,
//   which is fine for the owner's own apps.
// - On globalThis (Next 16 gives the routes separate module instances). The first counted request of a window schedules
//   one cleanup timer for the window's end (unref'd, so it never holds the process open); a request that rolls the window
//   over takes the old timer back.
// - A key that went over is logged once per minute, as a count, by its id.
// Pure: no import.

export const API_RATE_LIMIT = 300;
export const API_RATE_WINDOW_MS = 60 * 1000;

type RateState = { window: number; counts: Map<number, number>; refused: Map<number, number>; timer: unknown };

export type RateVerdict = {
  ok: boolean;
  limit: number;
  remaining: number;
  /** The window's end, epoch seconds (X-RateLimit-Reset). */
  resetS: number;
  /** Seconds to the window's end, at least 1 (Retry-After). */
  retryAfterS: number;
};

/** The process's counts, read on each call (a smoke starts them over by deleting globalThis.__apiV1Rate). */
function sharedState(): RateState {
  const g = globalThis as { __apiV1Rate?: RateState };
  return (g.__apiV1Rate ??= { window: -1, counts: new Map(), refused: new Map(), timer: null });
}

function rollOver(state: RateState, next: number): void {
  for (const [id, n] of state.refused) {
    console.warn(`[api] key ${id}: ${n} requests over the limit in the minute from ${new Date(state.window * API_RATE_WINDOW_MS).toISOString()}`);
  }
  if (state.timer != null) clearTimeout(state.timer as Parameters<typeof clearTimeout>[0]);
  state.timer = null;
  state.window = next;
  state.counts.clear();
  state.refused.clear();
}

function scheduleCleanup(state: RateState, window: number, now: number): void {
  const timer = setTimeout(() => {
    state.timer = null;
    if (state.window === window) rollOver(state, -1);
  }, (window + 1) * API_RATE_WINDOW_MS - now);
  // A cleanup timer, not a call timeout: it must never keep the process from exiting
  (timer as { unref?: () => unknown }).unref?.();
  state.timer = timer;
}

/** Counts one request of `keyId` at `now` (epoch ms) and says whether it may go on. */
export function countRequest(keyId: number, now: number): RateVerdict {
  const state = sharedState();
  const window = Math.floor(now / API_RATE_WINDOW_MS);
  if (window !== state.window) rollOver(state, window);
  const count = (state.counts.get(keyId) ?? 0) + 1;
  state.counts.set(keyId, count);
  if (state.timer == null) scheduleCleanup(state, window, now);
  const end = (window + 1) * API_RATE_WINDOW_MS;
  const base = { limit: API_RATE_LIMIT, resetS: Math.ceil(end / 1000), retryAfterS: Math.max(1, Math.ceil((end - now) / 1000)) };
  if (count <= API_RATE_LIMIT) return { ok: true, remaining: API_RATE_LIMIT - count, ...base };
  state.refused.set(keyId, (state.refused.get(keyId) ?? 0) + 1);
  return { ok: false, remaining: 0, ...base };
}

export function rateHeaders(verdict: RateVerdict): Record<string, string> {
  return { 'X-RateLimit-Limit': String(verdict.limit), 'X-RateLimit-Remaining': String(verdict.remaining), 'X-RateLimit-Reset': String(verdict.resetS) };
}

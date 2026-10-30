// The zmanim city pages' request limit (spec 2026-10-30-public-zmanim §6.4). The pages are rendered on each request in
// the one Railway process the bot's webhooks and cron run in, so one client address gets CITY_PAGE_LIMIT city pages a
// minute; past that the proxy answers 429 with Retry-After until the minute ends. No person reading pages comes near it.
//
// - The address is the x-real-ip header Railway's edge sets (famcal.bot is behind no proxy that sets another one).
// - The count lives in this process's memory, on globalThis (Next 16 gives the proxy and the routes separate module
//   instances, src/lib/timezone.ts), in fixed one-minute windows: it holds one minute of addresses at most, and a
//   restart starts it over.
// - Every city-page request counts, a router prefetch (next-router-prefetch: 1) too: a header is the client's to set, so
//   none buys a render past the limit. The zmanim pages link city pages with plain <a href>, which is never prefetched.
// - The path is read as the routes read it: next-intl decodes the pathname (decodeURI) before it rewrites, and Next
//   decodes the result once more, so /%7Amanim/jerusalem and /%257Amanim/jerusalem are city pages too. The test runs
//   over the path decoded until it stops changing (three rounds at most), case-insensitively.
// - No address outlives its minute: the first counted request of a window schedules one cleanup timer for the window's
//   end (unref'd, so it never holds the process open), which clears the addresses. The Privacy Policy says the count is
//   "in memory only and for one minute". A request that rolls the window over takes the old timer back.
// - Nothing about the visitor is logged: a minute with refusals is logged as a count, once, when its timer runs (or at the
//   first request after it, if the timer has not), with the minute it was.
// Pure: no import.

/** City pages one address may open in a minute. */
export const CITY_PAGE_LIMIT = 60;
export const CITY_PAGE_WINDOW_MS = 60 * 1000;

/** A city page in any language, as the proxy sees the path: /zmanim/<slug>, /he/zmanim/<slug>, /ru/zmanim/<slug>. */
const CITY_PAGE = /^\/(?:he\/|ru\/)?zmanim\/[^/]+\/?$/i;

/** The routes decode a path twice (next-intl, then Next); the third round is room. */
const DECODE_ROUNDS = 3;

export type CityPageLimitState = {
  window: number;
  counts: Map<string, number>;
  refused: number;
  /** The pending cleanup timer for the current window's end, or null. */
  timer: unknown;
};
export type CityPageRequest = { path: string; address: string | null };
export type CityPageVerdict = { ok: true } | { ok: false; retryAfterS: number };

/** The process's count, read on each call (a smoke starts it over by deleting globalThis.__zmanimPageLimit). */
function sharedState(): CityPageLimitState {
  const shared = globalThis as { __zmanimPageLimit?: CityPageLimitState };
  return (shared.__zmanimPageLimit ??= { window: -1, counts: new Map(), refused: 0, timer: null });
}

/**
 * The path as the routes will read it: percent-decoded (decodeURI, as next-intl does) until it stops changing, three
 * rounds at most. A malformed escape ends the decoding with the last good value: it is a client's input, not a failure,
 * and the path is not logged (nothing about a visitor is), so there is nothing to report. The proxy reads the locale
 * of a refused request from this too.
 */
export function routedPath(path: string): string {
  let current = path;
  for (let round = 0; round < DECODE_ROUNDS; round++) {
    let next: string;
    try {
      next = decodeURI(current);
    } catch {
      return current;
    }
    if (next === current) break;
    current = next;
  }
  return current;
}

/** Ends the current window: logs its refusals (once), takes the pending timer back, and starts `next` (-1: no window yet). */
function rollOver(state: CityPageLimitState, next: number): void {
  if (state.refused > 0) {
    console.warn(`[zmanim-limit] refused ${state.refused} requests in the minute from ${new Date(state.window * CITY_PAGE_WINDOW_MS).toISOString()}`);
  }
  if (state.timer != null) clearTimeout(state.timer as Parameters<typeof clearTimeout>[0]);
  state.timer = null;
  state.window = next;
  state.counts.clear();
  state.refused = 0;
}

/** One cleanup timer for the end of `window`: it clears the addresses unless a request has moved on to another window. */
function scheduleCleanup(state: CityPageLimitState, window: number, now: number): void {
  const timer = setTimeout(() => {
    state.timer = null;
    if (state.window === window) rollOver(state, -1);
  }, (window + 1) * CITY_PAGE_WINDOW_MS - now);
  // A cleanup timer, not a call timeout: it must never keep the process from exiting
  (timer as { unref?: () => unknown }).unref?.();
  state.timer = timer;
}

/**
 * Counts one page request (every request the proxy sees, so a new minute starts on time) and says whether it may go on:
 * any page but a city page always may; a city page (a prefetch of one too) may while its address has opened at most
 * CITY_PAGE_LIMIT of them this minute. `now` is epoch milliseconds.
 */
export function cityPageVerdict(request: CityPageRequest, now: number, state: CityPageLimitState = sharedState()): CityPageVerdict {
  const window = Math.floor(now / CITY_PAGE_WINDOW_MS);
  if (window !== state.window) rollOver(state, window);
  if (!CITY_PAGE.test(routedPath(request.path))) return { ok: true };
  const key = request.address ?? 'none';
  const count = (state.counts.get(key) ?? 0) + 1;
  state.counts.set(key, count);
  if (state.timer == null) scheduleCleanup(state, window, now);
  if (count <= CITY_PAGE_LIMIT) return { ok: true };
  state.refused += 1;
  return { ok: false, retryAfterS: Math.max(1, Math.ceil(((window + 1) * CITY_PAGE_WINDOW_MS - now) / 1000)) };
}

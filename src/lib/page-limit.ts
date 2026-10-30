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
// - Nothing about the visitor is logged: a minute with refusals is logged as a count, once, at the first request after
//   it, with the minute it was.
// Pure: no import.

/** City pages one address may open in a minute. */
export const CITY_PAGE_LIMIT = 60;
export const CITY_PAGE_WINDOW_MS = 60 * 1000;

/** A city page in any language, as the proxy sees the path: /zmanim/<slug>, /he/zmanim/<slug>, /ru/zmanim/<slug>. */
const CITY_PAGE = /^\/(?:he\/|ru\/)?zmanim\/[^/]+\/?$/;

export type CityPageLimitState = { window: number; counts: Map<string, number>; refused: number };
export type CityPageRequest = { path: string; address: string | null };
export type CityPageVerdict = { ok: true } | { ok: false; retryAfterS: number };

/** The process's count, read on each call (a smoke starts it over by deleting globalThis.__zmanimPageLimit). */
function sharedState(): CityPageLimitState {
  const shared = globalThis as { __zmanimPageLimit?: CityPageLimitState };
  return (shared.__zmanimPageLimit ??= { window: -1, counts: new Map(), refused: 0 });
}

/**
 * Counts one page request (every request the proxy sees, so a new minute starts on time) and says whether it may go on:
 * any page but a city page always may; a city page (a prefetch of one too) may while its address has opened at most
 * CITY_PAGE_LIMIT of them this minute. `now` is epoch milliseconds.
 */
export function cityPageVerdict(request: CityPageRequest, now: number, state: CityPageLimitState = sharedState()): CityPageVerdict {
  const window = Math.floor(now / CITY_PAGE_WINDOW_MS);
  if (window !== state.window) {
    if (state.refused > 0) {
      console.warn(`[zmanim-limit] refused ${state.refused} requests in the minute from ${new Date(state.window * CITY_PAGE_WINDOW_MS).toISOString()}`);
    }
    state.window = window;
    state.counts.clear();
    state.refused = 0;
  }
  if (!CITY_PAGE.test(request.path)) return { ok: true };
  const key = request.address ?? 'none';
  const count = (state.counts.get(key) ?? 0) + 1;
  state.counts.set(key, count);
  if (count <= CITY_PAGE_LIMIT) return { ok: true };
  state.refused += 1;
  return { ok: false, retryAfterS: Math.max(1, Math.ceil(((window + 1) * CITY_PAGE_WINDOW_MS - now) / 1000)) };
}

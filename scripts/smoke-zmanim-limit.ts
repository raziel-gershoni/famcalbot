// Smoke test for the zmanim city pages' request limit (spec 2026-10-30-public-zmanim §6.4; plan Task 9):
//
//  - Z1 the count: 60 city pages a minute from one address pass and the 61st gets Retry-After until the minute ends;
//    another address and any other page are not touched; the next minute starts over; requests with no address are
//    counted under one key.
//  - Z2 the paths it counts: a city page in en, he and ru (with or without a trailing slash); never the index, another
//    page, the /en address next-intl redirects, or a deeper path.
//  - Z3 the log: a minute with refusals is one line at the first request after it, with the count and the minute, and
//    never the address; a minute with none logs nothing.
//  - Z4 the proxy: the 61st city page from one address is a 429 with Retry-After and no-store, before next-intl;
//    a router prefetch (next-router-prefetch: 1) counts like any other request; the same address still gets the blog,
//    another address still gets the city, and the count is on globalThis.
//  - Z5 the path as the routes read it: a percent-encoded, double-encoded or upper-case city page path is counted
//    against the same address as the plain one (next-intl decodes the path and Next decodes it again), in the pure
//    module and in the real proxy; a malformed escape does not throw.
//  - Z6 the 429 page: a short static HTML page in the visitor's language (he and ru by the path prefix, else en), with
//    its words in messages (zmanimSite.limit), lang and dir right, no external CSS or JS, no emoji.
//  - Z7 the minute's end: the first counted request of a minute schedules ONE unref'd cleanup timer for the minute's
//    end, which clears the addresses, so none outlives its minute (the Privacy Policy says "for one minute").
//
// Pure code and the real proxy (next-intl's middleware over i18n/routing.ts). No network, no DB.
//
// Run with the fake env (never the real one), from the repo root, as ci-smokes.sh does.

import { assert, check, EMOJI, finish, load, messages, show, type Row } from './lib/site-harness';

/** A call of setTimeout the smoke saw: what it was asked, whether the handle was unref'd, whether it was cleared. */
type TimerCall = { fn: () => void; ms: number; unref: boolean; cleared: boolean; handle: unknown };

/**
 * Watches setTimeout and clearTimeout: every call is recorded in `timers`. With `pass` false a timer is never started
 * (the smoke runs it by hand with `fn()`); with `pass` true it is started as usual (the proxy's async code may need it).
 */
function watchTimers(pass: boolean) {
  const timers: TimerCall[] = [];
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: () => void, ms: number, ...rest: unknown[]) => {
    const call: TimerCall = { fn, ms, unref: false, cleared: false, handle: null };
    const handle = pass ? (realSet as (...args: unknown[]) => Row)(fn, ms, ...rest) : { unref: () => handle, ref: () => handle, hasRef: () => !call.unref };
    const unref = handle.unref.bind(handle);
    handle.unref = () => {
      call.unref = true;
      return unref();
    };
    call.handle = handle;
    timers.push(call);
    return handle;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    const call = timers.find((t) => t.handle === handle);
    if (call) call.cleared = true;
    if (pass) realClear(handle as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout;
  return {
    timers,
    restore: () => {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

const ADDRESS = '203.0.113.7';
const OTHER = '198.51.100.20';
// 12:00:20 UTC: 40 seconds are left in its minute
const T0 = Date.UTC(2026, 10, 6, 12, 0, 20);

async function main() {
  const { cityPageVerdict, CITY_PAGE_LIMIT, CITY_PAGE_WINDOW_MS } = await load('src/lib/page-limit.ts');
  const fresh = () => ({ window: -1, counts: new Map<string, number>(), refused: 0, timer: null });
  const city = (address: string | null, path = '/zmanim/jerusalem') => ({ path, address });
  /**
   * Runs `fn` with console.warn caught and the timers watched (a timer is recorded and never runs), and gives back what
   * it returned, the lines it logged and the timers it set.
   */
  const quiet = <T>(fn: () => T): { value: T; lines: string[]; timers: TimerCall[] } => {
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    const watch = watchTimers(false);
    try {
      return { value: fn(), lines, timers: watch.timers };
    } finally {
      console.warn = warn;
      watch.restore();
    }
  };

  await check('Z1 the count: 60 city pages a minute from one address, the 61st refused with Retry-After to the minute\'s end; other addresses and other pages untouched; the next minute starts over; no address is one key', () => {
    assert(CITY_PAGE_LIMIT === 60 && CITY_PAGE_WINDOW_MS === 60_000, `the limit ${CITY_PAGE_LIMIT} per ${CITY_PAGE_WINDOW_MS} ms`);
    const state = fresh();
    quiet(() => {
      for (let i = 1; i <= 60; i++) assert(cityPageVerdict(city(ADDRESS), T0 + i, state).ok, `request ${i} refused`);
      const refused = cityPageVerdict(city(ADDRESS), T0 + 100, state);
      assert(!refused.ok && refused.retryAfterS === 40, `the 61st: ${show(refused)}`);
      assert(cityPageVerdict(city(OTHER), T0 + 101, state).ok, 'another address refused');
      for (const path of ['/blog', '/zmanim', '/he', '/privacy']) assert(cityPageVerdict(city(ADDRESS, path), T0 + 102, state).ok, `${path} refused`);
      assert(!cityPageVerdict(city(ADDRESS, '/ru/zmanim/haifa'), T0 + 104, state).ok, 'another city in Russian passed: the count is per address, not per page');
      const late = cityPageVerdict(city(ADDRESS), T0 + 39_600, state);
      assert(!late.ok && late.retryAfterS === 1, `0.4 s before the minute ends: ${show(late)}`);
      assert(cityPageVerdict(city(ADDRESS), T0 + 40_000, state).ok, 'the next minute did not start over');
      for (let i = 1; i <= 60; i++) assert(cityPageVerdict(city(null), T0 + 40_000 + i, state).ok, `no address, request ${i} refused`);
      assert(!cityPageVerdict(city(null), T0 + 40_100, state).ok, 'requests with no address are not counted together');
    });
  });

  await check('Z2 the paths: a city page in en, he and ru (a trailing slash too) is counted; the index, other pages, /en (a redirect) and deeper paths are not', () => {
    const counted = (path: string) => {
      const state = fresh();
      return quiet(() => {
        for (let i = 0; i < CITY_PAGE_LIMIT; i++) cityPageVerdict(city(ADDRESS, path), T0, state);
        return !cityPageVerdict(city(ADDRESS, path), T0, state).ok;
      }).value;
    };
    for (const path of ['/zmanim/jerusalem', '/he/zmanim/jerusalem', '/ru/zmanim/new-york', '/zmanim/beer-sheva/', '/zmanim/no-such-city']) assert(counted(path), `${path} is not counted`);
    for (const path of ['/zmanim', '/he/zmanim', '/ru/zmanim/', '/', '/blog/why-i-built-famcal', '/en/zmanim/jerusalem', '/zmanim/jerusalem/extra', '/zmanimx/jerusalem', '/dashboard']) assert(!counted(path), `${path} is counted`);
  });

  await check('Z3 the log: one line per minute with refusals, at the first request after it, with the count and the minute and no address; nothing for a minute without', () => {
    const state = fresh();
    const first = quiet(() => {
      for (let i = 0; i < 65; i++) cityPageVerdict(city(ADDRESS), T0 + i, state);
      for (let i = 0; i < 62; i++) cityPageVerdict(city(OTHER), T0 + 100 + i, state);
    });
    assert(first.lines.length === 0, `logged inside the minute: ${show(first.lines)}`);
    const next = quiet(() => {
      cityPageVerdict(city(OTHER, '/blog'), T0 + 50_000, state);
      cityPageVerdict(city(OTHER, '/blog'), T0 + 50_001, state);
    });
    assert(show(next.lines) === show(['[zmanim-limit] refused 7 requests in the minute from 2026-11-06T12:00:00.000Z']), `the log ${show(next.lines)}`);
    assert(!next.lines.some((line) => line.includes(ADDRESS) || line.includes(OTHER)), 'an address in the log');
    const calm = quiet(() => cityPageVerdict(city(ADDRESS), T0 + 120_000, state));
    assert(calm.lines.length === 0, `a minute with no refusal logged ${show(calm.lines)}`);
  });

  await check('Z4 the proxy: the 61st city page from one address is a 429 with Retry-After and no-store, an HTML page, before next-intl; a router prefetch counts like any other request; the same address still gets the blog, another address still gets the city; the count is on globalThis', async () => {
    delete (globalThis as Row).__zmanimPageLimit;
    const { default: proxy, config } = await load('proxy.ts');
    const { NextRequest } = await import('next/server');
    const get = (path: string, address: string, headers: Record<string, string> = {}) =>
      proxy(new NextRequest(`https://famcal.bot${path}`, { headers: { 'x-real-ip': address, ...headers } })) as Promise<Response>;
    assert(show(config.matcher) === show(['/((?!api|_next|_vercel|refresh-token|oauth-callback|oauth-complete|.*\\..*).*)']), `the matcher ${show(config.matcher)}`);
    // The proxy reads the clock: held still, so the 61 requests fall in one minute however long they take
    const realNow = Date.now;
    Date.now = () => T0;
    try {
      for (let i = 1; i <= 59; i++) {
        const res = await get(i % 2 ? '/zmanim/jerusalem' : '/he/zmanim/haifa', ADDRESS);
        assert(res.status !== 429, `request ${i}: ${res.status}`);
      }
      // A router prefetch counts like any other request (a header is the client's to set): the 60th passes, the 61st is refused
      const prefetch = await get('/zmanim/eilat', ADDRESS, { 'next-router-prefetch': '1' });
      assert(prefetch.status !== 429, `the 60th, a prefetch: ${prefetch.status}`);
      const overPrefetch = await get('/zmanim/eilat', ADDRESS, { 'next-router-prefetch': '1', rsc: '1' });
      assert(overPrefetch.status === 429, `the 61st, a prefetch, was not counted: ${overPrefetch.status}`);
      const refused = await get('/zmanim/jerusalem', ADDRESS);
      assert(refused.status === 429 && refused.headers.get('retry-after') === '40', `the 62nd: ${refused.status}, Retry-After ${refused.headers.get('retry-after')}`);
      assert(refused.headers.get('cache-control') === 'no-store', 'the 429 is cached');
      assert(refused.headers.get('content-type')?.startsWith('text/html') === true, `the 429's type ${refused.headers.get('content-type')}`);
      assert(refused.headers.get('x-middleware-rewrite') === null, 'next-intl ran on a refused request');
      const blog = await get('/blog', ADDRESS);
      assert(blog.status === 200 && blog.headers.get('x-middleware-rewrite') === 'https://famcal.bot/en/blog', `the blog for a limited address: ${blog.status}`);
      const other = await get('/zmanim/jerusalem', OTHER);
      assert(other.status === 200 && other.headers.get('x-middleware-rewrite') === 'https://famcal.bot/en/zmanim/jerusalem', `another address: ${other.status}`);
    } finally {
      Date.now = realNow;
    }
    const state = (globalThis as Row).__zmanimPageLimit;
    assert(state && state.counts.get(ADDRESS) === 62 && state.counts.get(OTHER) === 1, `the shared count ${show(state && [...state.counts])}`);
  });

  await check('Z5 the path as the routes read it: an encoded, double-encoded or upper-case city page path counts against the same address as the plain one, in the pure module and in the real proxy; a malformed escape does not throw', async () => {
    // next-intl decodes the pathname (decodeURI) before it rewrites, and Next decodes the rewritten path once more
    const variants = [
      '/zmanim/jerusalem',
      '/%7Amanim/jerusalem',
      '/h%65/zmanim/haifa',
      '/%257Amanim/jerusalem',
      '/%25257Amanim/jerusalem',
      '/ZMANIM/Jerusalem',
      '/HE/Zmanim/haifa',
      '/%52u/zmanim/new-york',
      '/ru/zmanim/%6Eew-york/',
    ];
    const state = fresh();
    quiet(() => {
      for (let i = 0; i < CITY_PAGE_LIMIT; i++) assert(cityPageVerdict(city(ADDRESS, variants[i % variants.length]), T0, state).ok, `request ${i} refused`);
      for (const path of variants) assert(!cityPageVerdict(city(ADDRESS, path), T0, state).ok, `${path} was not counted against the address`);
    });
    // Neither the index nor a deeper path nor /en becomes a city page by being encoded
    for (const path of ['/%7Amanim', '/%7Amanim/', '/he/%7Amanim', '/en/%7Amanim/jerusalem', '/zmanim/jerusalem/%65xtra', '/%7Amanimx/jerusalem', '/%62log/why']) {
      const quietState = fresh();
      const counted = quiet(() => {
        for (let i = 0; i < CITY_PAGE_LIMIT; i++) cityPageVerdict(city(ADDRESS, path), T0, quietState);
        return !cityPageVerdict(city(ADDRESS, path), T0, quietState).ok;
      }).value;
      assert(!counted, `${path} is counted`);
    }
    // A malformed escape is the client's input, not a failure: it does not throw and the path is counted as the shape it has
    // (Next answers such a request 400, so no page is rendered for it)
    const odd = fresh();
    quiet(() => {
      for (const path of ['/zmanim/%E0%A4%A', '/zmanim/%']) {
        for (let i = 0; i < CITY_PAGE_LIMIT; i++) cityPageVerdict(city(ADDRESS, path), T0, odd);
        assert(!cityPageVerdict(city(ADDRESS, path), T0, odd).ok, `${path} was not counted`);
        odd.counts.clear();
      }
    });
    // The real proxy: the variants and the plain path share one count
    delete (globalThis as Row).__zmanimPageLimit;
    const { default: proxy } = await load('proxy.ts');
    const { NextRequest } = await import('next/server');
    const get = (path: string, address: string) => proxy(new NextRequest(`https://famcal.bot${path}`, { headers: { 'x-real-ip': address } })) as Promise<Response>;
    const realNow = Date.now;
    Date.now = () => T0;
    const watch = watchTimers(true);
    try {
      for (let i = 0; i < CITY_PAGE_LIMIT; i++) {
        const res = await get(variants[i % variants.length], OTHER);
        assert(res.status !== 429, `proxy request ${i} (${variants[i % variants.length]}): ${res.status}`);
      }
      for (const path of variants) {
        const res = await get(path, OTHER);
        assert(res.status === 429, `${path} passed the proxy past the limit: ${res.status}`);
      }
      const index = await get('/%7Amanim', OTHER);
      assert(index.status === 200, `the index, encoded: ${index.status}`);
    } finally {
      Date.now = realNow;
      watch.restore();
    }
  });

  await check('Z6 the 429 page: a short static HTML page in the visitor\'s language (he and ru by the path prefix, else en), words from messages, lang and dir right, no external CSS or JS, no emoji', async () => {
    delete (globalThis as Row).__zmanimPageLimit;
    const { default: proxy } = await load('proxy.ts');
    const { NextRequest } = await import('next/server');
    const get = (path: string, address: string) => proxy(new NextRequest(`https://famcal.bot${path}`, { headers: { 'x-real-ip': address } })) as Promise<Response>;
    const realNow = Date.now;
    Date.now = () => T0;
    const watch = watchTimers(true);
    try {
      const cases: [string, 'en' | 'he' | 'ru', string][] = [
        ['/zmanim/x', 'en', 'ltr'],
        ['/he/zmanim/x', 'he', 'rtl'],
        ['/ru/zmanim/x', 'ru', 'ltr'],
        ['/%48E/zmanim/x', 'he', 'rtl'],
      ];
      for (const [i, [path, locale, dir]] of cases.entries()) {
        const address = `192.0.2.${10 + i}`;
        for (let n = 0; n < CITY_PAGE_LIMIT; n++) await get(path, address);
        const res = await get(path, address);
        assert(res.status === 429, `${path}: ${res.status}`);
        assert(res.headers.get('retry-after') === '40' && res.headers.get('cache-control') === 'no-store', `${path}: Retry-After ${res.headers.get('retry-after')}, Cache-Control ${res.headers.get('cache-control')}`);
        assert(res.headers.get('content-type')?.replace(/\s/g, '').toLowerCase() === 'text/html;charset=utf-8', `${path}: content-type ${res.headers.get('content-type')}`);
        const html = await res.text();
        const { title, body } = messages[locale].zmanimSite.limit;
        assert(typeof title === 'string' && title.length > 10 && typeof body === 'string' && body.length > 10, `${locale} zmanimSite.limit: ${show(messages[locale].zmanimSite.limit)}`);
        assert(html.includes(title) && html.includes(body), `${path}: the ${locale} words are not in the page: ${html}`);
        assert(html.startsWith('<!doctype html>') && html.includes(`<html lang="${locale}" dir="${dir}">`), `${path}: lang/dir: ${html.slice(0, 120)}`);
        for (const other of ['en', 'he', 'ru'] as const) if (other !== locale) assert(!html.includes(messages[other].zmanimSite.limit.title), `${path}: the ${other} line is in the ${locale} page`);
        assert(!/<script|<link|<img|<iframe|src=|href=|url\(|@import/i.test(html), `${path}: an external resource: ${html}`);
        assert(!EMOJI.test(html), `${path}: an emoji`);
        assert(html.length < 1500, `${path}: ${html.length} bytes is not a tiny page`);
      }
    } finally {
      Date.now = realNow;
      watch.restore();
    }
  });

  await check('Z7 the minute\'s end: the first counted request of a minute schedules ONE unref\'d cleanup timer for the minute\'s end that clears the addresses; a late timer never clears a newer minute', () => {
    // No timer for a page that is not a city page, one for the first counted request, none for the rest of the minute
    const state = fresh();
    const first = quiet(() => {
      cityPageVerdict(city(ADDRESS, '/blog'), T0, state);
      cityPageVerdict(city(ADDRESS), T0 + 1, state);
      cityPageVerdict(city(OTHER), T0 + 2, state);
      for (let i = 0; i < 62; i++) cityPageVerdict(city(ADDRESS), T0 + 3 + i, state);
    });
    assert(first.timers.length === 1, `${first.timers.length} timers for one minute`);
    const [timer] = first.timers;
    // 12:00:20.001 now, so 39.999 s to 12:01:00; unref'd, so it never holds the process open
    assert(timer.ms === 39_999 && timer.unref && !timer.cleared, `the timer: ${show({ ms: timer.ms, unref: timer.unref, cleared: timer.cleared })}`);
    const held = () => state.counts.size;
    assert(held() === 2, 'the addresses are held until the timer runs');
    // It runs at the minute's end: the addresses go, the refusals are logged once, with the minute, and no address
    const fired = quiet(() => timer.fn());
    assert(held() === 0 && state.refused === 0 && state.timer === null, `after the timer: ${show({ counts: [...state.counts], refused: state.refused, timer: state.timer })}`);
    assert(show(fired.lines) === show(['[zmanim-limit] refused 3 requests in the minute from 2026-11-06T12:00:00.000Z']), `the timer's log ${show(fired.lines)}`);
    // The next request (any minute) starts over and logs nothing more; the first counted one sets the next timer
    const after = quiet(() => {
      cityPageVerdict(city(OTHER, '/blog'), T0 + 50_000, state);
      cityPageVerdict(city(ADDRESS), T0 + 50_001, state);
    });
    assert(after.lines.length === 0 && after.timers.length === 1 && after.timers[0].ms === 49_999, `the next minute: ${show({ lines: after.lines, timers: after.timers.map((t) => t.ms) })}`);

    // A request that rolls the minute over takes the old timer back; a late old timer clears nothing of the new minute
    const second = fresh();
    const rolled = quiet(() => {
      cityPageVerdict(city(ADDRESS), T0 + 1, second);
      cityPageVerdict(city(ADDRESS), T0 + 50_000, second);
    });
    assert(rolled.timers.length === 2 && rolled.timers[0].cleared && !rolled.timers[1].cleared, `the timers: ${show(rolled.timers.map((t) => ({ ms: t.ms, cleared: t.cleared })))}`);
    assert(rolled.timers[1].ms === 50_000 && rolled.timers[1].unref, 'the new minute\'s timer is for its own end');
    quiet(() => rolled.timers[0].fn());
    assert(second.counts.get(ADDRESS) === 1, `a late old timer cleared the new minute: ${show([...second.counts])}`);
    quiet(() => rolled.timers[1].fn());
    assert(second.counts.size === 0, 'the new minute\'s timer did not clear it');

    // The proxy's state (on globalThis) is the one the timer clears
    delete (globalThis as Row).__zmanimPageLimit;
    const shared = quiet(() => cityPageVerdict(city(ADDRESS), T0));
    const sharedState = (globalThis as Row).__zmanimPageLimit;
    assert(shared.timers.length === 1 && sharedState.counts.size === 1, 'the shared state set no timer');
    quiet(() => shared.timers[0].fn());
    assert(sharedState.counts.size === 0, 'the timer did not clear the shared state');
    delete (globalThis as Row).__zmanimPageLimit;
  });

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

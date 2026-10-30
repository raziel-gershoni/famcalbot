// Smoke test for the zmanim city pages' request limit (spec 2026-10-30-public-zmanim §6.4; plan Task 9):
//
//  - Z1 the count: 60 city pages a minute from one address pass and the 61st gets Retry-After until the minute ends;
//    another address and any other page are not touched; the next minute starts over; requests with no address are
//    counted under one key.
//  - Z2 the paths it counts: a city page in en, he and ru (with or without a trailing slash); never the index, another
//    page, the /en address next-intl redirects, or a deeper path.
//  - Z3 the log: a minute with refusals is one line at the first request after it, with the count and the minute, and
//    never the address; a minute with none logs nothing.
//  - Z4 the proxy: the 61st city page from one address is a 429 with Retry-After and no-store, empty, before next-intl;
//    a router prefetch (next-router-prefetch: 1) counts like any other request; the same address still gets the blog,
//    another address still gets the city, and the count is on globalThis.
//
// Pure code and the real proxy (next-intl's middleware over i18n/routing.ts). No network, no DB.
//
// Run with the fake env (never the real one), from the repo root, as ci-smokes.sh does.

import { assert, check, finish, load, show, type Row } from './lib/site-harness';

const ADDRESS = '203.0.113.7';
const OTHER = '198.51.100.20';
// 12:00:20 UTC: 40 seconds are left in its minute
const T0 = Date.UTC(2026, 10, 6, 12, 0, 20);

async function main() {
  const { cityPageVerdict, CITY_PAGE_LIMIT, CITY_PAGE_WINDOW_MS } = await load('src/lib/page-limit.ts');
  const fresh = () => ({ window: -1, counts: new Map<string, number>(), refused: 0 });
  const city = (address: string | null, path = '/zmanim/jerusalem') => ({ path, address });
  /** Runs `fn` with console.warn caught, and gives back what it returned and the lines it logged. */
  const quiet = <T>(fn: () => T): { value: T; lines: string[] } => {
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      return { value: fn(), lines };
    } finally {
      console.warn = warn;
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

  await check('Z4 the proxy: the 61st city page from one address is a 429 with Retry-After and no-store, empty, before next-intl; a router prefetch counts like any other request; the same address still gets the blog, another address still gets the city; the count is on globalThis', async () => {
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
      assert(refused.headers.get('cache-control') === 'no-store' && (await refused.text()) === '', 'the 429 is cached or has a body');
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

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

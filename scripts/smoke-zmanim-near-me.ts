// Smoke test for "Near me" on /zmanim and the shared position helper (plan 6a Task 7; spec 2026-10-30-public-zmanim
// §4.1.2, §9).
//
//  - N1 currentPosition asks with the Settings lookup's options and answers a position, a refusal, an unavailable or
//    timed-out position, or no geolocation at all, as data;
//  - N2 Near me in real React on the fake DOM, in en, he and ru: within 30 km it opens that city's page; from 30 to 100 km
//    in the device's own UTC offset it names the city and its distance with a link; further away, or in another offset,
//    "no city near you"; a refusal says where to allow location; an unavailable or missing position says so; each failure
//    points to the list;
//  - N3 while waiting the button shows its loading state, and an answer clears it;
//  - N4 no request carries the position: no fetch at all, and the page opened is the city's own clean address.
//
// The device's zone is the process's: this smoke runs itself under TZ=Asia/Jerusalem (as ci-smokes.sh does) if it isn't.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createElement as h } from 'react';
import { elements, fakeWindow, installWindow, mount, type FakeElement } from './lib/fake-dom';
import { assert, check, finish, LOCALES, load, messages, show, type Row } from './lib/site-harness';

if (process.env.TZ !== 'Asia/Jerusalem') {
  execFileSync(process.execPath, [...process.execArgv, __filename], { env: { ...process.env, TZ: 'Asia/Jerusalem' }, stdio: 'inherit' });
  process.exit(0);
}

const nodeRequire = createRequire(__filename);
const React = nodeRequire('react');
const { createTranslator } = nodeRequire('next-intl');
const setNavigator = (value: Row) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });

async function main() {
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const restoreNavigator = () => {
    if (navigatorBefore) Object.defineProperty(globalThis, 'navigator', navigatorBefore);
  };
  const { currentPosition, POSITION_OPTIONS } = await load('src/lib/geolocation.ts');
  const { CITIES } = await load('src/site/cities.ts');
  const { haversineKm, utcOffsetMinutes, OPEN_KM, NEAR_KM } = await load('src/site/near-city.ts');
  const { cityPath, localeHref } = await load('src/site/zmanim/links.ts');
  const { nearWords } = await load('src/site/zmanim/near-words.ts');
  const { NearMe } = await load('components/site/zmanim/NearMe.tsx');
  const settle = () => React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  await check('N1 currentPosition: the Settings lookup\'s options; a position, a refusal, an unavailable or timed-out position, no geolocation', async () => {
    try {
      let asked: Row | null = null;
      setNavigator({ geolocation: { getCurrentPosition: (ok: (p: Row) => void, _fail: unknown, options: Row) => { asked = options; ok({ coords: { latitude: 31.77, longitude: 35.21 } }); } } });
      assert(show(await currentPosition()) === show({ kind: 'ok', latitude: 31.77, longitude: 35.21 }), 'a position');
      assert(show(asked) === show({ enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }) && show(POSITION_OPTIONS) === show(asked), `the options ${show(asked)}`);
      for (const [code, kind] of [[1, 'denied'], [2, 'unavailable'], [3, 'unavailable'], [undefined, 'unavailable']] as const) {
        setNavigator({ geolocation: { getCurrentPosition: (_ok: unknown, fail: (e: Row) => void) => fail({ code }) } });
        const got = await currentPosition();
        assert(got.kind === kind, `code ${code}: ${show(got)}`);
      }
      setNavigator({});
      assert((await currentPosition()).kind === 'unsupported', 'no geolocation');
    } finally {
      restoreNavigator();
    }
  });

  installWindow();
  // react-dom/client reads navigator.userAgent when it first loads (mount loads it on first use), and the stand-in navigators
  // below hold only a geolocation: load it now, with the real one
  nodeRequire('react-dom/client');
  const assigned: string[] = [];
  fakeWindow.location.assign = (href: string) => void assigned.push(href);
  const fetched: unknown[] = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async (...args: unknown[]) => {
    fetched.push(args);
    throw new Error('no network in this smoke');
  }) as typeof fetch;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const nearest = (point: Row) => CITIES.map((c: Row) => ({ c, km: haversineKm(point, c) })).sort((a: Row, b: Row) => a.km - b.km)[0];
  const sameOffset = (c: Row) => utcOffsetMinutes(c.timeZone, now) === utcOffsetMinutes(zone, now);
  const JERUSALEM = CITIES.find((c: Row) => c.slug === 'jerusalem');
  const MITZPE_RAMON = { latitude: 30.6103, longitude: 34.8015 };
  const MID_SEA = { latitude: 34.0, longitude: 25.0 };
  const OXFORD = { latitude: 51.752, longitude: -1.2577 };

  try {
    await check('N2 Near me in en, he and ru: open within 30 km, the near city and its distance from 30 to 100 km in the same offset, "no city near you" further or in another offset, and each failure\'s line with the way to the list', async () => {
      assert(zone === 'Asia/Jerusalem', `the device's zone ${zone}`);
      const band = nearest(MITZPE_RAMON);
      assert(band.km > OPEN_KM && band.km <= NEAR_KM && sameOffset(band.c), `the near fixture: ${band.c.slug} at ${band.km} km`);
      assert(nearest(MID_SEA).km > NEAR_KM, 'the far fixture is near a city');
      const oxford = nearest(OXFORD);
      assert(oxford.km > OPEN_KM && oxford.km <= NEAR_KM && !sameOffset(oxford.c), `the other-offset fixture: ${oxford.c.slug} at ${oxford.km} km`);
      for (const locale of LOCALES) {
        const words = nearWords(createTranslator({ locale, messages: messages[locale] }));
        assert(words.near.includes('{city}') && words.near.includes('{km}') && words.opening.includes('{city}'), `${locale}: the templates`);
        const cities = CITIES.map((c: Row) => ({ slug: c.slug, latitude: c.latitude, longitude: c.longitude, timeZone: c.timeZone, name: messages[locale].cities[c.slug], href: localeHref(locale, cityPath(c.slug)) }));
        const byslug = (slug: string) => cities.find((c: Row) => c.slug === slug);
        const tap = async (geolocation: Row | undefined) => {
          setNavigator(geolocation === undefined ? {} : { geolocation });
          const m = mount(h(NearMe, { cities, words }));
          m.click(elements(m.container).find((e) => e.localName === 'button') as FakeElement);
          await settle();
          return m;
        };
        const at = (point: Row) => ({ getCurrentPosition: (ok: (p: Row) => void) => ok({ coords: point }) });
        const refused = (code: number) => ({ getCurrentPosition: (_ok: unknown, fail: (e: Row) => void) => fail({ code }) });
        const statusOf = (m: Row) => elements(m.container).find((e) => e.getAttribute('role') === 'status') as FakeElement;
        const toList = (m: Row) => elements(statusOf(m)).find((e) => e.localName === 'a' && e.getAttribute('href') === '#cities');

        assigned.length = 0;
        let m = await tap(at({ latitude: JERUSALEM.latitude, longitude: JERUSALEM.longitude }));
        assert(show(assigned) === show([byslug('jerusalem').href]), `${locale}: opened ${show(assigned)}`);
        assert(statusOf(m).textContent === words.opening.replace('{city}', byslug('jerusalem').name), `${locale}: ${statusOf(m).textContent}`);
        m.unmount();

        m = await tap(at(MITZPE_RAMON));
        const city = byslug(band.c.slug);
        const link = elements(statusOf(m)).find((e) => e.localName === 'a');
        assert(statusOf(m).textContent === words.near.replace('{city}', city.name).replace('{km}', String(Math.round(band.km))), `${locale}: the near line ${statusOf(m).textContent}`);
        assert(link?.getAttribute('href') === city.href && link?.textContent === city.name, `${locale}: the near city's link`);
        m.unmount();

        for (const [where, point] of [['far away', MID_SEA], ['another offset', OXFORD]] as const) {
          m = await tap(at(point));
          assert(statusOf(m).textContent?.includes(words.none) && toList(m)?.textContent === words.toList, `${locale} ${where}: ${statusOf(m).textContent}`);
          m.unmount();
        }
        for (const [what, geolocation, line] of [['refused', refused(1), words.denied], ['unavailable', refused(2), words.unavailable], ['timed out', refused(3), words.unavailable], ['no geolocation', undefined, words.unsupported]] as const) {
          m = await tap(geolocation);
          assert(statusOf(m).textContent?.includes(line) && toList(m)?.textContent === words.toList, `${locale} ${what}: ${statusOf(m).textContent}`);
          m.unmount();
        }
        assert(assigned.length === 1, `${locale}: a page opened without a city within 30 km: ${show(assigned)}`);
      }
    });

    await check('N3 while waiting the button shows its loading state, and an answer clears it', async () => {
      for (const locale of LOCALES) {
        const words = nearWords(createTranslator({ locale, messages: messages[locale] }));
        let answer: ((e: Row) => void) | null = null;
        setNavigator({ geolocation: { getCurrentPosition: (_ok: unknown, fail: (e: Row) => void) => { answer = fail; } } });
        const m = mount(h(NearMe, { cities: [], words }));
        const button = () => elements(m.container).find((e) => e.localName === 'button') as FakeElement;
        assert(button().textContent === words.button && !button().hasAttribute('disabled'), `${locale}: the button at first`);
        m.click(button());
        assert(button().hasAttribute('disabled') && button().textContent === words.locating && button().getAttribute('aria-busy') === 'true', `${locale}: no loading state`);
        await React.act(async () => {
          answer?.({ code: 2 });
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        assert(!button().hasAttribute('disabled') && button().textContent === words.button && button().getAttribute('aria-busy') === 'false', `${locale}: the loading state stays`);
        m.unmount();
      }
    });

    await check('N4 no request carries the position: no fetch, and the page opened is the city\'s own clean address', () => {
      assert(fetched.length === 0, `requests: ${show(fetched)}`);
      assert(assigned.every((href) => /^(?:\/(?:he|ru))?\/zmanim\/[a-z-]+$/.test(href)), `opened ${show(assigned)}`);
    });
  } finally {
    restoreNavigator();
    globalThis.fetch = fetchBefore;
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

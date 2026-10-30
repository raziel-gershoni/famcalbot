// Smoke test for the public zmanim pages (plan 6a Tasks 6 and 7; spec 2026-10-30-public-zmanim §4, §6.3, §6.5, §9).
//
//  - Z1 a city's page in en, he and ru: the day's rows are zmanDayForPlace's for the city (Jerusalem Sephardi with its
//    height, London in June with dawn's dash and the note, Moscow in June with tallit and tefillin's dash), its date in
//    both calendars, the community's method line, and the note (the height and 20 minutes, or the plain one);
//  - Z2 the windows ahead: Saint Petersburg's June Friday has candle lighting and an end with no time (and its line);
//    New York's next Pesach shows the two days of Yom Tov by name and the "not before" line;
//  - Z3 the metadata: the titles of §6.3, the description, the clean canonical and the four languages; none for an
//    unknown city;
//  - Z4 the links: every day, month, cell and community link is a plain anchor with rel="nofollow"; the day links keep
//    the community, the community links keep the date, Today keeps the community; the language links are the clean URL;
//    the month is a table with seven column headers, each cell link named by its full Gregorian and Hebrew date (and its
//    holiday), today carries aria-current="date" and the day shown is filled;
//  - Z5 bad and out-of-range parameters show today and the default community; at the range's ends the previous or next
//    links are left out;
//  - Z6 an unknown city: notFound(), so the site's 404;
//  - Z7 a section that fails is logged (captureError, with the city, the day and the community) and says so, and the rest
//    of the page renders;
//  - Z8 every rendered page passes the truth list, the no-emoji rule, the raw-key check and, in Russian, T6;
//  - Z9 the CSS: the kit's lint, every tap target at least 44 px, no hover, motion only under no-preference; the sheet's
//    rows and the page's CSS are each in the site's sheet once;
//  - Z10 no request leaves the server while a page renders; no file under app/[locale]/(site) or components/site calls
//    fetch, loads a script by src or imports next/script; and no component of the city page is a client one (only Near
//    me is);
//  - Z12 (review focus c) the Hebrew page: every time of day in <bdi dir="ltr">, the arrows with the app's RTL-flipped
//    icon, and the month grid from Sunday at the start (right) edge;
//  - Z13 (review focus d) repeated or odd query values are ignored without a throw: today and the default community.
//
// The pages run as Next runs them on the server (next-intl's server API over the real messages). No network, no DB.
// Run with the fake env (never the real one), from the repo root, as ci-smokes.sh does.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createElement as h, type ReactElement } from 'react';
import { lintCss } from './lib/css-lint';
import { assert, check, decodeEntities, EMOJI, finish, LOCALES, load, messages, OFF_SITE, readSource, request, render, ROOT, show, stub, stubIntlServer, textOf, UNTRUE, type Locale, type Row } from './lib/site-harness';

const nodeRequire = createRequire(__filename);
const { NextIntlClientProvider } = nodeRequire('next-intl');
const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
const { HDate } = nodeRequire('@hebcal/hdate');
const router = { push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} };

const attrs = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((m) => m[1]);
const attr = (a: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'i').exec(a)?.[1];
const prefix = (l: Locale) => (l === 'en' ? '' : `/${l}`);
/** A message key left in the text, for every namespace the zmanim pages read. */
const RAW_KEY = /\b(?:landing|site|blog|share|legal|ui|zmanimSite|cities|countries|calendarHome|holidays|zmanim)\.[a-z]+[A-Za-z.]*\b/;
/** smoke-site-truth's T6: a one-letter Russian word followed by a plain space. */
const T6_LOOSE = /(?<![^\s«(„"—*])[вскоуиая] /iu;
/** The tap targets the zmanim pages add; Task 7 adds Near me's and the city list's. */
const TAPS = ['.site-zm-arrow', '.site-zm-today a', '.site-zm-switch a', '.site-zm-cell', '.site-zm-sources a', '.site-zm-near-button', '.site-zm-near-list', '.site-zm-near-status a', '.site-zm-cities a'];

async function main() {
  stubIntlServer();
  class NotFound extends Error {}
  stub(nodeRequire.resolve('next/navigation'), { ...nodeRequire('next/navigation'), notFound: () => { throw new NotFound('NEXT_NOT_FOUND'); } });
  const captured: Row[] = [];
  stub('src/lib/error-capture.ts', {
    captureError: (error: unknown, context: string, extra: Row) => void captured.push({ error, context, extra }),
    captureWarning: () => undefined,
    captureInfo: () => undefined,
  });
  // The holidays and the day list as they are, with a switch that makes one section fail (spec §6.5)
  const fail = { holidays: false, day: '' };
  const realHolidays = nodeRequire(path.join(ROOT, 'src/services/hebrew-holidays.ts'));
  stub('src/services/hebrew-holidays.ts', {
    ...realHolidays,
    holidaysInRange: (...args: unknown[]) => {
      if (fail.holidays) throw new Error('hebcal failed (smoke)');
      return realHolidays.holidaysInRange(...args);
    },
  });
  const realDayList = nodeRequire(path.join(ROOT, 'src/services/zmanim/day-list.ts'));
  stub('src/services/zmanim/day-list.ts', {
    ...realDayList,
    zmanDayForPlace: (place: Row, community: string, day: string, options?: Row) => {
      if (day === fail.day) throw new Error('the day failed (smoke)');
      return realDayList.zmanDayForPlace(place, community, day, options);
    },
  });
  const fetched: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    fetched.push(String(input));
    throw new Error('no network in this smoke');
  }) as typeof fetch;

  const { default: CityPage, generateMetadata } = await load('app/[locale]/(site)/zmanim/[city]/page.tsx');
  const v = await load('src/site/zmanim/city-view.ts');
  const { cityBySlug } = await load('src/site/cities.ts');
  const { formatDayFull, formatTime } = await load('src/lib/calendar-view/format.ts');
  const { hebrewFullDate, dayKeyOfHDate } = await load('src/lib/calendar-view/hebrew-date.ts');
  const { addDaysToDate } = await load('src/utils/day-events.ts');
  const { pageUrl } = await load('src/site/seo.ts');

  const wrap = (locale: Locale, el: ReactElement) =>
    render(h(AppRouterContext.Provider, { value: router }, h(NextIntlClientProvider, { locale, timeZone: 'Asia/Jerusalem', messages: { site: messages[locale].site } } as never, el) as unknown as ReactElement));
  const cityPage = async (locale: Locale, slug: string, search: Row = {}) => {
    request.locale = locale;
    const el = (await CityPage({ params: Promise.resolve({ locale, city: slug }), searchParams: Promise.resolve(search) })) as ReactElement;
    return wrap(locale, el);
  };
  const common = (locale: Locale, html: string, where: string) => {
    assert(html.includes('class="site-header"') && html.includes('class="site-footer"'), `${where} ${locale}: not in the site's chrome`);
    assert(!EMOJI.test(html.replace(/https:\/\/wa\.me\/[^"\s]+/g, '')), `${where} ${locale}: an emoji: ${html.match(EMOJI)?.[0]}`);
    const text = decodeEntities(html);
    for (const [claim, pattern] of [...UNTRUE, ...OFF_SITE]) assert(!pattern.test(text), `${where} ${locale}: ${claim}: ${text.match(pattern)?.[0]}`);
    const visible = decodeEntities(textOf(html)).replace(/famcal\.bot|t\.me\/\S+|wa\.me\/\S+/g, '');
    assert(!RAW_KEY.test(visible), `${where} ${locale}: a raw key: ${visible.match(RAW_KEY)?.[0]}`);
    if (locale === 'ru') {
      // A row with no time draws a lone "—" in its own <span aria-hidden>: textOf puts a plain space where each tag was, so that
      // glyph reads " —" without being prose. Take it out before the dash is checked; the strings themselves are T6's.
      const prose = decodeEntities(textOf(html.replace(/<span aria-hidden="true">—<\/span>/g, ''))).replace(/famcal\.bot|t\.me\/\S+|wa\.me\/\S+/g, '');
      const loose = visible.match(new RegExp(`.{0,24}${T6_LOOSE.source}.{0,24}`, 'iu'))?.[0] ?? prose.match(/.{0,24} —.{0,24}/)?.[0];
      assert(!T6_LOOSE.test(visible) && !prose.includes(' —'), `${where} ru: not bound by a no-break space: ${show(loose)}`);
    }
  };
  const between = (html: string, from: string, to?: string) => {
    const a = html.indexOf(from);
    assert(a >= 0, `no ${from}`);
    const b = to ? html.indexOf(to, a + from.length) : -1;
    return html.slice(a, b < 0 ? undefined : b);
  };
  const rowsOf = (html: string) =>
    [...html.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/g)]
      .filter((m) => attr(m[1], 'data-zman'))
      .map((m) => ({ key: attr(m[1], 'data-zman'), time: /<bdi dir="ltr">([^<]*)<\/bdi>/.exec(m[2])?.[1] ?? null }));
  const wantRows = (list: Row, locale: Locale) => list.rows.map((r: Row) => ({ key: r.key, time: r.at === null ? null : formatTime(r.at, list.tz, locale) }));
  const dayCard = (html: string) => between(html, '<section class="site-zm-card"', '</section>');
  const real = (slug: string, community: string, day: string): Row => realDayList.zmanDayForPlace(v.cityPlace(cityBySlug(slug)), community, day, { memo: new Map(), quiet: true });
  const todayOf = (slug: string): string => v.cityToday(cityBySlug(slug), new Date());
  const genitive = (locale: Locale) => (locale === 'ru' ? messages.ru.calendarHome.hebrewMonthGenitive : undefined);
  /** The year of the next 21 June that is at least a week away. */
  const juneYear = (day: string) => Number(day.slice(0, 4)) + (day.slice(5) > '06-14' ? 1 : 0);
  const fridayOnOrBefore = (day: string) => addDaysToDate(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 2) % 7));
  /** The next Pesach whose eve is after `today`: its eve and its first day. */
  const nextPesach = (today: string) => {
    for (let year = new HDate(new Date(`${today}T12:00:00`)).getFullYear(); ; year++) {
      const first: string = dayKeyOfHDate(new HDate(15, 'Nisan', year));
      if (addDaysToDate(first, -1) > today) return { eve: addDaysToDate(first, -1), first };
    }
  };
  const anchorsOf = (html: string) =>
    attrs(html, 'a').map((a) => ({ href: decodeEntities(attr(a, 'href') ?? ''), rel: attr(a, 'rel'), hreflang: attr(a, 'hreflang'), current: attr(a, 'aria-current'), label: attr(a, 'aria-label') ? decodeEntities(attr(a, 'aria-label') as string) : undefined, cls: attr(a, 'class') }));
  const query = (href: string) => new URLSearchParams(href.split('?')[1] ?? '');

  await check('Z1 a city\'s page in en, he and ru: the rows are zmanDayForPlace\'s (Jerusalem with its height, London\'s and Moscow\'s June dashes and the note), the date in both calendars, the method line and the note', async () => {
    const y = juneYear(todayOf('london'));
    const cases: [string, Row, string, string][] = [
      ['jerusalem', {}, 'sephardi', todayOf('jerusalem')],
      ['london', { date: `${y}-06-21` }, 'ashkenazi', `${y}-06-21`],
      ['moscow', { date: `${y}-06-21` }, 'ashkenazi', `${y}-06-21`],
    ];
    for (const locale of LOCALES) {
      const z = messages[locale].zmanimSite;
      for (const [slug, search, community, day] of cases) {
        const html = await cityPage(locale, slug, search);
        common(locale, html, slug);
        const name = messages[locale].cities[slug];
        const text = decodeEntities(textOf(html));
        assert(decodeEntities(html).includes(`<h1 class="site-h1 site-page-title">${z.city.heading.replace('{city}', name)}</h1>`), `${locale} ${slug}: the heading`);
        const card = dayCard(html);
        const list = real(slug, community, day);
        assert(show(rowsOf(card)) === show(wantRows(list, locale)), `${locale} ${slug}: the rows ${show(rowsOf(card))}, want ${show(wantRows(list, locale))}`);
        const cardText = decodeEntities(textOf(card));
        assert(cardText.includes(formatDayFull(day, locale)) && cardText.includes(hebrewFullDate(day, locale, genitive(locale))), `${locale} ${slug}: the date`);
        assert(cardText.includes(z.day.method[community === 'sephardi' ? 'sephardi' : 'ashkenazi']), `${locale} ${slug}: the method line`);
        const dashed = list.rows.some((r: Row) => r.at === null);
        assert(cardText.includes(z.day.dashNote) === dashed, `${locale} ${slug}: the dash note (a dash: ${dashed})`);
        if (slug === 'london') assert(rowsOf(card).find((r) => r.key === 'ALOT')?.time === null, `${locale}: London's dawn has a time`);
        if (slug === 'moscow') assert(rowsOf(card).find((r) => r.key === 'MISHEYAKIR')?.time === null, `${locale}: Moscow's tallit and tefillin have a time`);
        const height = cityBySlug(slug).elevationM;
        const note = slug === 'jerusalem' ? z.note.height.replace('{city}', name).replace('{height}', String(height)) : z.note.plain.replace('{city}', name);
        assert(text.includes(note), `${locale} ${slug}: the note`);
      }
    }
  });

  await check('Z2 the windows ahead: Saint Petersburg\'s June Friday has candle lighting and an end with no time; New York\'s next Pesach names its two days of Yom Tov and shows "not before"', async () => {
    const friday = fridayOnOrBefore(`${juneYear(todayOf('saint-petersburg'))}-06-21`);
    const { eve, first } = nextPesach(todayOf('new-york'));
    for (const locale of LOCALES) {
      const z = messages[locale].zmanimSite;
      const spb = await cityPage(locale, 'saint-petersburg', { date: friday });
      common(locale, spb, 'saint-petersburg');
      assert(rowsOf(dayCard(spb)).find((r) => r.key === 'CANDLE_LIGHTING')?.time, `${locale}: no candle lighting on ${friday}`);
      const spbWindow = between(between(spb, 'aria-labelledby="ahead-title"', 'aria-labelledby="month-title"'), '<section class="site-zm-window"', '</section>');
      const rows = rowsOf(spbWindow);
      const end = rows[rows.length - 1];
      assert(rows[0]?.key === 'CANDLE_LIGHTING' && rows[0].time && end?.key === 'SHABBAT_ENDS' && end.time === null, `${locale}: Saint Petersburg's window ${show(rows)}`);
      assert(decodeEntities(textOf(spbWindow)).includes(z.ahead.noEnd), `${locale}: no line for the missing end`);
      const ny = await cityPage(locale, 'new-york', { date: eve });
      common(locale, ny, 'new-york');
      const window = between(between(ny, 'aria-labelledby="ahead-title"', 'aria-labelledby="month-title"'), '<section class="site-zm-window"', '</section>');
      assert(rowsOf(window).some((r) => r.key === 'CANDLE_LIGHTING_NOT_BEFORE' && r.time), `${locale}: no "not before" in ${show(rowsOf(window))}`);
      const days = realHolidays.holidaysInRange(first, addDaysToDate(first, 1), locale, { il: false }) as Record<string, Row[]>;
      const chag = Object.values(days).flat().filter((x) => x.chag).map((x) => x.title as string);
      const heading = decodeEntities(textOf(between(window, '<h3', '</h3>')));
      assert(chag.length === 2 && chag.every((title) => heading.includes(title)), `${locale}: the window's name ${heading}, want ${show(chag)}`);
    }
  });

  await check('Z3 the metadata: the titles of §6.3, the description, the clean canonical and the four languages; none for an unknown city', async () => {
    const want: Record<Locale, string> = { en: 'Shabbat times and zmanim in Jerusalem', he: 'זמני שבת וזמני היום בירושלים', ru: 'Время шаббата и зманим: Иерусалим' };
    for (const locale of LOCALES) {
      request.locale = locale;
      const meta = await generateMetadata({ params: Promise.resolve({ locale, city: 'jerusalem' }) });
      assert(meta.title === want[locale], `${locale}: the title ${show(meta.title)}`);
      assert(meta.description === messages[locale].zmanimSite.city.description.replace('{city}', messages[locale].cities.jerusalem), `${locale}: the description`);
      assert(meta.alternates.canonical === pageUrl(locale, '/zmanim/jerusalem') && !String(meta.alternates.canonical).includes('?'), `${locale}: the canonical ${meta.alternates.canonical}`);
      assert(show(Object.keys(meta.alternates.languages).sort()) === show(['en', 'he', 'ru', 'x-default']), `${locale}: the languages`);
      assert(show(await generateMetadata({ params: Promise.resolve({ locale, city: 'atlantis' }) })) === '{}', `${locale}: metadata for an unknown city`);
    }
  });

  await check('Z4 the links: plain anchors with rel="nofollow"; the date and the community kept; the clean language links; the month as a table with named cells, today and the day shown', async () => {
    const today = todayOf('jerusalem');
    const date = addDaysToDate(today, 10);
    let year = new HDate(new Date(`${today}T12:00:00`)).getFullYear();
    let roshHashana: string = dayKeyOfHDate(new HDate(1, 'Tishrei', year));
    while (roshHashana <= today) roshHashana = dayKeyOfHDate(new HDate(1, 'Tishrei', ++year));
    for (const locale of LOCALES) {
      const z = messages[locale].zmanimSite;
      const base = `${prefix(locale)}/zmanim/jerusalem`;
      const html = await cityPage(locale, 'jerusalem', { date, community: 'chabad' });
      common(locale, html, 'jerusalem chabad');
      const anchors = anchorsOf(html);
      const isLanguage = (a: Row) => Boolean(a.hreflang) || (a.current === 'true' && a.href === base);
      const own = anchors.filter((a) => a.href.startsWith(base) && !isLanguage(a));
      assert(own.length > 30 && own.every((a) => a.rel === 'nofollow'), `${locale}: links without nofollow ${show(own.filter((a) => a.rel !== 'nofollow'))}`);
      const dayLinks = own.filter((a) => a.label === z.day.previous || a.label === z.day.next);
      assert(dayLinks.length === 2 && dayLinks.every((a) => query(a.href).get('community') === 'chabad' && query(a.href).get('date')), `${locale}: the day links ${show(dayLinks)}`);
      const switches = attrs(between(html, '<ul class="site-zm-switch"', '</ul>'), 'a').map((a) => ({ href: decodeEntities(attr(a, 'href') ?? ''), current: attr(a, 'aria-current') }));
      assert(show(switches.map((a) => a.href)) === show([`${base}?date=${date}`, `${base}?date=${date}&community=ashkenazi`, `${base}?date=${date}&community=chabad`]), `${locale}: the community links ${show(switches)}`);
      assert(switches[2].current === 'true' && !switches[0].current && !switches[1].current, `${locale}: the current community`);
      const todayLink = own.find((a) => !query(a.href).get('date') && query(a.href).get('community') === 'chabad');
      assert(todayLink, `${locale}: no Today link keeping the community`);
      const kept = own.filter((a) => !switches.some((s) => s.href === a.href));
      assert(kept.every((a) => query(a.href).get('community') === 'chabad'), `${locale}: a link drops the community ${show(kept.filter((a) => query(a.href).get('community') !== 'chabad'))}`);
      const languages = anchors.filter(isLanguage);
      for (const l of LOCALES) assert(languages.some((a) => a.href === (l === locale ? base : `/${l}/zmanim/jerusalem`)), `${locale}: no clean link to ${l} in ${show(languages)}`);
      assert(languages.every((a) => !a.href.includes('?')), `${locale}: a language link carries the parameters`);
      const grid = between(html, '<table class="site-zm-grid"', '</table>');
      assert((grid.match(/<th scope="col">/g) ?? []).length === 7, `${locale}: the column headers`);
      const cell = anchorsOf(grid).find((a) => query(a.href).get('date') === date);
      assert(cell && cell.label?.startsWith(formatDayFull(date, locale)) && cell.label.includes(hebrewFullDate(date, locale, genitive(locale))) && /\bis-shown\b/.test(cell.cls ?? ''), `${locale}: the shown day's cell ${show(cell)}`);
      // Today's cell, on today's month with no parameters
      const plain = await cityPage(locale, 'jerusalem');
      const current = anchorsOf(between(plain, '<table class="site-zm-grid"', '</table>')).filter((a) => a.current === 'date');
      assert(current.length === 1 && query(current[0].href).get('date') === today, `${locale}: today's cell ${show(current)}`);
      // A holiday's name in its cell's name
      const rh = await cityPage(locale, 'jerusalem', { date: roshHashana });
      const rhCell = anchorsOf(between(rh, '<table class="site-zm-grid"', '</table>')).find((a) => query(a.href).get('date') === roshHashana);
      const title = (realHolidays.holidaysInRange(roshHashana, roshHashana, locale, { il: true })[roshHashana] as Row[]).find((x) => x.chag)?.title;
      assert(title && rhCell?.label?.includes(title), `${locale}: Rosh Hashana's cell ${show(rhCell)} lacks ${title}`);
    }
  });

  await check('Z5 bad and out-of-range parameters show today and the default community; at the range\'s ends the previous or next links are left out', async () => {
    const today = todayOf('jerusalem');
    const range = v.publicRange(cityBySlug('jerusalem'), new Date());
    for (const locale of LOCALES) {
      const z = messages[locale].zmanimSite;
      const sephardi = messages[locale].calendarHome.zmanimList.community.sephardi;
      for (const search of [{ date: '2026-13-45', community: 'reform' }, { date: addDaysToDate(range.last, 1) }, { date: addDaysToDate(range.first, -1) }, { date: 'tomorrow' }]) {
        const html = await cityPage(locale, 'jerusalem', search);
        const shown = decodeEntities(textOf(between(html, '<p class="ch-zl-day">', '</p>')));
        assert(shown === formatDayFull(today, locale), `${locale} ${show(search)}: shows ${shown}`);
        const current = /aria-current="true">([^<]+)</.exec(between(html, '<ul class="site-zm-switch"', '</ul>'))?.[1];
        assert(current === sephardi, `${locale} ${show(search)}: the community ${current}`);
      }
      const labels = (html: string) => anchorsOf(html).map((a) => a.label);
      const first = await cityPage(locale, 'jerusalem', { date: range.first });
      assert(!labels(first).includes(z.day.previous) && labels(first).includes(z.day.next) && !labels(first).includes(z.month.previous), `${locale}: the first day's links`);
      const last = await cityPage(locale, 'jerusalem', { date: range.last });
      assert(!labels(last).includes(z.day.next) && labels(last).includes(z.day.previous) && !labels(last).includes(z.month.next), `${locale}: the last day's links`);
    }
  });

  await check('Z6 an unknown city: the page calls notFound(), so the site\'s 404', async () => {
    for (const locale of LOCALES) {
      let thrown: unknown = null;
      try {
        await CityPage({ params: Promise.resolve({ locale, city: 'atlantis' }), searchParams: Promise.resolve({}) });
      } catch (err) {
        thrown = err;
      }
      assert(thrown instanceof NotFound, `${locale}: no notFound() for an unknown city`);
    }
  });

  await check('Z7 a section that fails is logged with the city, the day and the community, and says so; the rest of the page renders', async () => {
    // A Wednesday that no window holds, so only the day's own list asks for it
    let date = addDaysToDate(todayOf('jerusalem'), 2);
    for (;;) {
      const c = cityBySlug('jerusalem');
      const view = v.buildCityView(c, v.readCityParams(c, { date }, new Date()), 'en');
      if (new Date(`${date}T00:00:00Z`).getUTCDay() === 3 && !view.ahead.some((w: Row) => w.eve <= date && date <= w.last)) break;
      date = addDaysToDate(date, 1);
    }
    try {
      fail.holidays = true;
      captured.length = 0;
      for (const locale of LOCALES) {
        const z = messages[locale].zmanimSite;
        const html = await cityPage(locale, 'jerusalem', { date });
        const text = decodeEntities(textOf(html));
        assert(text.includes(z.ahead.failed) && text.includes(z.month.failed) && !text.includes(z.day.failed) && rowsOf(dayCard(html)).length > 0, `${locale}: the holidays failing`);
      }
      assert(captured.length === 6 && captured.every((c) => c.context === 'zmanim-site' && c.extra.slug === 'jerusalem' && c.extra.day === date && c.extra.community === 'sephardi'), `captured ${show(captured.map((c) => [c.context, c.extra]))}`);
      assert(show(captured.slice(0, 2).map((c) => c.extra.section)) === show(['ahead', 'month']), 'the sections named');
      fail.holidays = false;
      fail.day = date;
      captured.length = 0;
      for (const locale of LOCALES) {
        const z = messages[locale].zmanimSite;
        const html = await cityPage(locale, 'jerusalem', { date });
        const text = decodeEntities(textOf(html));
        assert(text.includes(z.day.failed) && !text.includes(z.ahead.failed) && !text.includes(z.month.failed) && html.includes('<table class="site-zm-grid"'), `${locale}: the day failing`);
      }
      assert(captured.length === 3 && captured.every((c) => c.extra.section === 'day'), `captured ${show(captured.map((c) => c.extra))}`);
    } finally {
      fail.holidays = false;
      fail.day = '';
    }
  });

  await check('Z12 (review focus c) the Hebrew page: every time of day sits in <bdi dir="ltr">, the previous and next arrows carry the app\'s RTL-flipped icon (.ch-flip, flipped under [dir=rtl]), and the month grid starts each row with Sunday, which the page\'s dir="rtl" puts at the start (right) edge', async () => {
    const friday = fridayOnOrBefore(addDaysToDate(todayOf('jerusalem'), 7));
    const html = await cityPage('he', 'jerusalem', { date: friday });
    common('he', html, 'jerusalem he');
    // Times of day: none outside a <bdi dir="ltr"> (the halachic hour line is a length, minutes:seconds, not a time of day)
    // (the page's <main>: the footer's copyright line is a <bdi dir="ltr"> too)
    const times = [...between(html, '<main', '</main>').matchAll(/<bdi dir="ltr">([^<]*)<\/bdi>/g)].map((m) => m[1]);
    assert(times.length >= 15 && times.every((x) => /^\d{1,2}:\d{2}$/.test(x)), `he: the times in <bdi> ${show(times)}`);
    const outside = decodeEntities(textOf(html.replace(/<bdi dir="ltr">[^<]*<\/bdi>/g, ' ').replace(/<p class="ch-zl-hours">[\s\S]*?<\/p>/g, ' '))).match(/\d{1,2}:\d{2}/g);
    assert(!outside, `he: a time outside <bdi dir="ltr">: ${show(outside)}`);
    // The arrows: the sun sheet's own icons (ChevronLeft for previous, ChevronRight for next, each with .ch-flip), flipped in RTL
    const z = messages.he.zmanimSite;
    const arrows = [...html.matchAll(/<a class="site-zm-arrow"([^>]*)>([\s\S]*?)<\/a>/g)];
    for (const [label, icon] of [[z.day.previous, 'chevron-left'], [z.day.next, 'chevron-right'], [z.month.previous, 'chevron-left'], [z.month.next, 'chevron-right']] as const) {
      const arrow = arrows.find((m) => decodeEntities(attr(m[1], 'aria-label') ?? '') === label);
      assert(arrow && new RegExp(`<svg[^>]*class="[^"]*\\blucide-${icon}\\b[^"]*\\bch-flip\\b`).test(arrow[2]), `he: the arrow "${label}": ${show(arrow?.[2].slice(0, 200))}`);
    }
    const { ZMANIM_PAGE_CSS } = await load('src/site/site-css.ts');
    assert(/\n\[dir='rtl'\] \.site-zm-arrow \.ch-flip \{\s*transform: scaleX\(-1\);\s*\}/.test(ZMANIM_PAGE_CSS), 'no RTL flip for the arrows\' icons');
    assert(/dir=\{locale === 'he' \? 'rtl' : 'ltr'\}/.test(readSource('app/[locale]/(site)/layout.tsx')), 'the site layout does not set dir="rtl" for Hebrew');
    // The month: no direction of its own, Sunday's column first, each week's dates in weekday order from Sunday
    const grid = between(html, '<table class="site-zm-grid"', '</table>');
    assert(!/\bdir="/.test(grid.slice(0, grid.indexOf('>'))) && !/(?<![-\w])direction\s*:/.test(ZMANIM_PAGE_CSS), 'the grid sets a direction of its own');
    const sunday = new Intl.DateTimeFormat('he', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 9, 18, 12)));
    const firstHeader = decodeEntities(textOf(between(grid, '<th scope="col">', '</th>')));
    assert(firstHeader.includes(sunday), `he: the first column is ${firstHeader}, not ${sunday}`);
    const weeks = [...between(grid, '<tbody', '</tbody>').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
      [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => query(decodeEntities(attr(attrs(cell[1], 'a')[0] ?? '', 'href') ?? '')).get('date')),
    );
    assert(weeks.length >= 4 && weeks.every((w) => w.length === 7 && w.every((d, i) => d === null || new Date(`${d}T00:00:00Z`).getUTCDay() === i)), `he: a week not from Sunday ${show(weeks)}`);
  });

  await check('Z13 (review focus d) repeated or odd query values (a repeated date or community, community[]=x, a 10,000-character date, 30 February) are ignored without a throw: the page shows today and the default community', async () => {
    const today = todayOf('jerusalem');
    const odd: Row[] = [
      { date: ['2026-11-01', '2026-11-02'] },
      { 'community[]': 'x' },
      { community: ['chabad', 'ashkenazi'] },
      { date: '2'.repeat(10_000) },
      { date: `${today}${'0'.repeat(9_990)}` },
      { date: '2026-02-30' },
    ];
    for (const locale of LOCALES) {
      const sephardi = messages[locale].calendarHome.zmanimList.community.sephardi;
      for (const search of odd) {
        const label = `${locale} ${show(search).slice(0, 60)}`;
        const html = await cityPage(locale, 'jerusalem', search);
        common(locale, html, label);
        const shown = decodeEntities(textOf(between(html, '<p class="ch-zl-day">', '</p>')));
        assert(shown === formatDayFull(today, locale), `${label}: shows ${shown}`);
        const current = /aria-current="true">([^<]+)</.exec(between(html, '<ul class="site-zm-switch"', '</ul>'))?.[1];
        assert(current === sephardi, `${label}: the community ${current}`);
        assert(!html.includes('2222222222') && !html.includes('0000000000'), `${label}: the odd value is written into the page`);
      }
    }
  });

  await check('Z9 the CSS: the kit\'s lint, every tap target at least 44 px, no hover, motion only under no-preference; the sheet\'s rows and the page\'s CSS each in the site\'s sheet once', async () => {
    const { SITE_CSS, ZMANIM_PAGE_CSS } = await load('src/site/site-css.ts');
    const { ZMANIM_SHEET_CSS } = await load('src/lib/calendar-view/zmanim-sheet-css.ts');
    const problems = lintCss(ZMANIM_PAGE_CSS);
    assert(problems.length === 0, show(problems));
    assert(SITE_CSS.split(ZMANIM_SHEET_CSS).length === 2 && SITE_CSS.split(ZMANIM_PAGE_CSS).length === 2, 'the sheet\'s rows or the page\'s CSS are not in the site\'s sheet exactly once');
    const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(ZMANIM_PAGE_CSS)?.[1];
    for (const selector of TAPS) {
      const body = rule(selector);
      const min = body ? /min-block-size:\s*(\d+)px/.exec(body) : null;
      assert(min && Number(min[1]) >= 44, `${selector}: ${body?.trim().replace(/\s+/g, ' ')}`);
    }
    assert(!/hover/.test(ZMANIM_PAGE_CSS), 'a hover rule');
    const outside = ZMANIM_PAGE_CSS.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, '');
    assert(![...outside.matchAll(/animation:\s*([^;]+);/g)].some((m) => m[1].trim() !== 'none'), 'an animation outside the no-preference block');
  });

  await check('Z10 no request leaves the server while a page renders; no file under app/[locale]/(site) or components/site calls fetch, loads a script by src or imports next/script; no component of the city page is a client one (only Near me is)', () => {
    assert(fetched.length === 0, `requests: ${show(fetched)}`);
    const walk = (rel: string): string[] =>
      fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(`${rel}/${entry.name}`) : /\.(?:tsx?|mdx?)$/.test(entry.name) ? [`${rel}/${entry.name}`] : []));
    const siteFiles = [...walk('app/[locale]/(site)'), ...walk('components/site')];
    assert(['app/[locale]/(site)/page.tsx', 'app/[locale]/(site)/zmanim/[city]/page.tsx', 'components/site/SiteHeader.tsx'].every((f) => siteFiles.includes(f)), `the walk missed the site: ${show(siteFiles)}`);
    for (const file of siteFiles) {
      const text = readSource(file);
      assert(!/\bfetch\s*\(/.test(text), `${file} calls fetch`);
      assert(!/<script\b[^>]*\bsrc\s*=/i.test(text), `${file} loads a script by src`);
      assert(!/['"]next\/script['"]/.test(text), `${file} imports next/script`);
    }
    for (const file of fs.readdirSync(path.join(ROOT, 'components/site/zmanim'))) {
      const client = /^\s*['"]use client['"]/m.test(readSource(`components/site/zmanim/${file}`));
      assert(client === (file === 'NearMe.tsx'), `${file}: ${client ? 'a client component' : 'Near me is not a client component'}`);
    }
    assert(!/['"]use client['"]/.test(readSource('app/[locale]/(site)/zmanim/[city]/page.tsx')), 'the city page is a client component');
  });

  await check('Z11 /zmanim in en, he and ru: the title and its line, Near me\'s button and privacy line, every city once (Israel first, then the countries by name, each country\'s cities by name in the page\'s language), plain links to the clean pages; the metadata', async () => {
    const { default: IndexPage, generateMetadata: indexMetadata } = await load('app/[locale]/(site)/zmanim/page.tsx');
    const { CITIES } = await load('src/site/cities.ts');
    const { intlLocale } = await load('src/lib/calendar-view/format.ts');
    for (const locale of LOCALES) {
      request.locale = locale;
      const html = await wrap(locale, (await IndexPage({ params: Promise.resolve({ locale }) })) as ReactElement);
      common(locale, html, 'index');
      const z = messages[locale].zmanimSite;
      const t = nodeRequire('next-intl').createTranslator({ locale, messages: messages[locale] });
      const text = decodeEntities(textOf(html));
      assert(text.includes(z.index.title) && text.includes(t('zmanimSite.index.lead', { count: CITIES.length })), `${locale}: the title and its line`);
      assert(text.includes(z.near.button) && text.includes(z.near.privacy), `${locale}: Near me`);
      const collator = new Intl.Collator(intlLocale(locale));
      const groups = [...html.matchAll(/<section class="site-zm-country"[^>]*>([\s\S]*?)<\/section>/g)].map((m) => ({
        name: decodeEntities(textOf(between(m[1], '<h3', '</h3>'))),
        hrefs: attrs(m[1], 'a').map((a) => decodeEntities(attr(a, 'href') ?? '')),
        names: [...m[1].matchAll(/<a [^>]*>([^<]*)<\/a>/g)].map((x) => decodeEntities(x[1])),
      }));
      assert(groups[0]?.name === messages[locale].countries.IL, `${locale}: the first group is ${groups[0]?.name}`);
      const rest = groups.slice(1).map((g) => g.name);
      assert(show(rest) === show([...rest].sort(collator.compare)), `${locale}: the countries' order ${show(rest)}`);
      for (const g of groups) assert(show(g.names) === show([...g.names].sort(collator.compare)), `${locale}: ${g.name}'s cities ${show(g.names)}`);
      const hrefs = groups.flatMap((g) => g.hrefs);
      assert(show([...hrefs].sort()) === show(CITIES.map((c: Row) => `${prefix(locale)}/zmanim/${c.slug}`).sort()), `${locale}: the city links`);
      assert(html.includes('id="cities"'), `${locale}: the list has no anchor for Near me`);
      const meta = await indexMetadata({ params: Promise.resolve({ locale }) });
      assert(meta.title === z.index.metaTitle && meta.alternates.canonical === pageUrl(locale, '/zmanim'), `${locale}: the metadata ${show([meta.title, meta.alternates?.canonical])}`);
    }
  });

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

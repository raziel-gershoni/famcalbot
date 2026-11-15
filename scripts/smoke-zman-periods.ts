// Smoke test for the home header's period lines (owner 2026-11-15): zmanPeriodOf and nextZmanChange
// (src/lib/calendar-view/zman-periods.ts) and their drawing in HomeHeader (ZmanPeriodLines), with the real messages in en,
// he and ru. The home's wiring (which lists it asks, the timer) is smoke-calendar-home-render.ts's #128n-#128r.
//
// What it pins:
//   - the owner's table through a Sephardi day in Harish: the night (from yesterday's midnight zman), dawn, Shema (from
//     misheyakir to the Magen Avraham's and the Gra's ends, the earlier first and the other on line 2 until it passes),
//     Shacharit (from Shema's last end), Shacharit after the fact, past midday, Mincha (named by the latest start that
//     passed: gedola, ketana, each plag), bein hashmashot, Maariv (from nightfall), and tomorrow's night from today's
//     midnight zman; a time exactly at a boundary belongs to the period it starts;
//   - Maariv runs on past midnight until yesterday's own midnight zman (a summer abroad);
//   - the Ashkenazi set (one plag) and Chabad's (one Shema end: no opinion on line 1);
//   - no period, so the header's two zman lines: a zman with no time that day, a list not here, no saved place;
//   - line 2: a second end still ahead, else the next zman not on line 1 (tomorrow's marked), the candle lighting on Friday;
//   - nextZmanChange: the earliest row of any list still ahead (yesterday's midnight zman after midnight);
//   - the header in en, he and ru: line 1's exact words with the time bold and left to right, the opinion only where the
//     period has two ends, line 2's words, the accent where line 1's end is a window row, one button whose label says both
//     lines and opens the sun sheet; the two zman lines when there is no period; the CSS of line 1.
// React must log no warning. No network, no DB.
//   npx tsx scripts/smoke-zman-periods.ts

import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { HomeHeader } from '../app/[locale]/(app)/dashboard/HomeHeader';
import { HOME_SHELL_CSS } from '../app/[locale]/(app)/dashboard/home-shell';
import { nextZmanChange, zmanPeriodOf, type ZmanPeriod } from '../src/lib/calendar-view/zman-periods';
import type { ZmanOpinion } from '../src/lib/calendar-view/zman-spec';
import type { ZmanimListResponse } from '../src/lib/calendar-view/zmanim-list';

const ROOT = path.resolve(__dirname, '..');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const LOCALES = ['en', 'he', 'ru'] as const;
type Locale = (typeof LOCALES)[number];
type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (value: unknown): string => JSON.stringify(value);
const messages: Record<Locale, Row> = {
  en: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8')),
  he: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/he.json'), 'utf8')),
  ru: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/ru.json'), 'utf8')),
};

const reactWarnings: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('(node:')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- Fixtures: Harish in winter (UTC+2) ----

const TZ = 'Asia/Jerusalem';
const YESTERDAY = '2026-11-14';
const TODAY = '2026-11-15';
const TOMORROW = '2026-11-16';
/** A wall time in Israel in winter as the instant the server sends; "24:30" is the next day's 00:30. */
const il = (day: string, hhmm: string): string => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h - 2, m)).toISOString();
};
const at = (day: string, hhmm: string) => Date.parse(il(day, hhmm));
const row = (day: string, key: string, hhmm: string | null, opinion: ZmanOpinion | null = null) => ({ key, opinion, at: hhmm === null ? null : il(day, hhmm) });

function sephardi(day: string, o: Partial<ZmanimListResponse> & { midnight?: string } = {}): ZmanimListResponse {
  return {
    day,
    tz: TZ,
    community: 'sephardi',
    place: { source: 'saved', name: 'חריש' },
    rows: [
      row(day, 'ALOT', '04:52'),
      row(day, 'MISHEYAKIR', '05:04'),
      row(day, 'NETZ', '06:04'),
      row(day, 'SOF_SHMA_MGA', '08:14', 'mga'),
      row(day, 'SOF_SHMA_GRA', '08:50', 'gra'),
      row(day, 'SOF_TFILA', '09:50'),
      row(day, 'CHATZOT', '11:36'),
      row(day, 'MINCHA_GEDOLA', '12:06'),
      row(day, 'MINCHA_KETANA', '14:43'),
      row(day, 'PLAG_HALACHA_BERURA', '15:26', 'halachaBerura'),
      row(day, 'PLAG_YALKUT_YOSEF', '15:53', 'yalkutYosef'),
      row(day, 'SHKIA', '16:41'),
      row(day, 'TZEIT', '16:55'),
      row(day, 'TZEIT_LECHUMRA', '17:01'),
      row(day, 'CHATZOT_HALAYLA', o.midnight ?? '23:36'),
    ],
    hours: [{ opinion: 'gra', ms: 3_324_000 }],
    ...o,
  };
}
const lists = { yesterday: sephardi(YESTERDAY), today: sephardi(TODAY), tomorrow: sephardi(TOMORROW) };
/** A period as "id start→end (other end) | next", for one-line asserts. */
const sum = (p: ZmanPeriod | null): string =>
  p === null ? 'none' : `${p.id} ${p.start.row.key}→${p.end.row.key}${p.otherEnd ? ` +${p.otherEnd.row.key}` : ''}${p.next ? ` | ${p.next.row.key}${p.next.when === 'today' ? '' : ` ${p.next.when}`}` : ''}`;

function inIntl(locale: Locale, el: ReactElement): ReactElement {
  const provider = { locale, messages: messages[locale], timeZone: TZ } as ComponentProps<typeof NextIntlClientProvider>;
  return createElement(NextIntlClientProvider, provider, el);
}
const noop = () => undefined;
const header = (locale: Locale, extra: Row) =>
  renderToString(inIntl(locale, createElement(HomeHeader, { today: null, hebrewDates: false, zone: null, sendOpen: false, menuOpen: false, onSend: noop, onMenu: noop, onZmanim: noop, ...extra })));
const buttonOf = (html: string) => /<button type="button" class="ch-head-zman"[^]*?<\/button>/.exec(html)?.[0] ?? '';
const textOf = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\u2060|\u2063/g, '');

async function runChecks(): Promise<void> {
  await check('the owner\'s table through a Sephardi day: each period from its start to its end, a time at a boundary belonging to the period it starts', () => {
    const cases: Array<[string, string]> = [
      ['00:30', 'night CHATZOT_HALAYLA→ALOT | MISHEYAKIR'],
      ['04:52', 'alot ALOT→MISHEYAKIR | NETZ'],
      ['05:30', 'shema MISHEYAKIR→SOF_SHMA_MGA +SOF_SHMA_GRA'],
      ['08:14', 'shema MISHEYAKIR→SOF_SHMA_GRA | SOF_TFILA'],
      ['08:50', 'shacharit SOF_SHMA_GRA→SOF_TFILA | CHATZOT'],
      ['10:00', 'shacharitLate SOF_TFILA→CHATZOT | MINCHA_GEDOLA'],
      ['11:40', 'midday CHATZOT→MINCHA_GEDOLA | MINCHA_KETANA'],
      ['13:00', 'mincha MINCHA_GEDOLA→SHKIA | MINCHA_KETANA'],
      ['15:00', 'mincha MINCHA_KETANA→SHKIA | PLAG_HALACHA_BERURA'],
      ['15:30', 'mincha PLAG_HALACHA_BERURA→SHKIA | PLAG_YALKUT_YOSEF'],
      ['16:00', 'mincha PLAG_YALKUT_YOSEF→SHKIA | TZEIT'],
      ['16:45', 'beinHashmashot SHKIA→TZEIT | TZEIT_LECHUMRA'],
      ['16:58', 'arvit TZEIT→CHATZOT_HALAYLA | TZEIT_LECHUMRA'],
      ['20:00', 'arvit TZEIT_LECHUMRA→CHATZOT_HALAYLA | ALOT tomorrow'],
      ['23:50', 'night CHATZOT_HALAYLA→ALOT | MISHEYAKIR tomorrow'],
    ];
    const wrong = cases.map(([hhmm, want]) => [hhmm, want, sum(zmanPeriodOf(lists, at(TODAY, hhmm)))]).filter(([, want, got]) => want !== got);
    assert(wrong.length === 0, `${show(wrong)}`);
    // The night after midnight is yesterday's midnight zman to today's dawn
    const night = zmanPeriodOf(lists, at(TODAY, '00:30'));
    assert(night?.start.when === 'yesterday' && night.end.when === 'today', `the night's days: ${night?.start.when} ${night?.end.when}`);
  });

  await check('Maariv runs on past midnight until yesterday\'s own midnight zman (a summer abroad), then the night begins; before it, yesterday\'s list is needed and without it there is no period', () => {
    const late = { yesterday: sephardi(YESTERDAY, { midnight: '24:40' }), today: sephardi(TODAY, { midnight: '24:40' }), tomorrow: undefined };
    assert(sum(zmanPeriodOf(late, at(TODAY, '00:20'))) === 'arvit TZEIT_LECHUMRA→CHATZOT_HALAYLA | ALOT', `00:20 ${sum(zmanPeriodOf(late, at(TODAY, '00:20')))}`);
    assert(sum(zmanPeriodOf(late, at(TODAY, '00:45'))) === 'night CHATZOT_HALAYLA→ALOT | MISHEYAKIR', `00:45 ${sum(zmanPeriodOf(late, at(TODAY, '00:45')))}`);
    assert(nextZmanChange(late, at(TODAY, '00:20')) === at(TODAY, '00:40'), 'the next change is yesterday\'s midnight zman');
    assert(zmanPeriodOf({ today: sephardi(TODAY) }, at(TODAY, '00:30')) === null, 'yesterday not here: no period');
    assert(zmanPeriodOf({ today: sephardi(TODAY), tomorrow: undefined }, at(TODAY, '23:50')) === null, 'tomorrow not here: no night yet');
  });

  await check('the Ashkenazi set (one plag, two Shema ends) and Chabad\'s (one Shema end, so no second end and no opinion)', () => {
    const ashkenazi = (day: string) => sephardi(day, { community: 'ashkenazi', rows: sephardi(day).rows.filter((r) => !['PLAG_HALACHA_BERURA', 'PLAG_YALKUT_YOSEF', 'TZEIT_LECHUMRA'].includes(r.key)).concat([row(day, 'PLAG_GRA', '15:26', 'gra')]) });
    const a = { yesterday: ashkenazi(YESTERDAY), today: ashkenazi(TODAY), tomorrow: ashkenazi(TOMORROW) };
    assert(sum(zmanPeriodOf(a, at(TODAY, '07:00'))) === 'shema MISHEYAKIR→SOF_SHMA_MGA +SOF_SHMA_GRA', `ashkenazi shema ${sum(zmanPeriodOf(a, at(TODAY, '07:00')))}`);
    assert(sum(zmanPeriodOf(a, at(TODAY, '15:30'))) === 'mincha PLAG_GRA→SHKIA | TZEIT', `ashkenazi plag ${sum(zmanPeriodOf(a, at(TODAY, '15:30')))}`);
    const chabad = (day: string) => sephardi(day, { community: 'chabad', rows: sephardi(day).rows.filter((r) => !['SOF_SHMA_MGA', 'PLAG_HALACHA_BERURA', 'PLAG_YALKUT_YOSEF', 'TZEIT_LECHUMRA'].includes(r.key)).map((r) => (r.key === 'SOF_SHMA_GRA' ? { ...r, opinion: 'baalHatanya' as const } : r)) });
    const c = zmanPeriodOf({ yesterday: chabad(YESTERDAY), today: chabad(TODAY), tomorrow: chabad(TOMORROW) }, at(TODAY, '07:00'));
    assert(sum(c) === 'shema MISHEYAKIR→SOF_SHMA_GRA | SOF_TFILA' && c?.severalEnds === false, `chabad ${sum(c)} ${c?.severalEnds}`);
    assert(zmanPeriodOf(lists, at(TODAY, '07:00'))?.severalEnds === true, 'Sephardi Shema has two ends');
  });

  await check('no period, so the header\'s two zman lines: a start or the ends with no time that day, a list that failed, a place counted at the zone\'s main city', () => {
    const noMisheyakir = { ...lists, today: sephardi(TODAY, { rows: sephardi(TODAY).rows.map((r) => (r.key === 'MISHEYAKIR' ? { ...r, at: null } : r)) }) };
    // Without misheyakir, dawn has no end and Shema no start: 05:30 is in no period; Shacharit still is
    assert(zmanPeriodOf(noMisheyakir, at(TODAY, '05:30')) === null, `${sum(zmanPeriodOf(noMisheyakir, at(TODAY, '05:30')))}`);
    assert(sum(zmanPeriodOf(noMisheyakir, at(TODAY, '09:00'))) === 'shacharit SOF_SHMA_GRA→SOF_TFILA | CHATZOT', 'the other periods stand');
    assert(zmanPeriodOf({ today: null }, at(TODAY, '09:00')) === null, 'today failed');
    assert(zmanPeriodOf({ ...lists, today: sephardi(TODAY, { place: { source: 'zone' } }) }, at(TODAY, '09:00')) === null, 'the zone');
  });

  await check('line 2: the second end while it is ahead, else the next zman not on line 1 (the candle lighting on a Friday, tomorrow\'s marked); nextZmanChange is the earliest row ahead in any list', () => {
    const friday = { ...lists, today: sephardi(TODAY, { rows: [...sephardi(TODAY).rows, row(TODAY, 'CANDLE_LIGHTING', '16:21')] }) };
    assert(sum(zmanPeriodOf(friday, at(TODAY, '16:00'))) === 'mincha PLAG_YALKUT_YOSEF→SHKIA | CANDLE_LIGHTING', `friday ${sum(zmanPeriodOf(friday, at(TODAY, '16:00')))}`);
    assert(zmanPeriodOf(lists, at(TODAY, '20:00'))?.next?.when === 'tomorrow', 'tomorrow\'s dawn is marked');
    assert(zmanPeriodOf(lists, at(TODAY, '05:30'))?.next === null, 'no next while a second end shows');
    // In the evening the next zman is tomorrow's: without tomorrow's list Maariv has nothing for line 2 (the home then asks for it, #128r)
    assert(sum(zmanPeriodOf({ yesterday: lists.yesterday, today: lists.today }, at(TODAY, '20:00'))) === 'arvit TZEIT_LECHUMRA→CHATZOT_HALAYLA', `20:00 without tomorrow: ${sum(zmanPeriodOf({ yesterday: lists.yesterday, today: lists.today }, at(TODAY, '20:00')))}`);
    assert(nextZmanChange(lists, at(TODAY, '13:00')) === at(TODAY, '14:43') && nextZmanChange(lists, at(TODAY, '23:50')) === at(TOMORROW, '04:52') && nextZmanChange({ today: sephardi(TODAY) }, at(TODAY, '23:50')) === null, 'the next change');
  });

  await check('the header in en, he and ru: line 1 in the period\'s words with the time bold and left to right, the opinion only where the period has two ends, line 2 the other end or the next zman, one button whose label says both lines', () => {
    const want: Record<Locale, Record<string, [string, string]>> = {
      en: {
        '05:30': ['Shema until 08:14 (MGA)', 'GRA: until 08:50'],
        '08:14': ['Shema until 08:50 (GRA)', 'Latest time for morning prayer 09:50'],
        '15:00': ['Mincha ketana until sunset 16:41', 'Plag hamincha (Halacha Berura) 15:26'],
        '16:00': ['Plag hamincha (Yalkut Yosef) until sunset 16:41', 'Nightfall (tzeit hakochavim) 16:55'],
        '20:00': ['Maariv until midnight 23:36', 'Tomorrow: Dawn (alot hashachar) 04:52'],
        '00:30': ['Night, until dawn 04:52', 'Tallit and tefillin 05:04'],
      },
      he: {
        '05:30': ['קריאת שמע עד 08:14 (מג״א)', 'לגר״א עד 08:50'],
        '04:52': ['עלות השחר, טלית ותפילין מ־05:04', 'הנץ החמה 06:04'],
        '10:00': ['שחרית בדיעבד עד חצות 11:36', 'מנחה גדולה 12:06'],
        '11:40': ['אחרי חצות היום, מנחה גדולה מ־12:06', 'מנחה קטנה 14:43'],
        '13:00': ['מנחה גדולה עד השקיעה 16:41', 'מנחה קטנה 14:43'],
        '16:45': ['בין השמשות עד צאת הכוכבים 16:55', 'צאת הכוכבים לחומרא 17:01'],
        '23:50': ['לילה, עד עלות השחר 04:52', 'מחר: זמן טלית ותפילין 05:04'],
      },
      ru: {
        '05:30': ['Чтение Шма до 08:14 (Маген Авраам)', 'ГРА: до 08:50'],
        '09:00': ['Шахарит до 09:50', 'Полдень (хацот) 11:36'],
        '16:45': ['Бейн а-шмашот до выхода звёзд 16:55', 'Выход звёзд, по строгому мнению 17:01'],
      },
    };
    for (const locale of LOCALES) {
      for (const [hhmm, [line1, line2]] of Object.entries(want[locale])) {
        const period = zmanPeriodOf(lists, at(TODAY, hhmm));
        const html = buttonOf(header(locale, { zmanPeriod: period, zmanWindow: { last: null, next: null } }));
        const rows = [...html.matchAll(/<span class="ch-head-zman-row[^"]*" aria-hidden="true">([^]*?)<\/span>(?=<span class="ch-head-zman-row|<\/button>)/g)].map((m) => textOf(m[1]));
        const flat = (text: string) => text.replace(/\s+/g, '');
        assert(show(rows.map(flat)) === show([line1, line2].map(flat)), `${locale} ${hhmm}: ${show(rows)}`);
        assert(html.includes(`aria-label="${line1}. ${line2}"`), `${locale} ${hhmm} label: ${/aria-label="([^"]*)"/.exec(html)?.[1]}`);
        assert(/class="ch-head-zman-row is-now[^"]*" aria-hidden="true"><span class="ch-head-zman-text">[^<]*<bdi dir="ltr" class="ch-head-zman-time">\d\d:\d\d<\/bdi>/.test(html), `${locale} ${hhmm}: line 1's time is a bdi inside its text: ${html}`);
      }
    }
  });

  await check('the header: the accent on line 2 when the next zman is a window row (the candle lighting); the period in place of the two zman lines, which still show when there is no period; nothing without the sun; line 1\'s CSS (the text colour, its time bold)', () => {
    const friday = { ...lists, today: sephardi(TODAY, { rows: [...sephardi(TODAY).rows, row(TODAY, 'CANDLE_LIGHTING', '16:21')] }) };
    const candles = buttonOf(header('he', { zmanPeriod: zmanPeriodOf(friday, at(TODAY, '16:00')) }));
    assert(candles.includes('<span class="ch-head-zman-row is-key" aria-hidden="true"><span class="ch-head-zman-name">הדלקת נרות</span>') && candles.includes('<span class="ch-head-zman-row is-now" aria-hidden="true">'), `the candle lighting: ${candles}`);
    const window = { last: { row: { key: 'SHKIA', opinion: null, at: il(TODAY, '16:41') }, tz: TZ, when: 'today' as const }, next: { row: { key: 'TZEIT', opinion: null, at: il(TODAY, '16:55') }, tz: TZ, when: 'today' as const } };
    const both = buttonOf(header('en', { zmanPeriod: zmanPeriodOf(lists, at(TODAY, '13:00')), zmanWindow: window }));
    assert(both.includes('is-now') && !both.includes('is-last'), 'the period, not the two lines');
    const fallback = buttonOf(header('en', { zmanPeriod: null, zmanWindow: window }));
    assert(fallback.includes('is-last') && fallback.includes('is-next') && !fallback.includes('is-now'), 'the two lines without a period');
    assert(!header('en', { zmanPeriod: zmanPeriodOf(lists, at(TODAY, '13:00')), zmanWindow: window, onZmanim: undefined }).includes('ch-head-zman'), 'nothing without the sun');
    const rule = (selector: string) => {
      const found = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(HOME_SHELL_CSS);
      assert(found, `no rule ${selector}`);
      return found[1];
    };
    assert(/color:\s*var\(--ch-text\)/.test(rule('.ch-head-zman-row.is-now')) && /font-weight:\s*600/.test(rule('.ch-head-zman-row.is-now .ch-head-zman-time')), 'line 1\'s CSS');
  });

  await check('React logged no warning', () => {
    assert(reactWarnings.length === 0, `React warned: ${show(reactWarnings.slice(0, 3))}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

runChecks().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Smoke test for the home's sun sheet (the zmanim list): the header's sun button (HomeHeader), the sheet
// (app/[locale]/(app)/dashboard/ZmanimSheet.tsx, its rows drawn by components/app-ui/ZmanimRows.tsx and its CSS in
// src/lib/calendar-view/zmanim-sheet-css.ts) and its request (src/lib/calendar-view/zmanim-list.ts), with the real
// messages in en, he (RTL) and ru, in real React (react-dom/client with act on scripts/lib/fake-dom.ts). The route behind
// it is smoke-zmanim-api.ts's; the container's gate (the button only for the Jewish calendar, the sheet opened from it) is
// smoke-calendar-home-render.ts's #126-#128.
//
// What it pins:
//   - the button: only when the home gives it a handler, beside Send and before the menu, with the dialog's aria
//     attributes, the sun icon hidden from readers, and its label in each language;
//   - the sheet in each language: the title (today's, else the plain one), the place and the set ("חריש · ספרדי"), the
//     Gregorian and the Hebrew date (gematriya in Hebrew), every row named with its opinion, its time in 24 hours in the
//     person's zone (not the device's) and left to right inside Hebrew, the candle lighting, the candle lighting "not
//     before" and the three ends (of Shabbat, of Yom Tov, of both) in the accent, a dash and a reader's text where the
//     sun makes no such zman, and the halachic hour line (worded by the editor's own "name (opinion)" message);
//   - the arrows: the sheet opens on the home's today, each tap asks the server for that day (previous and next, the
//     title following), the date follows at once, the list shows a loading state meanwhile, an older answer that lands
//     after a newer tap is dropped, and the arrows flip in RTL; the arrows and the spinner are the kit's icon library's
//     (lucide), not copies of an inline drawing;
//   - the states: a request that fails (an answer, a network error, a thrown error) says so with Retry, which asks again;
//     no saved place shows the editor's note with its way to Settings; no place at all shows the other note and no rows;
//   - the request: the URL, the init data in the header only, and every way it can fail read as `failed` and logged;
//   - the rows are one plain component (no 'use client', no hook), shared with the public city pages: rendered with a
//     server's translator it gives the sheet's own markup, and the sheet re-exports the CSS module's string;
//   - the sheet's CSS: nothing under 11 px, logical properties only, no hover, no colour literal, and only the contrast
//     pairs the app's design smoke already holds; the header's room: the usual three buttons beside the day from 320 px.
// React must log no warning. No network, no DB. Run under three process zones (this file re-runs itself as child
// processes, so one command covers UTC, Asia/Jerusalem and America/New_York): the times are the person's zone's, never the
// process's.
//   npx tsx scripts/smoke-zmanim-sheet.ts

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import React, { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import { HomeHeader } from '../app/[locale]/(app)/dashboard/HomeHeader';
import { HOME_SHELL_CSS } from '../app/[locale]/(app)/dashboard/home-shell';
import { ZMANIM_SHEET_CSS, ZmanimSheet } from '../app/[locale]/(app)/dashboard/ZmanimSheet';
import { ZmanimRows } from '../components/app-ui/ZmanimRows';
import { ZMANIM_SHEET_CSS as PLAIN_SHEET_CSS } from '../src/lib/calendar-view/zmanim-sheet-css';
import type { ZmanWordsT } from '../src/lib/calendar-view/zman-words';
import { APP_THEME_CSS } from '../components/app-ui/theme';
import { APP_SCREEN_CSS } from '../components/app-ui/screen';
import { formatDayLong } from '../src/lib/calendar-view/format';
import { hebrewFullDate } from '../src/lib/calendar-view/hebrew-date';
import { zoneLabel } from '../src/lib/calendar-view/home-client';
import type { ZmanOpinion } from '../src/lib/calendar-view/zman-spec';
import { fetchZmanimList, formatHalachicHour, isZmanimList, type ZmanimListOutcome, type ZmanimListResponse } from '../src/lib/calendar-view/zmanim-list';
import { elements, fakeWindow, installWindow, mount, type FakeElement, type FakeNode, type Mounted } from './lib/fake-dom';
import { lintCss } from './lib/css-lint';
import { cssBlocks, customProps, TEXT_PAIRS } from './lib/css-resolve';

const ROOT = path.resolve(__dirname, '..');
const ZONES = ['UTC', 'Asia/Jerusalem', 'America/New_York'] as const;
const CHILD = 'ZMANIM_SHEET_SMOKE_CHILD';

async function runChildren(): Promise<void> {
  const outputs = await Promise.all(
    ZONES.map(
      (zone) =>
        new Promise<{ zone: string; code: number; text: string }>((resolve) => {
          const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], {
            env: { ...process.env, TZ: zone, [CHILD]: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let text = '';
          child.stdout.on('data', (chunk) => (text += chunk));
          child.stderr.on('data', (chunk) => (text += chunk));
          child.on('close', (code) => resolve({ zone, code: code ?? 1, text }));
        }),
    ),
  );
  let failed = 0;
  for (const { zone, code, text } of outputs) {
    console.log(`\n===== process TZ=${zone} =====\n${text.trimEnd()}`);
    if (code !== 0) failed++;
  }
  console.log(`\n${ZONES.length - failed}/${ZONES.length} process zones passed (${ZONES.join(', ')})`);
  process.exit(failed === 0 ? 0 : 1);
}

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

// ---- React must not warn; the app's own log lines are kept apart ----

const reactWarnings: string[] = [];
const appLogs: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('(node:')) return original(...args);
    if (text.startsWith('[zmanim-list]') || text.startsWith('[zmanim-sheet]')) {
      appLogs.push(text.slice(0, 300));
      return;
    }
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- Rendering ----

const TZ = 'Asia/Jerusalem';
const noop = () => undefined;

function inIntl(locale: Locale, el: ReactElement): ReactElement {
  const provider = { locale, messages: messages[locale], timeZone: TZ } as ComponentProps<typeof NextIntlClientProvider>;
  return createElement(NextIntlClientProvider, provider, el);
}

const byClass = (node: FakeNode, cls: string): FakeElement[] => elements(node).filter((e) => e.className.split(' ').includes(cls));
const byLabel = (node: FakeNode, label: string): FakeElement => {
  const found = elements(node).filter((e) => e.getAttribute('aria-label') === label);
  assert(found.length === 1, `${found.length} elements labelled ${show(label)}`);
  return found[0];
};
/** The text a reader sees under a node (the markup's text nodes, joined). */
const textOf = (node: FakeNode): string => node.textContent.replace(/\s+/g, ' ').trim();
async function settle(): Promise<void> {
  await React.act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  });
}

// ---- Fixtures: Harish on Wednesday 28 October 2026 (Israel is on standard time, UTC+2, since the 25th) ----

const TODAY = '2026-10-28';
/** A wall time in Israel in winter (UTC+2) as the instant the server sends. */
const il = (day: string, hhmm: string): string => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h - 2, m)).toISOString();
};
const row = (day: string, key: string, hhmm: string | null, opinion: ZmanOpinion | null = null) => ({ key, opinion, at: hhmm === null ? null : il(day, hhmm) });

/** What the server really answers for Harish on 2026-10-28 (smoke-zmanim-api.ts pins them): 55:24 and 66:29, a second under Zmanei Yosef's 55:25 and 66:30. */
const HARISH_HOURS = { gra: { opinion: 'gra', ms: 3_324_000 }, mga: { opinion: 'mga', ms: 3_988_800 } } as const;

function harish(day = TODAY, o: Partial<ZmanimListResponse> = {}): ZmanimListResponse {
  return {
    day,
    tz: TZ,
    community: 'sephardi',
    place: { source: 'saved', name: 'חריש' },
    rows: [
      row(day, 'ALOT', '04:44'),
      row(day, 'NETZ', '05:54'),
      row(day, 'SOF_SHMA_MGA', '08:03', 'mga'),
      row(day, 'SOF_SHMA_GRA', '08:37', 'gra'),
      row(day, 'PLAG_YALKUT_YOSEF', '15:59', 'yalkutYosef'),
      row(day, 'SHKIA', '16:55'),
      row(day, 'TZEIT', '17:09'),
      row(day, 'CHATZOT_HALAYLA', '23:24'),
    ],
    hours: [HARISH_HOURS.gra, HARISH_HOURS.mga],
    ...o,
  };
}
const ok = (list: ZmanimListResponse): ZmanimListOutcome => ({ kind: 'ok', list });

/** A load function that records its calls and answers from `answer`. */
function loader(answer: (day: string) => ZmanimListOutcome | Promise<ZmanimListOutcome>) {
  const calls: Array<[number, string]> = [];
  // A throw inside the answer is a rejected promise, as the real request's async function makes it.
  return { calls, load: (userId: number, day: string) => { calls.push([userId, day]); return Promise.resolve().then(() => answer(day)); } };
}

type Sheet = Mounted & { closed: number[]; settings: number[] };
async function openSheet(locale: Locale, answer: (day: string) => ZmanimListOutcome | Promise<ZmanimListOutcome>, today = TODAY) {
  installWindow();
  const l = loader(answer);
  const closed: number[] = [];
  const settings: number[] = [];
  const m = mount(inIntl(locale, createElement(ZmanimSheet, { userId: 5550001, locale, today, load: l.load, onOpenSettings: () => settings.push(1), onClose: () => closed.push(1) })));
  await settle();
  return { m: Object.assign(m, { closed, settings }) as Sheet, ...l };
}
const rowsOf = (m: Mounted) => byClass(m.container, 'ch-zl-row');
/** React's escaping in renderToString, for text and attribute values. */
const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
/** A mounted node as markup, in the form renderToString writes it (attributes in the order React set them). */
const markupOfNode = (node: FakeNode): string => {
  if (node.nodeType === 3) return escapeHtml(node.textContent);
  const e = node as FakeElement;
  const attributes = [...e.attributes].map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('');
  return `<${e.localName}${attributes}>${e.childNodes.map(markupOfNode).join('')}</${e.localName}>`;
};
const rowKeys = (m: Mounted) => rowsOf(m).map((r) => r.getAttribute('data-zman'));
const dateLine = (m: Mounted) => textOf(byClass(m.container, 'ch-zl-date')[0]);
const titleOf = (m: Mounted) => textOf(elements(m.container).filter((e) => e.localName === 'h2')[0]);
const timeOfRow = (m: Mounted, key: string) => textOf(byClass(rowsOf(m).filter((r) => r.getAttribute('data-zman') === key)[0], 'ch-zl-time')[0]);

async function runChecks(): Promise<void> {
  console.log(`process TZ=${process.env.TZ} (Intl: ${Intl.DateTimeFormat().resolvedOptions().timeZone})`);

  // ================= The button =================

  await check('the sun button: no handler, no button; with one, a 44 px icon button after Send and before the menu, aria-haspopup="dialog" and aria-expanded following the sheet, the icon hidden from readers, labelled in each language', () => {
    const header = (locale: Locale, extra: Row) =>
      renderToString(inIntl(locale, createElement(HomeHeader, { today: null, hebrewDates: true, zone: null, sendOpen: false, menuOpen: false, onSend: noop, onMenu: noop, ...extra })));
    for (const locale of LOCALES) {
      const label = messages[locale].calendarHome.header.zmanim;
      const without = header(locale, {});
      assert(!without.includes(`aria-label="${label}"`) && (without.match(/<button/g) ?? []).length === 2, `${locale}: a sun without a handler`);
      const closed = header(locale, { onZmanim: noop, zmanimOpen: false });
      const opened = header(locale, { onZmanim: noop, zmanimOpen: true });
      const sun = /<button([^>]*aria-label="([^"]*)"[^>]*)>(<svg[^>]*>[\s\S]*?<\/svg>)<\/button>/g;
      const buttons = [...closed.matchAll(sun)].map((m) => ({ attrs: m[1], label: m[2], icon: m[3] }));
      assert(buttons.length === 3 && buttons[1].label === label, `${locale}: ${show(buttons.map((b) => b.label))}`);
      assert(buttons[0].label === messages[locale].calendarHome.header.send && buttons[2].label === messages[locale].calendarHome.header.menu, `${locale}: the sun sits between Send and the menu`);
      assert(/class="ch-icon-btn"/.test(buttons[1].attrs) && /aria-haspopup="dialog"/.test(buttons[1].attrs) && /aria-expanded="false"/.test(buttons[1].attrs) && /type="button"/.test(buttons[1].attrs), `${locale}: ${buttons[1].attrs}`);
      assert(/aria-hidden="true"/.test(buttons[1].icon) && /<circle/.test(buttons[1].icon), `${locale}: the icon ${buttons[1].icon.slice(0, 120)}`);
      assert(/aria-expanded="true"/.test(opened.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? ''), `${locale}: expanded while open`);
    }
    assert(messages.en.calendarHome.header.zmanim === 'Zmanim' && messages.he.calendarHome.header.zmanim === 'זמני היום' && messages.ru.calendarHome.header.zmanim === 'Зманим', 'the labels');
  });

  // ================= The sheet in each language =================

  await check('English: "Today\'s zmanim" under a dialog of that name, "Harish..." place line with the set, the day in Gregorian and Hebrew, every row named with its opinion, times in 24 hours in the person\'s zone inside <bdi dir="ltr">, the hour line "Halachic hour: 55:24 (GRA) · 66:29 (MGA)", and no key left bare', async () => {
    const { m, calls } = await openSheet('en', (day) => ok(harish(day, { place: { source: 'saved', name: 'Harish' } })));
    try {
      assert(calls.length === 1 && calls[0][0] === 5550001 && calls[0][1] === TODAY, `the request ${show(calls)}`);
      const dialog = elements(m.container).filter((e) => e.getAttribute('role') === 'dialog')[0];
      assert(dialog.getAttribute('aria-label') === 'Today’s zmanim' && titleOf(m) === 'Today’s zmanim', `title ${titleOf(m)}`);
      assert(textOf(byClass(m.container, 'ch-zl-place')[0]) === 'Harish · Sephardi', textOf(byClass(m.container, 'ch-zl-place')[0]));
      const day = textOf(byClass(m.container, 'ch-zl-day')[0]);
      const hebrewDate = textOf(byClass(m.container, 'ch-zl-hebrew')[0]);
      assert(day === formatDayLong(TODAY, 'en') && day === 'Wednesday, 28 October' && hebrewDate === hebrewFullDate(TODAY, 'en') && hebrewDate === '17 Cheshvan 5787', `date ${day} | ${hebrewDate}`);
      const names = rowsOf(m).map((r) => textOf(byClass(r, 'ch-zl-name')[0]));
      assert(show(names) === show(['Dawn (alot hashachar)', 'Sunrise', 'Latest time for Shema (MGA)', 'Latest time for Shema (GRA)', 'Plag hamincha (Yalkut Yosef)', 'Sunset', 'Nightfall (tzeit hakochavim)', 'Midnight (chatzot halayla)']), `names ${show(names)}`);
      assert(show(rowsOf(m).map((r) => textOf(byClass(r, 'ch-zl-time')[0]))) === show(['04:44', '05:54', '08:03', '08:37', '15:59', '16:55', '17:09', '23:24']), 'times');
      for (const r of rowsOf(m)) {
        const bdi = elements(r).filter((e) => e.localName === 'bdi');
        assert(bdi.length === 1 && bdi[0].getAttribute('dir') === 'ltr', 'a time in <bdi dir="ltr">');
      }
      const hours = byClass(m.container, 'ch-zl-hours')[0];
      assert(textOf(hours) === 'Halachic hour: 55:24 (GRA) · 66:29 (MGA)', textOf(hours));
      assert(!/zmanimList\.|calendarHome\./.test(textOf(m.container)), 'a key left bare');
    } finally {
      m.unmount();
    }
  });

  await check('Hebrew (RTL): "זמני היום", the place line "חריש · ספרדי", the date with the Hebrew year in gematriya, the names of the editor, the times left to right, the hour line "שעה זמנית: 55:24 (גר״א) · 66:29 (מג״א)"', async () => {
    const { m } = await openSheet('he', (day) => ok(harish(day)));
    try {
      assert(titleOf(m) === 'זמני היום', titleOf(m));
      assert(textOf(byClass(m.container, 'ch-zl-place')[0]) === 'חריש · ספרדי', textOf(byClass(m.container, 'ch-zl-place')[0]));
      const hebrew = textOf(byClass(m.container, 'ch-zl-hebrew')[0]);
      assert(hebrew === hebrewFullDate(TODAY, 'he') && /תשפ״ז$/.test(hebrew) && /^י״ז בחשון/.test(hebrew), `Hebrew date ${hebrew}`);
      assert(textOf(byClass(m.container, 'ch-zl-day')[0]) === formatDayLong(TODAY, 'he'), 'the Gregorian day in Hebrew');
      const names = rowsOf(m).map((r) => textOf(byClass(r, 'ch-zl-name')[0]));
      assert(names[2] === 'סוף זמן קריאת שמע (מג״א)' && names[3] === 'סוף זמן קריאת שמע (גר״א)' && names[4] === 'פלג המנחה (ילקוט יוסף)' && names[6] === 'צאת הכוכבים', `names ${show(names)}`);
      for (const r of rowsOf(m)) {
        const t = byClass(r, 'ch-zl-time')[0];
        assert(/^\d\d:\d\d$/.test(textOf(t)) && elements(t).some((e) => e.localName === 'bdi' && e.getAttribute('dir') === 'ltr'), 'a time left to right');
      }
      assert(textOf(byClass(m.container, 'ch-zl-hours')[0]) === 'שעה זמנית: 55:24 (גר״א) · 66:29 (מג״א)', textOf(byClass(m.container, 'ch-zl-hours')[0]));
      // The arrows flip in RTL: the previous day's points the way the reading goes back
      const arrows = byClass(m.container, 'ch-icon-btn').map((b) => elements(b).filter((e) => e.localName === 'svg')[0].className.split(' '));
      assert(arrows.length === 2 && arrows.every((classes) => classes.includes('ch-flip')), `arrows ${show(arrows)}`);
      assert(byLabel(m.container, 'היום הקודם') && byLabel(m.container, 'היום הבא'), 'the arrows\' labels');
    } finally {
      m.unmount();
    }
  });

  await check('Russian: "Зманим на сегодня", the place line with "Сефардский", the day with the Hebrew date in the genitive, the names of the editor, the hour line with "ГРА" and "Маген Авраам"', async () => {
    const { m } = await openSheet('ru', (day) => ok(harish(day, { place: { source: 'saved', name: 'Хариш' } })));
    try {
      assert(titleOf(m) === 'Зманим на сегодня', titleOf(m));
      assert(textOf(byClass(m.container, 'ch-zl-place')[0]) === 'Хариш · Сефардский', textOf(byClass(m.container, 'ch-zl-place')[0]));
      const genitive = messages.ru.calendarHome.hebrewMonthGenitive as string[];
      assert(textOf(byClass(m.container, 'ch-zl-hebrew')[0]) === hebrewFullDate(TODAY, 'ru', genitive) && /хешвана 5787$/.test(textOf(byClass(m.container, 'ch-zl-hebrew')[0])), `Hebrew date ${textOf(byClass(m.container, 'ch-zl-hebrew')[0])}`);
      const names = rowsOf(m).map((r) => textOf(byClass(r, 'ch-zl-name')[0]));
      assert(names[3] === 'Конец времени Шма (ГРА)' && names[2] === 'Конец времени Шма (Маген Авраам)', `names ${show(names)}`);
      assert(textOf(byClass(m.container, 'ch-zl-hours')[0]) === 'Галахический час: 55:24 (ГРА) · 66:29 (Маген Авраам)', textOf(byClass(m.container, 'ch-zl-hours')[0]));
      assert(!/zmanimList\.|calendarHome\./.test(textOf(m.container)), 'a key left bare');
    } finally {
      m.unmount();
    }
  });

  await check('the times are the person\'s zone\'s, not the device\'s: 20:56Z is 16:56 in New York and 22:56 in Israel, whatever zone this process runs in', async () => {
    const answer = (zone: string) => (day: string) => ok(harish(day, { tz: zone, rows: [{ key: 'SHKIA', opinion: null, at: '2026-10-28T20:56:00.000Z' }] }));
    const ny = await openSheet('en', answer('America/New_York'));
    try {
      assert(timeOfRow(ny.m, 'SHKIA') === '16:56', timeOfRow(ny.m, 'SHKIA'));
    } finally {
      ny.m.unmount();
    }
    const il2 = await openSheet('en', answer('Asia/Jerusalem'));
    try {
      assert(timeOfRow(il2.m, 'SHKIA') === '22:56', timeOfRow(il2.m, 'SHKIA'));
    } finally {
      il2.m.unmount();
    }
  });

  await check('a Friday and a Saturday: the candle lighting, the candle lighting "not before" and the three ends (Shabbat, Yom Tov, Shabbat and Yom Tov) are rows in the accent (is-key), named in each language; a plain row is not in the accent', async () => {
    const friday = '2026-10-30';
    const saturday = '2026-10-31';
    const expected = {
      en: ['Candle lighting', 'Shabbat ends', 'Yom Tov ends', 'Shabbat and Yom Tov end', 'Candle lighting after'],
      he: ['הדלקת נרות', 'צאת השבת', 'צאת החג', 'צאת השבת והחג', 'הדלקת נרות אחרי'],
      ru: ['Зажигание свечей', 'Исход Шаббата', 'Исход праздника', 'Исход Шаббата и праздника', 'Зажигание свечей после'],
    };
    for (const locale of LOCALES) {
      const fri = await openSheet(locale, (day) => ok(harish(day, { rows: [row(day, 'SHKIA', '16:53'), row(day, 'CANDLE_LIGHTING', '16:33')] })), friday);
      try {
        const candle = rowsOf(fri.m).filter((r) => r.getAttribute('data-zman') === 'CANDLE_LIGHTING')[0];
        assert(candle.className.split(' ').includes('is-key') && textOf(byClass(candle, 'ch-zl-name')[0]) === expected[locale][0], `${locale}: ${candle.className} ${textOf(candle)}`);
        const sunset = rowsOf(fri.m).filter((r) => r.getAttribute('data-zman') === 'SHKIA')[0];
        assert(!sunset.className.split(' ').includes('is-key'), 'a plain row in the accent');
      } finally {
        fri.m.unmount();
      }
      const keys = ['SHABBAT_ENDS', 'YOM_TOV_ENDS', 'SHABBAT_YOM_TOV_ENDS', 'CANDLE_LIGHTING_NOT_BEFORE'];
      const sat = await openSheet(locale, (day) => ok(harish(day, { rows: [row(day, 'TZEIT', '17:07'), ...keys.map((k, i) => row(day, k, `17:2${i + 5}`))] })), saturday);
      try {
        const named = keys.map((k) => rowsOf(sat.m).filter((r) => r.getAttribute('data-zman') === k)[0]);
        assert(show(named.map((r) => textOf(byClass(r, 'ch-zl-name')[0]))) === show(expected[locale].slice(1)), `${locale}: ${show(named.map(textOf))}`);
        assert(named.every((r) => r.className.includes('is-key')), `${locale}: the window rows are in the accent`);
        const tzeit = rowsOf(sat.m).filter((r) => r.getAttribute('data-zman') === 'TZEIT')[0];
        assert(!tzeit.className.includes('is-key'), `${locale}: a plain row in the accent`);
      } finally {
        sat.m.unmount();
      }
    }
  });

  await check('no time that day (the sun does not make it): a dash for the eye, "No time this day" for a reader, no crash, and a hidden hour is a dash too; the rest of the rows keep their times', async () => {
    const polar = (day: string) => ok(harish(day, { rows: [row(day, 'ALOT', null), row(day, 'NETZ', '02:51'), row(day, 'TZEIT', null)], hours: [{ opinion: 'gra', ms: 6344500 }, { opinion: 'mga', ms: null }] }));
    for (const locale of LOCALES) {
      const { m } = await openSheet(locale, polar);
      try {
        const alot = rowsOf(m).filter((r) => r.getAttribute('data-zman') === 'ALOT')[0];
        const time = byClass(alot, 'ch-zl-time')[0];
        const dash = elements(time).filter((e) => e.getAttribute('aria-hidden') === 'true')[0];
        const spoken = byClass(time, 'ch-visually-hidden')[0];
        assert(alot.className.includes('is-none') && dash.textContent === '—' && textOf(spoken) === messages[locale].calendarHome.zmanimList.noTime, `${locale}: ${textOf(alot)}`);
        assert(timeOfRow(m, 'NETZ').startsWith('02:51'), 'the rest keep their times');
        const hours = textOf(byClass(m.container, 'ch-zl-hours')[0]);
        assert(hours.includes('105:45') && hours.includes('—'), `${locale}: the hour line ${hours}`);
      } finally {
        m.unmount();
      }
    }
  });

  await check('Chabad names one hour, the Baal HaTanya\'s, and no Magen Avraham (en, he, ru)', async () => {
    const chabad = (day: string) => ok(harish(day, { community: 'chabad', hours: [{ opinion: 'baalHatanya', ms: (56 * 60 + 2) * 1000 }] }));
    const want = { en: 'Halachic hour: 56:02 (Baal HaTanya)', he: 'שעה זמנית: 56:02 (אדמו״ר הזקן)', ru: 'Галахический час: 56:02 (Баал а-Тания)' };
    for (const locale of LOCALES) {
      const { m } = await openSheet(locale, chabad);
      try {
        assert(textOf(byClass(m.container, 'ch-zl-hours')[0]) === want[locale], textOf(byClass(m.container, 'ch-zl-hours')[0]));
        assert(textOf(byClass(m.container, 'ch-zl-place')[0]).endsWith(messages[locale].calendarHome.zmanimList.community.chabad), 'the set');
      } finally {
        m.unmount();
      }
    }
  });

  await check('the hour line is worded by the editor\'s own "name (opinion)" message (calendarHome.zmanim.withOpinion), not by a format of its own: with that message changed, the line follows it in each language', async () => {
    for (const locale of LOCALES) {
      const changed = JSON.parse(JSON.stringify(messages[locale])) as Row;
      changed.calendarHome.zmanim.withOpinion = '{opinion} => {name}';
      installWindow();
      const l = loader((day) => ok(harish(day)));
      const provider = { locale, messages: changed, timeZone: TZ } as ComponentProps<typeof NextIntlClientProvider>;
      const m = mount(createElement(NextIntlClientProvider, provider, createElement(ZmanimSheet, { userId: 5550001, locale, today: TODAY, load: l.load, onOpenSettings: noop, onClose: noop })));
      await settle();
      try {
        const o = changed.calendarHome.zmanim.opinions;
        const want = `${changed.calendarHome.zmanimList.hourLabel} ${o.gra} => 55:24 · ${o.mga} => 66:29`;
        assert(textOf(byClass(m.container, 'ch-zl-hours')[0]) === want, `${locale}: ${textOf(byClass(m.container, 'ch-zl-hours')[0])} (want ${want})`);
        // The rows' names are worded by the same message, as before
        assert(textOf(byClass(rowsOf(m)[3], 'ch-zl-name')[0]).includes('=>'), `${locale}: the rows follow it too`);
      } finally {
        m.unmount();
      }
    }
  });

  await check('the sheet draws no icon of its own: the arrows are the kit\'s icon library\'s chevrons (lucide) flipped in RTL, the spinner is its Loader with the kit\'s .ch-spin', async () => {
    const { m } = await openSheet('en', (day) => ok(harish(day)));
    try {
      const arrows = byClass(m.container, 'ch-icon-btn').map((b) => elements(b).filter((e) => e.localName === 'svg')[0].className.split(' '));
      assert(arrows[0].includes('lucide-chevron-left') && arrows[1].includes('lucide-chevron-right') && arrows.every((c) => c.includes('ch-flip')), `arrows ${show(arrows)}`);
    } finally {
      m.unmount();
    }
    const loading = await openSheet('en', () => new Promise<ZmanimListOutcome>(() => undefined));
    try {
      const status = elements(loading.m.container).filter((e) => e.getAttribute('role') === 'status')[0];
      const spinner = elements(status).filter((e) => e.localName === 'svg')[0];
      assert(spinner && spinner.className.split(' ').includes('ch-spin') && spinner.className.includes('lucide') && spinner.getAttribute('aria-hidden') === 'true', `spinner ${spinner ? spinner.className : 'none'}`);
    } finally {
      loading.m.unmount();
    }
  });

  // ================= The arrows =================

  await check('the arrows: the sheet opens on the home\'s today; Next asks for the next day, Previous for the one before, the date and the title follow ("Zmanim" on another day, "Today\'s zmanim" on today), the places stay on the sheet, and each day shows its own rows', async () => {
    const { m, calls } = await openSheet('en', (day) => ok(harish(day, { rows: [row(day, 'NETZ', day === TODAY ? '05:54' : '05:55')] })));
    try {
      const next = byLabel(m.container, 'Next day');
      const previous = byLabel(m.container, 'Previous day');
      m.click(next);
      await settle();
      assert(show(calls.map((c) => c[1])) === show([TODAY, '2026-10-29']), `calls ${show(calls)}`);
      assert(dateLine(m).startsWith('Thursday, 29 October') && titleOf(m) === 'Zmanim' && timeOfRow(m, 'NETZ') === '05:55', `${dateLine(m)} | ${titleOf(m)} | ${timeOfRow(m, 'NETZ')}`);
      assert(textOf(byClass(m.container, 'ch-zl-place')[0]) === 'חריש · Sephardi', 'the place stays');
      m.click(previous);
      await settle();
      assert(calls[calls.length - 1][1] === TODAY && titleOf(m) === 'Today’s zmanim' && timeOfRow(m, 'NETZ') === '05:54', `back on today: ${show(calls)} ${titleOf(m)}`);
      m.click(previous);
      await settle();
      assert(calls[calls.length - 1][1] === '2026-10-27' && dateLine(m).startsWith('Tuesday, 27 October') && titleOf(m) === 'Zmanim', `yesterday: ${dateLine(m)}`);
      // The month and year boundaries: the day arithmetic is the calendar's
      const edge = await openSheet('en', (day) => ok(harish(day)), '2026-12-31');
      try {
        edge.m.click(byLabel(edge.m.container, 'Next day'));
        await settle();
        assert(edge.calls[1][1] === '2027-01-01', `across the year ${show(edge.calls)}`);
      } finally {
        edge.m.unmount();
      }
    } finally {
      m.unmount();
    }
  });

  await check('a tap shows the new date at once and a loading state until the day arrives (a status with the hidden "Loading zmanim…", no rows, no stale day\'s times under the new date), and the arrows still work meanwhile', async () => {
    const held: Array<(o: ZmanimListOutcome) => void> = [];
    const { m, calls } = await openSheet('en', (day) => (day === TODAY ? ok(harish(day)) : new Promise<ZmanimListOutcome>((resolve) => held.push(resolve))));
    try {
      m.click(byLabel(m.container, 'Next day'));
      await settle();
      assert(dateLine(m).startsWith('Thursday, 29 October'), `the date at once: ${dateLine(m)}`);
      assert(rowsOf(m).length === 0 && byClass(m.container, 'ch-zl-hours').length === 0, 'the old rows are gone');
      const status = elements(m.container).filter((e) => e.getAttribute('role') === 'status');
      assert(status.length === 1 && textOf(status[0]) === 'Loading zmanim…' && byClass(status[0], 'ch-visually-hidden').length === 1, `loading: ${status.map(textOf)}`);
      // Another tap while it loads: the first answer, landing late, is dropped.
      m.click(byLabel(m.container, 'Next day'));
      await settle();
      assert(calls.length === 3 && calls[2][1] === '2026-10-30', `calls ${show(calls)}`);
      held[0](ok(harish('2026-10-29', { rows: [{ key: 'NETZ', opinion: null, at: il('2026-10-29', '05:55') }] })));
      await settle();
      assert(rowsOf(m).length === 0 && dateLine(m).startsWith('Friday, 30 October'), `a late answer for an older day was shown: ${rowKeys(m)} ${dateLine(m)}`);
      held[1](ok(harish('2026-10-30', { rows: [{ key: 'NETZ', opinion: null, at: il('2026-10-30', '05:56') }] })));
      await settle();
      assert(rowsOf(m).length === 1 && timeOfRow(m, 'NETZ') === '05:56', 'the newest day shows');
      // The other order: the newest day's answer lands first, the older one after it, and must not take the sheet's place
      m.click(byLabel(m.container, 'Next day'));
      m.click(byLabel(m.container, 'Next day'));
      await settle();
      assert(calls.length > 4 && calls[4][1] === '2026-11-01' && calls[3][1] === '2026-10-31', `calls ${show(calls)}`);
      held[3](ok(harish('2026-11-01', { rows: [{ key: 'NETZ', opinion: null, at: il('2026-11-01', '05:58') }] })));
      await settle();
      assert(timeOfRow(m, 'NETZ') === '05:58', 'the newest day shows first');
      held[2](ok(harish('2026-10-31', { rows: [{ key: 'NETZ', opinion: null, at: il('2026-10-31', '05:57') }] })));
      await settle();
      assert(rowsOf(m).length === 1 && timeOfRow(m, 'NETZ') === '05:58' && dateLine(m).includes('Sunday, 1 November'), `an older answer landing after the newest took its place: ${rowKeys(m)} ${dateLine(m)}`);
    } finally {
      m.unmount();
    }
  });

  // ================= The states =================

  await check('a failed request says so and offers Retry (en, he, ru): an answer that is not 200, then Retry asks for the same day again and shows it; the date stays', async () => {
    for (const locale of LOCALES) {
      let fail = true;
      const { m, calls } = await openSheet(locale, (day) => (fail ? { kind: 'failed', status: 500 } : ok(harish(day))));
      try {
        const copy = messages[locale].calendarHome;
        const card = byClass(m.container, 'ch-home-card')[0];
        assert(card && textOf(card).includes(copy.zmanimList.failedTitle) && textOf(card).includes(copy.zmanimList.failedBody), `${locale}: ${card ? textOf(card) : 'no card'}`);
        assert(rowsOf(m).length === 0, 'rows with a failure');
        const retry = elements(card).filter((e) => e.localName === 'button' && textOf(e) === copy.actions.retry)[0];
        assert(retry, 'no Retry');
        fail = false;
        m.click(retry);
        await settle();
        assert(show(calls.map((c) => c[1])) === show([TODAY, TODAY]) && rowsOf(m).length === 8 && byClass(m.container, 'ch-home-card').length === 0, `after Retry: ${show(calls)} ${rowsOf(m).length}`);
      } finally {
        m.unmount();
      }
    }
  });

  await check('a request that throws is a failure too (logged by the sheet), and a failure on the next day leaves the arrows working: the day before shows again', async () => {
    appLogs.length = 0;
    const { m } = await openSheet('en', (day) => {
      if (day === TODAY) return ok(harish(day));
      throw new Error('the request blew up');
    });
    try {
      m.click(byLabel(m.container, 'Next day'));
      await settle();
      assert(byClass(m.container, 'ch-home-card').length === 1 && dateLine(m).startsWith('Thursday, 29 October'), 'the failure card for the new day');
      assert(appLogs.some((l) => l.startsWith('[zmanim-sheet] the list for 2026-10-29 could not be read')), `logged: ${show(appLogs)}`);
      m.click(byLabel(m.container, 'Previous day'));
      await settle();
      assert(byClass(m.container, 'ch-home-card').length === 0 && rowsOf(m).length === 8, 'today again');
    } finally {
      m.unmount();
    }
  });

  await check('no saved place: the sheet names the zone and the set, shows the editor\'s own note ("No location is saved…") with the way to Settings, still lists the rows; a saved place shows no note; no place at all shows the other note, no rows', async () => {
    const zoneOnly = await openSheet('en', (day) => ok(harish(day, { place: { source: 'zone' } })));
    try {
      assert(textOf(byClass(zoneOnly.m.container, 'ch-zl-place')[0]) === `${zoneLabel(TZ, 'en')} · Sephardi` && zoneLabel(TZ, 'en') !== TZ, textOf(byClass(zoneOnly.m.container, 'ch-zl-place')[0]));
      const note = byClass(zoneOnly.m.container, 'ch-notice')[0];
      assert(note && textOf(note).startsWith(messages.en.calendarHome.editor.zmanZoneOnly) && textOf(note).includes('Open Settings'), `note ${note ? textOf(note) : 'none'}`);
      assert(rowsOf(zoneOnly.m).length === 8, 'the rows still show');
      const link = elements(note).filter((e) => e.localName === 'button')[0];
      zoneOnly.m.click(link);
      assert(zoneOnly.m.settings.length === 1, 'Open Settings did not call onOpenSettings');
    } finally {
      zoneOnly.m.unmount();
    }
    const saved = await openSheet('en', (day) => ok(harish(day)));
    try {
      assert(byClass(saved.m.container, 'ch-notice').length === 0, 'a note for a saved place');
    } finally {
      saved.m.unmount();
    }
    for (const locale of LOCALES) {
      const none = await openSheet(locale, (day) => ok(harish(day, { place: null, rows: [], hours: [] })));
      try {
        const note = byClass(none.m.container, 'ch-notice')[0];
        assert(note && textOf(note).startsWith(messages[locale].calendarHome.editor.zmanNoPlace), `${locale}: ${note ? textOf(note) : 'none'}`);
        assert(rowsOf(none.m).length === 0 && byClass(none.m.container, 'ch-zl-hours').length === 0 && byClass(none.m.container, 'ch-zl-place').length === 0, 'rows or hours without a place');
      } finally {
        none.m.unmount();
      }
    }
  });

  await check('the sheet closes like every sheet of the kit: the Close button and Escape call onClose; a list is a plain list (no button in a row creates anything)', async () => {
    const { m } = await openSheet('en', (day) => ok(harish(day)));
    try {
      assert(rowsOf(m).every((r) => elements(r).every((e) => e.localName !== 'button' && e.localName !== 'a')), 'a control inside a row');
      m.click(elements(m.container).filter((e) => e.localName === 'button' && textOf(e) === 'Close')[0]);
      const closes = () => m.closed.length;
      assert(closes() === 1, 'Close');
      const dialog = elements(m.container).filter((e) => e.getAttribute('role') === 'dialog')[0];
      m.key(dialog, 'Escape');
      assert(closes() === 2, 'Escape');
    } finally {
      m.unmount();
    }
  });

  // ================= The request =================

  await check('the request: GET /api/zmanim with user_id and date, the init data in the header and never in the URL; 200 with a list is ok; every other outcome is failed and logged', async () => {
    const calls: Array<{ url: string; init: Row }> = [];
    let answer: () => Promise<Row> = async () => ({ status: 200, json: async () => harish() });
    (globalThis as Row).fetch = async (url: string, init: Row) => { calls.push({ url, init }); return answer(); };
    fakeWindow.Telegram = { WebApp: { initData: 'query_id=AAE&user=%7B%22id%22%3A5550001%7D&hash=abc' } };
    try {
      const good = await fetchZmanimList(5550001, '2026-10-28');
      assert(good.kind === 'ok' && good.list.day === TODAY, `ok: ${show(good).slice(0, 100)}`);
      const url = new URL(calls[0].url, 'https://famcal.test');
      assert(url.pathname === '/api/zmanim' && url.searchParams.get('user_id') === '5550001' && url.searchParams.get('date') === '2026-10-28' && !calls[0].url.includes('hash'), calls[0].url);
      assert(calls[0].init.method === 'GET' && calls[0].init.headers['X-Telegram-Init-Data'] === 'query_id=AAE&user=%7B%22id%22%3A5550001%7D&hash=abc' && calls[0].init.cache === 'no-store' && calls[0].init.credentials === 'same-origin', `init ${show(calls[0].init)}`);
      appLogs.length = 0;
      answer = async () => ({ status: 500, json: async () => ({ error: 'internal_error' }) });
      assert(show(await fetchZmanimList(1, TODAY)) === show({ kind: 'failed', status: 500 }), 'a 500');
      answer = async () => ({ status: 401, json: async () => ({ error: 'Unauthorized' }) });
      assert(show(await fetchZmanimList(1, TODAY)) === show({ kind: 'failed', status: 401 }), 'a 401');
      answer = async () => ({ status: 200, json: async () => ({ day: TODAY }) });
      assert(show(await fetchZmanimList(1, TODAY)) === show({ kind: 'failed', status: 200 }), 'a 200 that is not a list');
      answer = async () => ({ status: 502, json: async () => { throw new SyntaxError('not json'); } });
      assert(show(await fetchZmanimList(1, TODAY)) === show({ kind: 'failed', status: 502 }), 'an answer that is not JSON');
      answer = async () => { throw new TypeError('Failed to fetch'); };
      assert(show(await fetchZmanimList(1, TODAY)) === show({ kind: 'failed', status: null }), 'no answer at all');
      assert(appLogs.length >= 5 && appLogs.every((l) => l.startsWith('[zmanim-list]')), `logged: ${show(appLogs)}`);
    } finally {
      fakeWindow.Telegram = undefined;
    }
  });

  await check('the list\'s shape is checked before the sheet reads it: a real answer passes; a missing rows, an unknown opinion, a place of an unknown source, a time that is not a string or an hour that is not a number do not', () => {
    const good = harish();
    assert(isZmanimList(good) && isZmanimList({ ...good, place: null, rows: [], hours: [] }) && isZmanimList({ ...good, place: { source: 'zone' } }), 'a real answer');
    const bad: unknown[] = [
      null, 'x', [], { ...good, rows: undefined }, { ...good, community: 'reform' }, { ...good, place: { source: 'saved' } }, { ...good, place: { source: 'elsewhere', name: 'x' } },
      { ...good, rows: [{ key: 'NETZ', opinion: 'rambam', at: null }] }, { ...good, rows: [{ key: 'NETZ', opinion: null, at: 5 }] },
      { ...good, hours: [{ opinion: 'gra', ms: '55' }] }, { ...good, hours: [{ opinion: 'gra', ms: Number.NaN }] }, { ...good, tz: 5 },
    ];
    for (const value of bad) assert(!isZmanimList(value), `accepted ${show(value)}`);
  });

  await check('a halachic hour is minutes and seconds, not hours: 55:24 and 66:29 (Harish today), 55:25, 66:30 and 105:45 on a long day, whole seconds rounded, and a dash where the day has none', () => {
    const cases: Array<[number | null, string]> = [[3_324_000, '55:24'], [3_988_800, '66:29'], [3_325_000, '55:25'], [3_990_000, '66:30'], [6_344_500, '105:45'], [3_599_600, '60:00'], [3_324_400, '55:24'], [0, '0:00'], [59_000, '0:59'], [null, '—'], [-1, '—'], [Number.NaN, '—']];
    for (const [ms, want] of cases) assert(formatHalachicHour(ms) === want, `${String(ms)} -> ${formatHalachicHour(ms)} (want ${want})`);
  });

  // ================= The copy and the CSS =================

  await check('the copy: every new key is real text in en, he and ru, none is a copy of English in he or ru (apart from the plain "Zmanim" of the unchanged Hebrew title), the Russian and Hebrew community names match Settings\' own', () => {
    const keys = ['title', 'titleOther', 'previousDay', 'nextDay', 'shabbatEnds', 'yomTovEnds', 'shabbatYomTovEnds', 'candlesNotBefore', 'noTime', 'hourLabel', 'loading', 'failedTitle', 'failedBody'];
    for (const locale of LOCALES) {
      const list = messages[locale].calendarHome.zmanimList;
      for (const key of keys) assert(typeof list[key] === 'string' && list[key].length > 2, `${locale}.${key}`);
      for (const set of ['sephardi', 'ashkenazi', 'chabad']) assert(typeof list.community[set] === 'string' && list.community[set].length > 2, `${locale}.community.${set}`);
    }
    for (const locale of ['he', 'ru'] as const) {
      const list = messages[locale].calendarHome.zmanimList;
      for (const key of keys) assert(list[key] !== messages.en.calendarHome.zmanimList[key], `${locale}.${key} is English`);
    }
    // The set names are Settings' own short forms
    assert(messages.he.calendarHome.zmanimList.community.chabad === 'חב״ד' && messages.he.settings.zmanim.chabad === 'חב״ד', 'Hebrew Chabad');
    assert(messages.ru.settings.zmanim.sephardi.startsWith(messages.ru.calendarHome.zmanimList.community.sephardi) && messages.he.settings.zmanim.sephardi.startsWith(messages.he.calendarHome.zmanimList.community.sephardi), 'Sephardi');
    assert(messages.en.settings.zmanim.ashkenazi.startsWith(messages.en.calendarHome.zmanimList.community.ashkenazi), 'Ashkenazi');
  });

  await check('the rows are one plain component, shared with the public city pages: components/app-ui/ZmanimRows.tsx has no "use client", no hook and no next-intl import, the sheet draws its rows only through it, the CSS lives in src/lib/calendar-view/zmanim-sheet-css.ts (the sheet re-exports the same string), and rendered on a server with createTranslator over calendarHome it gives the markup the sheet shows (a window row, a dash, the hour line) in en, he and ru', async () => {
    const plain = fs.readFileSync(path.join(ROOT, 'components/app-ui/ZmanimRows.tsx'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert(!/['"]use client['"]/.test(plain) && !/\buse[A-Z]\w*\(/.test(plain) && !/from 'next-intl'/.test(plain), 'ZmanimRows is not a plain component');
    const sheet = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/dashboard/ZmanimSheet.tsx'), 'utf8');
    assert(/<ZmanimRows list=\{current\.list\} locale=\{locale\} t=\{t\} \/>/.test(sheet), 'the sheet does not draw ZmanimRows');
    assert(!/ch-zl-rows|ch-zl-row\b|ch-zl-hours|zmanName\(/.test(sheet) && !/`\n\.ch-zl-/.test(sheet), 'the sheet still draws rows or holds CSS of its own');
    assert(ZMANIM_SHEET_CSS === PLAIN_SHEET_CSS && PLAIN_SHEET_CSS.includes('.ch-zl-row {'), 'the sheet re-exports another string');
    const friday = '2026-10-30';
    const list = harish(friday, { rows: [row(friday, 'ALOT', null), row(friday, 'SOF_SHMA_GRA', '08:37', 'gra'), row(friday, 'CANDLE_LIGHTING', '16:33'), row(friday, 'SHKIA', '16:53')] });
    for (const locale of LOCALES) {
      const t = createTranslator({ locale, messages: messages[locale], namespace: 'calendarHome' }) as unknown as ZmanWordsT;
      const server = renderToString(createElement(ZmanimRows, { list, locale, t })).replace(/<!-- -->/g, '');
      const { m } = await openSheet(locale, () => ok(list), friday);
      try {
        const rows = byClass(m.container, 'ch-zl-rows')[0];
        const hours = byClass(m.container, 'ch-zl-hours')[0];
        const mounted = markupOfNode(rows) + markupOfNode(hours);
        assert(server === mounted, `${locale}: the server's rows differ from the sheet's:\n${server}\n${mounted}`);
        assert(/data-zman="CANDLE_LIGHTING"/.test(server) && /is-none/.test(server) && /ch-zl-hours/.test(server), `${locale}: the probe lacks a window row, a dash or the hour line`);
      } finally {
        m.unmount();
      }
    }
  });

  await check('the sheet\'s CSS: nothing under 11 px, every size in px, logical properties only, no hover, no colour literal; every colour is a theme token that exists, and its text pairs are ones the design smoke holds to 4.5:1', () => {
    const problems = lintCss(ZMANIM_SHEET_CSS);
    assert(problems.length === 0, problems.join('; '));
    const defined = new Set(cssBlocks(APP_THEME_CSS).flatMap(([, body]) => customProps(body).map(([name]) => name)).concat(cssBlocks(APP_SCREEN_CSS).flatMap(([, body]) => customProps(body).map(([name]) => name))));
    const used = [...new Set([...ZMANIM_SHEET_CSS.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))];
    assert(used.length >= 4, `tokens used: ${show(used)}`);
    for (const token of used) assert(defined.has(token), `${token} is not a theme token`);
    // Text colours the sheet uses sit on the sheet (--ch-section) or, in the note, on the surface
    const pairs: Array<[string, string]> = [['--ch-text', '--ch-section'], ['--ch-muted', '--ch-section'], ['--ch-accent', '--ch-section']];
    for (const [fg, bg] of pairs) assert(TEXT_PAIRS.some(([a, b]) => a === fg && b === bg), `${fg} on ${bg} is not a held pair`);
    const colours = [...ZMANIM_SHEET_CSS.matchAll(/(?:^|[;{\s])color:\s*(var\(--[\w-]+\))/g)].map((m) => m[1]);
    assert(colours.every((c) => ['var(--ch-muted)', 'var(--ch-accent)'].includes(c)), `colours ${show(colours)}`);
    assert(/\.ch-zl-note \.ch-notice \{\s*background: var\(--ch-surface\)/.test(ZMANIM_SHEET_CSS), 'the note sits on the surface, not on its own colour');
    assert(/\.ch-zl-row \{[^}]*min-block-size: 44px/.test(ZMANIM_SHEET_CSS), 'a row is at least 44 px');
    assert(/font-variant-numeric: tabular-nums/.test(ZMANIM_SHEET_CSS), 'times line up');
  });

  await check('the header makes room for the fourth button: the day keeps 120 px beside the buttons and the buttons wrap to a row of their own, at the end, when it would be left less; so the usual three never wrap on a phone of 320 px or more (128 px stay for the day, as before the sun), four buttons (the sun) wrap on a 360 px phone and sit beside the day from 364 px', () => {
    const rule = (selector: string) => {
      const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(HOME_SHELL_CSS);
      assert(m, `no rule ${selector}`);
      return m[1];
    };
    assert(/flex-wrap:\s*wrap/.test(rule('.ch-head')), '.ch-head wraps');
    const basis = /flex:\s*1 1 (\d+)px/.exec(rule('.ch-head-text'));
    assert(basis && Number(basis[1]) === 120, `.ch-head-text: ${rule('.ch-head-text')}`);
    assert(/margin-inline-start:\s*auto/.test(rule('.ch-head-buttons')), 'the wrapped buttons sit at the end');
    // The arithmetic the CSS makes: padding 16 + 16, the gap of 12, buttons of 44 with gaps of 8
    const gap = Number(/gap:\s*(\d+)px/.exec(rule('.ch-head'))![1]);
    const pad = Number(/padding:\s*\d+px (\d+)px/.exec(rule('.ch-head'))![1]);
    const buttons = (n: number) => 44 * n + Number(/gap:\s*(\d+)px/.exec(rule('.ch-head-buttons'))![1]) * (n - 1);
    const fits = (width: number, n: number) => Number(basis[1]) + gap + buttons(n) + 2 * pad <= width;
    assert(fits(320, 3) && fits(320, 2) && fits(360, 3) && fits(360, 2), 'the usual three buttons stay beside the day from 320 px');
    assert(!fits(360, 4) && !fits(363, 4) && fits(364, 4) && fits(388, 4) && fits(390, 4), 'four buttons: a 360 px phone wraps, 364 and wider do not');
    // What the day is left beside the buttons, in px: as before the sun at 320 px, and never narrower than the basis while it stays on the line
    assert(320 - 2 * pad - gap - buttons(3) >= Number(basis[1]), 'at 320 px the day keeps its room beside three buttons');
  });

  await check('React logged no warning (keys, nesting, attributes, act), and the sheet\'s own logs are only the failures the checks caused', () => {
    assert(reactWarnings.length === 0, `React warned: ${show(reactWarnings.slice(0, 3))}`);
    assert(appLogs.every((l) => /^\[zmanim-(list|sheet)\]/.test(l)), `logs ${show(appLogs)}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.env[CHILD] !== '1') {
  void runChildren();
} else {
  runChecks().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

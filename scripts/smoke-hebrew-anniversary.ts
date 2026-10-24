// Smoke test for the Hebrew anniversary count (docs/superpowers/specs/2026-10-25-hebrew-anniversary-count-design.md).
// Pure: no DB, no network. Parts are added as the count reaches each surface.
//   TZ=UTC npx tsx scripts/smoke-hebrew-anniversary.ts

import fs from 'fs';
import path from 'path';
import { createElement, type ComponentProps, type MutableRefObject } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { HDate, months } from '@hebcal/hdate';
import { toItemDto } from '../src/services/calendar-read/dto';
import type { ReadItem } from '../src/services/calendar-read/types';
import type { ItemDTO } from '../src/lib/calendar-view/types';
import { buildMonth } from '../src/lib/calendar-view/month';
import { ItemRow } from '../app/[locale]/dashboard/ItemRow';
import { ItemSheet } from '../app/[locale]/dashboard/ItemSheet';
import { Slot } from '../app/[locale]/dashboard/MonthBrowse';
import { MONTH_BROWSE_CSS } from '../app/[locale]/dashboard/MonthBrowse';
import { AGENDA_CSS } from '../app/[locale]/dashboard/AgendaView';
import { EditorSheet } from '../app/[locale]/dashboard/EditorSheet';
import { newItemForm } from '../src/lib/calendar-view/editor-model';
import { toUnifiedEvent } from '../src/services/calendar-provider/native-provider';
import { formatEventForPrompt } from '../src/utils/event-formatter';
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { hebrewCandidates } from '../src/services/native-calendar/recurrence';
import { anniversaryCount, anniversaryOf } from '../src/lib/hebrew-anniversary';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
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

const civil = (h: HDate) => {
  const g = h.greg();
  return `${g.getFullYear()}-${String(g.getMonth() + 1).padStart(2, '0')}-${String(g.getDate()).padStart(2, '0')}`;
};

async function main() {
  await check('count: Hebrew years apart, not civil years: a Tishrei anchor is a year on after the new year (Rosh Hashana)', () => {
    // 1 Tishrei 5786 is 2025-09-23; the day before is still 5785.
    assert(anniversaryCount('2025-09-22', '2025-09-23') === 1, 'across Rosh Hashana');
    assert(anniversaryCount('2025-09-23', '2025-09-23') === null, 'same day is N=0');
    assert(anniversaryCount('1990-05-01', '2026-05-01') === 36, 'a civil span of 36 years');
  });

  await check('count: N = 0 (the first occurrence) is hidden, null', () => {
    assert(anniversaryCount('2020-03-10', '2020-03-10') === null, 'the anchor itself');
    assert(anniversaryCount('2020-03-10', '2020-09-01') === null, 'same Hebrew year');
  });

  await check('count: an anchor in a future year shows nothing, never a negative number', () => {
    assert(anniversaryCount('2030-03-10', '2026-03-10') === null, 'future anchor');
  });

  await check('count: leap years and Adar: a 5784 (leap) Adar I and Adar II anchor, and the day-30 roll to 1 Nisan in a one-Adar year', () => {
    // 5784 is a leap year (Adar I and Adar II). 30 Adar I 5784 -> hebcal's rule puts it on 1 Nisan in 5785 (one Adar).
    const adarI30 = civil(new HDate(30, months.ADAR_I, 5784));
    const nisan1 = civil(new HDate(1, months.NISAN, 5785));
    assert(anniversaryCount(adarI30, nisan1) === 1, `rolled day ${adarI30} -> ${nisan1}`);
    // 14 Adar II 5784 anchor: 5785 (one Adar) it falls on 14 Adar; 5787 (leap) on 14 Adar II.
    const adarII14 = civil(new HDate(14, months.ADAR_II, 5784));
    assert(anniversaryCount(adarII14, civil(new HDate(14, months.ADAR_II, 5787))) === 3, 'leap to leap');
    assert(anniversaryCount(adarII14, civil(new HDate(14, months.ADAR_I, 5785))) === 1, 'a one-Adar year (hebcal numbers its only Adar ADAR_I)');
    // 30 Cheshvan rolled to 1 Kislev stays in its own year.
    const cheshvan30 = civil(new HDate(30, months.CHESHVAN, 5784));
    assert(anniversaryCount(cheshvan30, civil(new HDate(1, months.KISLEV, 5786))) === 2, 'Kislev 1');
  });

  await check('count follows the real expander: 30 Adar I 5784 lands on 1 Nisan 5785 (N=1) and the next leap year on 30 Adar I again', () => {
    const adarI30 = civil(new HDate(30, months.ADAR_I, 5784));
    const startsAt = fromZonedTime(`${adarI30} 00:00`, 'Asia/Jerusalem');
    const series = { startsAt, timeZone: 'Asia/Jerusalem', rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary' as const, hebrewAnchor: adarI30 };
    const slots = hebrewCandidates(series, { from: startsAt, to: fromZonedTime('2031-01-01 00:00', 'Asia/Jerusalem') });
    const days = slots.map((d) => formatInTimeZone(d, 'Asia/Jerusalem', 'yyyy-MM-dd'));
    const counts = days.map((d) => anniversaryCount(adarI30, d));
    assert(days[0] === adarI30 && counts[0] === null, `first ${days[0]} ${counts[0]}`);
    assert(days[1] === civil(new HDate(1, months.NISAN, 5785)) && counts[1] === 1, `5785 ${days[1]} ${counts[1]}`);
    assert(counts.slice(0, 6).every((n, i) => (i === 0 ? n === null : n === i)), `sequence ${counts}`);
  });


  // ---- The data path: provider event, DTO ----

  const SERIES = { kind: 'EVENT' as const, hebrewRule: 'anniversary', hebrewAnchor: '1990-05-01' };
  const instance = (startsAt: string, allDay = true) => ({
    title: "Dana's birthday", startsAt: new Date(startsAt), endsAt: new Date(startsAt), allDay, timeZone: 'Asia/Jerusalem',
    seriesEventId: 's1', instanceStartsAt: new Date(startsAt), isRecurringInstance: true,
  });
  const readItem = (event: ReturnType<typeof toUnifiedEvent>): ReadItem => ({
    source: 'famcal', key: 'famcal|s1', event, calendar: { id: 'native:c1', source: 'famcal', name: 'Family', color: null, mine: true, inLegend: true },
    title: event.summary, kind: 'event', seriesId: 's1', originalStart: event.start, recurring: true, rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary', hebrewAnchor: '1990-05-01',
  });
  const dtoFor = (startsAt: string, series: typeof SERIES | undefined): ItemDTO => {
    const event = toUnifiedEvent({ id: 'c1', name: 'Family' }, instance(startsAt), series);
    return toItemDto(readItem(event), null, { now: new Date('2026-05-01T00:00:00Z'), open: false, openSince: null });
  };

  await check('provider and DTO: a Hebrew series occurrence carries its count; the first occurrence, another series and a series-less read carry none', () => {
    const late = dtoFor('2026-04-30T21:00:00Z', SERIES); // 2026-05-01 00:00 in Jerusalem
    assert(late.anniversary === 36, `count ${late.anniversary}`);
    assert(dtoFor('1990-04-30T21:00:00Z', SERIES).anniversary === undefined, 'the anchor itself');
    assert(dtoFor('2026-04-30T21:00:00Z', { ...SERIES, hebrewRule: null as unknown as string }).anniversary === undefined, 'not Hebrew');
    assert(dtoFor('2026-04-30T21:00:00Z', undefined).anniversary === undefined, 'no series');
    assert(!('anniversary' in dtoFor('2026-04-30T21:00:00Z', { ...SERIES, hebrewAnchor: '2030-01-01' })), 'a future anchor leaves the field out');
  });

  // ---- Markup ----

  const messages = Object.fromEntries((['en', 'he', 'ru'] as const).map((l) => [l, JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${l}.json`), 'utf8'))]));
  const inHome = (locale: 'en' | 'he' | 'ru', el: ReturnType<typeof createElement>) => {
    const provider = { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as ComponentProps<typeof NextIntlClientProvider>;
    return createElement(NextIntlClientProvider, provider, createElement('div', { className: 'ch-home', 'data-theme': 'light' }, el));
  };
  const withCount = dtoFor('2026-04-30T21:00:00Z', SERIES);
  const without = dtoFor('1990-04-30T21:00:00Z', SERIES);
  const rowOf = (item: ItemDTO) => ({ item, whose: { mine: true, person: null, relation: null }, mark: null });
  const noop = () => undefined;
  const pills = (html: string) => [...html.matchAll(/<span class="ch-count"[^>]*>([\s\S]*?)<\/span>/g)];

  await check('Agenda row and item sheet: the pill follows the title, in every language; no pill without a count', () => {
    for (const locale of ['en', 'he', 'ru'] as const) {
      const row = renderToString(inHome(locale, createElement(ItemRow, { row: rowOf(withCount), day: '2026-05-01', tz: 'Asia/Jerusalem', onOpen: noop })));
      const m = pills(row);
      assert(m.length === 1 && />36</.test(m[0][0]) && row.indexOf("Dana&#x27;s birthday") < row.indexOf('ch-count'), `${locale} row ${row}`);
      assert(!/\(36\)/.test(row), 'not literal parentheses');
      const sheet = renderToString(inHome(locale, createElement(ItemSheet, { row: rowOf(withCount), today: '2026-05-01', tz: 'Asia/Jerusalem', onClose: noop })));
      assert(pills(sheet).length === 1, `${locale} sheet`);
      assert(pills(renderToString(inHome(locale, createElement(ItemRow, { row: rowOf(without), day: '1990-05-01', tz: 'Asia/Jerusalem', onOpen: noop })))).length === 0, `${locale} none`);
    }
    const he = renderToString(inHome('he', createElement(ItemRow, { row: rowOf(withCount), day: '2026-05-01', tz: 'Asia/Jerusalem', onOpen: noop })));
    assert(/ch-visually-hidden[^>]*>[^<]*36 שנים/.test(he.replace(/<!-- -->/g, '')), `hidden label ${he}`);
    const ru = renderToString(inHome('ru', createElement(ItemRow, { row: rowOf({ ...withCount, anniversary: 22 }), day: '2026-05-01', tz: 'Asia/Jerusalem', onOpen: noop })));
    assert(/22 года/.test(ru.replace(/<!-- -->/g, '')), `ru plural ${ru}`);
  });

  await check('CSS: the pill is muted, tabular, uses the home tokens, sits inline after the title (logical end); no physical left/right', () => {
    const css = AGENDA_CSS;
    const block = /\.ch-count\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    assert(/font-variant-numeric:\s*tabular-nums/.test(block) && /var\(--ch-muted\)/.test(block) && /var\(--ch-surface\)/.test(block), `block ${block}`);
    assert(!/\b(left|right|margin-left|margin-right)\b/.test(block), 'physical sides');
  });

  // ---- Month cell ----

  await check('Month: the slot carries the count; the chip puts the pill after the title; the CSS drops the pill below a width before it hides the title', () => {
    const slot = {
      kind: 'allDay' as const, key: 'k', title: "Dana's birthday", showTitle: true, mine: true, color: null, done: false,
      continuesBefore: false, continuesAfter: false, count: 36,
    };
    const html = renderToString(createElement(Slot, { slot, noTitle: '(No title)' }));
    assert(html.indexOf('<bdi') !== -1 && html.indexOf('<bdi') < html.indexOf('ch-mb-count') && html.includes('has-count'), `chip ${html}`);
    assert(!renderToString(createElement(Slot, { slot: { ...slot, count: null }, noTitle: '' })).includes('ch-mb-count'), 'no count, no pill');
    assert(!renderToString(createElement(Slot, { slot: { ...slot, showTitle: false }, noTitle: '' })).includes('ch-mb-count'), 'a bar day without a title has no pill');
    const css = MONTH_BROWSE_CSS;
    assert(/\.ch-mb-slot\s*\{[^}]*container-type:\s*inline-size/.test(css), 'the slot is the container');
    assert(/@container\s*\(min-width:\s*\d+px\)\s*\{[^}]*\.ch-mb-count[^}]*display:\s*inline-block/.test(css), 'the pill shows from a width');
    assert(/\.ch-mb-count\s*\{[^}]*display:\s*none/.test(css), 'the pill is off by default');
    assert(/\.ch-mb-chip-title\s*\{[^}]*text-overflow:\s*ellipsis/.test(css) && html.includes('class="ch-mb-chip-title"'), 'the title truncates');
    assert(typeof buildMonth === 'function', 'buildMonth');
  });

  // ---- Editor hint ----

  await check('Editor: with the Hebrew repeat chosen, a hint says the date should be the original one; not under another repeat; he/en/ru all have it', () => {
    const cal = { id: 'native:c1', name: 'Family', color: null, main: true, mine: true };
    const base = newItemForm({ today: '2026-10-15', pickedDay: null, nowMs: Date.parse('2026-10-15T07:00:00Z'), tz: 'Asia/Jerusalem', kinds: { event: true, reminder: true }, calendars: [cal] });
    const cancelRef = { current: null } as MutableRefObject<(() => void) | null>;
    const render = (locale: 'en' | 'he' | 'ru', repeat: 'hebrew' | 'yearly') =>
      renderToString(inHome(locale, createElement(EditorSheet, { mode: 'create', initial: { ...base, repeat }, kinds: { event: true, reminder: true }, calendars: [cal], hebrewDates: true, onSave: async () => ({ ok: true }) as never, onClose: noop, cancelRef })));
    for (const locale of ['en', 'he', 'ru'] as const) {
      const hint = messages[locale].calendarHome.editor.repeat.hebrewCountHint as string | undefined;
      assert(typeof hint === 'string' && hint.length > 10, `${locale} key`);
      assert(render(locale, 'hebrew').includes(hint.replace(/'/g, '&#x27;')), `${locale} shown`);
      assert(!render(locale, 'yearly').includes(hint.replace(/'/g, '&#x27;')), `${locale} hidden for yearly`);
    }
  });

  await check('count: a bad anchor or day gives null', () => {
    assert(anniversaryCount(null, '2026-01-01') === null && anniversaryCount('nope', '2026-01-01') === null && anniversaryCount('2020-01-01', 'x') === null, 'bad input');
  });

  await check('anniversaryOf: only an anniversary series with an anchor counts; the day is the instant\'s civil day in the zone', () => {
    const anchor = '2020-03-10';
    // 2026-03-09 22:30 UTC is already 2026-03-10 in Jerusalem.
    assert(anniversaryOf({ hebrewRule: 'anniversary', hebrewAnchor: anchor }, '2026-03-09T22:30:00Z', 'Asia/Jerusalem') !== null, 'timed instant');
    assert(anniversaryOf({ hebrewRule: 'anniversary', hebrewAnchor: anchor }, '2026-03-10', 'Asia/Jerusalem') === anniversaryOf({ hebrewRule: 'anniversary', hebrewAnchor: anchor }, '2026-03-09T22:30:00Z', 'Asia/Jerusalem'), 'all-day date equals the instant');
    assert(anniversaryOf({ hebrewRule: null, hebrewAnchor: anchor }, '2026-03-10', 'UTC') === null, 'no rule');
    assert(anniversaryOf({ hebrewRule: 'anniversary', hebrewAnchor: null }, '2026-03-10', 'UTC') === null, 'no anchor');
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` - ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();

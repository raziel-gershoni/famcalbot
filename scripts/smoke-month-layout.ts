// Smoke test for the one Month screen's pure rules (responsive home, release 2):
// src/lib/calendar-view/month-layout.ts (split heights, square sizes, the month at a
// scroll), month.ts's focus helpers and fitSlots/fitRow, and the shared media hook
// (src/lib/calendar-view/use-media.ts). No network, no database.
//
// Run with the fake env:
//   bash <scratchpad>/repro/run-env.sh scripts/smoke-month-layout.ts

import fs from 'fs';
import path from 'path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import {
  GRID_PAD_PX,
  HANDLE_PX,
  LIST_MIN_PX,
  SHORT_QUERY,
  SHORT_UPRIGHT_QUERY,
  SQUARE_LARGE_MIN_PX,
  WIDE_QUERY,
  monthAtScroll,
  splitHeights,
  squareSize,
} from '../src/lib/calendar-view/month-layout';
import {
  canStepMonth,
  clampFocus,
  monthBarPx,
  fitRow,
  fitSlots,
  focusJump,
  focusMonth,
  focusToday,
  initialFocus,
  selectDay,
  wantedFocusMonths,
  type MonthCell,
  type MonthFocus,
  type MonthSlot,
} from '../src/lib/calendar-view/month';
import { useMediaQuery } from '../src/lib/calendar-view/use-media';
import { fakeWindow, installWindow, mount } from './lib/fake-dom';

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

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function assertJson(got: unknown, want: unknown, label: string) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  assert(g === w, `${label}\n     got  ${g}\n     want ${w}`);
}

const TODAY = '2026-10-15';

const slot = (key: string, kind: MonthSlot['kind'] = 'allDay', extra: Partial<MonthSlot> = {}): MonthSlot => ({
  kind,
  key: kind === 'spacer' ? null : key,
  title: kind === 'spacer' ? null : key,
  showTitle: kind !== 'bar',
  mine: true,
  color: null,
  count: null,
  done: false,
  continuesBefore: false,
  continuesAfter: false,
  canEdit: true,
  repeatsEveryDay: false,
  ...extra,
});

const cell = (day: string, slots: MonthSlot[], inMonth = true): MonthCell => ({
  day,
  inMonth,
  today: false,
  status: 'answered',
  slots,
  dots: [],
  count: slots.length,
  fromPartner: 0,
  hebrewMonthStart: false,
});

async function main() {
  await check('splitHeights: the collapsed, squeezed, floor, tall and grown cases, and a bad input', () => {
    assertJson(splitHeights(560, 76, 54, false), { rowPx: 44, scrollerPx: 264, listPx: 198 }, '560');
    assertJson(splitHeights(440, 76, 54, false), { rowPx: 37, scrollerPx: 222, listPx: 120 }, '440');
    assertJson(splitHeights(380, 76, 54, false), { rowPx: 36, scrollerPx: 216, listPx: 66 }, '380');
    assertJson(splitHeights(900, 76, 110, false), { rowPx: 82, scrollerPx: 492, listPx: 310 }, '900');
    assertJson(splitHeights(560, 76, 54, true), { rowPx: 69, scrollerPx: 418, listPx: 44 }, 'grown');
    assertJson(splitHeights(NaN, 76, 54, false), { rowPx: 0, scrollerPx: 0, listPx: 0 }, 'NaN');
    assertJson(splitHeights(560, 76, 0, false), { rowPx: 0, scrollerPx: 0, listPx: 0 }, 'no cell width');
    assertJson(splitHeights(-5, 76, 54, true), { rowPx: 0, scrollerPx: 0, listPx: 0 }, 'negative');
    assert(HANDLE_PX === 22 && LIST_MIN_PX === 120, 'constants');
  });

  await check('splitHeights, a tablet held upright (owner 2026-11-26): squares wide enough for names grow the rows to a large square\'s height (82), so a six-week month shows names, not dots, while the list keeps a fifth of the region (an iPad mini\'s 770 px region too); phones and the grown month are untouched', () => {
    assert(SQUARE_LARGE_MIN_PX === 82 && squareSize(82, 110).kind === 'large' && squareSize(81, 110).kind === 'medium', 'the large square starts at 82');
    // 900 px region, 110 px cells: 0.6 of it gives rows of 77 (medium: dots); they grow to 82, the list keeps 310
    assertJson(splitHeights(900, 76, 110, false), { rowPx: 82, scrollerPx: 492, listPx: 310 }, '900');
    assert(squareSize(492 / 6, 110).kind === 'large' && squareSize(492 / 5, 110).kind === 'large', 'six- and five-week months draw names');
    // 800: 67 grows to 82, the list keeps 210 (over 160, a fifth)
    assertJson(splitHeights(800, 76, 110, false), { rowPx: 82, scrollerPx: 492, listPx: 210 }, '800');
    // An iPad mini (744 px wide, cells 104): a 770 px region's 64 px rows grow to 82, the list keeps 180 (over 154)
    assertJson(splitHeights(770, 76, (744 - GRID_PAD_PX) / 7, false), { rowPx: 82, scrollerPx: 492, listPx: 180 }, 'iPad mini');
    // 700: the list would keep 110, under 140: the rows stay 57
    assertJson(splitHeights(700, 76, 110, false), { rowPx: 57, scrollerPx: 342, listPx: 260 }, '700');
    // Squares too narrow for names (0.9 of 90 is 81): no growth; a phone's cells (54) neither
    assertJson(splitHeights(900, 76, 90, false), { rowPx: 77, scrollerPx: 462, listPx: 340 }, 'narrow squares');
    assertJson(splitHeights(560, 76, 54, false), { rowPx: 44, scrollerPx: 264, listPx: 198 }, 'phone');
    // Rows already large stay as they were; grown is the grown month's own rule
    assertJson(splitHeights(1100, 76, 110, false), { rowPx: 97, scrollerPx: 582, listPx: 420 }, '1100');
    assertJson(splitHeights(900, 76, 110, true), { rowPx: 126, scrollerPx: 758, listPx: 44 }, 'grown');
  });

  await check('splitHeights: a 320 x 568 phone region keeps rows of at least 36', () => {
    const s = splitHeights(330, 76, 42, false);
    assert(s.rowPx >= 36, `rowPx ${s.rowPx}`);
  });

  // The final review's I2: the upright region runs down to the screen's bottom edge (MONTH_VIEW_CSS: the
  // stable viewport less the header and tabs and the top safe areas; the bottom one is no longer taken
  // off, the list pads its own end by it). These pin today's numbers, not a target.
  const regionPx = (viewport: number, headerAndTabs: number, safeTop: number, contentSafeTop: number) => viewport - headerAndTabs - safeTop - contentSafeTop;
  const cellOf = (screenWidth: number) => (screenWidth - GRID_PAD_PX) / 7;

  await check('I2: the collapsed list on small phones with Hebrew dates (chrome 76), the region h = viewport − 200 px of header and tabs − the top safe areas (0 in Telegram outside fullscreen): a 375×667 iPhone SE (viewport 590) → h 390, rows 36, scroller 216, list 76; a 360×640 Android phone (viewport 560) → h 360, rows 36, scroller 216, list 46', () => {
    assert(monthBarPx(true) === 76, `chrome ${monthBarPx(true)}`);
    const se = regionPx(590, 200, 0, 0);
    assert(se === 390, `iPhone SE region ${se}`);
    assertJson(splitHeights(se, monthBarPx(true), cellOf(375), false), { rowPx: 36, scrollerPx: 216, listPx: 76 }, '375x667');
    const android = regionPx(560, 200, 0, 0);
    assert(android === 360, `Android region ${android}`);
    assertJson(splitHeights(android, monthBarPx(true), cellOf(360), false), { rowPx: 36, scrollerPx: 216, listPx: 46 }, '360x640');
  });

  await check('a short phone held upright (owner 2026-11-26): SHORT_UPRIGHT_QUERY is up to 700 px high in portrait; on the Month tab the header drops to one line (about 56 px and the tab bar\'s 48, against about 200 for both), so the list keeps about 120 px: a 375×667 iPhone SE (viewport 590) → region 486, rows 44, list 124; a 360×640 Android phone (viewport 560) → region 456, rows 39, list 124. These pin today\'s numbers, not a target', () => {
    assert(SHORT_UPRIGHT_QUERY === '(max-height: 700px) and (orientation: portrait)', SHORT_UPRIGHT_QUERY);
    const se = regionPx(590, 56 + 48, 0, 0);
    assertJson(splitHeights(se, monthBarPx(true), cellOf(375), false), { rowPx: 44, scrollerPx: 264, listPx: 124 }, '375x667');
    const android = regionPx(560, 56 + 48, 0, 0);
    assertJson(splitHeights(android, monthBarPx(true), cellOf(360), false), { rowPx: 39, scrollerPx: 234, listPx: 124 }, '360x640');
  });

  await check('I2: grown, the list\'s peek stays PEEK_PX clear of the bottom safe area the region now runs under: a 509 px region with a 34 px home indicator → scroller 333, list 78 (44 + 34); with none 367 and 44; collapsed, the safe area is part of the list (the same heights with or without it); a bad inset counts as 0', () => {
    assertJson(splitHeights(509, 76, cellOf(375), true, 34), { rowPx: 55, scrollerPx: 333, listPx: 78 }, 'grown, 34');
    assertJson(splitHeights(509, 76, cellOf(375), true), { rowPx: 61, scrollerPx: 367, listPx: 44 }, 'grown, none');
    assertJson(splitHeights(509, 76, cellOf(375), false, 34), splitHeights(509, 76, cellOf(375), false), 'collapsed');
    assertJson(splitHeights(509, 76, cellOf(375), true, NaN), splitHeights(509, 76, cellOf(375), true), 'NaN inset');
    assertJson(splitHeights(509, 76, cellOf(375), true, -3), splitHeights(509, 76, cellOf(375), true), 'negative inset');
  });

  await check('squareSize: small, medium and large by the cell, lines by the room', () => {
    assertJson(squareSize(44, 54), { kind: 'small', lines: 0, big: false }, '44x54');
    assertJson(squareSize(70, 54), { kind: 'medium', lines: 0, big: false }, '70x54');
    assertJson(squareSize(82, 30), { kind: 'small', lines: 0, big: false }, '82x30');
    assertJson(squareSize(92, 54), { kind: 'large', lines: 3, big: false }, '92x54');
    assertJson(squareSize(82, 54), { kind: 'large', lines: 2, big: false }, '82x54');
    assertJson(squareSize(100, 110), { kind: 'large', lines: 2, big: true }, '100x110');
    assertJson(squareSize(300, 120), { kind: 'large', lines: 7, big: true }, '300x120');
    assertJson(squareSize(NaN, 54), { kind: 'small', lines: 0, big: false }, 'NaN');
  });

  await check('monthAtScroll: the month under the middle of the pane, clamped', () => {
    assert(monthAtScroll(0, 400, 31) === 0, '0');
    assert(monthAtScroll(199, 400, 31) === 0, '199');
    assert(monthAtScroll(200, 400, 31) === 1, '200');
    assert(monthAtScroll(12000, 400, 31) === 30, '12000');
    assert(monthAtScroll(50, 0, 31) === 0, 'no pane');
    assert(monthAtScroll(50, 400, 0) === 0, 'no months');
  });

  await check('the queries', () => {
    assert(WIDE_QUERY === '(min-width: 600px) and (orientation: landscape)', WIDE_QUERY);
    assert(SHORT_QUERY === '(max-height: 520px) and (orientation: landscape)', SHORT_QUERY);
  });

  await check('focus helpers', () => {
    const f = initialFocus(TODAY);
    assertJson(f, { month: '2026-10', selected: '2026-10-15' }, 'initial');
    assert(f !== null, 'initial null');
    assert(initialFocus('x') === null, 'bad today');
    const s = selectDay(f, '2026-09-30');
    assertJson(s, { month: '2026-10', selected: '2026-09-30' }, 'selectDay keeps the month');
    assert(selectDay(s, '2026-09-30') === s, 'same object for the same day');
    assertJson(focusJump(f, '2027-03-04'), { month: '2027-03', selected: '2027-03-04' }, 'jump');
    assertJson(focusMonth(s, '2026-12'), { month: '2026-12', selected: '2026-09-30' }, 'focusMonth keeps the selection');
    assertJson(focusToday(focusJump(f, '2027-03-04'), TODAY), f, 'today');
    assert(!canStepMonth('2100-12', 1, TODAY) && !canStepMonth('1900-01', -1, TODAY), 'the ends');
    assert(canStepMonth('2100-12', -1, TODAY) && canStepMonth('1900-01', 1, TODAY) && canStepMonth('2026-10', 1, TODAY), 'inside');
    assertJson(clampFocus({ month: 'x', selected: '1800-01-01' }, TODAY), { month: '2026-10', selected: '2026-10-15' }, 'clamp malformed');
    assertJson(clampFocus({ month: '2300-01', selected: '2026-10-01' }, TODAY), { month: '2100-12', selected: '2026-10-01' }, 'clamp past the end');
    assertJson(clampFocus({ month: '1800-01', selected: '2026-10-01' }, TODAY), { month: '1900-01', selected: '2026-10-01' }, 'clamp before the start');
    const ok: MonthFocus = { month: '2026-10', selected: '2026-10-01' };
    assert(clampFocus(ok, TODAY) === ok, 'same object when unchanged');
  });

  await check('wantedFocusMonths: the anchor, the selected day\'s month, then the pool nearest first', () => {
    const f: MonthFocus = { month: '2026-10', selected: '2026-08-15' };
    assertJson(
      wantedFocusMonths(f, [], '2026-10', TODAY).map((w) => w.from.slice(0, 7)),
      ['2026-10', '2026-08', '2026-11', '2026-09'],
      'in view',
    );
    assertJson(
      wantedFocusMonths(f, [], null, TODAY).map((w) => w.from.slice(0, 7)),
      ['2026-10', '2026-08', '2026-11', '2026-09'],
      'no view: the focus month',
    );
    assertJson(
      wantedFocusMonths(f, [], '2026-12', TODAY).map((w) => w.from.slice(0, 7)),
      ['2026-12', '2026-08', '2027-01', '2026-11'],
      'view elsewhere',
    );
    assertJson(wantedFocusMonths({ month: '2100-12', selected: '2100-12-01' }, [], null, TODAY).map((w) => w.from.slice(0, 7)), ['2100-12', '2100-11'], 'inside the reach');
  });

  await check('fitSlots: lines are the total drawn, "+N" included', () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => slot('i' + i));
    let r = fitSlots(items(4), 3);
    assert(r.shown.length === 2 && r.more === 2, `4/3: ${r.shown.length} ${r.more}`);
    r = fitSlots(items(3), 3);
    assert(r.shown.length === 3 && r.more === 0, `3/3: ${r.shown.length} ${r.more}`);
    r = fitSlots(items(2), 1);
    assert(r.shown.length === 0 && r.more === 2, `2/1: ${r.shown.length} ${r.more}`);
    r = fitSlots(items(9), 7);
    assert(r.shown.length === 6 && r.more === 3, `9/7: ${r.shown.length} ${r.more}`);
    r = fitSlots(items(9), 99);
    assert(r.shown.length === 6 && r.more === 3, 'limit clamps to 7');
    r = fitSlots(items(2), 0);
    assert(r.shown.length === 0 && r.more === 2, 'limit clamps to 1');
    // A bar in lane 2 (spacers above) that moves up shows its title.
    const bar = slot('bar', 'bar', { showTitle: false });
    r = fitSlots([slot('s', 'spacer'), slot('s2', 'spacer'), bar, slot('a')], 2);
    const moved = r.shown.find((s) => s.key === 'bar');
    assert(moved !== undefined && moved.showTitle === true, 'the moved bar shows its title');
  });

  await check('fitRow: a bar the day before did not draw in the same slot gets its title', () => {
    const bar = slot('bar', 'bar', { showTitle: false });
    const row = [cell('2026-10-05', [slot('a'), slot('b'), slot('c'), slot('d')]), cell('2026-10-06', [bar]), cell('2026-10-07', [], false)];
    const out = fitRow(row, 3);
    assert(out[0].more === 2 && out[0].shown.length === 2, 'first day +2');
    assert(out[1].shown[0].showTitle === true, 'the bar is re-titled');
    assertJson(out[2], { shown: [], more: 0 }, 'a blank cell');
    const same = fitRow([cell('2026-10-05', [bar]), cell('2026-10-06', [bar])], 3);
    assert(same[1].shown[0].showTitle === false, 'a bar drawn the day before in the same slot keeps no title');
  });

  await check('month-layout.ts and month.ts are client-safe: no React, Prisma or @hebcal/core', () => {
    const view = path.resolve(__dirname, '..', 'src', 'lib', 'calendar-view');
    for (const file of ['month-layout.ts', 'month.ts']) {
      const root = path.join(view, file);
      const loaded = new Set<string>();
      const walk = (id: string) => {
        for (const child of require.cache[id]?.children ?? []) {
          if (loaded.has(child.id)) continue;
          loaded.add(child.id);
          walk(child.id);
        }
      };
      assert(require.cache[root] !== undefined, `${root} is not in require.cache: the check would be empty`);
      walk(root);
      const bad = [...loaded].filter((p) => /[\\/]node_modules[\\/](react|react-dom|@prisma|\.prisma|@hebcal[\\/]core)[\\/]/.test(p));
      assertJson(bad, [], `${file}: forbidden modules`);
      const code = fs.readFileSync(root, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert(!/from 'react'|@prisma|@hebcal\/core|\bwindow\./.test(code), `${file} imports or reads something it should not`);
    }
  });

  await check('useMediaQuery: false on the server; follows a matchMedia list; unsubscribes on unmount', () => {
    assert(renderToString(createElement(Probe, { query: '(x)' })) === '<span>no</span>', 'server render');
    const saved = fakeWindow.matchMedia;
    try {
      installWindow();
      const listeners = new Set<() => void>();
      let matches = true;
      const asked: string[] = [];
      fakeWindow.matchMedia = (q: string) => {
        asked.push(q);
        return {
          get matches() {
            return matches;
          },
          addEventListener: (_t: string, fn: () => void) => void listeners.add(fn),
          removeEventListener: (_t: string, fn: () => void) => void listeners.delete(fn),
        };
      };
      const m = mount(createElement(Probe, { query: '(wide)' }));
      const text = () => String(m.container.textContent);
      const subs = () => Number(listeners.size);
      assert(text() === 'yes', `mounted: ${text()}`);
      assert(subs() === 1 && asked.every((q) => q === '(wide)'), `subscribed: ${subs()}`);
      matches = false;
      m.render(createElement(Probe, { query: '(wide)' }));
      for (const fn of [...listeners]) fn();
      assert(text() === 'no', `after change: ${text()}`);
      m.unmount();
      assert(subs() === 0, 'unsubscribed');
    } finally {
      fakeWindow.matchMedia = saved;
    }
  });

  await check('useMediaQuery: the older addListener pair, no matchMedia, and a throwing matchMedia (logged once) read false or work', () => {
    const saved = fakeWindow.matchMedia;
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (...a: unknown[]) => void warned.push(String(a[0]));
    try {
      installWindow();
      fakeWindow.matchMedia = undefined;
      let m = mount(createElement(Probe, { query: '(none)' }));
      assert(m.container.textContent === 'no', 'no matchMedia');
      m.unmount();
      const old = new Set<() => void>();
      fakeWindow.matchMedia = () => ({ matches: true, addListener: (fn: () => void) => void old.add(fn), removeListener: (fn: () => void) => void old.delete(fn) });
      m = mount(createElement(Probe, { query: '(old)' }));
      assert(m.container.textContent === 'yes' && Number(old.size) === 1, 'addListener');
      m.unmount();
      assert(old.size === 0, 'removeListener');
      fakeWindow.matchMedia = () => {
        throw new Error('boom');
      };
      m = mount(createElement(Probe, { query: '(throws)' }));
      assert(m.container.textContent === 'no', 'a throwing matchMedia');
      m.unmount();
      assert(warned.length >= 1 && warned.every((w) => w === '[media] matchMedia failed:'), `warned: ${JSON.stringify(warned)}`);
    } finally {
      console.warn = warn;
      fakeWindow.matchMedia = saved;
    }
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

function Probe({ query }: { query: string }) {
  return createElement('span', null, useMediaQuery(query) ? 'yes' : 'no');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

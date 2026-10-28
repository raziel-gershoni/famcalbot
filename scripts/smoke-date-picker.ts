// Smoke test for the date and time pickers' logic (editor upgrades spec §1):
// src/lib/calendar-view/picker-model.ts, the year floor (year-limits.ts) on the client
// (editor-model.ts checkForm) and on the server (validate.ts parseCreate), and the three
// languages' labels.
//
// It checks:
//  - Hebrew paging: a leap year runs Shvat, Adar I, Adar II, Nisan; a common year Shvat, Adar,
//    Nisan; 13 and 12 pages from Tishrei to Elul; Adar I has 30 days, Adar II 29; stepping
//    forward and back meet;
//  - six rows: every Gregorian and Hebrew page from 1900 to 2100, on every week start, has 6 rows
//    of 7, holds exactly its own days in order and blank elsewhere;
//  - the limits: the year floor, an end that may not precede its start, greyed days, the
//    chevrons at a limit, a page past a limit pulled back;
//  - the jump wheels: the Hebrew month list by year, Adar I or II moved to a common year landing
//    on Adar, Adar in a leap year landing on Adar II, the years 5660 to 5861, a page held to the limits;
//  - the time wheels: the editor's 5-minute list, Settings' 15-minute list, an off-step minute
//    joining the list once and in order;
//  - labels in he, en and ru: the cells, the accessible names, the titles, the footer;
//  - keyboard moves: days, weeks, months (Hebrew day kept), the week's ends;
//  - the floor: 1950 yearly accepted, 1950 daily refused, on the form and on the server's parser;
//  - the module is client-safe: no React, no @hebcal/core, no server module.
//
// Pure: no database, Redis, network or AI. Run it under two clocks:
//   TZ=UTC npx tsx scripts/smoke-date-picker.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-date-picker.ts

import fs from 'fs';
import path from 'path';
import {
  PAGE_ROWS,
  PICKER_MAX_DAY,
  PICKER_MIN_DAY,
  canStep,
  cellText,
  clampDay,
  clampPage,
  dayAriaLabel,
  footerText,
  hebrewMonthIn,
  hebrewMonthsOfYear,
  hourOptions,
  isDisabledDay,
  joinTime,
  limitsFor,
  minuteOptions,
  moveDay,
  pageCells,
  pageOf,
  pageOfWheels,
  pageTitle,
  selectionOf,
  splitTime,
  stepPage,
  wheelMonths,
  wheelYears,
  yearLabel,
  type PickerMode,
  type PickerPage,
} from '../src/lib/calendar-view/picker-model';
import { hebrewDateOf } from '../src/lib/calendar-view/hebrew-date';
import { MIN_YEAR_BIRTH, MIN_YEAR_SERIES, minYearFor } from '../src/lib/calendar-view/year-limits';
import { checkForm, isRealDay, type EditorForm } from '../src/lib/calendar-view/editor-model';
import type { RepeatSpec } from '../src/lib/calendar-view/editor-types';
import { parseCreate } from '../src/services/calendar-write/validate';
import { addDaysToKey } from '../src/lib/calendar-view/store';
import { formatPillDate } from '../src/lib/calendar-view/format';
import { REMINDER_TIME_STEP_MINUTES } from '../src/lib/reminder-time';
import en from '../messages/en.json';
import he from '../messages/he.json';
import ru from '../messages/ru.json';

const ROOT = path.resolve(__dirname, '..');

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

const show = (value: unknown) => JSON.stringify(value);
function assertEqual(got: unknown, want: unknown, label: string) {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

const pageAt = (mode: PickerMode, day: string): PickerPage => {
  const page = pageOf(mode, day);
  assert(page !== null, `no page for ${day}`);
  return page;
};

/** The Hebrew months (name, days) a run of `n` pages visits from the page holding `day`. */
function hebrewRun(day: string, n: number): [string, number][] {
  let page = pageAt('hebrew', day);
  const out: [string, number][] = [];
  for (let i = 0; i < n; i++) {
    const hd = hebrewDateOf(page.first);
    assert(hd !== null, 'no Hebrew date');
    out.push([hd.getMonthName(), hd.daysInMonth()]);
    page = stepPage(page, 1);
  }
  return out;
}

const WIDE = limitsFor(MIN_YEAR_BIRTH);

async function main() {
  await check('Hebrew paging over a leap year: Tishrei to Elul is 13 pages and Shvat, Adar I, Adar II, Nisan run in that order (5787); Adar I has 30 days, Adar II 29', () => {
    // 5787 is a leap year: 1 Tishrei 5787 is 12 September 2026.
    const run = hebrewRun('2026-09-12', 13);
    assertEqual(
      run.map(([name]) => name),
      ['Tishrei', 'Cheshvan', 'Kislev', 'Tevet', "Sh'vat", 'Adar I', 'Adar II', 'Nisan', 'Iyyar', 'Sivan', 'Tamuz', 'Av', 'Elul'],
      'a leap year',
    );
    assertEqual(Object.fromEntries(run.filter(([name]) => name.startsWith('Adar'))), { 'Adar I': 30, 'Adar II': 29 }, 'the Adars');
    const next = stepPage(pageAt('hebrew', '2027-09-20'), 1); // after Elul 5787
    assertEqual(hebrewDateOf(next.first)?.getMonthName(), 'Tishrei', 'the page after Elul');
    assertEqual(hebrewDateOf(next.first)?.getFullYear(), 5788, 'is the next year');
  });

  await check('Hebrew paging over a common year: Shvat, Adar, Nisan, 12 pages (5788); stepping back from Nisan meets Adar then Shvat', () => {
    const run = hebrewRun('2027-10-02', 12); // 1 Tishrei 5788
    assertEqual(
      run.map(([name]) => name),
      ['Tishrei', 'Cheshvan', 'Kislev', 'Tevet', "Sh'vat", 'Adar', 'Nisan', 'Iyyar', 'Sivan', 'Tamuz', 'Av', 'Elul'],
      'a common year',
    );
    assertEqual(run.find(([name]) => name === 'Adar')?.[1], 29, 'Adar has 29 days (5788)');
    let page = pageAt('hebrew', '2028-04-01'); // Nisan 5788
    const back: string[] = [];
    for (let i = 0; i < 3; i++) {
      back.push(hebrewDateOf(page.first)?.getMonthName() ?? '');
      page = stepPage(page, -1);
    }
    assertEqual(back, ['Nisan', 'Adar', "Sh'vat"], 'back from Nisan');
  });

  await check('30 Adar I: the leap year\'s Adar I page ends on 30 Adar I, one day before 1 Adar II, and the pages meet in both directions', () => {
    const adarI = pageAt('hebrew', '2027-02-20');
    assertEqual([adarI.first, adarI.last], ['2027-02-08', '2027-03-09'], 'Adar I 5787');
    assertEqual(hebrewDateOf(adarI.last)?.getDate(), 30, 'the last day is the 30th');
    const adarII = stepPage(adarI, 1);
    assertEqual([adarII.first, adarII.last], ['2027-03-10', '2027-04-07'], 'Adar II 5787');
    assertEqual(stepPage(adarII, -1), adarI, 'back from Adar II');
    // 30 Adar I is the cell the 6th row of the Sunday-start page holds or not: it is in the page.
    const cells = pageCells(adarI, 0).flat().filter((d): d is string => d !== null);
    assertEqual([cells.length, cells[cells.length - 1]], [30, '2027-03-09'], 'all 30 days');
  });

  await check('Gregorian paging: steps over a year end both ways, a month\'s own days, 28 and 29 in February', () => {
    const dec = pageAt('gregorian', '2026-12-15');
    assertEqual([dec.first, dec.last], ['2026-12-01', '2026-12-31'], 'December');
    assertEqual(stepPage(dec, 1).first, '2027-01-01', 'January');
    assertEqual(stepPage(stepPage(dec, 1), -1), dec, 'and back');
    assertEqual(stepPage(dec, -12).first, '2025-12-01', 'twelve back');
    assertEqual(pageAt('gregorian', '2028-02-10').last, '2028-02-29', 'a leap February');
    assertEqual(pageAt('gregorian', '2027-02-10').last, '2027-02-28', 'a common February');
    assertEqual(pageOf('gregorian', '2026-02-30'), null, 'a day that does not exist');
    assertEqual(pageOf('hebrew', ''), null, 'no day');
  });

  await check('six rows: every page from 1900 to 2100, Gregorian and Hebrew, on every week start, is 6 rows of 7 holding exactly its own days in order, blank elsewhere', () => {
    for (const mode of ['gregorian', 'hebrew'] as const) {
      let page = pageAt(mode, PICKER_MIN_DAY);
      let pages = 0;
      while (page.first <= PICKER_MAX_DAY) {
        const days: string[] = [];
        for (let d = page.first; d <= page.last; d = addDaysToKey(d, 1)) days.push(d);
        assert(days.length >= 28 && days.length <= 31, `${mode} ${page.first}: ${days.length} days`);
        for (const ws of [0, 1, 2, 3, 4, 5, 6] as const) {
          const rows = pageCells(page, ws);
          assert(rows.length === PAGE_ROWS && rows.every((r) => r.length === 7), `${mode} ${page.first} ws ${ws}: shape`);
          const flat = rows.flat();
          assert(show(flat.filter((d) => d !== null)) === show(days), `${mode} ${page.first} ws ${ws}: the days`);
          const firstAt = flat.indexOf(page.first);
          const weekday = new Date(`${page.first}T12:00:00Z`).getUTCDay();
          assert(firstAt === (weekday - ws + 7) % 7, `${mode} ${page.first} ws ${ws}: first column ${firstAt}`);
        }
        page = stepPage(page, 1);
        pages++;
      }
      assert(pages > (mode === 'gregorian' ? 2400 : 2480), `${mode}: ${pages} pages`);
    }
    // A malformed week start reads Sunday, as the Month does.
    assertEqual(pageCells(pageAt('gregorian', '2026-10-15'), 9 as never)[0].indexOf('2026-10-01'), 4, 'Sunday start on a bad week start');
  });

  await check('limits: the floor by repeat, an end not before its start, greyed days, the chevrons at a limit, a page past a limit pulled back', () => {
    assertEqual([minYearFor('none'), minYearFor('yearly'), minYearFor('hebrew'), minYearFor(undefined)], [1900, 1900, 1900, 1900], 'one-off and yearly');
    assertEqual([minYearFor('daily'), minYearFor('weekly'), minYearFor('monthly'), minYearFor('custom')], [2000, 2000, 2000, 2000], 'other repeats');
    assertEqual(limitsFor(1900), { min: '1900-01-01', max: '2100-12-31' }, 'the widest');
    assertEqual(limitsFor(2000), { min: '2000-01-01', max: '2100-12-31' }, 'a series');
    const end = limitsFor(1900, '2027-03-14');
    assertEqual(end.min, '2027-03-14', 'an end not before its start');
    assertEqual(limitsFor(2000, '1999-01-01').min, '2000-01-01', 'a start before the floor does not lower it');
    assertEqual(limitsFor(1900, 'garbage').min, '1900-01-01', 'a start that is no day is ignored');
    assertEqual(limitsFor(1900, '2200-01-01').min, '2100-12-31', 'a start past 2100 holds at the last day');
    assert(isDisabledDay('2027-03-13', end) && !isDisabledDay('2027-03-14', end) && isDisabledDay('2101-01-01', end), 'greyed days');
    assertEqual([clampDay('2020-01-01', end), clampDay('2150-01-01', end), clampDay('2027-05-05', end)], ['2027-03-14', '2100-12-31', '2027-05-05'], 'clampDay');
    for (const mode of ['gregorian', 'hebrew'] as const) {
      const first = pageAt(mode, PICKER_MIN_DAY);
      const last = pageAt(mode, PICKER_MAX_DAY);
      assert(!canStep(first, -1, WIDE) && canStep(first, 1, WIDE), `${mode}: the first page`);
      assert(canStep(last, -1, WIDE) && !canStep(last, 1, WIDE), `${mode}: the last page`);
      const atEnd = pageAt(mode, '2027-03-14');
      const pastStart = stepPage(atEnd, -1);
      assert(canStep(pastStart, 1, end) && !canStep(atEnd, -1, end), `${mode}: no page wholly before the start`);
      assertEqual(clampPage(pastStart, end).first, atEnd.first, `${mode}: a page past the start pulled back`);
      assertEqual(clampPage(pageAt(mode, '2100-12-31'), WIDE), pageAt(mode, '2100-12-31'), `${mode}: a page inside stays`);
    }
    assertEqual(clampPage(stepPage(pageAt('gregorian', '2100-12-31'), 1), WIDE).last, '2100-12-31', 'a page past 2100 pulled back');
  });

  await check('jump wheels: the Hebrew month list by year, Adar I or II moved to a common year lands on Adar, Adar to a leap year on Adar II, years 5660 to 5861, the page held to the limits', () => {
    assertEqual(hebrewMonthsOfYear(5787).filter((m) => m.startsWith('Adar')), ['Adar I', 'Adar II'], 'leap year');
    assertEqual(hebrewMonthsOfYear(5788).filter((m) => m.startsWith('Adar')), ['Adar'], 'common year');
    assertEqual([hebrewMonthsOfYear(5787).length, hebrewMonthsOfYear(5788).length], [13, 12], 'month counts');
    assertEqual(hebrewMonthsOfYear(5787)[0], 'Tishrei', 'the list starts at Tishrei');
    assertEqual([hebrewMonthIn('Adar I', 5788), hebrewMonthIn('Adar II', 5788), hebrewMonthIn('Adar', 5787), hebrewMonthIn('Adar II', 5787), hebrewMonthIn('Nisan', 5788)], ['Adar', 'Adar', 'Adar II', 'Adar II', 'Nisan'], 'normalised');
    const fromAdarII = pageOfWheels('hebrew', { month: 'Adar II', year: 5788 }, WIDE);
    assertEqual(hebrewDateOf(fromAdarII.first)?.getMonthName(), 'Adar', 'Adar II into a common year');
    assertEqual(hebrewDateOf(fromAdarII.first)?.getFullYear(), 5788, 'keeps the year');
    const fromAdarI = pageOfWheels('hebrew', { month: 'Adar I', year: 5786 }, WIDE);
    assertEqual(hebrewDateOf(fromAdarI.first)?.getMonthName(), 'Adar', 'Adar I into a common year');
    assertEqual(hebrewDateOf(pageOfWheels('hebrew', { month: 'Adar', year: 5787 }, WIDE).first)?.getMonthName(), 'Adar II', 'Adar into a leap year');
    assertEqual(selectionOf(pageAt('hebrew', '2027-03-14')), { month: 'Adar II', year: 5787 }, 'the selection of a page');
    assertEqual(selectionOf(pageAt('gregorian', '2027-03-14')), { month: '03', year: 2027 }, 'and a Gregorian one');
    const hebrewYears = wheelYears('hebrew', WIDE);
    assertEqual([hebrewYears[0], hebrewYears[hebrewYears.length - 1], hebrewYears.length], [5660, 5861, 202], 'Hebrew years');
    const years = wheelYears('gregorian', WIDE);
    assertEqual([years[0], years[years.length - 1], years.length], [1900, 2100, 201], 'Gregorian years');
    assertEqual(wheelYears('gregorian', limitsFor(2000))[0], 2000, 'a series starts at 2000');
    assertEqual(wheelYears('hebrew', limitsFor(2000))[0], 5760, 'and 5760');
    const early = pageOfWheels('gregorian', { month: '03', year: 1950 }, limitsFor(2000));
    assertEqual(early.first, '2000-01-01', 'a month below the floor lands on the floor');
    assertEqual(pageOfWheels('gregorian', { month: '03', year: 2027 }, WIDE).first, '2027-03-01', 'a plain jump');
    assertEqual(pageOfWheels('hebrew', { month: 'Tishrei', year: 5660 }, WIDE).last >= PICKER_MIN_DAY, true, 'the first Hebrew year reaches 1900');
    const months = wheelMonths('gregorian', 2027, 'en');
    assertEqual([months.length, months[0], months[11]], [12, { value: '01', label: 'January' }, { value: '12', label: 'December' }], 'Gregorian months');
    assertEqual(wheelMonths('hebrew', 5787, 'en').map((m) => m.label).slice(4, 8), ["Sh'vat", 'Adar I', 'Adar II', 'Nisan'], 'Hebrew months, leap');
    assertEqual(wheelMonths('hebrew', 5788, 'he').map((m) => m.label).slice(4, 7), ['שבט', 'אדר', 'ניסן'], 'Hebrew months in Hebrew, common');
    assertEqual([yearLabel('hebrew', 5787, 'he'), yearLabel('hebrew', 5787, 'en'), yearLabel('gregorian', 2027, 'he')], ['תשפ״ז', '5787', '2027'], 'year labels');
  });

  await check('time wheels: 24 hours, 5-minute steps in the editor, 15 in Settings, an off-step minute joins the list once and in order, open and close change nothing', () => {
    assertEqual([hourOptions().length, hourOptions()[0], hourOptions()[23]], [24, '00', '23'], 'hours');
    const five = minuteOptions(5);
    assertEqual([five.length, five[0], five[1], five[11]], [12, '00', '05', '55'], 'five-minute steps');
    const fifteen = minuteOptions(REMINDER_TIME_STEP_MINUTES);
    assertEqual(fifteen, ['00', '15', '30', '45'], "Settings' 15-minute list");
    assertEqual(minuteOptions(5, '07'), ['00', '05', '07', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'], 'an off-step 07 joins in place');
    assertEqual(minuteOptions(15, '50'), ['00', '15', '30', '45', '50'], 'in Settings too');
    assertEqual(minuteOptions(5, '05'), five, 'an on-step minute adds nothing');
    assertEqual(minuteOptions(5, '59')[minuteOptions(5, '59').length - 1], '59', 'the last minute');
    assertEqual([minuteOptions(5, ''), minuteOptions(5, null), minuteOptions(5, 'xx'), minuteOptions(5, '75')].every((l) => l.length === 12), true, 'a bad minute adds nothing');
    assertEqual(minuteOptions(0).length, 12, 'a bad step reads 5');
    for (const time of ['10:07', '00:00', '23:59', '09:30']) {
      const parts = splitTime(time);
      assert(parts !== null, `split ${time}`);
      assert(minuteOptions(5, parts.minute).includes(parts.minute) && hourOptions().includes(parts.hour), `${time} is on the wheels`);
      assertEqual(joinTime(parts.hour, parts.minute), time, `${time} round trip`);
    }
    assertEqual([splitTime('24:00'), splitTime('9:30'), splitTime(''), splitTime('10:60')], [null, null, null, null], 'not times');
  });

  await check('labels in he, en and ru: cells, accessible names, titles and the footer (14 March 2027 is 5 Adar II 5787)', () => {
    const genitive: Record<string, readonly string[]> = {
      en: en.calendarHome.hebrewMonthGenitive,
      he: he.calendarHome.hebrewMonthGenitive,
      ru: ru.calendarHome.hebrewMonthGenitive,
    };
    const short: Record<string, readonly string[]> = {
      en: en.calendarHome.hebrewMonthShort,
      he: he.calendarHome.hebrewMonthShort,
      ru: ru.calendarHome.hebrewMonthShort,
    };
    // Gregorian leads: the day number over the Hebrew day, the month on Hebrew day 1.
    assertEqual(cellText('2027-03-14', 'gregorian', 'en', true, short.en), { primary: '14', secondary: '5' }, 'en cell');
    assertEqual(cellText('2027-03-14', 'gregorian', 'he', true, short.he), { primary: '14', secondary: 'ה׳' }, 'he cell');
    assertEqual(cellText('2027-03-10', 'gregorian', 'en', true, short.en).secondary, '1 Adar II', 'en: the month on Hebrew day 1');
    assertEqual(cellText('2027-03-10', 'gregorian', 'he', true, short.he).secondary, 'א׳ אדר ב׳', 'he: the month on Hebrew day 1');
    assert(cellText('2027-03-10', 'gregorian', 'ru', true, short.ru).secondary.startsWith('1 '), 'ru: the month on Hebrew day 1');
    assertEqual(cellText('2027-03-14', 'gregorian', 'en', false).secondary, '', 'no Hebrew line without Hebrew dates');
    // Hebrew leads: the Hebrew day over the Gregorian day, the month on the 1st.
    assertEqual(cellText('2027-03-14', 'hebrew', 'en', true), { primary: '5', secondary: '14' }, 'en Hebrew mode');
    assertEqual(cellText('2027-03-14', 'hebrew', 'he', true), { primary: 'ה׳', secondary: '14' }, 'he Hebrew mode');
    assertEqual(cellText('2027-04-01', 'hebrew', 'en', true), { primary: '23', secondary: '1 Apr' }, 'the Gregorian month on the 1st');
    assertEqual(dayAriaLabel('2027-03-14', 'en', true, genitive.en), 'Sunday, 14 March 2027, 5 Adar II', 'en aria');
    assertEqual(dayAriaLabel('2027-03-14', 'he', true, genitive.he), 'יום ראשון, 14 במרץ 2027, ה׳ באדר ב׳', 'he aria');
    assertEqual(dayAriaLabel('2027-03-14', 'ru', true, genitive.ru), 'воскресенье, 14 марта 2027 г., 5 адара II', 'ru aria');
    assertEqual(dayAriaLabel('2027-03-14', 'en', false), 'Sunday, 14 March 2027', 'no Hebrew part without Hebrew dates');
    assertEqual(footerText('2027-03-14', 'en', true, genitive.en), 'Sunday, 14 March 2027 · 5 Adar II 5787', 'en footer');
    assertEqual(footerText('2027-03-14', 'he', true, genitive.he), 'יום ראשון, 14 במרץ 2027 · ה׳ באדר ב׳ תשפ״ז', 'he footer');
    assertEqual(footerText('2027-03-14', 'en', false), 'Sunday, 14 March 2027', 'one calendar');
    assertEqual(pageTitle(pageAt('gregorian', '2027-03-14'), 'en', true), { title: 'March 2027', subtitle: 'Adar I – Adar II 5787' }, 'en Gregorian title');
    assertEqual(pageTitle(pageAt('hebrew', '2027-03-14'), 'en', true), { title: 'Adar II 5787', subtitle: 'Mar – Apr 2027' }, 'en Hebrew title');
    assertEqual(pageTitle(pageAt('hebrew', '2027-03-14'), 'he', true).title, 'אדר ב׳ תשפ״ז', 'he Hebrew title');
    assertEqual(pageTitle(pageAt('gregorian', '2027-03-14'), 'en', false).subtitle, '', 'no second line without Hebrew dates');
    assertEqual(pageTitle(pageAt('gregorian', '2027-03-14'), 'ru', true).title, 'Март 2027', 'ru title');
    assertEqual(formatPillDate('2027-03-14', 'en'), 'Sun, 14 Mar 2027', 'the pill, en');
    assertEqual(formatPillDate('2027-03-14', 'ru'), 'вс, 14 мар. 2027', 'the pill, ru');
    assertEqual(formatPillDate('2027-03-14', 'he'), 'ראשון 14 במרץ 2027', 'the pill, he');
  });

  await check('keyboard: arrows by day and week, PageUp and PageDown by month (the Hebrew day kept, the last day when the month is shorter), Home and End to the week\'s ends on the page, held inside the limits', () => {
    const greg = pageAt('gregorian', '2027-03-14');
    const go = (day: string, move: Parameters<typeof moveDay>[1], page = greg, limits = WIDE) => moveDay(day, move, page, 0, limits);
    assertEqual([go('2027-03-14', 'nextDay'), go('2027-03-14', 'prevDay'), go('2027-03-14', 'nextWeek'), go('2027-03-14', 'prevWeek')], ['2027-03-15', '2027-03-13', '2027-03-21', '2027-03-07'], 'days and weeks');
    assertEqual(go('2027-03-31', 'nextDay'), '2027-04-01', 'a day across the page');
    assertEqual([go('2027-03-31', 'nextMonth'), go('2027-01-31', 'nextMonth', pageAt('gregorian', '2027-01-31')), go('2027-03-14', 'prevMonth')], ['2027-04-30', '2027-02-28', '2027-02-14'], 'months keep the day number');
    assertEqual([go('2027-03-14', 'weekStart'), go('2027-03-14', 'weekEnd')], ['2027-03-14', '2027-03-20'], 'Sunday week');
    assertEqual([moveDay('2027-03-14', 'weekStart', greg, 1, WIDE), moveDay('2027-03-14', 'weekEnd', greg, 1, WIDE)], ['2027-03-08', '2027-03-14'], 'Monday week');
    assertEqual([go('2027-03-02', 'weekStart'), go('2027-03-30', 'weekEnd')], ['2027-03-01', '2027-03-31'], 'the ends stay on the page');
    const hebrew = pageAt('hebrew', '2027-03-09'); // 30 Adar I
    assertEqual(go('2027-03-09', 'nextMonth', hebrew), '2027-04-07', '30 Adar I into Adar II (29 days) lands on its last day');
    assertEqual(go('2027-03-14', 'nextMonth', pageAt('hebrew', '2027-03-14')), '2027-04-12', '5 Adar II into 5 Nisan');
    assertEqual(go('2027-03-14', 'prevMonth', pageAt('hebrew', '2027-03-14')), '2027-02-12', '5 Adar II back to 5 Adar I');
    const end = limitsFor(1900, '2027-03-14');
    assertEqual(go('2027-03-14', 'prevMonth', greg, end), '2027-03-01', 'held at the first page of the limit, the start of its month');
    assertEqual(moveDay('2100-12-31', 'nextDay', pageAt('gregorian', '2100-12-31'), 0, WIDE), '2100-12-31', 'and at 2100');
    assertEqual(moveDay('1900-01-01', 'prevDay', pageAt('gregorian', '1900-01-01'), 0, WIDE), '1900-01-01', 'and at 1900');
  });

  await check('the floor on the form and on the server: 1950 yearly (Gregorian or Hebrew) and a one-off accepted, 1950 daily, weekly and monthly refused, 1899 refused for all', () => {
    const form = (over: Partial<EditorForm>): EditorForm => ({
      kind: 'event',
      title: 'Birthday',
      location: '',
      notes: '',
      allDay: false,
      startDay: '1950-03-02',
      startTime: '10:00',
      endDay: '1950-03-02',
      endTime: '11:00',
      repeat: 'none',
      calendarId: null,
      forWho: 'me',
      eachMarksDone: false,
      alert: 'default',
      timeMode: 'time',
      zmanPick: '',
      zmanHours: 3,
      zmanMinutes: 0,
      zmanBefore: true,
      ...over,
    });
    // The form's repeat is a spec, or 'none' / 'custom' (repeat-model.ts).
    const rf = (r: 'none' | 'custom' | RepeatSpec['freq']) => (r === 'none' || r === 'custom' ? r : ({ freq: r, interval: 1 } as RepeatSpec));
    for (const repeat of ['none', 'yearly', 'hebrew'] as const) {
      assertEqual(checkForm(form({ repeat: rf(repeat) })), {}, `form: 1950 ${repeat} is fine`);
    }
    for (const repeat of ['daily', 'weekly', 'monthly', 'custom'] as const) {
      assertEqual(checkForm(form({ repeat: rf(repeat) })), { start: 'errYear' }, `form: 1950 ${repeat} gets the year error on the date`);
    }
    assertEqual(checkForm(form({ startDay: '2000-01-01', endDay: '1950-01-01', repeat: rf('daily') })).end, 'errYear', 'an end before the floor on a series');
    assertEqual(checkForm(form({ startDay: '1899-12-31', endDay: '1899-12-31' })).start, 'errDate', '1899 is no date at all');
    assertEqual(checkForm(form({ startDay: '2101-01-01', endDay: '2101-01-01' })).start, 'errDate', 'nor 2101');
    assertEqual(checkForm(form({ allDay: true, repeat: rf('yearly'), endDay: '1950-03-03' })), {}, 'all day, yearly');
    assert(isRealDay('1950-03-02', MIN_YEAR_BIRTH) && !isRealDay('1950-03-02') && !isRealDay('1950-03-02', MIN_YEAR_SERIES), 'isRealDay takes the floor, 2000 by default');
    const body = (repeat: string, start = '1950-03-02T10:00', end = '1950-03-02T11:00') => ({ kind: 'event', title: 'Birthday', allDay: false, start, end, repeat });
    for (const repeat of ['none', 'yearly', 'hebrew']) {
      const parsed = parseCreate(body(repeat));
      assert(parsed.ok, `server: 1950 ${repeat} accepted`);
    }
    for (const repeat of ['daily', 'weekly', 'monthly']) {
      assertEqual(parseCreate(body(repeat)), { ok: false, field: 'start' }, `server: 1950 ${repeat} refused`);
    }
    assertEqual(parseCreate({ kind: 'event', title: 'Birthday', allDay: false, start: '1950-03-02T10:00', end: '1950-03-02T11:00' }), parseCreate(body('none')), 'no repeat reads as a one-off');
    assertEqual(parseCreate(body('yearly', '1899-12-31T10:00', '1899-12-31T11:00')), { ok: false, field: 'start' }, 'server: 1899 refused even yearly');
    assert(parseCreate(body('daily', '2000-01-01T10:00', '2000-01-01T11:00')).ok, 'server: 2000 daily accepted');
  });

  await check('the picker model is client-safe: no React, no @hebcal/core, no server module, no clock', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/lib/calendar-view/picker-model.ts'), 'utf8');
    const imports = [...source.matchAll(/^import\s+(type\s+)?(?:[^'"]*?\s+from\s+)?'([^']+)';/gm)].map((m) => m[2]).sort();
    assertEqual(imports, ['./format', './grid', './hebrew-date', './store', './types', './year-limits', '@hebcal/hdate'], 'imports');
    assert(!/Date\.now\(|new Date\(\)/.test(source), 'no clock');
    assert(!/require\(|import\(/.test(source), 'no require() or import()');
    const limits = fs.readFileSync(path.join(ROOT, 'src/lib/calendar-view/year-limits.ts'), 'utf8');
    assertEqual([...limits.matchAll(/^import\s+(type\s+)?(?:[^'"]*?\s+from\s+)?'([^']+)';/gm)].map((m) => m[2]), ['./editor-types'], 'year-limits imports');
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

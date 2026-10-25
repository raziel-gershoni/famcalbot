// Smoke test for the date and time sheets' markup and CSS (editor upgrades spec §1):
// DatePickerSheet, TimePickerSheet and picker-kit in app/[locale]/dashboard/, rendered with the
// real messages and the real wheel library, in he, en and ru, light and dark.
//
// It checks, per language and look:
//  - the date sheet: a dialog with its name, a grid of 6 rows, a cell for each day of the month,
//    one tab stop on the chosen day, aria-selected / aria-current / aria-disabled where they
//    belong (days before an end's start are disabled), the weekday header from the week start,
//    the title with the other calendar's months under it, the footer in both calendars, Today;
//  - Hebrew mode: the Hebrew month's days, the Hebrew title over the Gregorian months, the
//    switch on Hebrew; no switch and no Hebrew line without Hebrew dates;
//  - RTL: the root carries dir="rtl" in Hebrew, the chevrons flip, the time wheels stay left to right;
//  - the time sheet: the real library's wheels (two focusable elements), Done, Cancel, no bare key;
//  - the wheel's ARIA (spinbutton, name, value text, place in the list) and the hidden copies;
//  - the CSS: the home's tokens only (no colour of its own), logical properties, no hover,
//    nothing under 11 px, 44 px targets, the reduced-motion rule, the page slide;
//  - Settings: the reminder-time <select> is gone, the time sheet is its picker (15-minute steps,
//    Telegram's Back and the vertical swipes while it is open).
//
// Run with the fake env from the task brief (no dotenv), under two clocks:
//   TZ=UTC npx tsx scripts/smoke-date-picker-render.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-date-picker-render.ts

import fs from 'fs';
import path from 'path';
import React, { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { DatePickerSheet } from '../app/[locale]/dashboard/DatePickerSheet';
import { TimePickerSheet } from '../app/[locale]/dashboard/TimePickerSheet';
import { PICKER_CSS, applyWheelAria } from '../app/[locale]/dashboard/picker-kit';
import { HOME_THEME_CSS } from '../app/[locale]/dashboard/home-theme';
import { pageCells, pageOf } from '../src/lib/calendar-view/picker-model';
import en from '../messages/en.json';
import he from '../messages/he.json';
import ru from '../messages/ru.json';

const ROOT = path.resolve(__dirname, '..');
type Locale = 'he' | 'en' | 'ru';
const LOCALES: Locale[] = ['he', 'en', 'ru'];
const messages = { he, en, ru } as const;

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

/** Renders `el` inside the home's root for a language and look, as the editor does. */
function render(locale: Locale, scheme: 'light' | 'dark', el: ReactElement, keepStyle = false): string {
  const provider = { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as unknown as ComponentProps<typeof NextIntlClientProvider>;
  const root = createElement('div', { className: 'ch-home', 'data-theme': scheme, dir: locale === 'he' ? 'rtl' : 'ltr', lang: locale }, el);
  const html = renderToString(createElement(NextIntlClientProvider, provider, root));
  // The <style> text names classes and attributes of its own; the markup checks count the elements.
  return keepStyle ? html : html.replace(/<style[\s\S]*?<\/style>/g, '');
}

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;
const textOf = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
/** The opening tag of the first element matching `re`. */
const tagOf = (html: string, re: RegExp) => (re.exec(html) ?? [''])[0];

const TODAY = '2026-10-15';
const dateProps = (locale: Locale, over: Partial<ComponentProps<typeof DatePickerSheet>> = {}): ComponentProps<typeof DatePickerSheet> => ({
  label: messages[locale].calendarHome.editor.startsDate,
  value: TODAY,
  today: TODAY,
  weekStart: 0,
  hebrewDates: true,
  mode: 'gregorian',
  minYear: 1900,
  min: null,
  onPick: () => undefined,
  onClose: () => undefined,
  ...over,
});

async function main() {
  for (const locale of LOCALES) {
    for (const scheme of ['light', 'dark'] as const) {
      const l = messages[locale].calendarHome;
      await check(`${locale} ${scheme}: the date sheet is a dialog with a grid of 6 rows, a cell for each of October's 31 days, one tab stop on the chosen day, today marked, the footer in both calendars`, () => {
        const html = render(locale, scheme, createElement(DatePickerSheet, dateProps(locale)));
        assert(html.includes(`data-theme="${scheme}"`) && html.includes(`dir="${locale === 'he' ? 'rtl' : 'ltr'}"`), 'the root');
        assert(new RegExp(`role="dialog"[^>]*aria-label="${l.editor.startsDate}"|aria-label="${l.editor.startsDate}"[^>]*role="dialog"`).test(html), 'a dialog named for the field');
        assert(html.includes('aria-modal="true"'), 'modal');
        assert(count(html, /role="grid"/g) === 1 && count(html, /class="ch-picker-row"/g) === 6, `one grid of 6 rows: ${count(html, /class="ch-picker-row"/g)}`);
        assert(count(html, /role="gridcell"[^>]*data-day=/g) === 31, `31 day cells: ${count(html, /data-day=/g)}`);
        assert(count(html, /tabindex="0"[^>]*data-day|data-day[^>]*tabindex="0"/g) === 1 && /data-day="2026-10-15"[^>]*tabindex="0"|tabindex="0"[^>]*data-day="2026-10-15"/.test(html), 'one tab stop, on the 15th');
        assert(count(html, /aria-selected="true"/g) === 1 && count(html, /aria-current="date"/g) === 1, 'the chosen day and today');
        assert(count(html, /aria-disabled/g) === 0, `nothing disabled: ${(html.match(/.{60}aria-disabled.{40}/g) ?? [])[0]}`);
        assert(html.includes(l.picker.today) && html.includes(l.picker.prevMonth) && html.includes(l.picker.nextMonth) && html.includes(l.picker.chooseMonth), 'the buttons are named');
        assert(count(html, /aria-live="polite"/g) === 1, 'the title is a live region');
        assert(count(html, /class="ch-picker-weekday"/g) === 7, 'seven weekday headings');
        const text = textOf(html);
        if (locale === 'en') assert(text.includes('Thursday, 15 October 2026 · 4 Cheshvan 5787'), `en footer: ${text.slice(-200)}`);
        if (locale === 'he') assert(text.includes('יום חמישי, 15 באוקטובר 2026 · ד׳ בחשון תשפ״ז'), `he footer: ${text.slice(-200)}`);
        assert(!/calendarHome\.|undefined|\[missing|NaN/.test(html), 'no bare key');
        if (locale === 'he') {
          assert(text.includes('אוקטובר 2026') && text.includes('תשרי'), `Hebrew title and months: ${text.slice(0, 300)}`);
          assert(count(html, /class="ch-picker-flip"/g) === 2, 'both chevrons carry the flip class');
        }
        if (locale === 'ru') assert(text.includes('Октябрь 2026'), 'Russian title');
      });

      await check(`${locale} ${scheme}: Hebrew mode shows the Hebrew month (Hebrew days leading, the switch on Hebrew); an end's start greys the days before it; Hebrew dates off: no switch and no Hebrew line`, () => {
        const l2 = messages[locale].calendarHome;
        const hebrew = render(locale, scheme, createElement(DatePickerSheet, dateProps(locale, { mode: 'hebrew' })));
        const page = pageOf('hebrew', TODAY);
        assert(page !== null, 'a Hebrew page');
        const days = pageCells(page, 0).flat().filter((d) => d !== null).length;
        assert(count(hebrew, /role="gridcell"[^>]*data-day=/g) === days, `the Hebrew month's ${days} days: ${count(hebrew, /data-day=/g)}`);
        assert(count(hebrew, /role="radio"/g) === 2, 'the switch');
        const radio = tagOf(hebrew, /<button[^>]*aria-checked="true"[^>]*>/);
        assert(radio.includes('role="radio"'), 'a checked radio');
        assert(textOf(hebrew.slice(hebrew.indexOf(radio))).trim().startsWith(l2.picker.hebrew), `the checked one is Hebrew: ${radio}`);
        assert(textOf(hebrew).includes(l2.picker.hebrew) && textOf(hebrew).includes(l2.picker.gregorian), 'the switch is worded');
        const text = textOf(hebrew);
        if (locale === 'en') assert(text.includes('Cheshvan 5787') && text.includes('Oct – Nov 2026'), `en Hebrew title: ${text.slice(0, 200)}`);
        if (locale === 'he') assert(text.includes('חשון תשפ״ז'), `he Hebrew title: ${text.slice(0, 200)}`);
        const limited = render(locale, scheme, createElement(DatePickerSheet, dateProps(locale, { min: '2026-10-10' })));
        assert(count(limited, /aria-disabled="true"/g) === 9, `Oct 1-9 greyed: ${count(limited, /aria-disabled="true"/g)}`);
        assert(/data-day="2026-10-09"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*data-day="2026-10-09"/.test(limited) && !/data-day="2026-10-10"[^>]*aria-disabled/.test(limited), 'the 9th greyed, the 10th not');
        const plain = render(locale, scheme, createElement(DatePickerSheet, dateProps(locale, { hebrewDates: false })));
        assert(count(plain, /role="radio"/g) === 0, 'no switch without Hebrew dates');
        assert(count(plain, /class="ch-picker-sub"/g) === 0, 'and no second line on a cell');
        assert(!textOf(plain).includes(' · '), 'one calendar in the footer');
        // A Hebrew yearly item with Hebrew dates off still shows the switch it opens on.
        const stored = render(locale, scheme, createElement(DatePickerSheet, dateProps(locale, { hebrewDates: false, mode: 'hebrew' })));
        assert(count(stored, /role="radio"/g) === 2, 'a Hebrew repeat keeps the switch');
      });

      await check(`${locale} ${scheme}: the time sheet is the real library's two wheels, always left to right, with Done and Cancel`, () => {
        const html = render(locale, scheme, createElement(TimePickerSheet, { label: l.editor.startsTime, value: '09:30', step: 5, onPick: () => undefined, onClose: () => undefined }));
        assert(count(html, /data-rwp="true"/g) === 2, `two wheels: ${count(html, /data-rwp="true"/g)}`);
        assert(count(html, /data-rwp-wrapper="true"/g) === 1, 'in one wrapper');
        assert(/class="ch-picker-body" dir="ltr"/.test(html), 'left to right in every language');
        assert(html.includes(`>${l.picker.done}<`) && html.includes(`>${l.editor.cancel}<`), 'Done and Cancel');
        assert(count(html, /data-rwp-option="true"/g) > 0, 'the options are drawn');
        assert(html.includes('09') && html.includes('30'), 'the time it opens on');
        assert(!/calendarHome\.|undefined|\[missing|NaN/.test(html), 'no bare key');
        assert(new RegExp(`aria-label="${l.editor.startsTime}"`).test(html), 'a dialog named for the field');
      });
    }
  }

  await check('the wheel gets the ARIA the library leaves out: a spinbutton with a name, the chosen text and its place in the list; the rotated copies are hidden', () => {
    const attrs: Record<string, string> = {};
    const hidden: string[] = [];
    const el = {
      setAttribute: (n: string, v: string) => {
        attrs[n] = v;
      },
      querySelectorAll: (selector: string) => {
        assert(selector.includes('[data-rwp-options]') && selector.includes('[data-rwp-highlight-wrapper]'), `the copies are selected: ${selector}`);
        return [{ setAttribute: (n: string, v: string) => hidden.push(`${n}=${v}`) }, { setAttribute: (n: string, v: string) => hidden.push(`${n}=${v}`) }];
      },
    };
    applyWheelAria(el, { label: 'Minute', text: '35', index: 7, count: 12 });
    assert(JSON.stringify(attrs) === JSON.stringify({ role: 'spinbutton', 'aria-label': 'Minute', 'aria-valuetext': '35', 'aria-valuenow': '7', 'aria-valuemin': '0', 'aria-valuemax': '11' }), `attributes: ${JSON.stringify(attrs)}`);
    assert(hidden.join() === 'aria-hidden=true,aria-hidden=true', `hidden: ${hidden}`);
    applyWheelAria(null, { label: 'x', text: 'y', index: 0, count: 1 });
  });

  await check("the picker's CSS follows the home's rules: only its tokens (no colour of its own), logical properties, no hover, nothing under 11 px, 44 px targets, a slide that reduced motion turns off", () => {
    const own = PICKER_CSS.slice(PICKER_CSS.indexOf('.ch-picker {'));
    assert(own.length > 500, 'the picker rules are there');
    assert(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(own), `a colour of its own: ${/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/i.exec(own)?.[0]}`);
    const tokens = [...own.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
    assert(tokens.length > 10 && tokens.every((t) => HOME_THEME_CSS.includes(`${t}:`) || t === '--ch-picker-slide'), `unknown tokens: ${tokens.filter((t) => !HOME_THEME_CSS.includes(`${t}:`))}`);
    const physical = own.match(/(?:margin|padding|border)-(?:left|right)|(?:^|[\s;{])(?:left|right)\s*:|text-align:\s*(?:left|right)|float:|(?:^|[\s;{])(?:width|height)\s*:|(?:min|max)-(?:width|height)\s*:/gm);
    assert(!physical, `physical properties: ${JSON.stringify(physical)}`);
    assert(!/:hover/.test(PICKER_CSS), 'no hover styles');
    assert([...own.matchAll(/font-size:\s*(\d+)px/g)].every((m) => Number(m[1]) >= 11), 'nothing under 11 px');
    const rule = (selector: string) => {
      const m = new RegExp(`(?:^|\\n)${selector.replace(/[.[\]]/g, '\\$&')} \\{([^}]*)\\}`).exec(PICKER_CSS);
      assert(m, `no rule for ${selector}`);
      return m[1];
    };
    for (const selector of ['.ch-picker-nav', '.ch-picker-title', '.ch-picker-cell', '.ch-picker-done']) {
      const size = /(?:min-block-size|block-size):\s*(\d+)px/.exec(rule(selector));
      assert(size && Number(size[1]) >= 44, `${selector} is ${size?.[1]}px`);
    }
    assert(/block-size:\s*288px/.test(rule('.ch-picker-body')) && /block-size:\s*288px/.test(rule('.ch-wheels')), 'the body and the wheels are 6 rows of 48 px: the sheet never jumps');
    assert(/repeat\(7, 1fr\)/.test(rule('.ch-picker-row')), 'seven columns');
    assert(/120ms/.test(rule('.ch-picker-grid')), 'pages slide in 120 ms');
    assert(/prefers-reduced-motion: reduce\)\s*\{[^@]*animation: none !important/.test(HOME_THEME_CSS), "the home's reduced-motion rule covers the slide");
    assert(/\.ch-home\[dir='rtl'\] \.ch-picker-flip \{\s*transform: scaleX\(-1\)/.test(PICKER_CSS), 'the chevrons flip in RTL');
    assert(/ch-picker-slide-rtl/.test(PICKER_CSS), 'the slide runs in reading direction');
    assert(/\[aria-selected='true'\] \{[^}]*var\(--ch-selected\)[^}]*var\(--ch-selected-text\)|\[aria-selected='true'\] \{[^}]*background: var\(--ch-selected\)/.test(PICKER_CSS), 'the chosen day is --ch-selected');
    assert(/\.ch-picker-cell\.is-today \.ch-picker-num \{[^}]*var\(--ch-accent\)/.test(PICKER_CSS), "today's number is --ch-accent");
    assert(/\.ch-picker-sub \{[^}]*font-size: 11px[^}]*var\(--ch-muted\)/.test(PICKER_CSS), 'the second line is --ch-muted at 11 px');
    assert(/\.ch-wheel-band \{[^}]*var\(--ch-surface\)/.test(PICKER_CSS), 'the wheel band is --ch-surface');
  });

  await check("Settings: the reminder time is a pill that opens the time sheet in 15-minute steps; the <select> is gone; Telegram's Back and the swipe lock follow the sheet", () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/[locale]/settings/SettingsClient.tsx'), 'utf8');
    assert(!/name="reminderTime"/.test(src) && !/REMINDER_TIME_OPTIONS/.test(src), 'no <select> of times');
    assert(/import\('\.\.\/dashboard\/TimePickerSheet'\)/.test(src) && /<TimePickerSheet[\s\S]*?standalone[\s\S]*?step=\{REMINDER_TIME_STEP_MINUTES\}/.test(src), 'the dashboard\'s time sheet, standalone, on the 15-minute step');
    assert(/useTelegramBackButton\(timeSheetOpen,/.test(src) && /useTelegramVerticalSwipes\(timeSheetOpen\)/.test(src), 'Back and the swipe lock follow the sheet');
    const kit = fs.readFileSync(path.join(ROOT, 'app/[locale]/dashboard/picker-kit.tsx'), 'utf8');
    assert(/export function PickerScope/.test(kit) && /HOME_THEME_CSS/.test(kit) && /data-theme=\{scheme\}/.test(kit) && /dir=\{locale === 'he'/.test(kit), 'the scope: tokens, data-theme, dir');
    const html = render('en', 'light', createElement(TimePickerSheet, { label: 'Reminder time', value: '09:15', step: 15, onPick: () => undefined, onClose: () => undefined, standalone: true }), true);
    assert(count(html, /class="ch-home"/g) === 2, 'the standalone sheet brings its own scope');
    assert(html.includes('--ch-bg') && html.includes('.ch-segmented'), "with the home's tokens and the form kit's CSS");
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

void React;
main().catch((err) => {
  console.error(err);
  process.exit(1);
});

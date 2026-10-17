// Smoke test for the calendar home's tab bar, its memory and the Month's colours (Plan E,
// Task E4; spec §7.1 State and Look, §7.4 Memory, §7.6, §7.7; Plan E Rulings 1, 2 and 9):
//  - HomeTabs (app/[locale]/dashboard/HomeTabs.tsx) in en, he and ru: one tablist named
//    by tabs.label, two tabs with their ids, aria-selected, aria-controls naming their
//    panels and a roving tabIndex, the labels, dir="rtl" in Hebrew only;
//  - in real React (react-dom/client with act on a small fake DOM): a tap selects the
//    other tab and a tap on the selected one does nothing; the arrow keys follow the
//    reading direction (mirrored in Hebrew) and wrap, Home and End go to the ends, focus
//    follows, and only those keys are taken;
//  - its CSS: every tab at least 44 px tall, nothing under 11 px, logical properties
//    only, no hover, the selected tab told apart by weight as well as colour, and only
//    tokens home-theme.ts defines;
//  - the storage helpers (src/lib/calendar-view/home-storage.ts): the per-user keys, the
//    tab in sessionStorage and the layout in localStorage, and their defaults with no
//    window, with storage that throws (on the property, on get, on set) and for unknown
//    values;
//  - the Month's colour tokens in home-theme.ts: each in light and dark; on Telegram's
//    theme params where one fits (resolved with every param set); the contrast floor on
//    the fallbacks, with and without color-mix (4.5:1 for text, 3:1 for the marks that
//    tell the viewer's items from the partner's);
//  - HomeErrorBoundary: a chunk-load error lets Telegram's BackButton and vertical swipes
//    go before its one reload (releaseTelegramControls), and its card turns swipes back on.
// React must log no warning. No network, no DB, no Redis.
//
// Run with the fake env from the task brief (no dotenv), under two clocks:
//   TZ=UTC npx tsx scripts/smoke-calendar-home-tabs.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-home-tabs.ts

import fs from 'fs';
import path from 'path';
import React, { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { HomeTabs, PANEL_IDS, TAB_IDS, TABS_CSS } from '../app/[locale]/dashboard/HomeTabs';
import { HOME_THEME_CSS } from '../app/[locale]/dashboard/home-theme';
import { CHUNK_RELOAD_KEY, HomeErrorBoundary } from '../app/[locale]/dashboard/HomeErrorBoundary';
import { useTelegramBackButton } from '../src/lib/telegram-ui';
import { FakeElement, byRole, fakeDocument, fakeWindow, installWindow, mount, type Mounted } from './lib/fake-dom';
import { homeTabKey, monthLayoutKey, readHomeTab, readMonthLayout, writeHomeTab, writeMonthLayout, type HomeTab } from '../src/lib/calendar-view/home-storage';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const LOCALES = ['en', 'he', 'ru'] as const;
type Locale = (typeof LOCALES)[number];

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

const show = (value: unknown) => JSON.stringify(value);
const noop = () => undefined;
const messages: Record<Locale, Row> = {
  en: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8')),
  he: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/he.json'), 'utf8')),
  ru: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/ru.json'), 'utf8')),
};

// ---- React must not warn ----

const reactWarnings: string[] = [];
/** The app's own log lines (the error boundary's): a check expects one; they are never React's. */
const appLogs: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('[telegram-ui]')) return original(...args);
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's.
    if (text.startsWith('(node:')) return original(...args);
    if (text.startsWith('[calendar-home]')) {
      appLogs.push(text.slice(0, 300));
      return;
    }
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- Rendering ----

function inIntl(locale: Locale, el: ReactElement): ReactElement {
  // The provider's props type makes children required; createElement takes them as its third argument.
  const provider = { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as ComponentProps<typeof NextIntlClientProvider>;
  return createElement(NextIntlClientProvider, provider, el);
}

const renderTabs = (locale: Locale, tab: HomeTab) => renderToString(inIntl(locale, createElement(HomeTabs, { tab, onTab: noop })));

/** An attribute of one opening tag, or null. */
const attr = (tag: string, name: string) => new RegExp(` ${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** The text a reader sees: tags and React's text separators out, spaces collapsed. */
const textOf = (html: string) =>
  html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ')
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** HomeTabs as the container holds it: the tab in state; `seen` records each onTab. */
function TabsHost({ start, seen }: { start: HomeTab; seen: HomeTab[] }) {
  const [tab, setTab] = React.useState<HomeTab>(start);
  return createElement(HomeTabs, {
    tab,
    onTab: (next: HomeTab) => {
      seen.push(next);
      setTab(next);
    },
  });
}

// ---- Storage on the shared fake DOM (scripts/lib/fake-dom.ts) ----

/** A Storage-like object over a Map. */
function memoryStorage(saved = new Map<string, string>()): Row {
  return {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, String(v)),
    removeItem: (k: string) => void saved.delete(k),
  };
}

Object.assign(fakeWindow, { sessionStorage: memoryStorage(), localStorage: memoryStorage() });

const g = globalThis as Row;


/** The two tabs, Agenda first, and the selected one's label check. */
function tabsOf(m: Mounted): [FakeElement, FakeElement] {
  const tabs = byRole(m.container, 'tab');
  assert(tabs.length === 2 && tabs[0].getAttribute('id') === TAB_IDS.agenda && tabs[1].getAttribute('id') === TAB_IDS.month, `tabs: ${show(tabs.map((t) => t.getAttribute('id')))}`);
  return [tabs[0], tabs[1]];
}
const selectedOf = (m: Mounted) => byRole(m.container, 'tab').filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.getAttribute('id'));
const tabIndexes = (m: Mounted) => byRole(m.container, 'tab').map((t) => t.getAttribute('tabindex'));

// ---- A fake Telegram.WebApp (records calls, as the SDK's methods are called) ----

/** Bot API versions compared as the SDK does: part by part, missing parts 0. */
function versionAtLeast(have: string, want: string): boolean {
  const a = have.split('.').map(Number);
  const b = want.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function fakeTelegram(calls: string[], version: string): Row {
  const ids = new Map<unknown, string>();
  const label = (a: unknown) => {
    if (typeof a !== 'function') return String(a);
    if (!ids.has(a)) ids.set(a, `fn${ids.size + 1}`);
    return ids.get(a) as string;
  };
  const rec =
    (name: string) =>
    (...args: unknown[]) =>
      void calls.push(`${name}(${args.map(label).join(',')})`);
  return {
    initData: 'query_id=AAE&user=%7B%22id%22%3A5550001%7D&auth_date=1792000000&hash=abc',
    version,
    colorScheme: 'light',
    isVersionAtLeast: (v: string) => versionAtLeast(version, v),
    setHeaderColor: rec('setHeaderColor'),
    setBackgroundColor: rec('setBackgroundColor'),
    onEvent: rec('onEvent'),
    offEvent: rec('offEvent'),
    enableVerticalSwipes: rec('enableVerticalSwipes'),
    disableVerticalSwipes: rec('disableVerticalSwipes'),
    BackButton: { onClick: rec('BackButton.onClick'), offClick: rec('BackButton.offClick'), show: rec('BackButton.show'), hide: rec('BackButton.hide') },
  };
}

// ---- The theme's tokens, resolved the way a browser resolves them ----

/** Plan E's tokens (the split's list); E6 and E7 read only these and D's. */
const TOKENS = [
  '--ch-tab-track',
  '--ch-tab-on',
  '--ch-tab-on-text',
  '--ch-tab-shadow',
  '--ch-mine-soft',
  '--ch-mine-soft-text',
  '--ch-mine-solid',
  '--ch-mine-solid-text',
  '--ch-partner-soft',
  '--ch-partner-soft-text',
  '--ch-partner-line',
  '--ch-partner-line-text',
  '--ch-dot-mine',
  '--ch-dot-partner',
  '--ch-today',
  '--ch-today-text',
  '--ch-selected',
  '--ch-selected-text',
  '--ch-pill-bg',
  '--ch-pill-line',
  '--ch-pill-text',
  '--ch-disabled',
  '--ch-month-title',
] as const;

type Theme = 'light' | 'dark';
type Rgb = [number, number, number];
type Rule = { selectors: string[]; decls: [string, string][]; supports: boolean };

/** The top-level blocks of a style sheet: [prelude, body]. Comments out first. */
function cssBlocks(css: string): [string, string][] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: [string, string][] = [];
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = 0;
  let prelude = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) {
        prelude = text.slice(preludeStart, i).trim();
        bodyStart = i + 1;
      }
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        out.push([prelude, text.slice(bodyStart, i)]);
        preludeStart = i + 1;
      }
    }
  }
  return out;
}

/** The custom properties a block body declares, in order. */
const customProps = (body: string): [string, string][] =>
  body
    .split(';')
    .map((d) => /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(d))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1], m[2]]);

/** The theme's rules in source order; the ones inside @supports (color-mix) marked. */
function themeRules(css: string): Rule[] {
  const rules: Rule[] = [];
  for (const [prelude, body] of cssBlocks(css)) {
    if (prelude.startsWith('@supports')) {
      for (const [inner, innerBody] of cssBlocks(body)) rules.push({ selectors: inner.split(',').map((s) => s.trim()), decls: customProps(innerBody), supports: true });
    } else if (!prelude.startsWith('@')) {
      rules.push({ selectors: prelude.split(',').map((s) => s.trim()), decls: customProps(body), supports: false });
    }
  }
  return rules;
}

/** The custom properties on .ch-home for a theme: the cascade over the two selectors the theme uses. */
function cascade(css: string, theme: Theme, colorMix: boolean): Map<string, string> {
  const specificity = (selector: string) => (selector === '.ch-home' ? 10 : selector === ".ch-home[data-theme='dark']" && theme === 'dark' ? 20 : 0);
  const won = new Map<string, { spec: number; value: string }>();
  for (const rule of themeRules(css)) {
    if (rule.supports && !colorMix) continue;
    const spec = Math.max(0, ...rule.selectors.map(specificity));
    if (spec === 0) continue;
    for (const [name, value] of rule.decls) {
      const prev = won.get(name);
      if (!prev || spec >= prev.spec) won.set(name, { spec, value });
    }
  }
  return new Map([...won].map(([k, v]) => [k, v.value]));
}

const GLOBALS = new Map(
  [...fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8').matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()] as [string, string]),
);

/** Splits a function's arguments at its top-level commas. */
function splitArgs(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '(') depth++;
    else if (inner[i] === ')') depth--;
    else if (inner[i] === ',' && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(inner.slice(start).trim());
  return out;
}

/** A resolver for one theme: a token's colour and the Telegram params it read. */
function resolver(theme: Theme, colorMix: boolean, tg: Record<string, string> = {}) {
  const props = cascade(HOME_THEME_CSS, theme, colorMix);
  let read = new Set<string>();
  const lookup = (name: string): string | null => {
    if (name.startsWith('--tg-')) {
      if (!(name in tg)) return null;
      read.add(name.replace(/^--tg-theme-|-color$/g, ''));
      return tg[name];
    }
    return props.get(name) ?? GLOBALS.get(name) ?? null;
  };
  const colour = (value: string, depth = 0): Rgb => {
    assert(depth < 20, `a var() loop at ${value}`);
    const v = value.trim();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
    if (hex) {
      const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
    }
    if (v.startsWith('var(') && v.endsWith(')')) {
      const [name, ...fallback] = splitArgs(v.slice(4, -1));
      const found = lookup(name);
      if (found !== null) return colour(found, depth + 1);
      assert(fallback.length > 0, `${name} is unset and has no fallback`);
      return colour(fallback.join(','), depth + 1);
    }
    if (v.startsWith('color-mix(') && v.endsWith(')')) {
      const [space, a, b] = splitArgs(v.slice(10, -1));
      assert(space === 'in srgb', `color-mix space ${space}`);
      const pa = /^([\s\S]+?)\s+([\d.]+)%$/.exec(a);
      assert(pa && !/%$/.test(b), `color-mix form: ${v}`);
      const p = Number(pa[2]) / 100;
      const x = colour(pa[1], depth + 1);
      const y = colour(b, depth + 1);
      return [0, 1, 2].map((i) => x[i] * p + y[i] * (1 - p)) as Rgb;
    }
    throw new Error(`not a colour: ${v}`);
  };
  return {
    props,
    colour: (token: string) => colour(`var(${token})`),
    reads: (token: string) => {
      read = new Set();
      colour(`var(${token})`);
      return [...read].sort();
    },
  };
}

const linear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, gr, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(gr) + 0.0722 * linear(b);
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Text on what it sits on: 4.5:1 (WCAG 1.4.3). */
const TEXT_PAIRS: [string, string][] = [
  ['--ch-tab-on-text', '--ch-tab-on'],
  ['--ch-muted', '--ch-tab-track'],
  ['--ch-mine-soft-text', '--ch-mine-soft'],
  ['--ch-mine-solid-text', '--ch-mine-solid'],
  ['--ch-partner-soft-text', '--ch-partner-soft'],
  ['--ch-partner-line-text', '--ch-bg'],
  ['--ch-today-text', '--ch-today'],
  ['--ch-selected-text', '--ch-selected'],
  ['--ch-pill-text', '--ch-pill-bg'],
  ['--ch-month-title', '--ch-bg'],
];
/** The marks that tell whose an item is without colour, and the solid fills: 3:1 (WCAG 1.4.11). */
const MARK_PAIRS: [string, string][] = [
  ['--ch-dot-mine', '--ch-bg'],
  ['--ch-dot-partner', '--ch-bg'],
  ['--ch-partner-line', '--ch-bg'],
  ['--ch-partner-line', '--ch-partner-soft'],
  ['--ch-mine-solid', '--ch-bg'],
  ['--ch-today', '--ch-bg'],
];

/** Every Telegram theme param the home maps, each a different grey, so the reads are unambiguous. */
const TG_ALL: Record<string, string> = Object.fromEntries(
  ['bg', 'text', 'hint', 'link', 'button', 'button-text', 'secondary-bg', 'header-bg', 'accent-text', 'section-bg', 'section-header-text', 'section-separator', 'subtitle-text', 'destructive-text'].map((n, i) => [
    `--tg-theme-${n}-color`,
    `#${(0x111111 * (i + 1)).toString(16).padStart(6, '0')}`,
  ]),
);

/** The Telegram params each token reads with color-mix, in light and dark alike ([] = a fixed shade: Telegram has no partner colour). */
const TG_READS: Record<string, string[]> = {
  '--ch-tab-track': ['secondary-bg'],
  '--ch-tab-on': ['section-bg'],
  '--ch-tab-on-text': ['text'],
  '--ch-mine-soft': ['accent-text', 'bg'],
  '--ch-mine-soft-text': ['accent-text', 'text'],
  '--ch-mine-solid': ['button'],
  '--ch-mine-solid-text': ['button-text'],
  '--ch-partner-soft': [],
  '--ch-partner-soft-text': [],
  '--ch-partner-line': [],
  '--ch-partner-line-text': [],
  '--ch-dot-mine': ['accent-text'],
  '--ch-dot-partner': [],
  '--ch-today': ['button'],
  '--ch-today-text': ['button-text'],
  '--ch-selected': ['text'],
  '--ch-selected-text': ['bg'],
  '--ch-pill-bg': ['accent-text', 'bg'],
  '--ch-pill-line': ['accent-text', 'bg'],
  '--ch-pill-text': ['accent-text', 'text'],
  '--ch-disabled': ['bg', 'hint'],
  '--ch-month-title': ['accent-text', 'text'],
};

// ---- The checks ----

async function main() {
  await check('#1 HomeTabs in en, he and ru: one tablist named by tabs.label; two tabs (type="button") with their ids, aria-selected, aria-controls naming their panels and a roving tabIndex (0 on the selected one only); the labels; dir="rtl" in Hebrew only; its own style sheet', () => {
    assert(
      show(TAB_IDS) === show({ agenda: 'ch-tab-agenda', month: 'ch-tab-month' }) && show(PANEL_IDS) === show({ agenda: 'ch-panel-agenda', month: 'ch-panel-month' }),
      `ids ${show(TAB_IDS)} ${show(PANEL_IDS)}`,
    );
    for (const locale of LOCALES) {
      const copy = messages[locale].calendarHome.tabs;
      for (const tab of ['agenda', 'month'] as const) {
        const html = renderTabs(locale, tab);
        const where = `${locale}, ${tab}`;
        const lists = html.match(/<div[^>]*role="tablist"[^>]*>/g) ?? [];
        assert(lists.length === 1, `${where}: ${lists.length} tablists`);
        assert(attr(lists[0], 'aria-label') === copy.label, `${where}: the tablist's name ${attr(lists[0], 'aria-label')}`);
        assert(attr(lists[0], 'dir') === (locale === 'he' ? 'rtl' : 'ltr'), `${where}: dir ${attr(lists[0], 'dir')}`);
        const buttons = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)];
        assert(buttons.length === 2, `${where}: ${buttons.length} buttons`);
        (['agenda', 'month'] as const).forEach((id, i) => {
          const open = buttons[i][1];
          const on = id === tab;
          const got = { role: attr(open, 'role'), type: attr(open, 'type'), id: attr(open, 'id'), selected: attr(open, 'aria-selected'), controls: attr(open, 'aria-controls'), tabIndex: attr(open, 'tabindex'), text: textOf(buttons[i][2]) };
          const want = { role: 'tab', type: 'button', id: TAB_IDS[id], selected: String(on), controls: PANEL_IDS[id], tabIndex: on ? '0' : '-1', text: copy[id] };
          assert(show(got) === show(want), `${where}, the ${id} tab: ${show(got)}, want ${show(want)}`);
        });
        assert(/^<style>[\s\S]*\.ch-tab[\s\S]*<\/style><div/.test(html), `${where}: its own style sheet first`);
        assert(!/calendarHome\.|tabs\./.test(textOf(html)), `${where}: an untranslated key`);
      }
    }
    assert(messages.he.calendarHome.tabs.agenda === 'סדר יום' && messages.he.calendarHome.tabs.month === 'חודש', 'the Hebrew labels (the split)');
  });

  await check('#2 in real React: a tap on the other tab calls onTab with it, and the selection and the tab order follow; a tap on the selected tab calls nothing', () => {
    installWindow();
    const seen: HomeTab[] = [];
    const m = mount(inIntl('en', createElement(TabsHost, { start: 'agenda', seen })));
    try {
      const [agenda, month] = tabsOf(m);
      m.click(month.childNodes[0]);
      assert(show(seen) === show(['month']), `tap Month: ${show(seen)}`);
      assert(show(selectedOf(m)) === show([TAB_IDS.month]) && show(tabIndexes(m)) === show(['-1', '0']), `after the tap: ${show(selectedOf(m))} ${show(tabIndexes(m))}`);
      m.click(month);
      assert(show(seen) === show(['month']), `a tap on the selected tab: ${show(seen)}`);
      m.click(agenda);
      assert(show(seen) === show(['month', 'agenda']) && show(selectedOf(m)) === show([TAB_IDS.agenda]) && show(tabIndexes(m)) === show(['0', '-1']), `tap Agenda: ${show(seen)} ${show(selectedOf(m))}`);
    } finally {
      m.unmount();
    }
  });

  await check('#3 in real React, English and Russian: ArrowRight goes to the next tab and ArrowLeft to the previous one, both wrapping; Home and End go to the first and last; a key on the unselected tab moves from that tab; focus follows and each of those keys is taken; ArrowUp, ArrowDown, Enter, Space, Tab and letters are left alone', () => {
    installWindow();
    for (const locale of ['en', 'ru'] as const) {
      const seen: HomeTab[] = [];
      const m = mount(inIntl(locale, createElement(TabsHost, { start: 'agenda', seen })));
      try {
        const [agenda, month] = tabsOf(m);
        const steps: [FakeElement, string, HomeTab, FakeElement][] = [
          [agenda, 'ArrowRight', 'month', month],
          [month, 'ArrowRight', 'agenda', agenda],
          [agenda, 'ArrowLeft', 'month', month],
          [month, 'ArrowLeft', 'agenda', agenda],
          [agenda, 'End', 'month', month],
          [month, 'Home', 'agenda', agenda],
        ];
        for (const [from, key, to, focused] of steps) {
          const event = m.key(from, key);
          assert(seen[seen.length - 1] === to && show(selectedOf(m)) === show([TAB_IDS[to]]), `${locale} ${key}: ${show(seen)} ${show(selectedOf(m))}`);
          assert(fakeDocument.activeElement === focused, `${locale} ${key}: focus on ${fakeDocument.activeElement?.getAttribute?.('id')}`);
          assert(event.defaultPrevented, `${locale} ${key} was not taken`);
        }
        const count = seen.length;
        const home = m.key(agenda, 'Home');
        assert(seen.length === count && home.defaultPrevented && fakeDocument.activeElement === agenda, `Home on the first tab: ${show(seen)}`);
        // Focus on the unselected Month (a screen reader can put it there): the previous tab from it is the Agenda, already selected.
        const other = m.key(month, 'ArrowLeft');
        assert(seen.length === count && other.defaultPrevented && fakeDocument.activeElement === agenda, `ArrowLeft on the unselected Month: ${show(seen)}`);
        for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'a']) {
          const event = m.key(agenda, key);
          assert(!event.defaultPrevented && seen.length === count, `${locale} ${show(key)} was taken: ${show(seen)}`);
        }
      } finally {
        m.unmount();
      }
    }
  });

  await check('#4 in real React, Hebrew (RTL): the arrows follow the reading direction, so ArrowLeft goes to the next tab and ArrowRight to the previous one, both wrapping; Home and End as in English', () => {
    installWindow();
    const seen: HomeTab[] = [];
    const m = mount(inIntl('he', createElement(TabsHost, { start: 'agenda', seen })));
    try {
      const [agenda, month] = tabsOf(m);
      m.key(agenda, 'ArrowLeft');
      assert(show(seen) === show(['month']) && fakeDocument.activeElement === month, `ArrowLeft from the Agenda: ${show(seen)}`);
      m.key(month, 'ArrowRight');
      assert(show(seen) === show(['month', 'agenda']) && fakeDocument.activeElement === agenda, `ArrowRight from the Month: ${show(seen)}`);
      m.key(agenda, 'ArrowRight');
      assert(show(seen) === show(['month', 'agenda', 'month']), `ArrowRight from the Agenda wraps to the Month: ${show(seen)}`);
      m.key(month, 'ArrowLeft');
      assert(show(seen) === show(['month', 'agenda', 'month', 'agenda']), `ArrowLeft from the Month wraps to the Agenda: ${show(seen)}`);
      m.key(agenda, 'End');
      m.key(month, 'Home');
      assert(show(seen.slice(4)) === show(['month', 'agenda']), `End, Home: ${show(seen)}`);
    } finally {
      m.unmount();
    }
  });

  await check('#5 the tab bar\'s CSS: every tab at least 44 px tall; nothing under 11 px, every size in px; logical properties only; no hover; no overflow: hidden; the 16 px gutter; the selected tab semibold on --ch-tab-on, the other label in D\'s --ch-muted; a focus ring; only tokens home-theme.ts defines', () => {
    const css = TABS_CSS;
    const rule = (selector: string) => {
      const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
      assert(m, `no rule ${selector}`);
      return m[1];
    };
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    assert(sizes.length >= 1 && Math.min(...sizes) >= 11, `font sizes: ${show(sizes)}`);
    assert(!/font-size:\s*[\d.]+(?:em|rem|%)|font:\s/.test(css), 'every font size in px (so the floor is checkable)');
    const min = /min-height:\s*(\d+)px/.exec(rule('.ch-tab'));
    assert(min && Number(min[1]) >= 44, `.ch-tab min-height ${min?.[1]}`);
    const physical = css.match(/(?:margin|padding|border)-(?:left|right)|(?:^|[\s;{])(?:left|right)\s*:|text-align:\s*(?:left|right)|float:/g);
    assert(!physical, `physical properties: ${show(physical)}`);
    assert(!/:hover/.test(css), 'no hover styles');
    assert(!/overflow:\s*hidden/.test(css), 'overflow: hidden');
    assert(/margin-inline:\s*16px/.test(rule('.ch-tabs')) && /background:\s*var\(--ch-tab-track\)/.test(rule('.ch-tabs')), `the track: ${rule('.ch-tabs')}`);
    assert(/color:\s*var\(--ch-muted\)/.test(rule('.ch-tab')), 'the other tab reads --ch-muted (D\'s floor)');
    const on = rule(".ch-tab[aria-selected='true']");
    assert(/font-weight:\s*600/.test(on) && /color:\s*var\(--ch-tab-on-text\)/.test(on), `the selected tab: ${on}`);
    const pill = rule(".ch-tab[aria-selected='true'] .ch-tab-pill");
    assert(/background:\s*var\(--ch-tab-on\)/.test(pill) && /box-shadow:\s*var\(--ch-tab-shadow\)/.test(pill), `the selected pill: ${pill}`);
    assert(/outline:\s*2px solid var\(--ch-accent\)/.test(rule('.ch-tab:focus-visible')), 'a focus ring');
    const defined = new Set(cascade(HOME_THEME_CSS, 'dark', true).keys());
    const used = [...new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))];
    assert(used.length >= 5 && used.every((n) => defined.has(n)), `tokens read but not defined: ${show(used.filter((n) => !defined.has(n)))}`);
  });

  await check('#6 the storage helpers: per-user keys with the page\'s user_id as it is; the tab in sessionStorage and the layout in localStorage, never the other way round; unknown values read as the defaults', () => {
    const saved = g.window;
    try {
      assert(homeTabKey(5550001) === 'famcal:homeTab:v1:5550001' && homeTabKey(42) === 'famcal:homeTab:v1:42', `homeTabKey ${homeTabKey(5550001)}`);
      assert(monthLayoutKey(5550001) === 'famcal:monthLayout:v1:5550001' && monthLayoutKey(42) === 'famcal:monthLayout:v1:42', `monthLayoutKey ${monthLayoutKey(5550001)}`);
      const session = new Map<string, string>();
      const local = new Map<string, string>();
      g.window = { sessionStorage: memoryStorage(session), localStorage: memoryStorage(local) };
      assert(readHomeTab(1) === 'agenda' && readMonthLayout(1) === null, 'an empty storage');
      writeHomeTab(1, 'month');
      assert(show([...session]) === show([['famcal:homeTab:v1:1', 'month']]) && local.size === 0, `the tab: ${show([...session])} ${show([...local])}`);
      assert(readHomeTab(1) === 'month' && readHomeTab(2) === 'agenda', 'per user');
      writeMonthLayout(1, 'picked');
      writeMonthLayout(2, 'browse');
      assert(show([...local]) === show([['famcal:monthLayout:v1:1', 'picked'], ['famcal:monthLayout:v1:2', 'browse']]) && session.size === 1, `the layouts: ${show([...local])}`);
      assert(readMonthLayout(1) === 'picked' && readMonthLayout(2) === 'browse' && readMonthLayout(3) === null, 'per user');
      writeHomeTab(1, 'agenda');
      assert(readHomeTab(1) === 'agenda', 'back to the Agenda');
      for (const value of ['Month', 'week', '', ' month', '"month"', 'null', 'picked']) {
        session.set(homeTabKey(7), value);
        assert(readHomeTab(7) === 'agenda', `the tab ${show(value)} read as ${readHomeTab(7)}`);
      }
      for (const value of ['Picked', 'grid', '', 'month', 'agenda', '"picked"']) {
        local.set(monthLayoutKey(7), value);
        assert(readMonthLayout(7) === null, `the layout ${show(value)} read as ${readMonthLayout(7)}`);
      }
      session.clear();
      local.clear();
      local.set(homeTabKey(8), 'month');
      session.set(monthLayoutKey(8), 'picked');
      assert(readHomeTab(8) === 'agenda' && readMonthLayout(8) === null, 'a value in the other storage counts');
    } finally {
      g.window = saved;
    }
  });

  await check('#7 the storage helpers never throw: no window (the server); a storage whose property read throws (blocked); a missing storage; getItem and setItem that throw (full) — reads give the defaults, writes do nothing', () => {
    const saved = g.window;
    try {
      const all = () => {
        writeHomeTab(1, 'month');
        writeMonthLayout(1, 'picked');
        return show([readHomeTab(1), readMonthLayout(1)]);
      };
      delete g.window;
      assert(all() === show(['agenda', null]), 'no window');
      const blocked: Row = {};
      for (const area of ['sessionStorage', 'localStorage']) {
        Object.defineProperty(blocked, area, {
          get() {
            throw new Error('SecurityError: The operation is insecure.');
          },
        });
      }
      g.window = blocked;
      assert(all() === show(['agenda', null]), 'a blocked storage');
      g.window = { sessionStorage: null, localStorage: undefined };
      assert(all() === show(['agenda', null]), 'no storage');
      const writes: string[] = [];
      const throwing = {
        getItem: () => {
          throw new Error('getItem threw');
        },
        setItem: (k: string) => {
          writes.push(k);
          throw new Error('QuotaExceededError');
        },
      };
      g.window = { sessionStorage: throwing, localStorage: throwing };
      assert(all() === show(['agenda', null]) && writes.length === 2, `throwing get and set: ${show(writes)}`);
      const full = new Map<string, string>([[homeTabKey(1), 'month'], [monthLayoutKey(1), 'picked']]);
      const readOnly = { getItem: (k: string) => full.get(k) ?? null, setItem: () => { throw new Error('QuotaExceededError'); } };
      g.window = { sessionStorage: readOnly, localStorage: readOnly };
      writeHomeTab(1, 'agenda');
      writeMonthLayout(1, 'browse');
      assert(readHomeTab(1) === 'month' && readMonthLayout(1) === 'picked', 'a full storage still reads');
    } finally {
      g.window = saved;
    }
  });

  await check('#8 Plan E\'s colour tokens: each one declared in the light and the dark block; resolved with every Telegram param set (and color-mix), each reads the params the split maps it onto, the partner\'s shades none, and no text colour reads the hint straight', () => {
    const lightBlock = cssBlocks(HOME_THEME_CSS).find(([p]) => p === '.ch-home');
    const darkBlock = cssBlocks(HOME_THEME_CSS).find(([p]) => p === ".ch-home[data-theme='dark']");
    assert(lightBlock && darkBlock, 'no light or dark block');
    for (const [name, block] of [['light', lightBlock[1]], ['dark', darkBlock[1]]] as const) {
      const declared = new Set(customProps(block).map(([n]) => n));
      const missing = TOKENS.filter((t) => !declared.has(t));
      assert(missing.length === 0, `${name}: missing ${show(missing)}`);
    }
    assert(Object.keys(TG_READS).length === TOKENS.length - 1, 'every colour token has an expectation (--ch-tab-shadow is a shadow)');
    for (const theme of ['light', 'dark'] as const) {
      const r = resolver(theme, true, TG_ALL);
      const got = Object.fromEntries(Object.keys(TG_READS).map((t) => [t, r.reads(t)]));
      const wrong = Object.keys(TG_READS).filter((t) => show(got[t]) !== show(TG_READS[t]));
      assert(wrong.length === 0, `${theme}: ${show(Object.fromEntries(wrong.map((t) => [t, got[t]])))}, want ${show(Object.fromEntries(wrong.map((t) => [t, TG_READS[t]])))}`);
    }
    const shadow = (theme: Theme) => cascade(HOME_THEME_CSS, theme, true).get('--ch-tab-shadow');
    assert(shadow('light') === '0 1px 2px rgba(26, 26, 46, 0.14)' && shadow('dark') === 'none', `the tab shadow: ${shadow('light')} / ${shadow('dark')}`);
  });

  await check('#9 the contrast floor on the fallbacks (a browser: no Telegram params), light and dark, with and without color-mix: every text colour at least 4.5:1 on what it sits on, and the marks that tell whose an item is (dots, the partner\'s outline, the solid fills) at least 3:1', () => {
    const low: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      for (const colorMix of [false, true]) {
        const r = resolver(theme, colorMix);
        for (const [pairs, floor] of [[TEXT_PAIRS, 4.5], [MARK_PAIRS, 3]] as const) {
          for (const [fg, bg] of pairs) {
            const ratio = contrast(r.colour(fg), r.colour(bg));
            if (ratio < floor) low.push(`${theme}${colorMix ? '+mix' : ''} ${fg} on ${bg}: ${ratio.toFixed(2)}`);
          }
        }
      }
    }
    assert(low.length === 0, `under the floor: ${show(low)}`);
  });

  await check('#10 HomeErrorBoundary: a chunk-load error lets Telegram\'s controls go before its one reload (offClick of the live handler, hide(), then enableVerticalSwipes()), and its card hides the BackButton and turns swipes back on', () => {
    installWindow();
    const calls: string[] = [];
    const savedLocation = fakeWindow.location;
    const savedSession = fakeWindow.sessionStorage;
    fakeWindow.Telegram = { WebApp: fakeTelegram(calls, '7.7') };
    fakeWindow.location = { hash: '', reload: () => void calls.push('location.reload()') };
    fakeWindow.sessionStorage = memoryStorage();
    appLogs.length = 0;
    function Probe({ crash }: { crash: boolean }) {
      useTelegramBackButton(true, noop);
      if (crash) throw Object.assign(new Error('Loading chunk 77 failed.'), { name: 'ChunkLoadError' });
      return null;
    }
    const tree = (crash: boolean) => inIntl('en', createElement(HomeErrorBoundary, null, createElement(Probe, { crash })));
    const controls = () => calls.filter((c) => /^(?:BackButton|enableVerticalSwipes|disableVerticalSwipes|location)/.test(c));
    const m = mount(tree(false), { onCaughtError: noop, onUncaughtError: noop });
    try {
      assert(show(controls()) === show(['BackButton.hide()', 'BackButton.onClick(fn1)', 'BackButton.show()']), `mounted: ${show(calls)}`);
      calls.length = 0;
      m.render(tree(true));
      const steps = controls();
      const reload = steps.indexOf('location.reload()');
      assert(reload >= 0 && steps.filter((c) => c === 'location.reload()').length === 1, `one reload: ${show(steps)}`);
      assert(show(steps.slice(0, reload)) === show(['BackButton.offClick(fn1)', 'BackButton.hide()', 'enableVerticalSwipes()']), `before the reload: ${show(steps)}`);
      const card = steps.slice(reload + 1);
      assert(card.includes('BackButton.hide()') && card.includes('enableVerticalSwipes()') && !card.includes('disableVerticalSwipes()'), `the card: ${show(card)}`);
      assert(fakeWindow.sessionStorage.getItem(CHUNK_RELOAD_KEY) !== null, 'the reload guard is set');
      assert(appLogs.some((l) => l.startsWith('[calendar-home] The home failed to render')), `logged: ${show(appLogs)}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
      fakeWindow.location = savedLocation;
      fakeWindow.sessionStorage = savedSession;
      appLogs.length = 0;
    }
  });

  await check('#11 React logged no warning', () => {
    assert(reactWarnings.length === 0, show(reactWarnings));
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

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
//    tokens components/app-ui/theme.ts defines;
//  - the storage helpers (src/lib/calendar-view/home-storage.ts): the per-user keys, the
//    tab in sessionStorage and the layout in localStorage, and their defaults with no
//    window, with storage that throws (on the property, on get, on set) and for unknown
//    values;
//  - the Month's colour tokens in components/app-ui/theme.ts: each in light and dark; on Telegram's
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
import { createRequire } from 'module';
import React, { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { HomeTabs, PANEL_IDS, TAB_IDS, TABS_CSS } from '../app/[locale]/dashboard/HomeTabs';
import { APP_THEME_CSS } from '../components/app-ui/theme';
import { cascade as cascadeOf, contrast, cssBlocks, customProps, resolver as resolverOf, TEXT_PAIRS, TG_ALL, type Theme } from './lib/css-resolve';
import { CHUNK_RELOAD_KEY, HomeErrorBoundary } from '../app/[locale]/dashboard/HomeErrorBoundary';
import { useTelegramBackButton } from '../src/lib/telegram-ui';
import { homeTabKey, monthLayoutKey, readHomeTab, readMonthLayout, writeHomeTab, writeMonthLayout, type HomeTab } from '../src/lib/calendar-view/home-storage';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
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

// ---- A small fake DOM for react-dom/client (no jsdom in node_modules), as in smoke-calendar-home-render.ts ----

const HTML_NS = 'http://www.w3.org/1999/xhtml';
type Listener = { type: string; capture: boolean; fn: (event: Row) => void };

class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  listeners: Listener[] = [];
  constructor(
    public nodeType: number,
    public nodeName: string,
  ) {}
  get ownerDocument(): Row {
    return fakeDocument;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get parentElement(): FakeNode | null {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  appendChild(child: FakeNode): FakeNode {
    child.parentNode?.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
    if (!before) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(value: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (value) this.appendChild(new FakeText(String(value)));
  }
  addEventListener(type: string, fn: (event: Row) => void, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    this.listeners.push({ type, capture, fn });
  }
  removeEventListener(type: string, fn: (event: Row) => void) {
    this.listeners = this.listeners.filter((l) => l.type !== type || l.fn !== fn);
  }
}

class FakeText extends FakeNode {
  constructor(public data: string) {
    super(3, '#text');
  }
  get nodeValue(): string {
    return this.data;
  }
  set nodeValue(value: string) {
    this.data = String(value);
  }
  get textContent(): string {
    return this.data;
  }
  set textContent(value: string) {
    this.data = String(value);
  }
}

class FakeElement extends FakeNode {
  tagName: string;
  attributes = new Map<string, string>();
  style: Row = { setProperty(k: string, v: string) { this[k] = v; }, removeProperty(k: string) { delete this[k]; } };
  constructor(
    public localName: string,
    public namespaceURI: string,
  ) {
    super(1, namespaceURI === HTML_NS ? localName.toUpperCase() : localName);
    this.tagName = this.nodeName;
  }
  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }
  setAttributeNS(_ns: string | null, name: string, value: unknown) {
    this.setAttribute(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  removeAttributeNS(_ns: string | null, name: string) {
    this.attributes.delete(name);
  }
  get className(): string {
    return this.getAttribute('class') ?? '';
  }
  set className(value: string) {
    this.setAttribute('class', value);
  }
  focus() {
    fakeDocument.activeElement = this;
  }
  blur() {
    if (fakeDocument.activeElement === this) fakeDocument.activeElement = fakeDocument.body;
  }
}

const fakeDocument: Row = {
  nodeType: 9,
  nodeName: '#document',
  documentElement: { nodeType: 1, nodeName: 'HTML' },
  createElement: (tag: string) => new FakeElement(String(tag).toLowerCase(), HTML_NS),
  createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns),
  createTextNode: (text: string) => new FakeText(text),
  addEventListener: noop,
  removeEventListener: noop,
};
fakeDocument.body = new FakeElement('body', HTML_NS);
fakeDocument.activeElement = fakeDocument.body;

/** A Storage-like object over a Map. */
function memoryStorage(saved = new Map<string, string>()): Row {
  return {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, String(v)),
    removeItem: (k: string) => void saved.delete(k),
  };
}

const fakeWindow: Row = {
  document: fakeDocument,
  HTMLIFrameElement: class {},
  addEventListener: noop,
  removeEventListener: noop,
  location: { hash: '' },
  sessionStorage: memoryStorage(),
  localStorage: memoryStorage(),
};
fakeDocument.defaultView = fakeWindow;

const g = globalThis as Row;
function installWindow() {
  g.window = fakeWindow;
  g.document = fakeDocument;
  g.IS_REACT_ACT_ENVIRONMENT = true;
}

type Mounted = {
  container: FakeElement;
  render: (el: ReactElement) => void;
  click: (el: FakeNode) => void;
  /** A keydown on `el`; returns the event, to see whether it was taken (defaultPrevented). */
  key: (el: FakeNode, key: string) => Row;
  unmount: () => void;
};

function mount(el: ReactElement, rootOptions?: Row): Mounted {
  const { createRoot } = nodeRequire('react-dom/client');
  const container = new FakeElement('div', HTML_NS);
  const root = createRoot(container, rootOptions);
  React.act(() => root.render(el));
  const dispatch = (target: FakeNode, type: string, extra: Row): Row => {
    const event: Row = {
      type,
      target,
      srcElement: target,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      isTrusted: true,
      timeStamp: Date.now(),
      button: 0,
      buttons: 0,
      detail: 1,
      ...extra,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation: noop,
      stopImmediatePropagation: noop,
    };
    React.act(() => {
      fakeWindow.event = event;
      for (const capture of [true, false]) {
        for (const l of container.listeners.filter((x) => x.type === type && x.capture === capture)) l.fn(event);
      }
      fakeWindow.event = undefined;
    });
    return event;
  };
  return {
    container,
    render: (next) => React.act(() => root.render(next)),
    click: (target) => void dispatch(target, 'click', {}),
    key: (target, key) => dispatch(target, 'keydown', { key }),
    unmount: () => React.act(() => root.unmount()),
  };
}

function elements(node: FakeNode, out: FakeElement[] = []): FakeElement[] {
  for (const c of node.childNodes) {
    if (c instanceof FakeElement) {
      out.push(c);
      elements(c, out);
    }
  }
  return out;
}
const byRole = (node: FakeNode, role: string) => elements(node).filter((e) => e.getAttribute('role') === role);

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

// The cascade, the resolver and the contrast are scripts/lib/css-resolve.ts's, over the theme's root selector.
const ROOT_SELECTOR = '.ch-app';
const cascade = (css: string, theme: Theme, colorMix: boolean) => cascadeOf(css, ROOT_SELECTOR, theme, colorMix);
const resolver = (theme: Theme, colorMix: boolean, tg: Record<string, string> = {}) => resolverOf(APP_THEME_CSS, ROOT_SELECTOR, theme, colorMix, tg);

/** The tab bar's own pairs (the app's other pairs are smoke-app-ui.ts's): text on the track and on the selected tab, 4.5:1. */
const TAB_TEXT_PAIRS = TEXT_PAIRS.filter(([, bg]) => bg === '--ch-tab-on' || bg === '--ch-tab-track');

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

  await check('#5 the tab bar\'s CSS: every tab at least 44 px tall; nothing under 11 px, every size in px; logical properties only; no hover; no overflow: hidden; the 16 px gutter; the selected tab semibold on --ch-tab-on, the other label in D\'s --ch-muted; a focus ring; only tokens theme.ts defines', () => {
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
    const defined = new Set(cascade(APP_THEME_CSS, 'dark', true).keys());
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
    const lightBlock = cssBlocks(APP_THEME_CSS).find(([p]) => p === '.ch-app');
    const darkBlock = cssBlocks(APP_THEME_CSS).find(([p]) => p === ".ch-app[data-theme='dark']");
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
    const shadow = (theme: Theme) => cascade(APP_THEME_CSS, theme, true).get('--ch-tab-shadow');
    assert(shadow('light') === '0 1px 2px rgba(26, 26, 46, 0.14)' && shadow('dark') === 'none', `the tab shadow: ${shadow('light')} / ${shadow('dark')}`);
  });

  await check('#9 the tab bar\'s contrast floor on the fallbacks (a browser: no Telegram params), light and dark, with and without color-mix: the selected tab\'s text and the other tab\'s label at least 4.5:1 on what they sit on (the app\'s other pairs are smoke-app-ui.ts\'s)', () => {
    assert(show(TAB_TEXT_PAIRS) === show([['--ch-tab-on-text', '--ch-tab-on'], ['--ch-muted', '--ch-tab-track']]), `the tabs' pairs: ${show(TAB_TEXT_PAIRS)}`);
    const low: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      for (const colorMix of [false, true]) {
        const r = resolver(theme, colorMix);
        for (const [fg, bg] of TAB_TEXT_PAIRS) {
          const ratio = contrast(r.colour(fg), r.colour(bg));
          if (ratio < 4.5) low.push(`${theme}${colorMix ? '+mix' : ''} ${fg} on ${bg}: ${ratio.toFixed(2)}`);
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

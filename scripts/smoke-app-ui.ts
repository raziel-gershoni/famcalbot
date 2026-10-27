// Smoke test for the app's design layer (components/app-ui/; F1 of the screens redesign,
// plan docs/superpowers/plans/2026-10-27-app-ui-F1.md, spec 2026-10-19-screens-and-colours §4):
//  - the tokens: every --ch-* of the parent of F1 (scripts/fixtures/app-ui-tokens-golden.json,
//    resolved from its CSS) resolves to the same colour from APP_THEME_CSS on .ch-app, in
//    light and dark, with color-mix and without, with no Telegram params and with every one set;
//  - the CSS lint over the theme and the screen: nothing under 11 px, taps at least 44 px,
//    logical properties only, no hover, no hex outside the token blocks;
//  - contrast: the text pairs reach 4.5:1 and the marks 3:1, in light and dark, with color-mix
//    on and off, in a browser (no Telegram params) and under a Telegram theme;
//  - the frame hangs on .ch-screen only: the theme scope a sheet brings into another page
//    gets no frame and no page paint;
//  - AppScreen (in real React on a small fake DOM, with a fake Telegram.WebApp): its root, the
//    scheme it provides, and Telegram's BackButton, which shows exactly while onBack is set,
//    calls the latest onBack, and goes with the screen; AppScope takes no BackButton and no
//    Telegram colours; and no other file calls useTelegramBackButton but the three clients
//    W1 and W3 still have to move;
//  - the layer's boundary: nothing in components/app-ui/ imports from app/ or a server module,
//    so every screen can take it into its client bundle;
//  - the cards (renderToString in en, he and ru): StateCard draws the home's card with the markup
//    the busy, retry and crash cards always had; MissingParameterCard and the 404 are
//    AppScreens in the page's direction and language with their text from messages (no raw
//    key, no English in he and ru), and show no BackButton, in Telegram or in a browser; the
//    gate's card (PageGate's NoCredentialCard) in the app look closes the Mini App or links on;
//  - an unknown path under a locale calls notFound() (the catch-all), which Next answers with
//    app/[locale]/not-found.tsx;
//  - the dashboard's redirect (the 404's way back, the menu button, a launch with no user_id), in
//    real React with a fake router and Telegram: no colour call, the app loader, a push for a
//    Telegram user, and the app-look gate card without one, in a browser and inside Telegram;
//  - the home's --ch-top-h: published on the root through AppScreen's ref, and on the first commit,
//    when React has not attached that ref yet, on the wrapper's parent, the same element.
// React must log no warning. No network, no DB, no Redis.
//
// Run with the fake env from the task brief (no dotenv), under two clocks:
//   TZ=UTC npx tsx scripts/smoke-app-ui.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-app-ui.ts

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { APP_THEME_CSS } from '../components/app-ui/theme';
import { APP_SCREEN_CSS } from '../components/app-ui/screen';
import { AppScope, AppScreen, useAppScheme } from '../components/app-ui/AppScreen';
import { MissingParameterCard, NotFoundCard, StateCard, type StateCardProps } from '../components/app-ui/StateCard';
import NotFound from '../app/[locale]/not-found';
import UnknownPath from '../app/[locale]/[...rest]/page';
import { NoCredentialCard } from '../app/[locale]/PageGate';
import TelegramDashboardRedirect from '../app/[locale]/dashboard/TelegramDashboardRedirect';
import { publishTopHeight } from '../app/[locale]/dashboard/CalendarHome';
import { contrast, MARK_PAIRS, resolver, TEXT_PAIRS, TG_ALL, type Theme } from './lib/css-resolve';
import { byRole, elements, fakeTelegram, fakeWindow, installWindow, mount, type Row } from './lib/fake-dom';

const ROOT = path.resolve(__dirname, '..');
const ROOT_SELECTOR = '.ch-app';

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
const messages: Record<string, Row> = {
  en: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8')),
  he: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/he.json'), 'utf8')),
  ru: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/ru.json'), 'utf8')),
};

// ---- Rendering ----

/** Inside next-intl's provider, as the layout gives it to every page. */
function inIntl(locale: string, el: ReactElement): ReactElement {
  // The provider's props type makes children required; createElement takes them as its third argument.
  return createElement(NextIntlClientProvider, { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as never, el);
}

/** The screen and the scope with their children passed as createElement arguments (the lint rule forbids the prop). */
const ScreenProbe = AppScreen as unknown as (props: Omit<ComponentProps<typeof AppScreen>, 'children'>) => ReactElement;
const ScopeProbe = AppScope as unknown as () => ReactElement;

const CardProbe = StateCard as unknown as (props: StateCardProps) => ReactElement;

/** The text a reader sees: style sheets, tags and React's text separators out, entities decoded, spaces collapsed. */
const textOf = (html: string) =>
  html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ')
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** The markup without the style sheets. */
const markupOf = (html: string) => html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');

/** A part that shows the scheme useAppScheme gives it. */
function SchemeProbe() {
  return createElement('span', { 'data-probe': 'scheme' }, useAppScheme());
}

/** The calls the fake Telegram recorded for the BackButton, a handler as `fn` (offClick removes by identity: the fake's backHandlers show it went). */
const backCalls = (calls: string[]) => calls.filter((c) => c.startsWith('BackButton')).map((c) => c.replace(/fn\d+/, 'fn'));

// ---- React must not warn ----

const reactWarnings: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('[telegram-ui]')) return original(...args);
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's.
    if (text.startsWith('(node:')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- The CSS, as the lint reads it ----

const CSS = APP_THEME_CSS + APP_SCREEN_CSS;

/** The body of the rule whose selector is exactly `selector`, in `css`. */
function rule(css: string, selector: string): string {
  const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
  assert(m, `no rule ${selector}`);
  return m[1];
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const hexOf = ([r, g, b]: [number, number, number]) => `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

// ---- The checks ----

async function main() {
  await check('#1 the tokens: every --ch-* of the parent of F1 (the golden, resolved from its CSS) resolves to the same colour, or the same text for a shadow, from APP_THEME_CSS on .ch-app: light and dark, color-mix on and off, no Telegram params and every param set; none missing', () => {
    const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/app-ui-tokens-golden.json'), 'utf8')) as { combos: Record<string, Record<string, number[] | string>> };
    const names = Object.keys(golden.combos).sort();
    assert(show(names) === show(['dark/mix/plain', 'dark/mix/tg', 'dark/nomix/plain', 'dark/nomix/tg', 'light/mix/plain', 'light/mix/tg', 'light/nomix/plain', 'light/nomix/tg']), `the golden's combinations: ${show(names)}`);
    const tokens = Object.keys(golden.combos['light/mix/plain']);
    assert(tokens.length >= 43, `the golden holds ${tokens.length} tokens`);
    const problems: string[] = [];
    for (const name of names) {
      const [theme, mix, tg] = name.split('/');
      const r = resolver(APP_THEME_CSS, ROOT_SELECTOR, theme as Theme, mix === 'mix', tg === 'tg' ? TG_ALL : {});
      for (const [token, want] of Object.entries(golden.combos[name])) {
        if (!r.props.has(token)) {
          problems.push(`${name} ${token}: missing`);
          continue;
        }
        const got = r.value(token);
        const same = 'rgb' in got ? Array.isArray(want) && got.rgb.every((c, i) => round(c) === want[i]) : got.text === want;
        if (!same) problems.push(`${name} ${token}: ${show('rgb' in got ? got.rgb.map(round) : got.text)}, want ${show(want)}`);
      }
    }
    assert(problems.length === 0, `${problems.length} differ, first: ${show(problems.slice(0, 5))}`);
  });

  await check('#2 the lint over the theme and the screen: nothing under 11 px and every size in px; .ch-btn, .ch-icon-btn and .ch-sheet-close at least 44 px; logical properties only; no hover; no hex or rgb() outside the token blocks (the page paint\'s dark fallback is the dark --ch-bg\'s own)', () => {
    const sizes = [...CSS.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    assert(sizes.length > 5 && Math.min(...sizes) >= 11, `font sizes: ${show(sizes)}`);
    assert(!/font-size:\s*[\d.]+(?:em|rem|%)|font:\s/.test(CSS), 'every font size in px (so the floor is checkable)');
    for (const selector of ['.ch-btn', '.ch-icon-btn', '.ch-sheet-close']) {
      const css = selector === '.ch-icon-btn' ? APP_SCREEN_CSS : APP_THEME_CSS;
      const min = /min-height:\s*(\d+)px/.exec(rule(css, selector));
      assert(min && Number(min[1]) >= 44, `${selector} min-height ${min?.[1]}`);
    }
    for (const [css, selector] of [[APP_THEME_CSS, '.ch-btn'], [APP_SCREEN_CSS, '.ch-icon-btn']] as const) {
      const body = rule(css, selector);
      assert(/min-width:\s*44px/.test(body), `${selector} min-width 44px`);
    }
    assert(/block-size:\s*44px/.test(rule(APP_SCREEN_CSS, '.ch-icon-btn')) && /inline-size:\s*44px/.test(rule(APP_SCREEN_CSS, '.ch-icon-btn')), '.ch-icon-btn is 44 x 44');
    const physical = CSS.match(/(?:margin|padding|border)-(?:left|right)|(?:^|[\s;{])(?:left|right)\s*:|text-align:\s*(?:left|right)|float:/g);
    assert(!physical, `physical properties: ${show(physical)}`);
    assert(!/:hover/.test(CSS), 'no hover styles');
    // A token block's declarations are tokens (the shades live there); the one exemption outside is the dark page paint's
    // own declaration (html has no tokens above it), whose fallback is checked against the dark --ch-bg's below.
    const paint = /(html:has\(\.ch-screen\[data-theme='dark'\]\) \{\s*)background-color:\s*var\(--tg-theme-bg-color,\s*#[0-9a-f]{6}\);/i;
    assert(paint.test(APP_SCREEN_CSS), 'the dark page paint declaration');
    const outside = CSS.replace(/^\s*--[\w-]+\s*:[^;]*;/gm, '').replace(paint, '$1');
    const literal = outside.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi);
    assert(!literal, `colour literals outside the token blocks: ${show(literal)}`);
    const dark = /html:has\(\.ch-screen\[data-theme='dark'\]\) \{[^}]*var\(--tg-theme-bg-color, (#[0-9a-f]{6})\)/i.exec(APP_SCREEN_CSS)?.[1];
    const darkBg = /\.ch-app\[data-theme='dark'\] \{[^}]*--ch-bg: var\(--tg-theme-bg-color, (#[0-9a-f]{6})\)/i.exec(APP_THEME_CSS)?.[1];
    assert(dark && dark === darkBg, `the dark page paint ${dark} is the dark --ch-bg's fallback ${darkBg}`);
  });

  await check('#2b contrast: the text pairs reach 4.5:1 and the marks that tell whose an item is 3:1, in light and dark, with color-mix on and off, in a browser (no Telegram params) and under a Telegram theme (stand-ins: the fallback palette sent as Telegram params, since the repo holds no captured device themes; TG_ALL, a different grey per param, is #1\'s and the tabs smoke\'s reads)', () => {
    const paramOf: Record<string, string> = {
      bg: '--ch-bg',
      text: '--ch-text',
      hint: '--ch-hint',
      link: '--ch-accent',
      'accent-text': '--ch-accent',
      // The dark primary button's own fallback (--brand-primary, #7c5cfc) is 4.38:1 under white text; the Month's fill (#6d4ff0) is the pair the floors cover.
      button: '--ch-mine-solid',
      'button-text': '--ch-button-text',
      'secondary-bg': '--ch-surface',
      'section-bg': '--ch-section',
      'section-separator': '--ch-separator',
      'destructive-text': '--ch-danger',
    };
    const telegramTheme = (theme: Theme): Record<string, string> => {
      const fallbacks = resolver(APP_THEME_CSS, ROOT_SELECTOR, theme, false);
      return Object.fromEntries(Object.entries(paramOf).map(([param, token]) => [`--tg-theme-${param}-color`, hexOf(fallbacks.colour(token))]));
    };
    const low: string[] = [];
    let compared = 0;
    for (const theme of ['light', 'dark'] as const) {
      for (const colorMix of [false, true]) {
        for (const [look, tg] of [['browser', {}], ['telegram', telegramTheme(theme)]] as const) {
          const r = resolver(APP_THEME_CSS, ROOT_SELECTOR, theme, colorMix, tg);
          for (const [pairs, floor] of [[TEXT_PAIRS, 4.5], [MARK_PAIRS, 3]] as const) {
            for (const [fg, bg] of pairs) {
              compared++;
              const ratio = contrast(r.colour(fg), r.colour(bg));
              if (ratio < floor) low.push(`${theme}${colorMix ? '+mix' : ''} ${look} ${fg} on ${bg}: ${ratio.toFixed(2)}`);
            }
          }
        }
      }
    }
    assert(compared === 2 * 2 * 2 * (TEXT_PAIRS.length + MARK_PAIRS.length), `compared ${compared} pairs`);
    assert(low.length === 0, `under the floor: ${show(low)}`);
  });

  await check('#3 the frame hangs on .ch-screen only: its rule (the stable height, the safe areas, overflow-x: clip) exists once and on that class alone; no rule of the theme or the screen hangs on .ch-standalone; every html-level rule is .ch-screen\'s; the theme brings no html-level rule', () => {
    const frame = rule(APP_SCREEN_CSS, '.ch-screen');
    assert(frame.includes('min-height: var(--tg-viewport-stable-height, 100dvh)') && /overflow-x:\s*clip/.test(frame) && frame.includes('--tg-safe-area-inset-top') && frame.includes('--tg-content-safe-area-inset-top'), `the frame: ${frame}`);
    assert((CSS.match(/min-height:\s*var\(--tg-viewport-stable-height/g) ?? []).length === 1, 'the stable height is declared once');
    assert(!/ch-standalone/.test(CSS), 'no rule hangs on .ch-standalone');
    assert(!/html:has|html\s*\{|:root\s*\{/.test(APP_THEME_CSS), 'the theme scope brings no html-level rule');
    const htmlLevel = [...APP_SCREEN_CSS.matchAll(/^(html[^{]*)\{/gm)].map((m) => m[1].trim());
    assert(show(htmlLevel) === show(['html:has(.ch-screen)', "html:has(.ch-screen[data-theme='dark'])"]), `the html-level rules: ${show(htmlLevel)}`);
    // The frame properties are on no other root rule: not on the theme's .ch-app blocks.
    for (const selector of ['.ch-app', ".ch-app[data-theme='dark']"]) {
      const body = rule(APP_THEME_CSS, selector);
      assert(!/(?:min-height|padding-block-start|padding-inline|overflow-x)\s*:/.test(body), `${selector} carries a frame property`);
    }
  });

  await check('#4 AppScreen: the root is .ch-app .ch-screen plus its class, with data-theme, dir and lang, and both style sheets come first; its ref gets the root; useAppScheme gives the scheme (Telegram\'s, dark here)', () => {
    for (const locale of ['en', 'he', 'ru']) {
      const html = renderToString(inIntl(locale, createElement(ScreenProbe, { className: 'ch-home' }, createElement('i', { id: 'child' }))));
      const dir = locale === 'he' ? 'rtl' : 'ltr';
      assert(html.startsWith(`<div class="ch-app ch-screen ch-home" data-theme="light" dir="${dir}" lang="${locale}"><style>`), `${locale}: ${html.slice(0, 140)}`);
      assert(html.indexOf(APP_THEME_CSS) < html.indexOf(APP_SCREEN_CSS) && html.indexOf(APP_SCREEN_CSS) < html.indexOf('<i id="child">'), `${locale}: the theme, the screen, then the children`);
    }
    const bare = renderToString(inIntl('en', createElement(ScreenProbe, null, createElement('i'))));
    assert(bare.startsWith('<div class="ch-app ch-screen" data-theme="light" dir="ltr" lang="en">'), `no class of its own: ${bare.slice(0, 100)}`);
    installWindow();
    const calls: string[] = [];
    const tg = fakeTelegram(calls, '7.7');
    tg.colorScheme = 'dark';
    fakeWindow.Telegram = { WebApp: tg };
    const rootRef: { current: HTMLDivElement | null } = { current: null };
    const m = mount(inIntl('he', createElement(ScreenProbe, { className: 'ch-home', rootRef }, createElement(SchemeProbe))));
    try {
      const home = elements(m.container).find((e) => e.className === 'ch-app ch-screen ch-home');
      assert(home && home.getAttribute('data-theme') === 'dark' && home.getAttribute('dir') === 'rtl' && home.getAttribute('lang') === 'he', 'the mounted root');
      assert(elements(m.container).find((e) => e.getAttribute('data-probe') === 'scheme')?.textContent === 'dark', "useAppScheme gives Telegram's scheme");
      assert(calls.includes('setHeaderColor(bg_color)') && calls.includes('setBackgroundColor(bg_color)'), `Telegram takes the theme's colours: ${show(calls)}`);
      assert((rootRef.current as unknown) === home, 'rootRef is the root element');
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#4b AppScreen owns the BackButton: nothing shown without onBack (it only hides a button the client kept); with onBack it registers one handler and shows; a tap calls the latest onBack; clearing onBack takes the handler off and hides; a new onBack is called by the next tap; unmounting takes it off and hides', () => {
    installWindow();
    const calls: string[] = [];
    const tg = fakeTelegram(calls, '7.7');
    fakeWindow.Telegram = { WebApp: tg };
    const taps: string[] = [];
    const screen = (onBack?: (() => void) | null) => inIntl('en', createElement(ScreenProbe, { onBack }, createElement('i')));
    const m = mount(screen());
    try {
      assert(show(backCalls(calls)) === show(['BackButton.hide()']), `no onBack: ${show(backCalls(calls))}`);
      assert(tg.backHandlers.length === 0, 'no handler registered');
      calls.length = 0;
      m.render(screen(() => taps.push('first')));
      assert(show(backCalls(calls)) === show(['BackButton.onClick(fn)', 'BackButton.show()']), `onBack set: ${show(backCalls(calls))}`);
      assert(tg.backHandlers.length === 1, 'one handler');
      tg.backHandlers[0]();
      assert(show(taps) === show(['first']), `a tap: ${show(taps)}`);
      // A new onBack with the button still showing: no new registration, the tap reaches the latest one.
      calls.length = 0;
      m.render(screen(() => taps.push('second')));
      assert(backCalls(calls).length === 0 && tg.backHandlers.length === 1, `a new onBack re-registers nothing: ${show(backCalls(calls))}`);
      tg.backHandlers[0]();
      assert(show(taps) === show(['first', 'second']), `the latest onBack: ${show(taps)}`);
      calls.length = 0;
      m.render(screen(null));
      assert(show(backCalls(calls)) === show(['BackButton.offClick(fn)', 'BackButton.hide()']) && tg.backHandlers.length === 0, `onBack cleared: ${show(backCalls(calls))}`);
      calls.length = 0;
      m.render(screen(() => taps.push('third')));
      assert(show(backCalls(calls)) === show(['BackButton.onClick(fn)', 'BackButton.show()']), `set again: ${show(backCalls(calls))}`);
    } finally {
      calls.length = 0;
      m.unmount();
    }
    assert(show(backCalls(calls)) === show(['BackButton.offClick(fn)', 'BackButton.hide()']) && tg.backHandlers.length === 0, `unmount: ${show(backCalls(calls))}`);
    fakeWindow.Telegram = undefined;
  });

  await check("#4c AppScope (a sheet's scope inside a page that is no screen): .ch-app .ch-standalone with the theme only and the device's scheme; no BackButton call, no Telegram colour call, no frame; the scheme reaches useAppScheme", () => {
    installWindow();
    const calls: string[] = [];
    const tg = fakeTelegram(calls, '7.7');
    tg.colorScheme = 'dark';
    fakeWindow.Telegram = { WebApp: tg };
    const m = mount(inIntl('he', createElement(ScopeProbe, null, createElement(SchemeProbe))));
    try {
      const scope = elements(m.container).find((e) => e.className === 'ch-app ch-standalone');
      assert(scope && scope.getAttribute('data-theme') === 'dark' && scope.getAttribute('dir') === 'rtl' && scope.getAttribute('lang') === 'he', 'the mounted scope');
      assert(elements(m.container).find((e) => e.getAttribute('data-probe') === 'scheme')?.textContent === 'dark', 'useAppScheme');
      assert(!calls.some((c) => /^(?:BackButton|setHeaderColor|setBackgroundColor)/.test(c)), `no BackButton or colour call: ${show(calls)}`);
      const styles = elements(m.container).filter((e) => e.localName === 'style').map((e) => e.textContent);
      assert(styles.length === 1 && styles[0] === APP_THEME_CSS, 'the theme is its only style sheet');
      assert(byRole(m.container, 'dialog').length === 0, 'it brings no content of its own');
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
    const html = renderToString(inIntl('en', createElement(ScopeProbe, null, createElement('i'))));
    assert(html.startsWith('<div class="ch-app ch-standalone" data-theme="light" dir="ltr" lang="en"><style>') && !html.includes('ch-screen'), 'rendered on the server: no ch-screen');
  });

  await check("#5 one BackButton owner per screen: no file calls useTelegramBackButton but AppScreen.tsx (the hook is src/lib/telegram-ui.ts's), except the Settings, Calendars and Pair clients, which W1 and W3 move onto AppScreen; the list is pinned, so a new caller fails", () => {
    const calls: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(entry.name)) {
          const code = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
          if (/\buseTelegramBackButton\(/.test(code)) calls.push(rel);
        }
      }
    };
    for (const dir of ['app', 'components', 'src']) walk(dir);
    const expected = [
      'app/[locale]/calendars/CalendarsClient.tsx',
      'app/[locale]/pair/PairClient.tsx',
      'app/[locale]/settings/SettingsClient.tsx',
      'components/app-ui/AppScreen.tsx',
      'src/lib/telegram-ui.ts',
    ];
    assert(show(calls.sort()) === show(expected), `callers: ${show(calls)}, want ${show(expected)}`);
    const owner = fs.readFileSync(path.join(ROOT, 'components/app-ui/AppScreen.tsx'), 'utf8');
    assert((owner.match(/useTelegramBackButton\(/g) ?? []).length === 1, 'AppScreen makes the one call');
  });

  await check('#6 the layer is client-safe and stands alone: no file of components/app-ui/ imports from app/, src/services or a server-only package; the files the layer is made of are all there', () => {
    const dir = path.join(ROOT, 'components/app-ui');
    const files = fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).sort();
    for (const want of ['AppScreen.tsx', 'BottomSheet.tsx', 'form-kit.tsx', 'screen.ts', 'theme.ts']) assert(files.includes(want), `${want} is not in components/app-ui: ${show(files)}`);
    const forbidden = /^@\/app\/|^(?:\.\.\/)+app\/|(?:^|\/)src\/(?:services|utils|config)\/|^@prisma|^@upstash|^ioredis|^server-only$|^date-fns-tz$|^@hebcal\/|^googleapis$/;
    const bad: string[] = [];
    for (const file of files) {
      const code = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
      for (const m of code.matchAll(/(?:from\s+|import\(\s*|require\(\s*)['"]([^'"]+)['"]/g)) {
        if (forbidden.test(m[1])) bad.push(`${file}: ${m[1]}`);
      }
    }
    assert(bad.length === 0, `imports the layer must not make: ${show(bad)}`);
  });

  await check('#7 StateCard draws the home\'s card with the markup its busy, retry and crash cards always had: a status paragraph title with a button; a title, a body and a button; the crash card an alert with an h1 and a ch-crash class; a link action is an anchor in the same classes; a second action stacks under the first, quieter', () => {
    const html = (props: StateCardProps) => markupOf(renderToString(inIntl('en', createElement(CardProbe, props))));
    // HomeCard before F1 (CalendarHome.tsx): busy
    assert(html({ title: 'Busy', action: { label: 'Retry', onClick: noop } }) === '<div class="ch-home-card" role="status"><p class="ch-home-card-title">Busy</p><button type="button" class="ch-btn ch-btn-primary ch-home-card-action">Retry</button></div>', 'the busy card');
    assert(html({ title: 'Oops', body: 'Try again soon', action: { label: 'Retry', onClick: noop } }) === '<div class="ch-home-card" role="status"><p class="ch-home-card-title">Oops</p><p class="ch-home-card-body">Try again soon</p><button type="button" class="ch-btn ch-btn-primary ch-home-card-action">Retry</button></div>', 'the retry card');
    // HomeCrash before F1 (HomeErrorBoundary.tsx)
    assert(html({ tone: 'crash', title: 'Stuck', body: 'Reload', action: { label: 'Reload', onClick: noop } }) === '<div class="ch-home-card ch-crash" role="alert"><h1 class="ch-home-card-title">Stuck</h1><p class="ch-home-card-body">Reload</p><button type="button" class="ch-btn ch-btn-primary ch-home-card-action">Reload</button></div>', 'the crash card');
    assert(html({ title: 'No actions' }) === '<div class="ch-home-card" role="status"><p class="ch-home-card-title">No actions</p></div>', 'no action, no body');
    assert(html({ title: 'T', action: { label: 'Go', href: '/he/dashboard' } }) === '<div class="ch-home-card" role="status"><p class="ch-home-card-title">T</p><a class="ch-btn ch-btn-primary ch-home-card-action" href="/he/dashboard">Go</a></div>', 'a link action');
    assert(
      html({ title: 'T', action: { label: 'One', href: '/a' }, secondary: { label: 'Two', href: '/b' } }) ===
        '<div class="ch-home-card" role="status"><p class="ch-home-card-title">T</p><div class="ch-home-card-actions"><a class="ch-btn ch-btn-primary ch-home-card-action" href="/a">One</a><a class="ch-btn ch-home-card-action" href="/b">Two</a></div></div>',
      'two actions',
    );
    assert(/\.ch-home-card-action \{[^}]*text-decoration:\s*none/.test(APP_SCREEN_CSS) && /\.ch-home-card-actions \{[^}]*flex-direction:\s*column/.test(APP_SCREEN_CSS), "a link reads as the card's button, and two stack");
  });

  await check("#7b MissingParameterCard and the 404 in en, he and ru: an AppScreen with the page's direction and language, the card's h1 and text from messages (no raw key; no Latin letters in he and ru), the 404's link to /<locale>/dashboard, no BackButton in Telegram or in a browser; the card paints through the theme's tokens", () => {
    for (const locale of ['en', 'he', 'ru']) {
      const dir = locale === 'he' ? 'rtl' : 'ltr';
      const ui = messages[locale].ui as Row;
      const missing = renderToString(inIntl(locale, createElement(MissingParameterCard)));
      assert(missing.startsWith(`<div class="ch-app ch-screen" data-theme="light" dir="${dir}" lang="${locale}">`), `${locale}: the root: ${missing.slice(0, 120)}`);
      assert(markupOf(missing).includes(`<h1 class="ch-home-card-title">${ui.missingParameter.title.replace(/'/g, '&#x27;')}</h1>`), `${locale}: the h1`);
      assert(textOf(missing) === `${ui.missingParameter.title} ${ui.missingParameter.body}`, `${locale}: the text: ${textOf(missing)}`);
      const gone = renderToString(inIntl(locale, createElement(NotFound)));
      assert(gone.startsWith(`<div class="ch-app ch-screen" data-theme="light" dir="${dir}" lang="${locale}">`), `${locale}: the 404's root`);
      assert(textOf(gone) === `${ui.notFound.title} ${ui.notFound.body} ${ui.notFound.home}`, `${locale}: the 404's text: ${textOf(gone)}`);
      assert(markupOf(gone).includes(`<a class="ch-btn ch-btn-primary ch-home-card-action" href="/${locale}/dashboard">${ui.notFound.home}</a>`), `${locale}: the way back`);
      for (const html of [missing, gone]) {
        assert(!/\bui\.(?:missingParameter|notFound)|ui\./.test(textOf(html)), `${locale}: a raw key`);
        if (locale !== 'en') assert(!/[A-Za-z]/.test(textOf(html)), `${locale}: Latin letters in ${textOf(html)}`);
      }
    }
    // A browser has no Telegram.WebApp calls to make; Telegram gets the BackButton hidden and never shown
    installWindow();
    for (const card of [MissingParameterCard, NotFoundCard]) {
      const plain = mount(inIntl('he', createElement(card)));
      try {
        assert(elements(plain.container).some((e) => e.className === 'ch-app ch-screen' && e.getAttribute('dir') === 'rtl'), 'mounted in a browser');
      } finally {
        plain.unmount();
      }
      const calls: string[] = [];
      fakeWindow.Telegram = { WebApp: fakeTelegram(calls, '7.7') };
      const inTelegram = mount(inIntl('en', createElement(card)));
      try {
        assert(show(backCalls(calls)) === show(['BackButton.hide()']), `in Telegram: ${show(backCalls(calls))}`);
      } finally {
        inTelegram.unmount();
        fakeWindow.Telegram = undefined;
      }
    }
    // The loader and the cards paint through the same token: Telegram's bg_color first, then the fallback
    const root = rule(APP_THEME_CSS, '.ch-app');
    assert(/--ch-bg:\s*var\(--tg-theme-bg-color,\s*var\(--bg-white\)\)/.test(root) && /background:\s*var\(--ch-bg\)/.test(root), `the root's background: ${root}`);
  });

  await check("#7c PageGate's gate card in the app look (NoCredentialCard): in Telegram its button closes the Mini App; in a browser it links to WhatsApp first and Telegram second, filled then quiet; both are an AppScreen with the card's h1 and no BackButton", () => {
    installWindow();
    const links = { whatsapp: 'https://wa.me/972500000000?text=settings', telegram: 'https://t.me/test_bot?start=dashboard' };
    const calls: string[] = [];
    fakeWindow.Telegram = { WebApp: fakeTelegram(calls, '7.7') };
    const card = (inTelegram: boolean) => inIntl('he', createElement(NoCredentialCard, { look: 'app', inTelegram, links }));
    const tg = mount(card(true));
    try {
      const buttons = elements(tg.container).filter((e) => e.localName === 'button');
      assert(buttons.length === 1 && buttons[0].textContent === messages.he.pageGate.close, `the in-Telegram card's buttons: ${show(buttons.map((b) => b.textContent))}`);
      calls.length = 0;
      tg.click(buttons[0]);
      assert(show(calls.filter((c) => c.startsWith('close'))) === show(['close()']), `the click: ${show(calls)}`);
      assert(elements(tg.container).some((e) => e.localName === 'h1' && e.textContent === messages.he.pageGate.telegramTitle), 'the title is the h1');
    } finally {
      tg.unmount();
      fakeWindow.Telegram = undefined;
    }
    const browser = mount(card(false));
    try {
      const anchors = elements(browser.container).filter((e) => e.localName === 'a');
      assert(show(anchors.map((a) => [a.getAttribute('href'), a.className])) === show([[links.whatsapp, 'ch-btn ch-btn-primary ch-home-card-action'], [links.telegram, 'ch-btn ch-home-card-action']]), `the browser card's links: ${show(anchors.map((a) => [a.getAttribute('href'), a.className]))}`);
    } finally {
      browser.unmount();
    }
  });

  await check("#8 an unknown path under a locale reaches the app's 404: the catch-all page calls notFound(), and the route files are where Next looks (app/[locale]/[...rest]/page.tsx, app/[locale]/not-found.tsx)", () => {
    let digest = '';
    try {
      UnknownPath();
    } catch (err) {
      digest = String((err as Row)?.digest ?? err);
    }
    assert(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/.test(digest), `the catch-all threw ${digest || 'nothing'}`);
    for (const file of ['app/[locale]/[...rest]/page.tsx', 'app/[locale]/not-found.tsx']) assert(fs.existsSync(path.join(ROOT, file)), `no ${file}`);
    const gone = fs.readFileSync(path.join(ROOT, 'app/[locale]/not-found.tsx'), 'utf8');
    assert(/NotFoundCard/.test(gone), 'the 404 is the card');
  });

  await check("#9 TelegramDashboardRedirect is in the app look: a Telegram user gets ready, expand and swipes (no setHeaderColor, no setBackgroundColor), the app loader and a push to their dashboard; with no user the gate card is the app's, in a browser (WhatsApp then Telegram link) and in Telegram (close); no purple anywhere", () => {
    installWindow();
    const { AppRouterContext } = createRequire(__filename)('next/dist/shared/lib/app-router-context.shared-runtime');
    const pushes: string[] = [];
    const router = { push: (href: string) => void pushes.push(href), replace: noop, prefetch: noop, back: noop, forward: noop, refresh: noop };
    const links = { whatsapp: 'https://wa.me/972500000000?text=settings', telegram: 'https://t.me/test_bot?start=dashboard' };
    const el = () =>
      createElement(AppRouterContext.Provider, { value: router }, inIntl('he', createElement(TelegramDashboardRedirect as unknown as (props: Row) => ReactElement, { locale: 'he', links })));
    // AppScreen asks Telegram for the theme's own 'bg_color'; a hex argument is a colour of ours (the old purple was #667eea)
    const colourCalls = (calls: string[]) => calls.filter((c) => /^set(?:Header|Background)Color\(#/.test(c));
    const run = (setup: (tg: Row) => void) => {
      const calls: string[] = [];
      const tg = fakeTelegram(calls, '7.7');
      setup(tg);
      fakeWindow.Telegram = { WebApp: tg };
      pushes.length = 0;
      const m = mount(el());
      const html = elements(m.container);
      return { m, calls, html };
    };
    // A Telegram user: the dashboard's own calls, the loader up while the push goes out
    const user = run((tg) => {
      tg.initDataUnsafe = { user: { id: 5550001 } };
    });
    try {
      assert(show(user.calls.filter((c) => /^(?:ready|expand|enableVerticalSwipes|disableVerticalSwipes)\(/.test(c))) === show(['ready()', 'expand()', 'enableVerticalSwipes()']), `the calls: ${show(user.calls)}`);
      assert(show(colourCalls(user.calls)) === show([]) && user.calls.includes('setHeaderColor(bg_color)'), `a colour of ours: ${show(user.calls)}`);
      assert(show(pushes) === show(['/he/dashboard?user_id=5550001']), `the push: ${show(pushes)}`);
      const loader = user.html.find((e) => e.className === 'ch-loader');
      assert(loader && user.html.some((e) => e.className === 'ch-app ch-screen') && user.html.some((e) => /ch-spin/.test(e.getAttribute('class') ?? '')), 'the app loader');
      assert(user.html.find((e) => e.className === 'ch-visually-hidden')?.textContent === messages.he.pageGate.loading, 'the loading text');
    } finally {
      user.m.unmount();
      fakeWindow.Telegram = undefined;
    }
    // No Telegram user, in a browser (the SDK is there, there is no init data): the browser card
    const browser = run((tg) => {
      tg.initData = '';
    });
    try {
      assert(show(colourCalls(browser.calls)) === show([]), `colours: ${show(browser.calls)}`);
      const anchors = elements(browser.m.container).filter((e) => e.localName === 'a');
      assert(show(anchors.map((a) => [a.getAttribute('href'), a.className])) === show([[links.whatsapp, 'ch-btn ch-btn-primary ch-home-card-action'], [links.telegram, 'ch-btn ch-home-card-action']]), `the browser card: ${show(anchors.map((a) => a.getAttribute('href')))}`);
      assert(elements(browser.m.container).some((e) => e.localName === 'h1' && e.textContent === messages.he.pageGate.browserTitle) && pushes.length === 0, 'the browser title, no push');
      assert(!elements(browser.m.container).some((e) => e.className === 'ch-loader'), 'the loader is gone');
    } finally {
      browser.m.unmount();
      fakeWindow.Telegram = undefined;
    }
    // Inside Telegram with no user: the close card
    const inside = run(noop);
    try {
      assert(show(colourCalls(inside.calls)) === show([]), `colours: ${show(inside.calls)}`);
      const buttons = elements(inside.m.container).filter((e) => e.localName === 'button');
      assert(buttons.length === 1 && buttons[0].textContent === messages.he.pageGate.close, `the in-Telegram card: ${show(buttons.map((b) => b.textContent))}`);
      assert(elements(inside.m.container).some((e) => e.localName === 'h1' && e.textContent === messages.he.pageGate.telegramTitle), 'the Telegram title');
    } finally {
      inside.m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check("#10 --ch-top-h goes on the home's root: through the ref once it is attached; on the first commit React has not attached it yet (a root's ref comes after its children's layout effects), and the wrapper's parent, the same element, takes it; nothing to set it on, nothing thrown", () => {
    const fakeRoot = (): Row => {
      const set: Record<string, string> = {};
      return { set, style: { getPropertyValue: (k: string) => set[k] ?? '', setProperty: (k: string, v: string) => void (set[k] = v) } };
    };
    const topOf = (parent: Row | null, height: number) => ({ parentElement: parent, getBoundingClientRect: () => ({ height }) }) as unknown as HTMLElement;
    const asRef = (el: Row | null) => ({ current: el }) as unknown as { current: HTMLElement | null };
    // The first commit: an empty ref, and the parent is the root
    const parent = fakeRoot();
    publishTopHeight(topOf(parent, 126.4), asRef(null));
    assert(parent.set['--ch-top-h'] === '126px', `the first commit: ${show(parent.set)}`);
    // Later commits: the ref is set and is the one that takes it
    const attached = fakeRoot();
    publishTopHeight(topOf(parent, 140), asRef(attached));
    assert(attached.set['--ch-top-h'] === '140px' && parent.set['--ch-top-h'] === '126px', `through the ref: ${show([attached.set, parent.set])}`);
    // An unchanged height sets nothing again; no root and no ref is no call and no throw
    let writes = 0;
    const counting = fakeRoot();
    const setProperty = counting.style.setProperty;
    counting.style.setProperty = (k: string, v: string) => {
      writes++;
      setProperty(k, v);
    };
    publishTopHeight(topOf(counting, 90), asRef(null));
    publishTopHeight(topOf(counting, 90), asRef(null));
    assert(writes === 1, `an unchanged height is written once: ${writes}`);
    publishTopHeight(topOf(null, 90), asRef(null));
    publishTopHeight(null, asRef(null));
  });

  await check('#99 React logged no warning', () => {
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

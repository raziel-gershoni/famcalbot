// Smoke test for the app's design layer (components/app-ui/; F1 of the screens redesign,
// plan docs/superpowers/plans/2026-10-27-app-ui-F1.md, spec 2026-10-19-screens-and-colours §4):
//  - the tokens: every --ch-* of the parent of F1 (scripts/fixtures/app-ui-tokens-golden.json,
//    resolved from its CSS) resolves to the same colour from APP_THEME_CSS on .ch-app, in
//    light and dark, with color-mix and without, with no Telegram params and with every one set;
//  - the CSS lint over the theme, the screen and the form kit: nothing under 11 px, taps at least 44 px,
//    logical properties only, no hover, no hex outside the token blocks;
//  - contrast: the text pairs reach 4.5:1 and the marks 3:1, in light and dark, with color-mix
//    on and off, in a browser (no Telegram params) and under a Telegram theme;
//  - the frame hangs on .ch-screen only: the theme scope a sheet brings into another page
//    gets no frame and no page paint;
//  - AppScreen (in real React on a small fake DOM, with a fake Telegram.WebApp): its root, the
//    scheme it provides, and Telegram's BackButton, which shows exactly while onBack is set,
//    calls the latest onBack, and goes with the screen; and no other file calls
//    useTelegramBackButton but the two clients W3 still has to move;
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
//  - the pieces W1a added (K1-K10, plan docs/superpowers/plans/2026-10-27-app-ui-W1a-settings.md): ScreenHeader
//    and SectionLabel, Notice, DayChips, AppScreen's grouped ground and what it asks Telegram for, the form kit's
//    additions (a disabled SwitchRow, a note, valueDir, the SaveBar's status, disabled and sticky), the
//    BottomSheet's closeDisabled, and the new CSS (the switch's off outline, the grouped paint, the chips).
// React must log no warning. No network, no DB, no Redis.
//
// Run with the fake env from the task brief (no dotenv), under two clocks:
//   TZ=UTC npx tsx scripts/smoke-app-ui.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-app-ui.ts

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { act, createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { APP_THEME_CSS } from '../components/app-ui/theme';
import { APP_SCREEN_CSS } from '../components/app-ui/screen';
import { AppScreen, useAppScheme } from '../components/app-ui/AppScreen';
import { MissingParameterCard, NotFoundCard, StateCard, type StateCardProps } from '../components/app-ui/StateCard';
import { BottomSheet } from '../components/app-ui/BottomSheet';
import { DayChips, type DayChip } from '../components/app-ui/DayChips';
import { ButtonRow, FORM_CSS, SaveBar, SwitchRow, ValueRow } from '../components/app-ui/form-kit';
import { Notice } from '../components/app-ui/Notice';
import { ScreenHeader, SectionLabel } from '../components/app-ui/ScreenHeader';
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

const CardProbe = StateCard as unknown as (props: StateCardProps) => ReactElement;
const LabelProbe = SectionLabel as unknown as (props: Record<string, never>) => ReactElement;
const NoticeProbe = Notice as unknown as (props: Omit<ComponentProps<typeof Notice>, 'children'>) => ReactElement;
const SheetProbe = BottomSheet as unknown as (props: Omit<ComponentProps<typeof BottomSheet>, 'children'>) => ReactElement;

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

const CSS = APP_THEME_CSS + APP_SCREEN_CSS + FORM_CSS;

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

  await check('#2 the lint over the theme, the screen and the form kit: nothing under 11 px and every size in px; .ch-btn, .ch-icon-btn and .ch-sheet-close at least 44 px; logical properties only; no hover; no hex or rgb() outside the token blocks (the two page paints\' fallbacks are the dark --ch-bg\'s and the light --ch-surface\'s own)', () => {
    const sizes = [...CSS.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    assert(sizes.length > 5 && Math.min(...sizes) >= 11, `font sizes: ${show(sizes)}`);
    // `font: inherit` takes the size from the parent and has none of its own; any other shorthand would hide one.
    assert(!/font-size:\s*[\d.]+(?:em|rem|%)|font:\s+(?!inherit\s*;)/.test(CSS), 'every font size in px (so the floor is checkable)');
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
    // A token block's declarations are tokens (the shades live there); the two exemptions outside are the page paints'
    // own declarations (html has no tokens above it): the dark one's fallback is checked against the dark --ch-bg's, the
    // grouped one's against the light --ch-surface's, below.
    const paint = /(html:has\(\.ch-screen\[data-theme='dark'\]\) \{\s*)background-color:\s*var\(--tg-theme-bg-color,\s*#[0-9a-f]{6}\);/i;
    const groupedPaint = /(html:has\(\.ch-screen\.ch-grouped\) \{\s*)background-color:\s*var\(--tg-theme-secondary-bg-color,\s*#[0-9a-f]{6}\);/i;
    assert(paint.test(APP_SCREEN_CSS), 'the dark page paint declaration');
    assert(groupedPaint.test(APP_SCREEN_CSS), 'the grouped page paint declaration');
    const outside = CSS.replace(/^\s*--[\w-]+\s*:[^;]*;/gm, '').replace(paint, '$1').replace(groupedPaint, '$1');
    const literal = outside.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi);
    assert(!literal, `colour literals outside the token blocks: ${show(literal)}`);
    const dark = /html:has\(\.ch-screen\[data-theme='dark'\]\) \{[^}]*var\(--tg-theme-bg-color, (#[0-9a-f]{6})\)/i.exec(APP_SCREEN_CSS)?.[1];
    const darkBg = /\.ch-app\[data-theme='dark'\] \{[^}]*--ch-bg: var\(--tg-theme-bg-color, (#[0-9a-f]{6})\)/i.exec(APP_THEME_CSS)?.[1];
    assert(dark && dark === darkBg, `the dark page paint ${dark} is the dark --ch-bg's fallback ${darkBg}`);
    const grouped = /html:has\(\.ch-screen\.ch-grouped\) \{[^}]*var\(--tg-theme-secondary-bg-color, (#[0-9a-f]{6})\)/i.exec(APP_SCREEN_CSS)?.[1];
    const lightSurface = /\.ch-app \{[^}]*--ch-surface: var\(--tg-theme-secondary-bg-color, (#[0-9a-f]{6})\)/i.exec(APP_THEME_CSS)?.[1];
    assert(grouped && grouped === lightSurface, `the grouped page paint ${grouped} is the light --ch-surface's fallback ${lightSurface}`);
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

  await check('#3 the frame hangs on .ch-screen only: its rule (the stable height, the safe areas, overflow-x: clip) exists once and on that class alone; no rule of the theme or the screen hangs on .ch-standalone (the scope W1a removed); every html-level rule is .ch-screen\'s; the theme brings no html-level rule', () => {
    const frame = rule(APP_SCREEN_CSS, '.ch-screen');
    assert(frame.includes('min-height: var(--tg-viewport-stable-height, 100dvh)') && /overflow-x:\s*clip/.test(frame) && frame.includes('--tg-safe-area-inset-top') && frame.includes('--tg-content-safe-area-inset-top'), `the frame: ${frame}`);
    assert((CSS.match(/min-height:\s*var\(--tg-viewport-stable-height/g) ?? []).length === 1, 'the stable height is declared once');
    assert(!/ch-standalone/.test(CSS), 'no rule hangs on .ch-standalone');
    assert(!/html:has|html\s*\{|:root\s*\{/.test(APP_THEME_CSS), 'the theme scope brings no html-level rule');
    // In this order: the grouped ground paints over the plain one, and the dark ground over the grouped (same specificity, the later wins).
    const htmlLevel = [...APP_SCREEN_CSS.matchAll(/^(html[^{]*)\{/gm)].map((m) => m[1].trim());
    assert(show(htmlLevel) === show(['html:has(.ch-screen)', 'html:has(.ch-screen.ch-grouped)', "html:has(.ch-screen[data-theme='dark'])"]), `the html-level rules: ${show(htmlLevel)}`);
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

  await check("#5 one BackButton owner per screen: no file calls useTelegramBackButton but AppScreen.tsx (the hook is src/lib/telegram-ui.ts's), except the Calendars and Pair clients, which W3 moves onto AppScreen; the list is pinned, so a new caller fails", () => {
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

  // ---- W1a: the pieces Settings and the screens after it share (ScreenHeader, SectionLabel, Notice, DayChips, the grouped ground, the form kit's additions) ----

  const HeaderProbe = ScreenHeader as unknown as (props: ComponentProps<typeof ScreenHeader>) => ReactElement;
  const ChipsProbe = DayChips as unknown as (props: ComponentProps<typeof DayChips>) => ReactElement;
  const buttonsIn = (m: { container: Parameters<typeof elements>[0] }) => elements(m.container).filter((e) => e.localName === 'button');

  await check("K1 ScreenHeader: the h1 and, where Telegram has no BackButton, an in-page back (a button with its label, the chevron flipped in RTL) that calls onBack; none in Telegram 6.1+ (the BackButton is AppScreen's), none without onBack, none on the server; the file never calls useTelegramBackButton", () => {
    installWindow();
    let backs = 0;
    const header = (onBack?: (() => void) | null) => inIntl('en', createElement(HeaderProbe, { title: 'Settings', backLabel: 'Back', onBack }));
    // A browser (no init data): the in-page back is the way back
    const browser = mount(header(() => void backs++));
    try {
      const buttons = buttonsIn(browser);
      assert(buttons.length === 1 && buttons[0].getAttribute('aria-label') === 'Back' && buttons[0].getAttribute('type') === 'button', `the browser's buttons: ${show(buttons.map((b) => b.getAttribute('aria-label')))}`);
      assert(buttons[0].className === 'ch-icon-btn ch-icon-btn-plain', `the button's classes: ${buttons[0].className}`);
      const svg = elements(browser.container).find((e) => e.localName === 'svg');
      assert(svg && /\bch-flip\b/.test(svg.getAttribute('class') ?? '') && svg.getAttribute('aria-hidden') === 'true', 'the chevron flips in RTL and is hidden from assistive tech');
      browser.click(buttons[0]);
      assert(backs === 1, `a tap calls onBack: ${backs}`);
      const head = elements(browser.container).find((e) => e.localName === 'header');
      assert(head?.className === 'ch-screen-head' && elements(browser.container).some((e) => e.localName === 'h1' && e.className === 'ch-screen-title' && e.textContent === 'Settings'), 'the header and its h1');
    } finally {
      browser.unmount();
    }
    // No onBack: no button, in a browser too
    for (const none of [undefined, null]) {
      const bare = mount(header(none));
      try {
        assert(buttonsIn(bare).length === 0, `onBack ${none}: no button`);
      } finally {
        bare.unmount();
      }
    }
    // Telegram 7.7 has the BackButton (AppScreen's); 6.0 has none, and the in-page back returns
    for (const [version, want] of [['7.7', 0], ['6.0', 1]] as const) {
      fakeWindow.Telegram = { WebApp: fakeTelegram([], version) };
      const m = mount(header(() => void backs++));
      try {
        assert(buttonsIn(m).length === want, `Telegram ${version}: ${buttonsIn(m).length} in-page back button(s), want ${want}`);
      } finally {
        m.unmount();
        fakeWindow.Telegram = undefined;
      }
    }
    // The server renders what Telegram's clients get (no button), so a Telegram page hydrates without a mismatch
    const server = markupOf(renderToString(header(() => undefined)));
    assert(!server.includes('<button') && server.includes('<h1 class="ch-screen-title">Settings</h1>'), `on the server: ${server}`);
    const code = fs.readFileSync(path.join(ROOT, 'components/app-ui/ScreenHeader.tsx'), 'utf8').split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
    assert(!/useTelegramBackButton\(/.test(code), 'ScreenHeader never calls useTelegramBackButton');
  });

  await check('K2 SectionLabel is an h2 with the section-label class', () => {
    assert(renderToString(createElement(LabelProbe, {}, 'Summaries')) === '<h2 class="ch-section-label">Summaries</h2>', 'the label');
  });

  await check('K3 Notice: role="status" by default, role="alert" for an error (the danger tone); its action is a button that calls onClick', () => {
    const html = (props: Omit<ComponentProps<typeof Notice>, 'children'>) => renderToString(createElement(NoticeProbe, props, 'Heads up'));
    assert(html({}) === '<div class="ch-notice" role="status"><p class="ch-notice-text">Heads up</p></div>', `info: ${html({})}`);
    assert(html({ tone: 'info' }) === html({}), 'info is the default');
    assert(html({ tone: 'error' }) === '<div class="ch-notice ch-notice-error" role="alert"><p class="ch-notice-text">Heads up</p></div>', `error: ${html({ tone: 'error' })}`);
    let taps = 0;
    const m = mount(createElement(NoticeProbe, { action: { label: 'See plans', onClick: () => void taps++ } }, 'Heads up'));
    try {
      const buttons = buttonsIn(m);
      assert(buttons.length === 1 && buttons[0].className === 'ch-notice-action' && buttons[0].getAttribute('type') === 'button' && buttons[0].textContent === 'See plans', 'the action button');
      m.click(buttons[0]);
      assert(taps === 1, `a tap calls onClick: ${taps}`);
    } finally {
      m.unmount();
    }
  });

  await check('K4 DayChips: a labelled group of toggle buttons (aria-pressed, the full day as the name, the short one shown); a pinned chip is aria-disabled, described by the hint, and a tap on it calls nothing; a tap on another calls onToggle with its id', () => {
    const ids = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const days: DayChip[] = ids.map((id, i) => ({ id, short: `S${i}`, full: `Day ${id}`, on: i < 3, pinned: i === 2 }));
    const toggled: string[] = [];
    const m = mount(createElement(ChipsProbe, { label: 'Days', days, onToggle: (id: string) => void toggled.push(id), describedBy: 'hint-1' }));
    try {
      const group = byRole(m.container, 'group');
      assert(group.length === 1 && group[0].getAttribute('aria-label') === 'Days' && group[0].className === 'ch-daychips', 'the group');
      const chips = buttonsIn(m);
      assert(chips.length === 7 && chips.every((c) => c.className === 'ch-daychip' && c.getAttribute('type') === 'button'), 'seven chips');
      assert(show(chips.map((c) => c.getAttribute('data-day'))) === show(ids), 'in the given order');
      assert(show(chips.map((c) => c.getAttribute('aria-pressed'))) === show(['true', 'true', 'true', 'false', 'false', 'false', 'false']), 'aria-pressed follows on');
      assert(chips[0].getAttribute('aria-label') === 'Day sun' && chips[0].textContent === 'S0', 'the full name is the label, the short one the text');
      assert(chips[2].getAttribute('aria-disabled') === 'true' && chips[2].getAttribute('aria-describedby') === 'hint-1', 'the pinned chip');
      assert(chips.filter((c) => c.getAttribute('aria-disabled') !== null || c.getAttribute('aria-describedby') !== null).length === 1, 'only the pinned chip carries either');
      m.click(chips[2]);
      assert(toggled.length === 0, `a pinned chip calls nothing: ${show(toggled)}`);
      m.click(chips[3]);
      m.click(chips[0]);
      assert(show(toggled) === show(['wed', 'sun']), `the others call onToggle(id): ${show(toggled)}`);
    } finally {
      m.unmount();
    }
  });

  await check("K5 AppScreen ground=\"grouped\": the root has ch-grouped; Telegram's header and background take secondary_bg_color in a light theme and bg_color in a dark one, and a themeChanged gives the colour of the scheme it changed to; a plain screen asks bg_color in both", () => {
    const html = renderToString(inIntl('en', createElement(ScreenProbe, { ground: 'grouped', className: 'ch-settings' }, createElement('i'))));
    assert(html.startsWith('<div class="ch-app ch-screen ch-grouped ch-settings" data-theme="light" dir="ltr" lang="en">'), `the grouped root: ${html.slice(0, 120)}`);
    assert(renderToString(inIntl('en', createElement(ScreenProbe, { ground: 'plain' }, createElement('i')))).startsWith('<div class="ch-app ch-screen" '), 'plain has no ch-grouped');
    installWindow();
    const colourCalls = (calls: string[]) => calls.filter((c) => /^set(?:Header|Background)Color\(/.test(c));
    const run = (ground: 'plain' | 'grouped', scheme: 'light' | 'dark') => {
      const calls: string[] = [];
      const tg = fakeTelegram(calls, '7.7');
      tg.colorScheme = scheme;
      fakeWindow.Telegram = { WebApp: tg };
      const m = mount(inIntl('en', createElement(ScreenProbe, { ground }, createElement('i'))));
      return { m, tg, calls };
    };
    const light = run('grouped', 'light');
    try {
      assert(show(colourCalls(light.calls)) === show(['setHeaderColor(secondary_bg_color)', 'setBackgroundColor(secondary_bg_color)']), `grouped, light: ${show(colourCalls(light.calls))}`);
      // The user switches Telegram to a dark theme: the handler asks again, with the scheme of that moment
      light.calls.length = 0;
      light.tg.colorScheme = 'dark';
      act(() => {
        for (const handler of light.tg.eventHandlers.themeChanged ?? []) handler();
      });
      assert(show(colourCalls(light.calls)) === show(['setHeaderColor(bg_color)', 'setBackgroundColor(bg_color)']), `grouped, themeChanged to dark: ${show(colourCalls(light.calls))}`);
      light.calls.length = 0;
      light.tg.colorScheme = 'light';
      act(() => {
        for (const handler of light.tg.eventHandlers.themeChanged ?? []) handler();
      });
      assert(show(colourCalls(light.calls)) === show(['setHeaderColor(secondary_bg_color)', 'setBackgroundColor(secondary_bg_color)']), `grouped, themeChanged back to light: ${show(colourCalls(light.calls))}`);
    } finally {
      light.m.unmount();
      fakeWindow.Telegram = undefined;
    }
    for (const [ground, scheme] of [['grouped', 'dark'], ['plain', 'light'], ['plain', 'dark']] as const) {
      const r = run(ground, scheme);
      try {
        assert(show(colourCalls(r.calls)) === show(['setHeaderColor(bg_color)', 'setBackgroundColor(bg_color)']), `${ground}, ${scheme}: ${show(colourCalls(r.calls))}`);
      } finally {
        r.m.unmount();
        fakeWindow.Telegram = undefined;
      }
    }
  });

  await check('K6 SwitchRow disabled: aria-disabled="true", a tap does not call onChange, and nothing dims it; an enabled one still calls onChange with the new value', () => {
    const seen: boolean[] = [];
    const m = mount(createElement(SwitchRow, { label: 'Alerts', hint: 'Soon', checked: false, disabled: true, onChange: (on: boolean) => void seen.push(on) }));
    try {
      const sw = byRole(m.container, 'switch');
      assert(sw.length === 1 && sw[0].getAttribute('aria-disabled') === 'true' && sw[0].getAttribute('aria-checked') === 'false' && !sw[0].hasAttribute('disabled'), 'the disabled switch');
      m.click(sw[0]);
      assert(seen.length === 0, `a tap on it calls nothing: ${show(seen)}`);
    } finally {
      m.unmount();
    }
    const on = mount(createElement(SwitchRow, { label: 'Alerts', checked: false, onChange: (v: boolean) => void seen.push(v) }));
    try {
      const sw = byRole(on.container, 'switch')[0];
      assert(!sw.hasAttribute('aria-disabled'), 'an enabled switch has no aria-disabled');
      on.click(sw);
      assert(show(seen) === show([true]), `an enabled one: ${show(seen)}`);
    } finally {
      on.unmount();
    }
    assert(!/button\.ch-form-row\[aria-disabled[^{]*\{/.test(FORM_CSS) && !/\.ch-form-row\[aria-disabled/.test(FORM_CSS), 'no rule dims a disabled row');
  });

  await check('K7 ButtonRow and ValueRow valueDir="ltr" draw the value as <bdi dir="ltr">09:15</bdi> (a time stays left to right in Hebrew), and without it no bdi; SwitchRow note is a second hint line under the hint', () => {
    const button = (extra: Record<string, unknown>) => markupOf(renderToString(createElement(ButtonRow, { label: 'Time', value: '09:15', onClick: noop, ...extra })));
    assert(button({ valueDir: 'ltr' }).includes('<span class="ch-form-value-text" dir="auto"><bdi dir="ltr">09:15</bdi></span>'), `ButtonRow: ${button({ valueDir: 'ltr' })}`);
    assert(!button({}).includes('<bdi') && button({}).includes('dir="auto">09:15</span>'), 'ButtonRow without valueDir');
    const value = (extra: Record<string, unknown>) => markupOf(renderToString(createElement(ValueRow, { label: 'Morning', value: '07', options: [{ value: '07', text: '07:00' }], onChange: noop, ...extra })));
    assert(value({ valueDir: 'ltr' }).includes('<span class="ch-form-value-text" dir="auto"><bdi dir="ltr">07:00</bdi></span>'), `ValueRow: ${value({ valueDir: 'ltr' })}`);
    assert(!value({}).includes('<bdi'), 'ValueRow without valueDir');
    const note = markupOf(renderToString(createElement(SwitchRow, { label: 'Text', hint: 'A message', note: '3 of 5 used', checked: true, onChange: noop })));
    assert(note.includes('<span class="ch-form-hint">A message</span><span class="ch-form-hint">3 of 5 used</span>'), `the note: ${note}`);
    assert(!markupOf(renderToString(createElement(SwitchRow, { label: 'Text', hint: 'A message', checked: true, onChange: noop }))).includes('3 of 5'), 'no note, no line');
  });

  await check('K8 SaveBar: a status renders as role="status", disabled disables the button, sticky adds the class; the error is still role="alert" and busy still disables and marks aria-busy', () => {
    const html = (props: Partial<ComponentProps<typeof SaveBar>>) => markupOf(renderToString(createElement(SaveBar, { label: 'Save', busy: false, error: null, onSave: noop, ...props })));
    assert(html({}) === '<div class="ch-save-bar"><button type="button" class="ch-btn ch-btn-primary ch-save">Save</button></div>', `the bar as it was: ${html({})}`);
    assert(html({ status: 'Saved' }).includes('<p class="ch-save-status" role="status">Saved</p>'), `the status: ${html({ status: 'Saved' })}`);
    assert(html({ disabled: true }).includes('disabled=""') && !html({}).includes('disabled'), 'disabled disables the button');
    assert(html({ sticky: true }).startsWith('<div class="ch-save-bar ch-save-bar-sticky">'), `sticky: ${html({ sticky: true })}`);
    assert(html({ error: 'Nope' }).includes('<p class="ch-form-error" role="alert">Nope</p>'), 'the error');
    assert(html({ busy: true }).includes('disabled=""') && html({ busy: true }).includes('aria-busy="true"'), 'busy');
    let saves = 0;
    const m = mount(createElement(SaveBar, { label: 'Save', busy: false, error: null, disabled: false, onSave: () => void saves++ }));
    try {
      m.click(buttonsIn(m)[0]);
      assert(saves === 1, `a tap saves: ${saves}`);
    } finally {
      m.unmount();
    }
  });

  await check('K9 BottomSheet closeDisabled: the close button is disabled, and Escape and the scrim do not call onClose; without it all three do', () => {
    installWindow();
    const run = (closeDisabled: boolean) => {
      let closed = 0;
      const m = mount(createElement(SheetProbe, { label: 'Sheet', closeLabel: 'Close', onClose: () => void closed++, closeDisabled }, createElement('i')));
      const panel = byRole(m.container, 'dialog')[0];
      const close = elements(m.container).find((e) => e.className === 'ch-btn ch-sheet-close');
      const scrim = elements(m.container).find((e) => e.className === 'ch-sheet-backdrop');
      assert(panel && close && scrim, 'the sheet');
      return { m, panel, close, scrim, closed: () => closed };
    };
    const locked = run(true);
    try {
      assert(locked.close.hasAttribute('disabled'), 'the close button is disabled');
      locked.m.key(locked.panel, 'Escape');
      locked.m.click(locked.scrim);
      locked.m.click(locked.close);
      assert(locked.closed() === 0, `Escape, the scrim and the button: ${locked.closed()} close(s)`);
    } finally {
      locked.m.unmount();
    }
    const free = run(false);
    try {
      assert(!free.close.hasAttribute('disabled'), 'the close button is enabled');
      free.m.key(free.panel, 'Escape');
      assert(free.closed() === 1, `Escape closes: ${free.closed()}`);
      free.m.click(free.scrim);
      assert(free.closed() === 2, `the scrim closes: ${free.closed()}`);
    } finally {
      free.m.unmount();
    }
  });

  await check("K10 the new CSS: the off switch track has an outline and the on track a fill, each in a token #2b holds to 3:1 against the card; the thumb is on tokens; the grouped ground paints the surface; the sticky bar keeps .ch-save-bar's flex: none; the plain icon button follows .ch-icon-btn; a chip is 44 px tall with its transition behind no-preference, and no rule takes the Agenda's .ch-day names", () => {
    const off = /box-shadow:\s*inset 0 0 0 1\.5px var\((--[\w-]+)\)/.exec(rule(FORM_CSS, '.ch-switch'))?.[1];
    assert(off, 'the off track has an inset outline');
    const on = /background:\s*var\((--[\w-]+)\)/.exec(rule(FORM_CSS, '.ch-switch.is-on'))?.[1];
    assert(on && /box-shadow:\s*none/.test(rule(FORM_CSS, '.ch-switch.is-on')), 'the on track fills with a token and has no outline');
    const thumb = rule(FORM_CSS, '.ch-switch::after');
    assert(/background:\s*var\(--ch-switch-thumb\)/.test(thumb) && /box-shadow:\s*var\(--ch-switch-thumb-shadow\)/.test(thumb), 'the thumb is on its tokens');
    // #2b measures these pairs in every look; the CSS must draw with exactly these tokens
    const marked = (fg: string) => MARK_PAIRS.some(([a, b]) => a === fg && b === '--ch-section');
    assert(marked(off), `${off} on --ch-section is not one of #2b's mark pairs`);
    assert(marked(on), `${on} on --ch-section is not one of #2b's mark pairs`);
    assert(/\.ch-screen\.ch-grouped \{[^}]*background:\s*var\(--ch-surface\)/.test(APP_SCREEN_CSS), 'a grouped screen paints the surface');
    assert(/\.ch-app\.ch-grouped\[data-theme='dark'\] \{[^}]*background:\s*var\(--ch-bg\)/.test(APP_SCREEN_CSS), "a grouped screen in the dark paints the page's own ground");
    assert(/\.ch-save-bar-sticky \{[^}]*position:\s*sticky[^}]*inset-block-end:\s*0/.test(FORM_CSS) && /\.ch-save-bar \{[^}]*flex:\s*none/.test(FORM_CSS), 'a sticky bar that still never shrinks');
    assert(APP_SCREEN_CSS.indexOf('.ch-icon-btn-plain {') > APP_SCREEN_CSS.indexOf('.ch-icon-btn {') && /\.ch-icon-btn-plain \{[^}]*background:\s*transparent/.test(APP_SCREEN_CSS), 'the plain icon button comes after .ch-icon-btn and is transparent');
    assert(/\.ch-daychip \{[^}]*min-block-size:\s*44px/.test(FORM_CSS), 'a day chip is at least 44 px tall');
    const guarded = /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/.exec(FORM_CSS)?.[0] ?? '';
    assert(/\.ch-daychip \{[^}]*transition/.test(guarded) && !/\.ch-daychip \{[^}]*transition/.test(FORM_CSS.replace(guarded, '')), 'its transition sits behind no-preference');
    assert(!/\.ch-day\b(?!chip)|\.ch-days\b/.test(FORM_CSS), "no .ch-day or .ch-days (the Agenda's day sections have those names)");
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

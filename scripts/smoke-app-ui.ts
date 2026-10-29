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
//    useTelegramBackButton;
//  - the layer's boundary: nothing in components/app-ui/ imports from app/ or a server module,
//    so every screen can take it into its client bundle;
//  - the cards (renderToString in en, he and ru): StateCard draws the home's card with the markup
//    the busy, retry and crash cards always had; MissingParameterCard and the 404 are
//    AppScreens in the page's direction and language with their text from messages (no raw
//    key, no English in he and ru), and show no BackButton, in Telegram or in a browser; the
//    gate's card (PageGate's NoCredentialCard) in the app look closes the Mini App or links on;
//  - an unknown path under a locale calls notFound() (the catch-all), which Next answers with
//    app/[locale]/(app)/not-found.tsx;
//  - the dashboard's redirect (the 404's way back, the menu button, a launch with no user_id), in
//    real React with a fake router and Telegram: no colour call, the app loader, a push for a
//    Telegram user, and the app-look gate card without one, in a browser and inside Telegram;
//  - the home's --ch-top-h: published on the root through AppScreen's ref, and on the first commit,
//    when React has not attached that ref yet, on the wrapper's parent, the same element.
//  - the pieces W1a added (K1-K10, plan docs/superpowers/plans/2026-10-27-app-ui-W1a-settings.md): ScreenHeader
//    and SectionLabel, Notice, DayChips, AppScreen's grouped ground and what it asks Telegram for, the form kit's
//    additions (a disabled SwitchRow, a note, valueDir, the SaveBar's status, disabled and sticky), the
//    BottomSheet's closeDisabled, and the new CSS (the switch's off outline, the grouped paint, the chips);
//  - the fix round (K11, K12): the fake DOM matches the selectors the app passes and throws on the rest, and the
//    loader of a grouped page (Settings, Subscription, Pair) is on its ground, so Telegram's header does not change colour on arrival;
//  - the pieces W1b added (K13-K16, plan docs/superpowers/plans/2026-10-27-app-ui-W1b-subscription-feedback-story.md): Tag, Meter
//    (its aria, its cap, its near-limit class), the Panel card, the outlined button and the near-limit colour, and lintCss itself
//    (scripts/lib/css-lint.ts, which #2 and the screens' own smokes run over their CSS);
//  - the piece W3 added (K17, plan docs/superpowers/plans/2026-10-27-app-ui-W3-partner-invite.md): CopyField, the copy-link field
//    (its parts, a tap writing the value and saying Copied for 2 seconds, a blocked clipboard selecting the text instead, and a disabled field);
//  - the pieces plan A added (K18, plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md): ListRow (a button row with a title, a quiet
//    line, tags and a chevron), the Tag tones (danger, muted) with the new --ch-danger-soft token, and FORM_CSS's list row and action row rules.
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
import { APP_TOKENS } from '../components/app-ui/tokens';
import { AppScreen, useAppScheme } from '../components/app-ui/AppScreen';
import { MissingParameterCard, NotFoundCard, StateCard, type StateCardProps } from '../components/app-ui/StateCard';
import { BottomSheet, TABBABLE } from '../components/app-ui/BottomSheet';
import { CopyField } from '../components/app-ui/CopyField';
import { DayChips, type DayChip } from '../components/app-ui/DayChips';
import { ButtonRow, FORM_CSS, RadioCard, SaveBar, SwitchRow, TextField, ValueRow } from '../components/app-ui/form-kit';
import { Meter, NEAR_LIMIT } from '../components/app-ui/Meter';
import { Notice } from '../components/app-ui/Notice';
import { ScreenHeader, SectionLabel } from '../components/app-ui/ScreenHeader';
import { ListRow } from '../components/app-ui/ListRow';
import { Tag } from '../components/app-ui/Tag';
import NotFound from '../app/[locale]/(app)/not-found';
import UnknownPath from '../app/[locale]/(app)/[...rest]/page';
import PageGate, { NoCredentialCard, renderPage } from '../app/[locale]/(app)/PageGate';
import TelegramDashboardRedirect from '../app/[locale]/(app)/dashboard/TelegramDashboardRedirect';
import { HOME_TOP_CSS, publishTopHeight } from '../app/[locale]/(app)/dashboard/CalendarHome';
import { AGENDA_CSS } from '../app/[locale]/(app)/dashboard/AgendaView';
import { DRAG_BAR_CSS } from '../app/[locale]/(app)/dashboard/DragBar';
import { DRAG_CSS } from '../app/[locale]/(app)/dashboard/DragSurface';
import { EDITOR_FORM_CSS } from '../app/[locale]/(app)/dashboard/form-kit';
import { TABS_CSS } from '../app/[locale]/(app)/dashboard/HomeTabs';
import { HOME_SHELL_CSS } from '../app/[locale]/(app)/dashboard/home-shell';
import { MONTH_BROWSE_CSS } from '../app/[locale]/(app)/dashboard/MonthBrowse';
import { MONTH_PICKED_CSS } from '../app/[locale]/(app)/dashboard/MonthPicked';
import { PICKER_CSS } from '../app/[locale]/(app)/dashboard/picker-kit';
import { REPEAT_CSS } from '../app/[locale]/(app)/dashboard/RepeatSheet';
import { ZMANIM_SHEET_CSS } from '../app/[locale]/(app)/dashboard/ZmanimSheet';
import { contrast, MARK_PAIRS, resolver, TEXT_PAIRS, TG_ALL, type Theme } from './lib/css-resolve';
import { lintCss } from './lib/css-lint';
import { byRole, elements, fakeDocument, fakeTelegram, fakeWindow, installWindow, mount, type Row } from './lib/fake-dom';

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
/** What CopyField logs when the clipboard is not there to use (K17 reads it). */
const copyLogs: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('[telegram-ui]')) return original(...args);
    if (text.startsWith('[copy]')) return void copyLogs.push(text);
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

  await check('#1b one palette: theme.ts and screen.ts write no colour of their own (every hex and rgba() is APP_TOKENS\', components/app-ui/tokens.ts, which the public site reads too), and the brand values APP_TOKENS holds equal app/globals.css\'s tokens the theme falls back to', () => {
    const own = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    for (const rel of ['components/app-ui/theme.ts', 'components/app-ui/screen.ts']) {
      const literals = own(rel).match(/#[0-9a-f]{3,8}\b|rgba?\(/gi);
      assert(!literals, `${rel} writes ${show(literals)}`);
    }
    const globals = fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8');
    const brand = (name: string) => new RegExp(`^\\s*${name}:\\s*(#[0-9a-f]{6});`, 'im').exec(globals)?.[1]?.toLowerCase();
    const L = APP_TOKENS.light;
    for (const [token, value] of [['--bg-white', L.bg], ['--bg-white', L.buttonText], ['--text-primary', L.text], ['--brand-primary-dark', L.accent], ['--brand-primary-dark', L.button]] as const) {
      assert(brand(token) === value.toLowerCase(), `${token} is ${brand(token)} in globals.css, ${value} in APP_TOKENS`);
    }
  });

  await check('#2 the lint over the theme, the screen and the form kit (lintCss, scripts/lib/css-lint.ts): nothing under 11 px and every size in px; .ch-btn, .ch-icon-btn and .ch-sheet-close at least 44 px; logical properties only; no hover; no hex or rgb() outside the token blocks (the two page paints\' fallbacks are the only exemptions, and are the dark --ch-bg\'s and the light --ch-surface\'s own)', () => {
    const sizes = [...CSS.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)];
    assert(sizes.length > 5, `font sizes found: ${sizes.length}`);
    // lintCss checks the rules it finds; these must be there to be checked
    for (const selector of ['.ch-btn', '.ch-icon-btn', '.ch-sheet-close']) rule(selector === '.ch-icon-btn' ? APP_SCREEN_CSS : APP_THEME_CSS, selector);
    for (const [css, selector] of [[APP_THEME_CSS, '.ch-btn'], [APP_SCREEN_CSS, '.ch-icon-btn']] as const) {
      const body = rule(css, selector);
      assert(/min-width:\s*44px/.test(body), `${selector} min-width 44px`);
    }
    assert(/block-size:\s*44px/.test(rule(APP_SCREEN_CSS, '.ch-icon-btn')) && /inline-size:\s*44px/.test(rule(APP_SCREEN_CSS, '.ch-icon-btn')), '.ch-icon-btn is 44 x 44');
    // A token block's declarations are tokens (the shades live there); the two exemptions outside are the page paints'
    // own declarations (html has no tokens above it): the dark one's fallback is checked against the dark --ch-bg's, the
    // grouped one's against the light --ch-surface's, below.
    const paint = /(html:has\(\.ch-screen\[data-theme='dark'\]\) \{\s*)background-color:\s*var\(--tg-theme-bg-color,\s*#[0-9a-f]{6}\);/i.exec(APP_SCREEN_CSS);
    const groupedPaint = /(html:has\(\.ch-screen\.ch-grouped\) \{\s*)background-color:\s*var\(--tg-theme-secondary-bg-color,\s*#[0-9a-f]{6}\);/i.exec(APP_SCREEN_CSS);
    assert(paint, 'the dark page paint declaration');
    assert(groupedPaint, 'the grouped page paint declaration');
    const problems = lintCss(CSS, { exempt: [paint[0], groupedPaint[0]] });
    assert(problems.length === 0, `lintCss: ${show(problems)}`);
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
      // The Telegram stand-in's button: the Month's fill, which the primary button's dark fallback is too (#6d4ff0)
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

  await check("#5 one BackButton owner per screen: no file calls useTelegramBackButton but AppScreen.tsx (the hook is src/lib/telegram-ui.ts's); the list is pinned, so a new caller fails", () => {
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
    const card = (inTelegram: boolean) => inIntl('he', createElement(NoCredentialCard, { inTelegram, links }));
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

  await check("#8 an unknown path under a locale reaches the app's 404: the catch-all page calls notFound(), and the route files are where Next looks (app/[locale]/(app)/[...rest]/page.tsx, app/[locale]/(app)/not-found.tsx)", () => {
    let digest = '';
    try {
      UnknownPath();
    } catch (err) {
      digest = String((err as Row)?.digest ?? err);
    }
    assert(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/.test(digest), `the catch-all threw ${digest || 'nothing'}`);
    for (const file of ['app/[locale]/(app)/[...rest]/page.tsx', 'app/[locale]/(app)/not-found.tsx']) assert(fs.existsSync(path.join(ROOT, file)), `no ${file}`);
    const gone = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/not-found.tsx'), 'utf8');
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

  await check("K10b the kit's classes are the kit's alone: the class selectors FORM_CSS defines (the subject of each selector, not a class it only sits under) are not defined by the home's own style sheets (the Agenda, the tabs, the month, the pickers, the editor, the sheets ...), which share a page with it and, at the same specificity, the later sheet wins (the 44 px colour swatch became the Agenda's 10 px dot's square); state modifiers (is-*, has-*) always sit on a base class and are left out; the guard sees the old clash", () => {
    /** The classes a selector's subject carries (its last compound, minus what is inside :not(...) or another pseudo's brackets). */
    const subjectClasses = (css: string) => {
      const heads = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|\})\s*([^{}@][^{}]*)\{/g)].map((m) => m[1]);
      const out = new Set<string>();
      for (const head of heads) {
        for (const selector of head.split(',')) {
          const plain = selector.replace(/\[[^\]]*\]/g, '').replace(/:[\w-]+\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '').trim();
          const subject = plain.split(/[\s>+~]+/).filter(Boolean).at(-1) ?? '';
          for (const m of subject.matchAll(/\.([A-Za-z][\w-]*)/g)) out.add(m[1]);
        }
      }
      return out;
    };
    const STATE = /^(?:is|has)-/;
    const shared = (a: string, b: string) => [...subjectClasses(a)].filter((c) => !STATE.test(c) && subjectClasses(b).has(c)).sort();
    const home: Record<string, string> = { AGENDA_CSS, TABS_CSS, DRAG_BAR_CSS, DRAG_CSS, ZMANIM_SHEET_CSS, HOME_SHELL_CSS, HOME_TOP_CSS, PICKER_CSS, EDITOR_FORM_CSS, MONTH_BROWSE_CSS, MONTH_PICKED_CSS, REPEAT_CSS };
    assert(subjectClasses(FORM_CSS).size > 50 && subjectClasses(AGENDA_CSS).size > 20, `the guard reads the sheets: ${subjectClasses(FORM_CSS).size} and ${subjectClasses(AGENDA_CSS).size} classes`);
    assert(show(shared(FORM_CSS + '\n.ch-swatch {\n  inline-size: 44px;\n}\n', AGENDA_CSS)) === show(['ch-swatch']), "the old clash (FORM_CSS's .ch-swatch against the Agenda's) is seen");
    assert(show(shared('.a:not(.b) .c {}', '.b {} .a {}')) === show([]) && show(shared('.x .a.is-on {}', '.a {}')) === show(['a']), 'the guard reads the subject, not the context');
    const clashes = Object.entries(home).flatMap(([name, css]) => shared(FORM_CSS, css).map((c) => `${name}: .${c}`));
    assert(clashes.length === 0, `FORM_CSS and a sheet of the home define the same class: ${show(clashes)}`);
  });

  await check("K12 a boundary where the grounds are the same: a sheet's card and a muted tag draw a 1px inset ring in the token the switch's off track uses (--ch-done, which #2b holds to 3:1 against --ch-section in every look), so they stay visible under a Telegram theme whose section and secondary colours are one; the ring is on the sheet's card only (the page's cards, the full-screen editor's cards and the other tags are as they were); #2's lint covers the new CSS", () => {
    const ring = /box-shadow:\s*inset 0 0 0 1px var\((--[\w-]+)\)/;
    const off = /box-shadow:\s*inset 0 0 0 1\.5px var\((--[\w-]+)\)/.exec(rule(FORM_CSS, '.ch-switch'))?.[1];
    const sheetCard = rule(FORM_CSS, '.ch-sheet:not(.ch-sheet-full) .ch-form-card');
    const sheetRing = ring.exec(sheetCard)?.[1];
    const tagRing = ring.exec(rule(APP_SCREEN_CSS, '.ch-tag-muted'))?.[1];
    assert(off && sheetRing === off && tagRing === off, `the rings: sheet ${sheetRing}, tag ${tagRing}, switch ${off}`);
    assert(MARK_PAIRS.some(([a, b]) => a === off && b === '--ch-section'), `${off} on --ch-section is not one of #2b's mark pairs`);
    assert(/background:\s*var\(--ch-surface\)/.test(sheetCard), "the sheet's card keeps its ground");
    assert(!/box-shadow/.test(rule(FORM_CSS, '.ch-form-card')) && !/box-shadow/.test(rule(APP_SCREEN_CSS, '.ch-tag')) && !/box-shadow/.test(rule(APP_SCREEN_CSS, '.ch-tag-danger')), 'a page card, a plain tag and a danger tag carry no ring');
    const ringed = [...FORM_CSS.matchAll(/(?:^|\n)([^\n{}]*\.ch-form-card[^\n{}]*) \{([^}]*)\}/g)].filter((m) => /box-shadow/.test(m[2])).map((m) => m[1]);
    assert(show(ringed) === show(['.ch-sheet:not(.ch-sheet-full) .ch-form-card']), `the rules that ring a card: ${show(ringed)} (the full-screen editor's cards are not among them)`);
  });

  await check("K10c TextField, RadioCard and ListRow can be switched off while their screen works (disabled, dimmed by the kit's own :disabled rules), and without it they are exactly what they were: an enabled field and option, a row with no disabled attribute", () => {
    const html = (el: ReactElement) => markupOf(renderToString(el));
    const Field = TextField as unknown as (props: Row) => ReactElement;
    const Radios = RadioCard as unknown as (props: Row) => ReactElement;
    const Row2 = ListRow as unknown as (props: Row) => ReactElement;
    const field = { label: 'Name', value: 'Home', onChange: noop };
    assert(!/\bdisabled/.test(html(createElement(Field, field))) && /<input [^>]*\bdisabled=""/.test(html(createElement(Field, { ...field, disabled: true }))), `the field: ${html(createElement(Field, { ...field, disabled: true }))}`);
    assert(!/\bdisabled/.test(html(createElement(Field, { ...field, multiline: true }))) && /<textarea [^>]*\bdisabled=""/.test(html(createElement(Field, { ...field, multiline: true, disabled: true }))), 'the notes');
    const radios = { label: 'Who', value: 'a', options: [{ value: 'a', text: 'A' }, { value: 'b', text: 'B' }], onChange: noop };
    assert(!/\bdisabled/.test(html(createElement(Radios, radios))) && (html(createElement(Radios, { ...radios, disabled: true })).match(/<button [^>]*\bdisabled=""/g) ?? []).length === 2, 'the options');
    const row = { title: 'Home', onClick: noop };
    assert(!/\bdisabled/.test(html(createElement(Row2, row))) && /<button [^>]*\bdisabled=""/.test(html(createElement(Row2, { ...row, disabled: true }))), 'the list row');
    assert(/button\.ch-form-row:disabled\s*\{[^}]*opacity/.test(FORM_CSS) && /\.ch-form-field:disabled\s*\{[^}]*opacity/.test(FORM_CSS), 'the kit dims a disabled row button and a disabled field');
    // A tap on a disabled one does nothing
    installWindow();
    let taps = 0;
    const m = mount(createElement('div', null, createElement(Row2, { ...row, disabled: true, onClick: () => void taps++ }), createElement(Radios, { ...radios, disabled: true, onChange: () => void taps++ })));
    try {
      for (const b of elements(m.container).filter((e) => e.localName === 'button')) m.click(b);
      assert(taps === 0, `${taps} tap(s) reached a disabled control`);
    } finally {
      m.unmount();
    }
  });

  await check("K11 the fake DOM's selectors: it matches what the app passes (BottomSheet's TABBABLE finds only the enabled controls, a [attr] list, [attr=\"v\"], [attr^=\"v\"]) and throws \"fake-dom: unsupported selector\" on the rest, so a check that reaches one can't pass on nothing; BottomSheet's Tab trap, which runs on TABBABLE, wraps over the enabled button only", () => {
    installWindow();
    const m = mount(
      createElement(
        'div',
        null,
        createElement('button', { id: 'off', disabled: true }, 'Off'),
        createElement('button', { id: 'on' }, 'On'),
        createElement('a', { id: 'link', href: '/x' }, 'Link'),
        createElement('a', { id: 'bare' }, 'No href'),
        createElement('input', { id: 'hidden', type: 'hidden' }),
        createElement('input', { id: 'text', type: 'text', onChange: noop }),
        createElement('div', { id: 'negative', tabIndex: -1 }),
        createElement('div', { id: 'zero', tabIndex: 0 }),
        createElement('i', { id: 'day', 'data-day': '2026-10-15' }),
        createElement('i', { id: 'options', 'data-rwp-options': '' }),
        createElement('i', { id: 'highlight', 'data-rwp-highlight-wrapper': '' }),
      ),
    );
    try {
      const ids = (selector: string) => m.container.querySelectorAll(selector).map((e) => e.getAttribute('id'));
      assert(show(ids(TABBABLE)) === show(['on', 'link', 'text', 'zero']), `TABBABLE: ${show(ids(TABBABLE))}`);
      assert(show(ids('[data-rwp-options], [data-rwp-highlight-wrapper]')) === show(['options', 'highlight']), 'a list of attribute presences, in document order');
      assert(show(ids('[data-day="2026-10-15"]')) === show(['day']) && show(ids('[data-day="2026-10-16"]')) === show([]), 'an attribute value');
      assert(show(ids('[href^="/"]')) === show(['link']) && show(ids('a')) === show(['link', 'bare']) && show(ids('button:not([disabled])')) === show(['on']), 'a prefix, a tag, a tag and a :not');
      assert(m.container.querySelector('[data-rwp]') === null && m.container.querySelector('canvas') === null, 'nothing found is null');
      for (const selector of ['div > p', 'a b', '', '*', 'a:first-child', 'a, ', '[data-x*="v"]', ':not(a b)']) {
        let message = '';
        try {
          m.container.querySelectorAll(selector);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        assert(message === `fake-dom: unsupported selector ${selector}`, `${show(selector)}: ${show(message)}`);
      }
    } finally {
      m.unmount();
    }
    // The sheet's Tab trap: Shift+Tab on its first control wraps to its last. The disabled button is no control, so the enabled one is both.
    const sheet = mount(createElement(SheetProbe, { label: 'Sheet', closeLabel: 'Close', onClose: noop, variant: 'full' }, createElement('button', { id: 'off', disabled: true }, 'Off'), createElement('button', { id: 'on' }, 'On')));
    try {
      const panel = byRole(sheet.container, 'dialog')[0];
      const enabled = elements(sheet.container).find((e) => e.getAttribute('id') === 'on');
      assert(panel && enabled, 'the sheet');
      enabled.focus();
      const event = sheet.key(panel, 'Tab', { shiftKey: true });
      assert(event.defaultPrevented === true && fakeDocument.activeElement === enabled, `Shift+Tab wraps over the enabled button only: prevented ${event.defaultPrevented}`);
    } finally {
      sheet.unmount();
    }
  });

  await check("K12 the loader is on the page's ground: PageGate's own (while the data is on its way) and the dynamic() fallback of Settings, of Subscription, of Pair, of Calendars and of Select calendars draw the grouped screen, and in a light Telegram 7.7 ask secondary_bg_color, so the header does not change colour when the page arrives; the dashboard's loader stays plain (bg_color)", () => {
    installWindow();
    const { AppRouterContext } = createRequire(__filename)('next/dist/shared/lib/app-router-context.shared-runtime');
    const router = { push: noop, replace: noop, prefetch: noop, back: noop, forward: noop, refresh: noop };
    const links = { whatsapp: 'https://wa.me/972500000000?text=settings', telegram: 'https://t.me/test_bot?start=dashboard' };
    const inRouter = (el: ReactElement) => createElement(AppRouterContext.Provider, { value: router }, inIntl('en', el));
    const GateProbe = PageGate as unknown as (props: Row) => ReactElement;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    try {
      for (const [page, grouped] of [['settings', true], ['subscription', true], ['pair', true], ['calendars', true], ['select-calendars', true], ['dashboard', false]] as const) {
        // The gate's own loader, mounted in a light Telegram 7.7
        const calls: string[] = [];
        fakeWindow.Telegram = { WebApp: fakeTelegram(calls, '7.7') };
        const m = mount(inRouter(createElement(GateProbe, { page, userId: 1, locale: 'en', links })));
        try {
          const root = elements(m.container).find((e) => e.className.startsWith('ch-app ch-screen'));
          assert(root && root.className === (grouped ? 'ch-app ch-screen ch-grouped' : 'ch-app ch-screen') && elements(m.container).some((e) => e.className === 'ch-loader'), `${page}: the gate's loader: ${root?.className}`);
          const colour = grouped ? 'secondary_bg_color' : 'bg_color';
          assert(calls.includes(`setHeaderColor(${colour})`) && calls.includes(`setBackgroundColor(${colour})`), `${page}: ${show(calls.filter((c) => /Color/.test(c)))}`);
          assert(!calls.some((c) => c === `setHeaderColor(${grouped ? 'bg_color' : 'secondary_bg_color'})`), `${page}: the other colour was asked too: ${show(calls)}`);
        } finally {
          m.unmount();
          fakeWindow.Telegram = undefined;
        }
        // The page's chunk loading (next/dynamic's fallback)
        const props = page === 'select-calendars' ? { userId: 1, currentSelections: { selectedCalendars: [], calendarLabels: [], calendarRules: [], spouseInfo: null, globalRules: [] } } : page !== 'dashboard' ? { userId: 1 } : { user: { id: 5550001, name: 'Dana', location: 'Tel Aviv', isAdmin: false }, locale: 'en', sources: ['famcal'], googleConnected: false, googleState: 'none', trial: { isTrialing: false, daysRemaining: 0, trialEndsAt: null }, isEarlyAdopter: false, hints: { reminders: true, voiceEvents: false }, lookahead7: false };
        const fallback = renderToString(inRouter(renderPage(page, props as never)));
        assert(fallback.startsWith(`<div class="${grouped ? 'ch-app ch-screen ch-grouped' : 'ch-app ch-screen'}" `) && fallback.includes('class="ch-loader"'), `${page}: the chunk's fallback: ${fallback.slice(0, 90)}`);
      }
    } finally {
      globalThis.fetch = origFetch;
    }
    // The gate's cards (nobody proved who they are) are a different screen and stay plain
    const card = renderToString(inIntl('en', createElement(NoCredentialCard, { inTelegram: false, links })));
    assert(card.startsWith('<div class="ch-app ch-screen" '), 'the gate card is plain');
  });

  // ---- W1b: Tag, Meter, the Panel card, the outlined button and the near-limit colour (K13-K16; K1-K12 are W1a's) ----

  const TagProbe = Tag as unknown as (props: Record<string, never>) => ReactElement;
  const meterHtml = (props: ComponentProps<typeof Meter>) => markupOf(renderToString(createElement(Meter, props)));

  await check('K13 Tag is a span.ch-tag with its text', () => {
    assert(renderToString(createElement(TagProbe, {}, 'Current')) === '<span class="ch-tag">Current</span>', `the tag: ${renderToString(createElement(TagProbe, {}, 'Current'))}`);
    assert(renderToString(createElement(TagProbe, {}, 'גישה מוקדמת')) === '<span class="ch-tag">גישה מוקדמת</span>', 'the text is whatever it is given');
  });

  await check('K14 Meter: the count in a bare <bdi> (it takes the direction of its own sentence, no dir="ltr"); a track with role="meter" (min 0, max the limit, now the used count capped at the limit, text as shown) and a fill whose inline-size is used over limit, capped at 100%; near (the is-near class) from 80% (NEAR_LIMIT) and over the limit; an unlimited one (limit null) is the label and the text alone, with no track and no role', () => {
    assert(NEAR_LIMIT === 0.8, `NEAR_LIMIT ${NEAR_LIMIT}`);
    const seven = meterHtml({ label: 'Text summaries', used: 7, limit: 10, valueText: '7 of 10' });
    assert(
      seven ===
        '<div class="ch-meter"><div class="ch-meter-head"><span class="ch-meter-label">Text summaries</span><span class="ch-meter-value"><bdi>7 of 10</bdi></span></div>' +
          '<div class="ch-meter-track" role="meter" aria-label="Text summaries" aria-valuemin="0" aria-valuemax="10" aria-valuenow="7" aria-valuetext="7 of 10"><div class="ch-meter-fill" style="inline-size:70%"></div></div></div>',
      `7 of 10: ${seven}`,
    );
    // The edges: [used, limit, valuenow, fill, near]
    for (const [used, limit, now, fill, near] of [
      [8, 10, 8, '80%', true],
      [4, 5, 4, '80%', true],
      [79, 100, 79, '79%', false],
      [3, 3, 3, '100%', true],
      [12, 10, 10, '100%', true],
      [0, 3, 0, '0%', false],
      [2, 3, 2, '66.66666666666666%', false],
    ] as const) {
      const html = meterHtml({ label: 'Voice', used, limit, valueText: `${used} of ${limit}` });
      assert(html.includes(`aria-valuenow="${now}"`) && html.includes(`aria-valuemax="${limit}"`) && html.includes('aria-valuemin="0"') && html.includes(`aria-valuetext="${used} of ${limit}"`), `${used}/${limit}: the aria: ${html}`);
      assert(html.includes(`style="inline-size:${fill}"`), `${used}/${limit}: the fill ${fill}: ${html}`);
      assert(html.startsWith(near ? '<div class="ch-meter is-near">' : '<div class="ch-meter">'), `${used}/${limit}: near ${near}: ${html.slice(0, 40)}`);
    }
    const unlimited = meterHtml({ label: 'Calendars', used: 4, limit: null, valueText: 'Unlimited' });
    assert(unlimited === '<div class="ch-meter"><div class="ch-meter-head"><span class="ch-meter-label">Calendars</span><span class="ch-meter-value"><bdi>Unlimited</bdi></span></div></div>', `unlimited: ${unlimited}`);
    assert(!/role="meter"|ch-meter-track|ch-meter-fill|is-near/.test(unlimited), 'unlimited: no track, no role, never near');
    // The count is a translated sentence ("7 מתוך 10"): it takes its own direction, never a forced left to right (which reads "10 of 7" in Hebrew)
    const hebrew = meterHtml({ label: 'סיכומי טקסט', used: 7, limit: 10, valueText: '7 מתוך 10' });
    assert(hebrew.includes('<span class="ch-meter-value"><bdi>7 מתוך 10</bdi></span>') && !/dir="ltr"/.test(hebrew + seven + unlimited), `the count has no forced direction: ${hebrew}`);
    // A limit of 0 draws no NaN: an empty bar if nothing was used, a full one if anything was
    const zero = meterHtml({ label: 'x', used: 0, limit: 0, valueText: '0' });
    const over = meterHtml({ label: 'x', used: 1, limit: 0, valueText: '1' });
    assert(zero.includes('style="inline-size:0%"') && over.includes('style="inline-size:100%"') && !/NaN|Infinity/.test(zero + over), `a limit of 0: ${zero} ${over}`);
  });

  await check('K15 the Panel card, the outlined button, the tag and the meter on tokens #2b measures: .ch-panel-ring is the 1.5px --ch-button ring; .ch-btn-outline is transparent with that ring, accent text, 15px/600, at least 44 px and after .ch-btn in the cascade; the tag is --ch-accent on --ch-accent-soft; the fill is --ch-accent and, near the limit, --ch-warn with its count in --ch-warn-text; both themes declare the two warn tokens; the new pairs are in the lists, once', () => {
    const panel = rule(APP_SCREEN_CSS, '.ch-panel');
    assert(/background:\s*var\(--ch-section\)/.test(panel) && /border-radius:\s*16px/.test(panel) && /padding:\s*16px/.test(panel) && /flex-direction:\s*column/.test(panel) && /gap:\s*10px/.test(panel), `.ch-panel: ${panel}`);
    assert(/box-shadow:\s*inset 0 0 0 1\.5px var\(--ch-button\)/.test(rule(APP_SCREEN_CSS, '.ch-panel-ring')), '.ch-panel-ring is the 1.5px --ch-button ring');
    const outline = rule(APP_SCREEN_CSS, '.ch-btn-outline');
    assert(/background:\s*transparent/.test(outline) && /box-shadow:\s*inset 0 0 0 1\.5px var\(--ch-button\)/.test(outline) && /color:\s*var\(--ch-accent\)/.test(outline), `.ch-btn-outline: ${outline}`);
    const min = /min-(?:height|block-size):\s*(\d+)px/.exec(outline);
    assert(min && Number(min[1]) >= 44, `.ch-btn-outline is at least 44 px: ${min?.[1]}`);
    assert(/font-size:\s*15px/.test(outline) && /font-weight:\s*600/.test(outline), '.ch-btn-outline is 15px/600');
    // AppScreen renders the theme, then the screen sheet: the outline wins over .ch-btn (same specificity) by coming later
    const screen = renderToString(inIntl('en', createElement(ScreenProbe, null, createElement('i'))));
    assert(screen.indexOf('.ch-btn {') !== -1 && screen.indexOf('.ch-btn {') < screen.indexOf('.ch-btn-outline {'), '.ch-btn-outline comes after .ch-btn');
    const tag = rule(APP_SCREEN_CSS, '.ch-tag');
    assert(/background:\s*var\(--ch-accent-soft\)/.test(tag) && /color:\s*var\(--ch-accent\)/.test(tag) && /font-size:\s*12px/.test(tag) && /font-weight:\s*600/.test(tag) && /padding:\s*4px 10px/.test(tag) && /border-radius:\s*10px/.test(tag) && /white-space:\s*nowrap/.test(tag), `.ch-tag: ${tag}`);
    const track = rule(APP_SCREEN_CSS, '.ch-meter-track');
    assert(/block-size:\s*6px/.test(track) && /border-radius:\s*3px/.test(track) && /background:\s*var\(--ch-separator\)/.test(track) && /overflow:\s*clip/.test(track), `.ch-meter-track: ${track}`);
    const fill = rule(APP_SCREEN_CSS, '.ch-meter-fill');
    assert(/block-size:\s*6px/.test(fill) && /border-radius:\s*3px/.test(fill) && /background:\s*var\(--ch-accent\)/.test(fill), `.ch-meter-fill: ${fill}`);
    assert(/background:\s*var\(--ch-warn\)/.test(rule(APP_SCREEN_CSS, '.ch-meter.is-near .ch-meter-fill')), 'a near meter fills with --ch-warn');
    assert(/color:\s*var\(--ch-warn-text\)/.test(rule(APP_SCREEN_CSS, '.ch-meter.is-near .ch-meter-value')), 'a near meter counts in --ch-warn-text');
    assert(/color:\s*var\(--ch-muted\)/.test(rule(APP_SCREEN_CSS, '.ch-meter-value')) && /font-size:\s*14px/.test(rule(APP_SCREEN_CSS, '.ch-meter-value')), 'the count is 14px muted');
    // The two warn tokens are declared in both themes, as colours (#2b measures them); the dark block holds its own, not the light ones through the cascade
    for (const theme of ['light', 'dark'] as const) {
      const r = resolver(APP_THEME_CSS, ROOT_SELECTOR, theme, true);
      for (const token of ['--ch-warn', '--ch-warn-text']) assert(r.props.has(token) && 'rgb' in r.value(token), `${theme} ${token}`);
    }
    const darkBlock = rule(APP_THEME_CSS, ".ch-app[data-theme='dark']");
    for (const token of ['--ch-warn', '--ch-warn-text']) assert(new RegExp(`\\n\\s*${token}:`).test(`\n${darkBlock}`), `the dark block declares ${token}`);
    assert(show(resolver(APP_THEME_CSS, ROOT_SELECTOR, 'light', true).colour('--ch-warn')) !== show(resolver(APP_THEME_CSS, ROOT_SELECTOR, 'dark', true).colour('--ch-warn')), 'the dark orange is its own shade');
    const count = (pairs: [string, string][], a: string, b: string) => pairs.filter(([x, y]) => x === a && y === b).length;
    for (const [a, b] of [['--ch-accent', '--ch-accent-soft'], ['--ch-warn-text', '--ch-section'], ['--ch-muted', '--ch-section']] as const) assert(count(TEXT_PAIRS, a, b) === 1, `TEXT_PAIRS holds ${a} on ${b} once: ${count(TEXT_PAIRS, a, b)}`);
    for (const [a, b] of [['--ch-warn', '--ch-section'], ['--ch-accent', '--ch-section'], ['--ch-button', '--ch-section']] as const) assert(count(MARK_PAIRS, a, b) === 1, `MARK_PAIRS holds ${a} on ${b} once: ${count(MARK_PAIRS, a, b)}`);
  });

  await check('K16 lintCss finds what #2 looks for, in any style sheet: a size under 11 px, a size not in px, a font shorthand that hides one (but not font: inherit), a .ch-btn / .ch-icon-btn / .ch-sheet-close / .ch-btn-outline under 44 px or with no minimum, a physical property, :hover, and a colour literal outside a token block; comments and token blocks are clean; an exemption is that text once, and an exemption that is not in the CSS is a problem', () => {
    const clean = `/* a #fff in a comment */\n.ch-app {\n  --ch-x: #fff;\n  --ch-y: rgba(0, 0, 0, 0.5);\n}\n.a {\n  font-size: 14px;\n  font: inherit;\n  margin-inline-start: 4px;\n  color: var(--ch-text);\n}\n.ch-btn {\n  min-height: 44px;\n}\n.ch-btn-outline {\n  min-block-size: 48px;\n}\n`;
    assert(show(lintCss(clean)) === show([]), `clean: ${show(lintCss(clean))}`);
    const bad: [string, string, RegExp][] = [
      ['a size under 11 px', '.a {\n  font-size: 10px;\n}', /11/],
      ['a size in rem', '.a {\n  font-size: 1rem;\n}', /px/],
      ['a size in %', '.a {\n  font-size: 90%;\n}', /px/],
      ['a font shorthand', '.a {\n  font: 12px/1.2 sans-serif;\n}', /shorthand/],
      ['.ch-btn under 44', '.ch-btn {\n  min-height: 40px;\n}', /ch-btn.*44/],
      ['.ch-btn with no minimum', '.ch-btn {\n  display: flex;\n}', /ch-btn/],
      ['.ch-icon-btn under 44', '.ch-icon-btn {\n  min-height: 43px;\n}', /ch-icon-btn.*44/],
      ['.ch-sheet-close under 44', '.ch-sheet-close {\n  min-height: 30px;\n}', /ch-sheet-close.*44/],
      ['.ch-btn-outline under 44', '.ch-btn-outline {\n  min-block-size: 40px;\n}', /ch-btn-outline.*44/],
      ['margin-left', '.a {\n  margin-left: 4px;\n}', /physical/],
      ['padding-right', '.a {\n  padding-right: 4px;\n}', /physical/],
      ['border-left', '.a {\n  border-left: 1px solid;\n}', /physical/],
      ['left:', '.a {\n  left: 0;\n}', /physical/],
      ['text-align: right', '.a {\n  text-align: right;\n}', /physical/],
      ['float', '.a {\n  float: left;\n}', /physical/],
      ['a hover', '.a:hover {\n  color: red;\n}', /hover/],
      ['a hex outside a token block', '.a {\n  color: #fff;\n}', /literal/],
      ['an 8-digit hex', '.a {\n  color: #ffffff80;\n}', /literal/],
      ['rgb()', '.a {\n  color: rgb(0, 0, 0);\n}', /literal/],
      ['rgba()', '.a {\n  background: rgba(0, 0, 0, 0.5);\n}', /literal/],
      ['hsl()', '.a {\n  color: hsl(0, 0%, 0%);\n}', /literal/],
    ];
    for (const [name, css, want] of bad) {
      const found = lintCss(css);
      assert(found.length >= 1 && found.some((p) => want.test(p)), `${name}: ${show(found)}`);
    }
    // An exemption is a piece of the CSS, once; the same text elsewhere, and the same declaration under another selector, are still literals
    const paint = 'html:has(.x) {\n  background-color: var(--tg-theme-bg-color, #15151d);';
    const css = `${paint}\n}\n.b {\n  background-color: var(--tg-theme-bg-color, #15151d);\n}`;
    assert(lintCss(`${paint}\n}`, { exempt: [paint] }).length === 0, 'the exempt text is clean');
    const twice = lintCss(css, { exempt: [paint] });
    assert(twice.length === 1 && /literal/.test(twice[0]), `the same colour elsewhere is not exempt: ${show(twice)}`);
    const declaration = 'background-color: var(--tg-theme-bg-color, #15151d);';
    const repeated = lintCss(`.a {\n  ${declaration}\n}\n.b {\n  ${declaration}\n}`, { exempt: [declaration] });
    assert(repeated.length === 1 && /literal/.test(repeated[0]), `the exempt text twice: only the first is skipped: ${show(repeated)}`);
    const stale = lintCss('.a {\n  color: var(--ch-text);\n}', { exempt: ['gone'] });
    assert(stale.length === 1 && /exempt/.test(stale[0]), `an exemption not in the CSS: ${show(stale)}`);
  });

  // ---- W3: CopyField (K17; K1-K16 are W1's) ----

  await check("K17 CopyField: a field (label, value, a read-only input that reads left to right, a 44 px icon button named Copy link, a hidden status) whose tap writes the value to the clipboard, then says Copied (the button's name, the check mark and the status) for 2 seconds and goes back; with no clipboard, or one that rejects, it never says Copied, logs why ([copy] clipboard unavailable:), selects the input's whole text so a long press copies it, and throws nothing; a disabled field has a disabled button that copies nothing", async () => {
    installWindow();
    const props = { label: 'Invite link', value: 'https://famcal.bot/en/invite/abc123', copyLabel: 'Copy link', copiedLabel: 'Copied' };
    // Its parts, on the server
    const server = markupOf(renderToString(createElement(CopyField, props)));
    assert(server.startsWith('<div class="ch-copy-field"><input ') && server.includes('class="ch-copy-field-input"') && /readonly=""/i.test(server) && server.includes('dir="ltr"'), `the server markup: ${server.slice(0, 240)}`);
    assert(server.includes('<span class="ch-visually-hidden" role="status"></span></div>'), `the status: ${server.slice(-120)}`);
    // The clipboard and the 2 second timer, held by hand
    const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const written: string[] = [];
    const setNavigator = (value: Row) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
    const held: { fn: () => void; delay: number }[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, delay?: number, ...rest: unknown[]) => {
      if (delay === 2000) {
        held.push({ fn, delay });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(fn, delay, ...rest);
    }) as typeof setTimeout;
    // A tap whose handler throws or rejects ends in an unhandled rejection: "throws nothing" is checked here, as a failure of this check
    const tap = async (m: ReturnType<typeof mount>, el: Parameters<typeof m.click>[0]) => {
      const thrown: unknown[] = [];
      const onRejection = (reason: unknown) => void thrown.push(reason);
      process.on('unhandledRejection', onRejection);
      try {
        await act(async () => {
          m.click(el);
          for (let i = 0; i < 4; i++) await Promise.resolve();
        });
        await new Promise((resolve) => realSetTimeout(resolve, 0));
      } finally {
        process.off('unhandledRejection', onRejection);
      }
      assert(thrown.length === 0, `a tap threw: ${thrown.map(String).join('; ')}`);
    };
    const parts = (m: ReturnType<typeof mount>) => {
      const all = elements(m.container);
      const input = all.find((e) => e.localName === 'input');
      const button = all.find((e) => e.localName === 'button');
      const status = all.find((e) => e.getAttribute('role') === 'status');
      assert(input && button && status, 'the three parts');
      return { input, button, status, svg: all.find((e) => e.localName === 'svg') };
    };
    try {
      // A clipboard that works
      setNavigator({ clipboard: { writeText: async (text: string) => void written.push(text) } });
      const m = mount(createElement(CopyField, props));
      try {
        const field = elements(m.container).find((e) => e.className === 'ch-copy-field');
        const { input, button, status, svg } = parts(m);
        assert(field && show(field.childNodes.map((n) => (n as { localName?: string }).localName)) === show(['input', 'button', 'span']), 'the field holds an input, a button and a status, in that order');
        assert(input.className === 'ch-copy-field-input' && (input.hasAttribute('readonly') || input.hasAttribute('readOnly')) && input.getAttribute('dir') === 'ltr' && input.getAttribute('aria-label') === props.label && input.value === props.value, `the input: ${show([...input.attributes])}`);
        assert(button.className === 'ch-icon-btn ch-copy-field-btn' && button.getAttribute('type') === 'button' && button.getAttribute('aria-label') === 'Copy link', `the button: ${button.className} ${button.getAttribute('aria-label')}`);
        assert(svg?.getAttribute('aria-hidden') === 'true' && /lucide-copy\b/.test(svg.getAttribute('class') ?? ''), `the icon before: ${svg?.getAttribute('class')}`);
        assert(status.className === 'ch-visually-hidden' && status.textContent === '', 'the status is empty');
        await tap(m, button);
        assert(show(written) === show([props.value]), `written: ${show(written)}`);
        const after = parts(m);
        assert(after.status.textContent === 'Copied' && after.button.getAttribute('aria-label') === 'Copied' && /lucide-check\b/.test(after.svg?.getAttribute('class') ?? ''), `copied: ${after.status.textContent} ${after.button.getAttribute('aria-label')} ${after.svg?.getAttribute('class')}`);
        assert(held.length === 1 && copyLogs.length === 0 && after.input.selection === null, `after a tap: ${held.length} timer(s), ${show(copyLogs)}, selection ${show(after.input.selection)}`);
        act(() => held[0].fn());
        const back = parts(m);
        assert(back.status.textContent === '' && back.button.getAttribute('aria-label') === 'Copy link' && /lucide-copy\b/.test(back.svg?.getAttribute('class') ?? ''), 'after 2 seconds it goes back');
      } finally {
        m.unmount();
      }
      // A disabled field (a request is changing the link): the button is disabled and a tap copies nothing
      written.length = 0;
      const waiting = mount(createElement(CopyField, { ...props, disabled: true }));
      try {
        const { button } = parts(waiting);
        assert(button.hasAttribute('disabled'), 'the button is disabled');
        await tap(waiting, button);
        assert(written.length === 0 && copyLogs.length === 0 && parts(waiting).status.textContent === '', `a tap on the disabled button: ${show(written)}`);
      } finally {
        waiting.unmount();
      }
      // No clipboard API at all, then one that rejects: never Copied, the text selected, the reason logged, nothing thrown
      for (const [name, clipboard] of [['no clipboard', undefined], ['a rejecting clipboard', { writeText: () => Promise.reject(new Error('denied')) }]] as const) {
        copyLogs.length = 0;
        held.length = 0;
        setNavigator(clipboard ? { clipboard } : {});
        const blocked = mount(createElement(CopyField, props));
        try {
          const { input, button } = parts(blocked);
          await tap(blocked, button);
          const now = parts(blocked);
          assert(now.status.textContent === '' && now.button.getAttribute('aria-label') === 'Copy link' && held.length === 0, `${name}: Copied was said (${now.status.textContent}), ${held.length} timer(s)`);
          assert(copyLogs.length === 1 && copyLogs[0].startsWith('[copy] clipboard unavailable:'), `${name}: the log ${show(copyLogs)}`);
          assert(show(input.selection) === show({ start: 0, end: props.value.length }), `${name}: the selection ${show(input.selection)}`);
        } finally {
          blocked.unmount();
        }
      }
    } finally {
      globalThis.setTimeout = realSetTimeout;
      if (navigatorBefore) Object.defineProperty(globalThis, 'navigator', navigatorBefore);
    }
  });

  // ---- Plan A: ListRow and the Tag tones (K18) ----

  await check('K18 ListRow and the Tag tones (plan A): a list row is a button row (ch-form-row ch-list-row) with the title (dir="auto"), a quiet line, a row of tags and the chevron, in that order, without the lines it was not given, and a tap calls onClick once; a Tag takes a tone (accent is the plain ch-tag; danger and muted add their class); the tones follow .ch-tag in the cascade on tokens #2b measures (--ch-danger on --ch-danger-soft, --ch-muted on --ch-surface), --ch-danger-soft is declared in both themes as its own shade, and FORM_CSS holds the list row\'s rules after the grouped page\'s row padding', () => {
    const RowProbe = ListRow as unknown as (props: Omit<ComponentProps<typeof ListRow>, 'children'>) => ReactElement;
    const TonedTag = Tag as unknown as (props: { tone?: 'accent' | 'danger' | 'muted' }) => ReactElement;
    const row = markupOf(renderToString(createElement(RowProbe, { title: 'Noa', meta: '9 days left', tags: createElement(TonedTag, { tone: 'danger' }, 'Suspended'), onClick: noop, describedBy: 'hint' })));
    const order = ['<button type="button" class="ch-form-row ch-list-row" aria-describedby="hint">', '<span class="ch-form-label">', '<span class="ch-list-title" dir="auto">Noa</span>', '<span class="ch-form-hint">9 days left</span>', '<span class="ch-list-tags"><span class="ch-tag ch-tag-danger">Suspended</span></span>', 'class="ch-form-chevron"', '</button>'];
    let at = -1;
    for (const part of order) {
      const found = row.indexOf(part, at + 1);
      assert(found > at, `the list row: "${part}" is missing or out of order in ${row}`);
      at = found;
    }
    const bare = markupOf(renderToString(createElement(RowProbe, { title: 'Users', onClick: noop })));
    assert(!bare.includes('ch-form-hint') && !bare.includes('ch-list-tags') && !bare.includes('aria-describedby') && bare.includes('class="ch-form-chevron"'), `a list row with a title only: ${bare}`);
    installWindow();
    let taps = 0;
    const m = mount(createElement(RowProbe, { title: 'Dan', onClick: () => void taps++ }));
    try {
      const button = elements(m.container).find((e) => e.localName === 'button');
      assert(button, 'the row is a button');
      m.click(button);
      assert(taps === 1, `a tap called onClick ${taps} time(s)`);
    } finally {
      m.unmount();
    }
    // Tones
    const tag = (tone?: 'accent' | 'danger' | 'muted') => renderToString(createElement(TonedTag, { tone }, 'x'));
    assert(tag() === '<span class="ch-tag">x</span>' && tag('accent') === '<span class="ch-tag">x</span>', `the accent tag: ${tag()} ${tag('accent')}`);
    assert(tag('danger') === '<span class="ch-tag ch-tag-danger">x</span>' && tag('muted') === '<span class="ch-tag ch-tag-muted">x</span>', `the toned tags: ${tag('danger')} ${tag('muted')}`);
    assert(/background:\s*var\(--ch-danger-soft\)/.test(rule(APP_SCREEN_CSS, '.ch-tag-danger')) && /color:\s*var\(--ch-danger\)/.test(rule(APP_SCREEN_CSS, '.ch-tag-danger')), '.ch-tag-danger is --ch-danger on --ch-danger-soft');
    assert(/background:\s*var\(--ch-surface\)/.test(rule(APP_SCREEN_CSS, '.ch-tag-muted')) && /color:\s*var\(--ch-muted\)/.test(rule(APP_SCREEN_CSS, '.ch-tag-muted')), '.ch-tag-muted is --ch-muted on --ch-surface');
    assert(APP_SCREEN_CSS.indexOf('.ch-tag {') < APP_SCREEN_CSS.indexOf('.ch-tag-danger {') && APP_SCREEN_CSS.indexOf('.ch-tag-danger {') < APP_SCREEN_CSS.indexOf('.ch-tag-muted {'), 'the tones follow .ch-tag');
    for (const theme of ['light', 'dark'] as const) {
      const r = resolver(APP_THEME_CSS, ROOT_SELECTOR, theme, true);
      assert(r.props.has('--ch-danger-soft') && 'rgb' in r.value('--ch-danger-soft'), `${theme}: --ch-danger-soft is a colour`);
    }
    const darkBlock = rule(APP_THEME_CSS, ".ch-app[data-theme='dark']");
    assert(/\n\s*--ch-danger-soft:/.test(`\n${darkBlock}`), 'the dark block declares --ch-danger-soft');
    assert(show(resolver(APP_THEME_CSS, ROOT_SELECTOR, 'light', false).colour('--ch-danger-soft')) !== show(resolver(APP_THEME_CSS, ROOT_SELECTOR, 'dark', false).colour('--ch-danger-soft')), 'the dark danger ground is its own shade');
    const count = (pairs: [string, string][], a: string, b: string) => pairs.filter(([x, y]) => x === a && y === b).length;
    assert(count(TEXT_PAIRS, '--ch-danger', '--ch-danger-soft') === 1 && count(TEXT_PAIRS, '--ch-muted', '--ch-surface') === 1, 'TEXT_PAIRS holds the danger tag and the muted tag once each');
    // FORM_CSS: the list row's rules, and the grouped page's row padding must not undo them
    const grouped = FORM_CSS.indexOf('.ch-form-page-grouped .ch-form-row {');
    const listInGrouped = FORM_CSS.indexOf('.ch-form-page-grouped .ch-list-row {');
    assert(grouped !== -1 && listInGrouped > grouped, 'the list row beats the grouped page\'s row padding by coming after it at the same specificity');
    assert(/padding-block:\s*10px/.test(rule(FORM_CSS, '.ch-list-row')) && /padding-block:\s*10px/.test(rule(FORM_CSS, '.ch-form-page-grouped .ch-list-row')), 'a list row is 10px above and below');
    assert(/font-size:\s*16px/.test(rule(FORM_CSS, '.ch-list-title')) && /overflow-wrap:\s*anywhere/.test(rule(FORM_CSS, '.ch-list-title')), 'the title is 16px and wraps');
    assert(/flex-wrap:\s*wrap/.test(rule(FORM_CSS, '.ch-list-tags')) && /gap:\s*6px/.test(rule(FORM_CSS, '.ch-list-tags')), 'the tags wrap with a 6px gap');
    // An action row (a row that does something, as a danger row does something that cannot be undone): the accent, after the danger row
    assert(/color:\s*var\(--ch-accent\)/.test(rule(FORM_CSS, 'button.ch-action-row')) && FORM_CSS.indexOf('button.ch-action-row {') > FORM_CSS.indexOf('button.ch-danger-row {'), 'an action row reads in the accent, after the danger row');
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

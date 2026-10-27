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
//    gets no frame and no page paint.
// React must log no warning. No network, no DB, no Redis.
//
// Run with the fake env from the task brief (no dotenv), under two clocks:
//   TZ=UTC npx tsx scripts/smoke-app-ui.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-app-ui.ts

import fs from 'fs';
import path from 'path';
import { APP_THEME_CSS } from '../components/app-ui/theme';
import { APP_SCREEN_CSS } from '../components/app-ui/screen';
import { contrast, MARK_PAIRS, resolver, TEXT_PAIRS, TG_ALL, type Theme } from './lib/css-resolve';

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
    // A token block's declarations are tokens (the shades live there); the one exemption outside is a Telegram var()'s fallback.
    const outside = CSS.replace(/^\s*--[\w-]+\s*:[^;]*;/gm, '').replace(/var\(--tg-theme-[\w-]+,\s*#[0-9a-f]{3,8}\)/gi, 'var(--tg-theme-x, FALLBACK)');
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

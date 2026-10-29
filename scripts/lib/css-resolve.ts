// The design-layer smokes' CSS helpers: a style sheet's custom properties resolved the way a
// browser resolves them (the cascade over the root selector's rules, var() with its fallbacks,
// color-mix(in srgb), the --tg-theme-* values Telegram sets), and the WCAG contrast of two
// resolved colours. Shared by smoke-calendar-home-tabs.ts and smoke-app-ui.ts; scripts/lib/
// is not a smoke (ci-smokes.sh runs scripts/smoke-*.ts only).
//
// The root selector is a parameter (the theme's scope: '.ch-app'), so a rename of the root
// is one edit in the caller. The cascade knows exactly the two selectors a theme uses:
// <root> (specificity 10) and <root>[data-theme='dark'] (20, dark only).

import fs from 'fs';
import path from 'path';

export type Theme = 'light' | 'dark';
export type Rgb = [number, number, number];
type Rule = { selectors: string[]; decls: [string, string][]; supports: boolean };

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** The top-level blocks of a style sheet: [prelude, body]. Comments out first. */
export function cssBlocks(css: string): [string, string][] {
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
export const customProps = (body: string): [string, string][] =>
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

/** The custom properties on the root for a theme: the cascade over the two selectors the theme uses. */
export function cascade(css: string, root: string, theme: Theme, colorMix: boolean): Map<string, string> {
  const specificity = (selector: string) => (selector === root ? 10 : selector === `${root}[data-theme='dark']` && theme === 'dark' ? 20 : 0);
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

/** app/globals.css's own custom properties (the brand fallbacks the tokens end in). */
export const GLOBALS = new Map(
  [...fs.readFileSync(path.join(__dirname, '../../app/globals.css'), 'utf8').matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()] as [string, string]),
);

/** Splits a function's arguments at its top-level commas. */
export function splitArgs(inner: string): string[] {
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
export function resolver(css: string, root: string, theme: Theme, colorMix: boolean, tg: Record<string, string> = {}) {
  const props = cascade(css, root, theme, colorMix);
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
    /**
     * What a token comes to: a colour (hex, var() or color-mix), or its literal text for a value that
     * is none (a shadow, the scrim's rgba). The text keeps no var(): a literal token has none.
     */
    value: (token: string): { rgb: Rgb } | { text: string } => {
      const raw = props.get(token);
      assert(raw !== undefined, `${token} is not declared`);
      if (/^#|^var\(|^color-mix\(/.test(raw)) return { rgb: colour(`var(${token})`) };
      assert(!raw.includes('var('), `${token} mixes a literal with var(): ${raw}`);
      return { text: raw };
    },
  };
}

const linear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, gr, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(gr) + 0.0722 * linear(b);
/** The WCAG contrast ratio of two colours. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every Telegram theme param the app maps, each a different grey, so the reads are unambiguous. */
export const TG_ALL: Record<string, string> = Object.fromEntries(
  ['bg', 'text', 'hint', 'link', 'button', 'button-text', 'secondary-bg', 'header-bg', 'accent-text', 'section-bg', 'section-header-text', 'section-separator', 'subtitle-text', 'destructive-text'].map((n, i) => [
    `--tg-theme-${n}-color`,
    `#${(0x111111 * (i + 1)).toString(16).padStart(6, '0')}`,
  ]),
);

/** Text on what it sits on: 4.5:1 (WCAG 1.4.3). The pairs of the tab bar and of the Month's colours. */
export const TEXT_PAIRS: [string, string][] = [
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
  // W1a: text on the grouped ground (the surface) and on its cards (the section colour)
  ['--ch-muted', '--ch-surface'],
  ['--ch-text', '--ch-section'],
  ['--ch-muted', '--ch-section'],
  ['--ch-danger', '--ch-section'],
  ['--ch-danger', '--ch-surface'],
  ['--ch-accent', '--ch-section'],
  ['--ch-text', '--ch-surface'],
  // W1a: the Disconnect button's text on its danger fill (the page's ground, as the selected day's text is: --ch-button-text on --ch-danger is 2.3:1 in the dark)
  ['--ch-bg', '--ch-danger'],
  // W1b: a tag's text on its soft ground, and a near-limit count on the card
  ['--ch-accent', '--ch-accent-soft'],
  ['--ch-warn-text', '--ch-section'],
  // W3: the copy button's icon (on the icon button's surface fill) and a quiet button's text on the invite card, both on the surface
  ['--ch-accent', '--ch-surface'],
  // A (the admin panel): the danger tag's text on its soft ground. The muted tag is --ch-muted on --ch-surface (W1a's pair above).
  ['--ch-danger', '--ch-danger-soft'],
  // W4-3: a primary button's label on its fill (Back to FamCal, Finish in Telegram on the browser pages, in the dark too)
  ['--ch-button-text', '--ch-button'],
];
/** The marks that tell whose an item is without colour, and the solid fills: 3:1 (WCAG 1.4.11). */
export const MARK_PAIRS: [string, string][] = [
  ['--ch-dot-mine', '--ch-bg'],
  ['--ch-dot-partner', '--ch-bg'],
  ['--ch-partner-line', '--ch-bg'],
  ['--ch-partner-line', '--ch-partner-soft'],
  ['--ch-mine-solid', '--ch-bg'],
  ['--ch-today', '--ch-bg'],
  // W1a: a switch's off outline and its on track, against the card they sit on
  ['--ch-done', '--ch-section'],
  ['--ch-button', '--ch-section'],
  // W1b: a meter's near-limit fill and its ordinary fill, on the card
  ['--ch-warn', '--ch-section'],
  ['--ch-accent', '--ch-section'],
];

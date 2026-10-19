// Each calendar's own colour on the calendar home (spec 2026-10-19 §3.2, §3.3). Pure and
// client-safe, with no imports.
//
// A calendar's colour (Google's backgroundColor, or a FamCal calendar's swatch) is often a
// pastel that can't carry text, and the home has a light and a dark look. calendarTones
// turns one colour into three tones for one look:
// - fill: the colour mixed into the look's ground, behind the viewer's own chips;
// - text: the colour made darker (light) or lighter (dark) until it reads at 4.5:1 on
//   that fill and on every ground in the look's list. Only its HSL lightness moves, so
//   the hue and saturation stay: a pastel blue's text is a deep blue, not a grey;
// - line: the same, until it reaches 3:1 on every ground, for the stripes, outlines,
//   dots and rings.
// The grounds are the home's own fallbacks plus the common Telegram themes' backgrounds,
// so the floors hold inside Telegram too.
//
// calendarVars carries both looks' tones as custom properties on the element that draws
// the mark; the element also takes the class 'has-cal', and HOME_THEME_CSS picks the
// light or the dark set by the home's data-theme (no theme in React, so the server's
// render and the client's agree). Anything but '#rrggbb' gives null, and null means
// today's look: the accent for the viewer's items and orange for the partner's.

export type ToneTheme = 'light' | 'dark';

export interface CalendarTones {
  fill: string;
  text: string;
  line: string;
}

interface Look {
  /** What the fill is mixed into: the home's fallback background. */
  ground: string;
  /** The calendar colour's share of the fill. */
  fillShare: number;
  /** Which way text and lines move: darker on a light ground, lighter on a dark one. */
  direction: -1 | 1;
  /** Every background a coloured mark may sit on in this look. */
  grounds: readonly string[];
}

const LOOKS: Readonly<Record<ToneTheme, Look>> = {
  light: {
    ground: '#ffffff',
    fillShare: 0.28,
    direction: -1,
    // The page, the surface (a failed day) and the "Still open" card.
    grounds: ['#ffffff', '#f3f2f8', '#f5f2ff'],
  },
  dark: {
    ground: '#15151d',
    fillShare: 0.3,
    direction: 1,
    // The home's page, section and card; Telegram's iOS, desktop and Android night backgrounds.
    grounds: ['#15151d', '#1e1e29', '#221d3a', '#000000', '#17212b', '#212121'],
  },
};

export const TEXT_FLOOR = 4.5;
export const LINE_FLOOR = 3;
/** How far each step moves a tone's HSL lightness. */
const STEP = 0.01;

const HEX = /^#[0-9a-f]{6}$/i;

type Rgb = readonly [number, number, number];

function rgbOf(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hexOf(rgb: Rgb): string {
  return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** `share` of `a`, the rest `b`, per sRGB channel. */
function mix(a: Rgb, b: Rgb, share: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i] * share + b[i] * (1 - share))) as unknown as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two '#rrggbb' colours. */
export function contrast(a: string, b: string): number {
  const la = luminance(rgbOf(a));
  const lb = luminance(rgbOf(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

type Hsl = readonly [number, number, number];

function hslOf([r, g, b]: Rgb): Hsl {
  const [rs, gs, bs] = [r / 255, g / 255, b / 255];
  const max = Math.max(rs, gs, bs);
  const min = Math.min(rs, gs, bs);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rs ? (gs - bs) / d + (gs < bs ? 6 : 0) : max === gs ? (bs - rs) / d + 2 : (rs - gs) / d + 4;
  return [h / 6, s, l];
}

function rgbOfHsl([h, s, l]: Hsl): Rgb {
  if (s === 0) return [l, l, l].map((c) => Math.round(c * 255)) as unknown as Rgb;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((c) => Math.round(c * 255)) as unknown as Rgb;
}

/**
 * The colour with its lightness moved in `direction` step by step until it reads at
 * `floor` on every background. Black and white always do on the looks' grounds, so it
 * ends there at the latest.
 */
function moved(colour: Rgb, direction: -1 | 1, floor: number, backgrounds: readonly string[]): string {
  const [h, s, l] = hslOf(colour);
  const end = direction < 0 ? 0 : 1;
  for (let i = 0; ; i++) {
    const lightness = Math.min(1, Math.max(0, l + direction * i * STEP));
    const tone = hexOf(rgbOfHsl([h, s, lightness]));
    if (lightness === end || backgrounds.every((bg) => contrast(tone, bg) >= floor)) return tone;
  }
}

const tonesMemo = new Map<string, CalendarTones | null>();

/** The tones of a calendar colour in one look, or null for anything but '#rrggbb'. Memoised per colour and look. */
export function calendarTones(hex: string | null | undefined, theme: ToneTheme): CalendarTones | null {
  if (typeof hex !== 'string' || !HEX.test(hex)) return null;
  const key = `${theme}|${hex.toLowerCase()}`;
  const memo = tonesMemo.get(key);
  if (memo !== undefined) return memo;
  const look = LOOKS[theme];
  const colour = rgbOf(hex);
  const fill = hexOf(mix(colour, rgbOf(look.ground), look.fillShare));
  const tones: CalendarTones = Object.freeze({
    fill,
    text: moved(colour, look.direction, TEXT_FLOOR, [fill, ...look.grounds]),
    line: moved(colour, look.direction, LINE_FLOOR, look.grounds),
  });
  tonesMemo.set(key, tones);
  return tones;
}

/** Every background a look's marks are checked against (the smoke reads it). */
export function toneGrounds(theme: ToneTheme): readonly string[] {
  return LOOKS[theme].grounds;
}

export type CalendarVars = Readonly<Record<string, string>>;

const varsMemo = new Map<string, CalendarVars | null>();

/**
 * Both looks' tones as the custom properties a coloured mark carries in its style
 * (--cal-fill-l, --cal-text-l, --cal-line-l and the -d set), or null for no usable
 * colour. The element takes the class 'has-cal' with them. Memoised per colour, so
 * every mark of a calendar shares one object.
 */
export function calendarVars(hex: string | null | undefined): CalendarVars | null {
  if (typeof hex !== 'string' || !HEX.test(hex)) return null;
  const key = hex.toLowerCase();
  const memo = varsMemo.get(key);
  if (memo !== undefined) return memo;
  const light = calendarTones(key, 'light') as CalendarTones;
  const dark = calendarTones(key, 'dark') as CalendarTones;
  const vars: CalendarVars = Object.freeze({
    '--cal-fill-l': light.fill,
    '--cal-text-l': light.text,
    '--cal-line-l': light.line,
    '--cal-fill-d': dark.fill,
    '--cal-text-d': dark.text,
    '--cal-line-d': dark.line,
  });
  varsMemo.set(key, vars);
  return vars;
}

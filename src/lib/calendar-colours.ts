// The one place calendar colours are decided (colour change, 2026-10-24). Pure and
// client-safe; its only imports are culori, for CIEDE2000 and colour-space conversion, and
// calendarTones, which turns a colour into the tones a look draws.
//
// 1. Google's colours. The API's calendarList returns Google's classic, pale calendar
//    backgroundColors; Google's own app shows the current ones. mapGoogleColour turns each
//    of the 24 classic hexes into the current UI hex and passes any other hex (a custom
//    colour) through. Applied wherever a Google calendar's colour enters the app.
// 2. FamCal's own palette: CALENDAR_PALETTE. Add entries to grow it (the picker, the
//    create route, onboarding and the auto-pick all read this list).
// 3. pickCalendarColour: the palette colour farthest (CIEDE2000, worst case over the light
//    and dark looks) from every colour already on the user's screen.
// 4. displayColours: a FamCal calendar whose displayed colour is too close to another
//    visible calendar's is shifted on screen only. The saved colour never changes and a
//    Google calendar is never shifted.

import { clampChroma, converter, differenceCiede2000, formatHex, parse } from 'culori';
import { calendarTones } from './calendar-view/colours';

/** Two displayed colours closer than this (CIEDE2000) are "too alike". */
export const MIN_DELTA_E = 15;

const HEX = /^#[0-9a-f]{6}$/i;

// ---------------------------------------------------------------------------------------
// 1. Google
// ---------------------------------------------------------------------------------------

/**
 * Google's classic calendar colours (colorIds 1-24, what the Calendar API returns) to the
 * current ones Google's apps show. Source: the google-calendar-simple-api colour table,
 * https://google-calendar-simple-api.readthedocs.io/en/latest/colors.html (community-made;
 * Google publishes no such mapping). Keys are lower case. No current hex is also a classic
 * key, so mapping twice changes nothing more (the smoke checks it).
 */
const GOOGLE_CLASSIC_TO_CURRENT: Readonly<Record<string, string>> = {
  '#ac725e': '#795548', // Cocoa
  '#d06b64': '#e67c73', // Flamingo
  '#f83a22': '#d50000', // Tomato
  '#fa573c': '#f4511e', // Tangerine
  '#ff7537': '#ef6c00', // Pumpkin
  '#ffad46': '#f09300', // Mango
  '#42d692': '#009688', // Eucalyptus
  '#16a765': '#0b8043', // Basil
  '#7bd148': '#7cb342', // Pistachio
  '#b3dc6c': '#c0ca33', // Avocado
  '#fbe983': '#e4c441', // Citron
  '#fad165': '#f6bf26', // Banana
  '#92e1c0': '#33b679', // Sage
  '#9fe1e7': '#039be5', // Peacock
  '#9fc6e7': '#4285f4', // Cobalt
  '#4986e7': '#3f51b5', // Blueberry
  '#9a9cff': '#7986cb', // Lavender
  '#b99aff': '#b39ddb', // Wisteria
  '#c2c2c2': '#616161', // Graphite
  '#cabdbf': '#a79b8e', // Birch
  '#cca6ac': '#ad1457', // Radicchio
  '#f691b2': '#d81b60', // Cherry Blossom
  '#cd74e6': '#8e24aa', // Grape
  '#a47ae2': '#9e69af', // Amethyst
};

/** The colour Google gives a calendar nobody coloured (its primary default), as its app shows it. */
export const GOOGLE_DEFAULT_COLOUR = '#039be5';

/**
 * The colour a Google calendar is drawn in: Google's live colour when one is known, else the
 * saved choice's, else Google's default; mapped to the colour Google's app shows. The one rule
 * the read's legend (googleCalendarRef) and the colour step (services/native-calendar/colour.ts)
 * share, so every surface agrees. `fallback: false` leaves out the default (the legend draws
 * nothing for a calendar with no colour at all).
 */
export function googleDrawnColour(live: string | null | undefined, saved: string | null | undefined, fallback = true): string | null {
  const known = (typeof live === 'string' && HEX.test(live) ? live : null) ?? (saved || null);
  return mapGoogleColour(known ?? (fallback ? GOOGLE_DEFAULT_COLOUR : null));
}

/** The classic hexes the table maps, and what they become (the smoke reads them). */
export const GOOGLE_COLOUR_TABLE: Readonly<Record<string, string>> = GOOGLE_CLASSIC_TO_CURRENT;

/**
 * A Google calendar's colour as Google's app shows it: lower case '#rrggbb'. A classic
 * hex is mapped; any other hex passes through (lower-cased); anything that is not a
 * '#rrggbb' string passes through unchanged (null and undefined give null).
 */
export function mapGoogleColour(hex: string): string;
export function mapGoogleColour(hex: string | null | undefined): string | null;
export function mapGoogleColour(hex: string | null | undefined): string | null {
  if (typeof hex !== 'string') return null;
  if (!HEX.test(hex)) return hex;
  const key = hex.toLowerCase();
  return GOOGLE_CLASSIC_TO_CURRENT[key] ?? key;
}

// ---------------------------------------------------------------------------------------
// 2. The native palette
// ---------------------------------------------------------------------------------------

export interface PaletteColour {
  name: string;
  hex: string;
}

/**
 * FamCal's calendar colours, in pick order: Google's current named colours, chosen
 * greedily so each is as far as possible from the ones before it, in both looks. The
 * first is the schema default. To grow the palette (16 or 24 colours), append entries:
 * nothing else reads its length.
 */
export const CALENDAR_PALETTE: readonly PaletteColour[] = [
  { name: 'Peacock', hex: '#039be5' },
  { name: 'Tangerine', hex: '#f4511e' },
  { name: 'Radicchio', hex: '#ad1457' },
  { name: 'Basil', hex: '#0b8043' },
  { name: 'Wisteria', hex: '#b39ddb' },
  { name: 'Grape', hex: '#8e24aa' },
  { name: 'Graphite', hex: '#616161' },
  { name: 'Citron', hex: '#e4c441' },
];

// ---------------------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------------------

const deltaE = differenceCiede2000();
const LOOKS = ['light', 'dark'] as const;

/**
 * The worst case over the light and dark looks of the CIEDE2000 distance between the two
 * colours' line tones (the stripe and dot colour calendarTones draws). Infinity when
 * either colour is unusable (it draws nothing).
 */
export function displayDistance(a: string, b: string): number {
  let worst = Infinity;
  for (const theme of LOOKS) {
    const ta = calendarTones(a, theme);
    const tb = calendarTones(b, theme);
    if (!ta || !tb) continue;
    worst = Math.min(worst, deltaE(ta.line, tb.line));
  }
  return worst;
}

/** The distance in one look only (the smoke reports each look). */
export function lookDistance(a: string, b: string, theme: (typeof LOOKS)[number]): number {
  const ta = calendarTones(a, theme);
  const tb = calendarTones(b, theme);
  return ta && tb ? deltaE(ta.line, tb.line) : Infinity;
}

// ---------------------------------------------------------------------------------------
// 3. Auto-pick
// ---------------------------------------------------------------------------------------

/**
 * The palette colour with the largest minimum display distance to every colour on the
 * user's screen (their FamCal calendars, the partner's they see, their chosen Google
 * calendars after mapGoogleColour). Ties go to the earlier palette entry; on an empty
 * screen that is the first.
 */
export function pickCalendarColour(
  onScreen: readonly (string | null | undefined)[],
  palette: readonly PaletteColour[] = CALENDAR_PALETTE,
): string {
  const used = onScreen.filter((c): c is string => typeof c === 'string' && HEX.test(c));
  let best = palette[0].hex;
  let bestScore = -1;
  for (const { hex } of palette) {
    let score = Infinity;
    for (const u of used) score = Math.min(score, displayDistance(hex, u));
    if (score > bestScore) {
      best = hex;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------
// 4. The display nudge
// ---------------------------------------------------------------------------------------

export interface VisibleCalendar {
  id: string;
  color: string | null;
  /** True for a FamCal calendar, the only kind that may be shifted. */
  native: boolean;
}

const toOklch = converter('oklch');
/** One step: this much lightness, or this many degrees of hue. */
const L_STEP = 0.02;
const H_STEP = 5;
const MAX_STEPS = 16;

function shifted(hex: string, dL: number, dH: number): string | null {
  const c = toOklch(parse(hex));
  if (!c) return null;
  const l = Math.min(0.97, Math.max(0.12, c.l + dL));
  const h = (((c.h ?? 0) + dH) % 360 + 360) % 360;
  return formatHex(clampChroma({ mode: 'oklch', l, c: c.c, h }, 'oklch')) ?? null;
}

/** The candidates at one step, in a fixed order: darker, lighter, hue back, hue forward. */
function candidates(hex: string, step: number): string[] {
  return [shifted(hex, -step * L_STEP, 0), shifted(hex, step * L_STEP, 0), shifted(hex, 0, -step * H_STEP), shifted(hex, 0, step * H_STEP)]
    .filter((c): c is string => c !== null);
}

function nearest(hex: string, others: readonly string[]): number {
  let m = Infinity;
  for (const o of others) m = Math.min(m, displayDistance(hex, o));
  return m;
}

/**
 * The colour each visible calendar is drawn in, by calendar id. Only a FamCal calendar can
 * differ from its saved colour: one whose display is within MIN_DELTA_E of another visible
 * calendar's moves by the smallest step (lightness or hue) that clears it in both looks
 * (or, if none does within the step limit, to the farthest candidate tried). Google
 * calendars and calendars without a usable colour come back as they are. Deterministic: it
 * reads only the colours and ids, taking the FamCal calendars in id order, each judged
 * against the Google ones and the FamCal ones before it as drawn (the ones after it move
 * for themselves), so of two alike the first id keeps its colour. Nothing here is saved.
 */
export function displayColours(calendars: readonly VisibleCalendar[]): Map<string, string> {
  const out = new Map<string, string>();
  const usable = calendars.filter((c): c is VisibleCalendar & { color: string } => typeof c.color === 'string' && HEX.test(c.color));
  for (const c of usable) out.set(c.id, c.color);
  const natives = usable.filter((c) => c.native).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const n of natives) {
    const others = usable.filter((c) => !c.native || natives.indexOf(c) < natives.indexOf(n)).map((c) => out.get(c.id) as string);
    let bestScore = nearest(n.color, others);
    if (bestScore >= MIN_DELTA_E) continue;
    let best = n.color;
    for (let step = 1; step <= MAX_STEPS; step++) {
      let stepBest: string | null = null;
      let stepScore = -1;
      for (const cand of candidates(n.color, step)) {
        const score = nearest(cand, others);
        if (score > stepScore) {
          stepBest = cand;
          stepScore = score;
        }
      }
      if (!stepBest) continue;
      if (stepScore >= MIN_DELTA_E) {
        best = stepBest;
        break;
      }
      if (stepScore > bestScore) {
        best = stepBest;
        bestScore = stepScore;
      }
    }
    out.set(n.id, best);
  }
  return out;
}

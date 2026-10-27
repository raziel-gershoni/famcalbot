// Smoke test for each calendar's own colour on the calendar home (spec 2026-10-19 §3.2,
// §3.3; Plan H1): calendarTones and calendarVars in src/lib/calendar-view/colours.ts, and
// the theme rules that turn a mark's inline tones into --cal-fill, --cal-text and
// --cal-line (components/app-ui/theme.ts), with the marks' own rules (the Agenda's stripe, the Month's
// chips, picked's dots).
//
// It checks:
//  - Google's 24 calendar colours (calendarList's backgroundColor palette), FamCal's
//    default swatch and the extremes, in both looks: every text tone reads at 4.5:1 on its
//    fill and on every ground the look lists, every line at 3:1 on every ground, and the
//    fill is the colour mixed into the look's ground;
//  - the floors hold for any colour (a 4,096-colour grid);
//  - the grounds cover what the home paints: the theme's page, section, surface and card
//    fallbacks, the card as color-mix paints it, and any accent's card on the listed
//    pages (the bounds), read from APP_THEME_CSS rather than from the module's own list;
//  - the hue stays: a tone that moved is still the colour's hue (a pastel blue's text is a
//    blue), unless the colour is a grey;
//  - anything but '#rrggbb' gives null, case doesn't matter, and the answers are memoised;
//  - calendarVars carries both looks' tones as six custom properties, frozen, one object
//    per colour;
//  - the CSS: has-cal picks the light set, the dark home the dark one, and each mark reads
//    the picked set; without has-cal the marks keep today's tokens.
//
// Pure: no database, Redis, network or AI. The output must not depend on the process
// timezone:
//   TZ=UTC npx tsx scripts/smoke-calendar-colours.ts

import { CalendarTones, LINE_FLOOR, TEXT_FLOOR, calendarTones, calendarVars, contrast, toneGrounds, type ToneTheme } from '../src/lib/calendar-view/colours';
import { APP_THEME_CSS } from '../components/app-ui/theme';
import { AGENDA_CSS } from '../app/[locale]/dashboard/AgendaView';
import { MONTH_PICKED_CSS } from '../app/[locale]/dashboard/MonthPicked';
import { MONTH_BROWSE_CSS } from '../app/[locale]/dashboard/MonthBrowse';
import fs from 'fs';
import path from 'path';

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

/** calendarList's backgroundColor palette: Google's 24 calendar colours (colors.get, "calendar"). */
const GOOGLE_CALENDAR_COLOURS = [
  '#ac725e', '#d06b64', '#f83a22', '#fa573c', '#ff7537', '#ffad46', '#42d692', '#16a765',
  '#7bd148', '#b3dc6c', '#fbe983', '#fad165', '#92e1c0', '#9fe1e7', '#9fc6e7', '#4986e7',
  '#9a9cff', '#b99aff', '#c2c2c2', '#cabdbf', '#cca6ac', '#f691b2', '#cd74e6', '#a47ae2',
];
/** FamCal's default swatch (prisma NativeCalendar.color), the fixtures' and the mockups' colours, and the extremes. */
const OTHERS = ['#039BE5', '#F4511E', '#7986CB', '#E67C73', '#7c5ce0', '#000000', '#ffffff', '#ffff00', '#00ffff', '#0000ff', '#808080'];
const ALL = [...GOOGLE_CALENDAR_COLOURS, ...OTHERS];
const THEMES: ToneTheme[] = ['light', 'dark'];

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** HSL hue in degrees and saturation, by an independent formula. */
function hueSat(hex: string): { hue: number; sat: number } {
  const [r, g, b] = rgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { hue: 0, sat: 0 };
  const sat = d / (1 - Math.abs(2 * l - 1));
  const hue = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { hue: (hue + 360) % 360, sat };
}

const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

async function main() {
  await check(`#1 every colour, both looks: text at ${TEXT_FLOOR}:1 on its fill and on every ground, every line at ${LINE_FLOOR}:1 on every ground`, () => {
    const low: string[] = [];
    for (const theme of THEMES) {
      for (const colour of ALL) {
        const t = calendarTones(colour, theme) as CalendarTones;
        assert(t, `${theme} ${colour}: null`);
        if (contrast(t.text, t.fill) < TEXT_FLOOR) low.push(`${theme} ${colour} text ${t.text} on fill ${t.fill}: ${contrast(t.text, t.fill).toFixed(2)}`);
        for (const ground of toneGrounds(theme)) {
          if (contrast(t.text, ground) < TEXT_FLOOR) low.push(`${theme} ${colour} text ${t.text} on ${ground}: ${contrast(t.text, ground).toFixed(2)}`);
          if (contrast(t.line, ground) < LINE_FLOOR) low.push(`${theme} ${colour} line ${t.line} on ${ground}: ${contrast(t.line, ground).toFixed(2)}`);
        }
      }
    }
    assert(low.length === 0, `${low.length} below the floor: ${show(low.slice(0, 6))}`);
    assert(toneGrounds('light').includes('#ffffff') && toneGrounds('dark').includes('#15151d') && toneGrounds('dark').includes('#000000'), 'the grounds include the home\'s and Telegram\'s');
  });

  await check('#2 the fill is the colour mixed into the look\'s ground: 28% on white, 30% on #15151d', () => {
    for (const [theme, ground, share] of [['light', '#ffffff', 0.28], ['dark', '#15151d', 0.3]] as const) {
      for (const colour of ALL) {
        const fill = rgb((calendarTones(colour, theme) as CalendarTones).fill);
        const want = rgb(colour).map((c, i) => c * share + rgb(ground)[i] * (1 - share));
        assert(fill.every((c, i) => Math.abs(c - want[i]) <= 1), `${theme} ${colour}: fill ${show(fill)}, wanted about ${show(want)}`);
      }
    }
  });

  await check('#3 only the lightness moves: every tone keeps the colour\'s hue (within 8°), so a pastel blue reads as a deep blue, not a grey; text goes darker in light and lighter in dark', () => {
    const drift: string[] = [];
    for (const theme of THEMES) {
      for (const colour of ALL) {
        const t = calendarTones(colour, theme) as CalendarTones;
        const base = hueSat(colour);
        for (const tone of [t.text, t.line]) {
          const got = hueSat(tone);
          // A grey, or a tone pushed all the way to black or white, has no hue to keep.
          if (base.sat < 0.05 || got.sat === 0) continue;
          if (hueGap(base.hue, got.hue) > 8) drift.push(`${theme} ${colour} → ${tone}: ${base.hue.toFixed(0)}° → ${got.hue.toFixed(0)}°`);
        }
        const lum = (hex: string) => contrast(hex, '#000000');
        const ok = theme === 'light' ? lum(t.text) <= lum(colour) && lum(t.line) <= lum(colour) : lum(t.text) >= lum(colour) && lum(t.line) >= lum(colour);
        if (!ok) drift.push(`${theme} ${colour}: text ${t.text} line ${t.line} moved the wrong way`);
      }
    }
    assert(drift.length === 0, show(drift.slice(0, 6)));
    const blue = calendarTones('#9fc6e7', 'light') as CalendarTones;
    assert(hueSat(blue.text).sat > 0.4, `the pastel blue's text ${blue.text} is a blue, not a grey`);
  });

  await check('#4 a colour already strong enough is kept as it is (the dark look\'s pastels, the light look\'s deep lines)', () => {
    const dark = calendarTones('#9fc6e7', 'dark') as CalendarTones;
    assert(dark.text === '#9fc6e7' && dark.line === '#9fc6e7', `dark pastel blue: ${show(dark)}`);
    const light = calendarTones('#4986e7', 'light') as CalendarTones;
    assert(light.line === '#4986e7', `light #4986e7's line: ${light.line}`);
  });

  await check('#5 anything but #rrggbb gives null; case doesn\'t matter; the answers are memoised and frozen', () => {
    for (const bad of [null, undefined, '', '#fff', '#12345', '#1234567', '#12345g', 'red', '9fc6e7', ' #9fc6e7', '#9fc6e7 ', 'javascript:alert(1)', 'var(--x)', '#9fc6e7;color:red']) {
      assert(calendarTones(bad as string, 'light') === null && calendarTones(bad as string, 'dark') === null, `${show(bad)}: tones`);
      assert(calendarVars(bad as string) === null, `${show(bad)}: vars`);
    }
    assert(show(calendarTones('#9FC6E7', 'light')) === show(calendarTones('#9fc6e7', 'light')), 'upper case');
    assert(calendarTones('#9fc6e7', 'dark') === calendarTones('#9fc6e7', 'dark'), 'memoised tones');
    assert(Object.isFrozen(calendarTones('#9fc6e7', 'dark')), 'frozen tones');
    assert(calendarVars('#039BE5') === calendarVars('#039be5'), 'one vars object per colour, whatever its case');
    assert(Object.isFrozen(calendarVars('#039be5')), 'frozen vars');
  });

  await check('#6 calendarVars: both looks\' tones as six custom properties, and nothing else', () => {
    for (const colour of ALL) {
      const vars = calendarVars(colour);
      const light = calendarTones(colour, 'light') as CalendarTones;
      const dark = calendarTones(colour, 'dark') as CalendarTones;
      const want = {
        '--cal-fill-l': light.fill, '--cal-text-l': light.text, '--cal-line-l': light.line,
        '--cal-fill-d': dark.fill, '--cal-text-d': dark.text, '--cal-line-d': dark.line,
      };
      assert(show(vars) === show(want), `${colour}: ${show(vars)}`);
      assert(Object.values(want).every((v) => /^#[0-9a-f]{6}$/.test(v)), `${colour}: a tone that isn't lower-case #rrggbb`);
    }
  });

  await check('#7 the CSS: has-cal picks the light set, the dark home the dark one; each mark reads the picked set only under has-cal, and keeps today\'s tokens without it', () => {
    const block = (css: string, selector: string) => {
      const at = css.indexOf(`${selector} {`);
      assert(at >= 0, `no rule ${selector}`);
      return css.slice(at, css.indexOf('}', at));
    };
    const light = block(APP_THEME_CSS, '.ch-app .has-cal');
    const dark = block(APP_THEME_CSS, ".ch-app[data-theme='dark'] .has-cal");
    for (const tone of ['fill', 'text', 'line']) {
      assert(light.includes(`--cal-${tone}: var(--cal-${tone}-l);`), `light ${tone}`);
      assert(dark.includes(`--cal-${tone}: var(--cal-${tone}-d);`), `dark ${tone}`);
    }
    // Every rule that reads a --cal tone is a has-cal rule.
    for (const [name, css] of [['AGENDA_CSS', AGENDA_CSS], ['MONTH_BROWSE_CSS', MONTH_BROWSE_CSS], ['MONTH_PICKED_CSS', MONTH_PICKED_CSS]] as const) {
      const rules = [...css.matchAll(/\n([^\n{}]+(?:,\n[^\n{}]+)*) \{([^}]*)\}/g)];
      const reading = rules.filter((m) => /var\(--cal-/.test(m[2]));
      assert(reading.length > 0, `${name}: no rule reads a calendar tone`);
      for (const m of reading) assert(m[1].split(',\n').every((sel) => sel.includes('.has-cal')), `${name}: ${show(m[1])} reads a tone without has-cal`);
    }
    assert(/\.ch-stripe \{[^}]*background: var\(--ch-dot-mine\);/.test(AGENDA_CSS) && /\.ch-stripe\.is-partner \{[^}]*border: 1\.5px solid var\(--ch-dot-partner\);[^}]*background: transparent;/.test(AGENDA_CSS), 'the stripe without a colour: the accent, or an orange outline');
    assert(/\.ch-stripe\.has-cal \{\s*background: var\(--cal-line\);/.test(AGENDA_CSS) && /\.ch-stripe\.has-cal\.is-partner \{\s*border-color: var\(--cal-line\);\s*background: transparent;/.test(AGENDA_CSS), 'the stripe in a colour: solid, or hollow');
    assert(/\.ch-stripe \{[^}]*inline-size: 4px;/.test(AGENDA_CSS) && /\.ch-stripe \{[^}]*align-self: stretch;/.test(AGENDA_CSS), 'a 4 px stripe the row\'s height');
    assert(/\.ch-mp-dot\.has-cal\.is-mine \{\s*background: var\(--cal-line\);/.test(MONTH_PICKED_CSS) && /\.ch-mp-dot\.has-cal\.is-partner \{\s*border-color: var\(--cal-line\);/.test(MONTH_PICKED_CSS), 'picked\'s dots and rings');
  });

  await check(`#8 the floors hold for any colour: every #rrggbb on a 16-step grid (4,096 colours), both looks`, () => {
    const steps = Array.from({ length: 16 }, (_, i) => (i * 17).toString(16).padStart(2, '0'));
    let low = 0;
    let first = '';
    for (const r of steps) for (const g of steps) for (const b of steps) {
      const colour = `#${r}${g}${b}`;
      for (const theme of THEMES) {
        const t = calendarTones(colour, theme) as CalendarTones;
        const bad = contrast(t.text, t.fill) < TEXT_FLOOR || toneGrounds(theme).some((ground) => contrast(t.text, ground) < TEXT_FLOOR || contrast(t.line, ground) < LINE_FLOOR);
        if (bad && !low++) first = `${theme} ${colour}: ${show(t)}`;
      }
    }
    assert(low === 0, `${low} below the floor, first ${first}`);
  });

  await check('#9 the grounds cover what the home paints, read from the theme: the page, section, surface and card fallbacks in each look and the card as color-mix paints it from the fallback accent; every tone keeps its floors on each; and any accent\'s card on a listed page is no harder than a listed ground', () => {
    const globals = fs.readFileSync(path.join(__dirname, '../app/globals.css'), 'utf8');
    const blockOf = (selector: string) => {
      const at = APP_THEME_CSS.indexOf(`${selector} {`);
      assert(at >= 0, `no ${selector}`);
      return APP_THEME_CSS.slice(at, APP_THEME_CSS.indexOf('}', at));
    };
    /** A token's fallback colour: the last hex in its declaration, or the globals.css token it falls back to. */
    const fallback = (block: string, token: string): string => {
      const decl = new RegExp(`${token}: ([^;]+);`).exec(block)?.[1];
      assert(decl, `no ${token}`);
      const hexes = decl.match(/#[0-9a-f]{6}/gi);
      if (hexes) return hexes[hexes.length - 1].toLowerCase();
      const name = [...decl.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]).filter((n) => !n.startsWith('--tg-')).pop();
      const value = name && new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(globals)?.[1];
      assert(value, `${token}: no fallback in ${show(decl)}`);
      return value.toLowerCase();
    };
    const mix8 = (a: string, b: string) => `#${rgb(a).map((c, i) => Math.round(c * 0.08 + rgb(b)[i] * 0.92).toString(16).padStart(2, '0')).join('')}`;
    const looks = { light: blockOf('.ch-app'), dark: blockOf(".ch-app[data-theme='dark']") };
    const grid = Array.from({ length: 16 }, (_, i) => (i * 17).toString(16).padStart(2, '0'));
    const accents = grid.flatMap((r) => grid.flatMap((g) => grid.map((b) => `#${r}${g}${b}`)));
    const low: string[] = [];
    for (const theme of THEMES) {
      const block = theme === 'light' ? looks.light : `${looks.light}\n${looks.dark}`;
      // The dark block overrides; a token it leaves alone keeps the light one.
      const pick = (token: string) => (new RegExp(`${token}: `).test(looks[theme]) ? fallback(looks[theme], token) : fallback(block, token));
      const bg = pick('--ch-bg');
      const painted = [bg, pick('--ch-section'), pick('--ch-surface'), pick('--ch-card'), mix8(pick('--ch-accent'), bg)];
      for (const colour of ALL) {
        const t = calendarTones(colour, theme) as CalendarTones;
        for (const ground of painted) {
          if (contrast(t.line, ground) < LINE_FLOOR) low.push(`${theme} ${colour} line ${t.line} on ${ground}: ${contrast(t.line, ground).toFixed(3)}`);
          if (contrast(t.text, ground) < TEXT_FLOOR) low.push(`${theme} ${colour} text ${t.text} on ${ground}: ${contrast(t.text, ground).toFixed(3)}`);
        }
      }
      // Any accent's card on a page this look lists is no harder than the listed ground it is bounded by.
      const lum = (hex: string) => contrast(hex, '#000000');
      const grounds = toneGrounds(theme);
      const pages = theme === 'light' ? ['#ffffff'] : ['#15151d', '#000000', '#17212b', '#212121'];
      for (const page of pages) {
        assert(grounds.includes(page), `${theme}: ${page} is not a ground`);
        const hardest = theme === 'light' ? Math.min(...grounds.map(lum)) : Math.max(...grounds.map(lum));
        for (const accent of accents) {
          const card = mix8(accent, page);
          if (theme === 'light' ? lum(card) < hardest - 1e-9 : lum(card) > hardest + 1e-9) {
            low.push(`${theme} card ${card} (accent ${accent} on ${page}) is harder than every ground`);
            break;
          }
        }
      }
    }
    assert(low.length === 0, `${low.length}: ${show(low.slice(0, 6))}`);
  });

  let failed = 0;
  for (const r of results) {
    process.stdout.write(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}\n`);
    if (!r.ok) failed++;
  }
  process.stdout.write(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stdout.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

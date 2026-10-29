// The app's look (spec 2026-10-19 §4): the colour tokens, mapped onto Telegram's theme
// params with fallbacks, plus the pieces every screen shares (buttons, chips, the bottom
// sheet). It began as the calendar home's own, and every --ch-* and ch-* name is kept.
//
// The fallbacks: every value is ./tokens.ts's (APP_TOKENS), the one module the public
// site's style sheet reads too. The brand colours go through app/globals.css's own tokens
// (--bg-white, --text-primary, --brand-primary-dark), whose values APP_TOKENS holds as well
// (smoke-app-ui keeps them equal); the app's layouts import globals.css. The neutral
// shades globals.css has no token for (the hint, surfaces, separators, the danger colour,
// the whole dark palette) are the approved mockups' and belong to the app's look alone.
//
// The theme scope is the .ch-app class, carried by AppScreen (a whole screen):
//   <div className="ch-app" data-theme={scheme} dir={…}>
//     <style>{APP_THEME_CSS}</style>
//     …
// Inside Telegram the SDK writes --tg-theme-* on <html>, so the tokens follow the
// user's Telegram theme, light or dark. In a browser there are no --tg-theme-* values,
// and the fallbacks follow data-theme (prefers-color-scheme).
//
// The frame (the height, the safe areas) and the page root's paint belong to .ch-screen
// (./screen.ts), never to the theme scope: the tokens are the whole of .ch-app.
//
// Rules: nothing smaller than 11 px; every tap target at least 44 px; logical
// properties only, so RTL needs no overrides; no hover styles (touch only).
//
// Plan E's tokens, for the tab bar and the Month (E6 and E7 read only these and the ones
// above). Each is set in light and dark, on Telegram's theme params where one fits; the
// fallbacks are the approved mockups' shades (MonthFlow, MonthPicked, Dark).
// - The tabs: --ch-tab-track behind both; --ch-tab-on, --ch-tab-on-text and
//   --ch-tab-shadow for the selected one (Telegram's section colour on its secondary
//   background, the pairing it uses for a card on a grouped list).
// - Whose an item is (spec §7.3), never told by colour alone:
//   - the viewer's items are filled: a timed one is --ch-mine-soft under
//     --ch-mine-soft-text; all-day items and bars are --ch-mine-solid under
//     --ch-mine-solid-text;
//   - the partner's are outlined: a timed one is a 1 px --ch-partner-line border on the
//     page's background with --ch-partner-line-text; all-day items and bars are
//     --ch-partner-soft under --ch-partner-soft-text, with the same 1 px --ch-partner-line
//     border;
//   - picked's dots: a filled --ch-dot-mine, or a 1.5 px --ch-dot-partner ring.
//   Telegram has no colour for a partner, so those shades are fixed (orange, as D's person
//   chip). The marks (the lines, rings, dots and the solid fill) keep 3:1 against what
//   they sit on, and every text colour 4.5:1.
// - Today's number on --ch-today with --ch-today-text, Telegram's button pair. As plain
//   text on the page (picked, when today isn't selected) it reads --ch-accent.
// - The selected day: --ch-selected with --ch-selected-text (the theme's text and
//   background, swapped).
// - The Today pill: --ch-pill-bg, --ch-pill-line and --ch-pill-text. Month titles:
//   --ch-month-title. Both are the accent pulled a fifth towards the text.
// - Each calendar's own colour (spec 2026-10-19 §3.2, §3.3): a mark drawn in it carries
//   the class has-cal and its tones for both looks as --cal-{fill,text,line}-{l,d}
//   (colours.ts, calendarVars); the rules below pick the set as --cal-fill, --cal-text
//   and --cal-line by data-theme. Without a usable colour a mark keeps the tokens above.
// - A disabled chevron: --ch-disabled, faint on purpose (the button is also disabled). It
//   is the only new colour that reads the hint straight. Every text colour keeps D's
//   floor: an unselected tab's label reads --ch-muted.
// - A danger tag's ground (plan A, Tag tone="danger"): --ch-danger-soft, the page's background with a tenth of the danger
//   colour mixed in; its text is --ch-danger.
// - The banners' and the accent icon buttons' ground: --ch-accent-soft, the page's
//   background with 14% of the accent mixed in.
// - The switch's thumb: --ch-switch-thumb (white in both themes) and its shadow,
//   --ch-switch-thumb-shadow, a literal-text token (a shadow has no colour to resolve).
// - Near a limit (W1b, the Meter): --ch-warn is the fill's orange and --ch-warn-text the count's, on the card
//   (--ch-section): the fill keeps 3:1 and the text 4.5:1. They are fixed shades (Telegram has no orange).
// - The primary button's fill outside Telegram (W4-3): in the dark it is the Month's fill (#6d4ff0, 5.2:1 under the white
//   label and 3:1 on the dark grounds); --brand-primary was 4.38:1. Inside Telegram the theme's button colour stands.

import { APP_TOKENS } from './tokens';

const L = APP_TOKENS.light;
const D = APP_TOKENS.dark;

export const APP_THEME_CSS = `
.ch-app {
  --ch-bg: var(--tg-theme-bg-color, var(--bg-white));
  --ch-text: var(--tg-theme-text-color, var(--text-primary));
  --ch-hint: var(--tg-theme-hint-color, ${L.hint});
  --ch-muted: var(--ch-hint);
  --ch-accent: var(--tg-theme-accent-text-color, var(--tg-theme-link-color, var(--brand-primary-dark)));
  --ch-surface: var(--tg-theme-secondary-bg-color, ${L.surface});
  --ch-section: var(--tg-theme-section-bg-color, var(--tg-theme-bg-color, var(--bg-white)));
  --ch-separator: var(--tg-theme-section-separator-color, ${L.separator});
  --ch-button: var(--tg-theme-button-color, var(--brand-primary-dark));
  --ch-button-text: var(--tg-theme-button-text-color, var(--bg-white));
  --ch-danger: var(--tg-theme-destructive-text-color, ${L.danger});
  --ch-card: ${L.card};
  --ch-card-separator: ${L.cardSeparator};
  --ch-done: ${L.done};
  --ch-chip-bg: ${L.chipBg};
  --ch-chip-text: ${L.chipText};
  --ch-outline: ${L.outline};
  --ch-scrim: ${L.scrim};
  --ch-sheet-shadow: ${L.sheetShadow};
  --ch-tab-track: var(--ch-surface);
  --ch-tab-on: var(--ch-section);
  --ch-tab-on-text: var(--ch-text);
  --ch-tab-shadow: ${L.tabShadow};
  --ch-mine-soft: ${L.mineSoft};
  --ch-mine-soft-text: ${L.mineSoftText};
  --ch-mine-solid: var(--ch-button);
  --ch-mine-solid-text: var(--ch-button-text);
  --ch-partner-soft: ${L.partnerSoft};
  --ch-partner-soft-text: ${L.partnerSoftText};
  --ch-partner-line: ${L.partnerLine};
  --ch-partner-line-text: ${L.partnerLineText};
  --ch-dot-mine: var(--ch-accent);
  --ch-dot-partner: ${L.dotPartner};
  --ch-today: var(--ch-button);
  --ch-today-text: var(--ch-button-text);
  --ch-selected: var(--ch-text);
  --ch-selected-text: var(--ch-bg);
  --ch-pill-bg: var(--ch-card);
  --ch-pill-line: ${L.pillLine};
  --ch-pill-text: var(--tg-theme-accent-text-color, var(--tg-theme-link-color, ${L.pillText}));
  --ch-disabled: ${L.disabled};
  --ch-month-title: var(--tg-theme-accent-text-color, var(--tg-theme-link-color, ${L.monthTitle}));
  --ch-accent-soft: ${L.accentSoft};
  --ch-danger-soft: ${L.dangerSoft};
  --ch-switch-thumb: ${L.switchThumb};
  --ch-switch-thumb-shadow: ${L.switchThumbShadow};
  --ch-warn: ${L.warn};
  --ch-warn-text: ${L.warnText};
  color-scheme: light;
  background: var(--ch-bg);
  color: var(--ch-text);
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Heebo, Inter, sans-serif;
  font-size: 16px;
  line-height: 1.4;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
  -webkit-tap-highlight-color: transparent;
}
.ch-app[data-theme='dark'] {
  --ch-bg: var(--tg-theme-bg-color, ${D.bg});
  --ch-text: var(--tg-theme-text-color, ${D.text});
  --ch-hint: var(--tg-theme-hint-color, ${D.hint});
  --ch-accent: var(--tg-theme-accent-text-color, var(--tg-theme-link-color, ${D.accent}));
  --ch-surface: var(--tg-theme-secondary-bg-color, ${D.surface});
  --ch-section: var(--tg-theme-section-bg-color, var(--tg-theme-bg-color, ${D.section}));
  --ch-separator: var(--tg-theme-section-separator-color, ${D.separator});
  --ch-button: var(--tg-theme-button-color, ${D.button});
  --ch-danger: var(--tg-theme-destructive-text-color, ${D.danger});
  --ch-card: ${D.card};
  --ch-card-separator: ${D.cardSeparator};
  --ch-done: ${D.done};
  --ch-chip-bg: ${D.chipBg};
  --ch-chip-text: ${D.chipText};
  --ch-outline: ${D.outline};
  --ch-scrim: ${D.scrim};
  --ch-sheet-shadow: ${D.sheetShadow};
  --ch-tab-track: var(--ch-surface);
  --ch-tab-on: var(--tg-theme-section-bg-color, ${D.tabOn});
  --ch-tab-on-text: var(--ch-text);
  --ch-tab-shadow: none;
  --ch-mine-soft: ${D.mineSoft};
  --ch-mine-soft-text: ${D.mineSoftText};
  --ch-mine-solid: var(--tg-theme-button-color, ${D.button});
  --ch-mine-solid-text: var(--ch-button-text);
  --ch-partner-soft: ${D.partnerSoft};
  --ch-partner-soft-text: ${D.partnerSoftText};
  --ch-partner-line: ${D.partnerLine};
  --ch-partner-line-text: ${D.partnerLineText};
  --ch-dot-mine: var(--ch-accent);
  --ch-dot-partner: ${D.dotPartner};
  --ch-today: var(--tg-theme-button-color, ${D.button});
  --ch-today-text: var(--ch-button-text);
  --ch-selected: var(--ch-text);
  --ch-selected-text: var(--ch-bg);
  --ch-pill-bg: var(--ch-card);
  --ch-pill-line: ${D.pillLine};
  --ch-pill-text: var(--ch-accent);
  --ch-disabled: ${D.disabled};
  --ch-month-title: var(--ch-accent);
  --ch-accent-soft: ${D.accentSoft};
  --ch-danger-soft: ${D.dangerSoft};
  --ch-warn: ${D.warn};
  --ch-warn-text: ${D.warnText};
  color-scheme: dark;
}
@supports (color: color-mix(in srgb, red 50%, blue)) {
  .ch-app,
  .ch-app[data-theme='dark'] {
    /* A contrast floor over the theme's hint colour (§7.7): pulled a quarter towards the text. */
    --ch-muted: color-mix(in srgb, var(--ch-hint) 75%, var(--ch-text));
    --ch-card: color-mix(in srgb, var(--ch-accent) 8%, var(--ch-bg));
    --ch-card-separator: color-mix(in srgb, var(--ch-accent) 18%, var(--ch-bg));
    --ch-done: color-mix(in srgb, var(--ch-hint) 80%, var(--ch-bg));
    --ch-outline: color-mix(in srgb, var(--ch-hint) 45%, var(--ch-bg));
    /* Plan E: text in the accent, pulled towards the text so it reads on any theme's background; a faint disabled chevron. */
    --ch-mine-soft-text: color-mix(in srgb, var(--ch-accent) 55%, var(--ch-text));
    --ch-pill-text: color-mix(in srgb, var(--ch-accent) 80%, var(--ch-text));
    --ch-month-title: color-mix(in srgb, var(--ch-accent) 80%, var(--ch-text));
    --ch-disabled: color-mix(in srgb, var(--ch-hint) 35%, var(--ch-bg));
    /* The banners' and the accent icon buttons' soft ground. */
    --ch-accent-soft: color-mix(in srgb, var(--ch-accent) 14%, var(--ch-bg));
    /* The danger tag's ground: the danger colour at a tenth, so its text keeps 4.5:1 on it. */
    --ch-danger-soft: color-mix(in srgb, var(--ch-danger) 10%, var(--ch-bg));
  }
  .ch-app {
    --ch-mine-soft: color-mix(in srgb, var(--ch-accent) 12%, var(--ch-bg));
    --ch-pill-line: color-mix(in srgb, var(--ch-accent) 25%, var(--ch-bg));
  }
  .ch-app[data-theme='dark'] {
    --ch-mine-soft: color-mix(in srgb, var(--ch-accent) 22%, var(--ch-bg));
    --ch-pill-line: color-mix(in srgb, var(--ch-accent) 30%, var(--ch-bg));
  }
}
.ch-app .has-cal {
  --cal-fill: var(--cal-fill-l);
  --cal-text: var(--cal-text-l);
  --cal-line: var(--cal-line-l);
}
.ch-app[data-theme='dark'] .has-cal {
  --cal-fill: var(--cal-fill-d);
  --cal-text: var(--cal-text-d);
  --cal-line: var(--cal-line-d);
}
.ch-app *,
.ch-app *::before,
.ch-app *::after {
  box-sizing: border-box;
}
.ch-visually-hidden {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
.ch-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 44px;
  min-width: 44px;
  padding: 0 14px;
  border: 0;
  border-radius: 12px;
  background: var(--ch-surface);
  color: var(--ch-accent);
  font-family: inherit;
  font-size: 15px;
  font-weight: 500;
  line-height: 1.2;
  text-align: center;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-btn:focus-visible,
.ch-tap:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 2px;
}
.ch-btn-primary {
  background: var(--ch-button);
  color: var(--ch-button-text);
}
.ch-chip {
  display: inline-block;
  max-inline-size: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: 6px;
  padding: 1px 7px;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  background: var(--ch-chip-bg);
  color: var(--ch-chip-text);
}
.ch-chip-outline {
  background: transparent;
  color: var(--ch-muted);
  border: 1px solid var(--ch-outline);
  padding: 0 6px;
  font-weight: 400;
}
.ch-sheet-layer {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}
.ch-sheet-backdrop {
  position: absolute;
  inset: 0;
  background: var(--ch-scrim);
  touch-action: none;
}
.ch-sheet {
  position: relative;
  max-block-size: 88vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--ch-section);
  color: var(--ch-text);
  border-start-start-radius: 20px;
  border-start-end-radius: 20px;
  box-shadow: var(--ch-sheet-shadow);
  padding: 8px 16px calc(16px + max(env(safe-area-inset-bottom, 0px), var(--tg-safe-area-inset-bottom, 0px)));
  animation: ch-sheet-in 180ms ease-out;
  outline: none;
}
.ch-sheet-grab {
  inline-size: 40px;
  block-size: 5px;
  border-radius: 3px;
  background: var(--ch-outline);
  margin: 2px auto 14px;
}
.ch-sheet-close {
  display: flex;
  inline-size: 100%;
  min-height: 48px;
  margin-block-start: 16px;
  color: var(--ch-text);
}
.ch-sheet-close:disabled {
  opacity: 0.6;
  cursor: default;
}
.ch-sheet-full {
  flex: 1;
  display: flex;
  flex-direction: column;
  max-block-size: none;
  overflow: hidden;
  padding: 0;
  border-radius: 0;
  background: var(--ch-surface);
}
.ch-app[data-theme='dark'] .ch-sheet-full {
  background: var(--ch-bg);
}
@keyframes ch-sheet-in {
  from { transform: translateY(24px); opacity: 0; }
  to { transform: none; opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .ch-app *,
  .ch-app *::before,
  .ch-app *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}
`;

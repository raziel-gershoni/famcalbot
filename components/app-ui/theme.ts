// The app's look (spec 2026-10-19 §4): the colour tokens, mapped onto Telegram's theme
// params with fallbacks, plus the pieces every screen shares (buttons, chips, the bottom
// sheet). It began as the calendar home's own, and every --ch-* and ch-* name is kept.
//
// The fallbacks: the brand colours are app/globals.css's own tokens (--bg-white,
// --text-primary, --brand-primary-dark, --brand-primary), so the palette lives in one
// place; the layout imports globals.css on every page. The neutral shades globals.css has
// no token for (the hint, surfaces, separators, the danger colour, the whole dark
// palette) are the approved mockups' and belong to the app's look alone.
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
// - The banners' and the accent icon buttons' ground: --ch-accent-soft, the page's
//   background with 14% of the accent mixed in.
// - The switch's thumb: --ch-switch-thumb (white in both themes) and its shadow,
//   --ch-switch-thumb-shadow, a literal-text token (a shadow has no colour to resolve).


export const APP_THEME_CSS = `
.ch-app {
  --ch-bg: var(--tg-theme-bg-color, var(--bg-white));
  --ch-text: var(--tg-theme-text-color, var(--text-primary));
  --ch-hint: var(--tg-theme-hint-color, #5e5e78);
  --ch-muted: var(--ch-hint);
  --ch-accent: var(--tg-theme-accent-text-color, var(--tg-theme-link-color, var(--brand-primary-dark)));
  --ch-surface: var(--tg-theme-secondary-bg-color, #f3f2f8);
  --ch-section: var(--tg-theme-section-bg-color, var(--tg-theme-bg-color, var(--bg-white)));
  --ch-separator: var(--tg-theme-section-separator-color, #eceaf3);
  --ch-button: var(--tg-theme-button-color, var(--brand-primary-dark));
  --ch-button-text: var(--tg-theme-button-text-color, var(--bg-white));
  --ch-danger: var(--tg-theme-destructive-text-color, #c62828);
  --ch-card: #f5f2ff;
  --ch-card-separator: #e4defa;
  --ch-done: #8a8aa0;
  --ch-chip-bg: #ffebd9;
  --ch-chip-text: #8a3d00;
  --ch-outline: #d4d2e0;
  --ch-scrim: rgba(18, 18, 32, 0.45);
  --ch-sheet-shadow: 0 -8px 24px rgba(18, 18, 32, 0.18);
  --ch-tab-track: var(--ch-surface);
  --ch-tab-on: var(--ch-section);
  --ch-tab-on-text: var(--ch-text);
  --ch-tab-shadow: 0 1px 2px rgba(26, 26, 46, 0.14);
  --ch-mine-soft: #eee9ff;
  --ch-mine-soft-text: #2e1a87;
  --ch-mine-solid: var(--ch-button);
  --ch-mine-solid-text: var(--ch-button-text);
  --ch-partner-soft: #ffd9b8;
  --ch-partner-soft-text: #6b2c00;
  --ch-partner-line: #b05f22;
  --ch-partner-line-text: #7a3500;
  --ch-dot-mine: var(--ch-accent);
  --ch-dot-partner: #b4540b;
  --ch-today: var(--ch-button);
  --ch-today-text: var(--ch-button-text);
  --ch-selected: var(--ch-text);
  --ch-selected-text: var(--ch-bg);
  --ch-pill-bg: var(--ch-card);
  --ch-pill-line: #d9d2fa;
  --ch-pill-text: var(--tg-theme-accent-text-color, var(--tg-theme-link-color, #4b2fc9));
  --ch-disabled: #c9c8d6;
  --ch-month-title: var(--tg-theme-accent-text-color, var(--tg-theme-link-color, #4b2fc9));
  --ch-accent-soft: #eee9ff;
  --ch-switch-thumb: #ffffff;
  --ch-switch-thumb-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
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
  --ch-bg: var(--tg-theme-bg-color, #15151d);
  --ch-text: var(--tg-theme-text-color, #f1f0f7);
  --ch-hint: var(--tg-theme-hint-color, #a6a6be);
  --ch-accent: var(--tg-theme-accent-text-color, var(--tg-theme-link-color, #bba8ff));
  --ch-surface: var(--tg-theme-secondary-bg-color, #22222e);
  --ch-section: var(--tg-theme-section-bg-color, var(--tg-theme-bg-color, #1e1e29));
  --ch-separator: var(--tg-theme-section-separator-color, #2a2a38);
  --ch-button: var(--tg-theme-button-color, var(--brand-primary));
  --ch-danger: var(--tg-theme-destructive-text-color, #ff8a80);
  --ch-card: #221d3a;
  --ch-card-separator: #332b55;
  --ch-done: #7c7c94;
  --ch-chip-bg: #3d2715;
  --ch-chip-text: #ffc796;
  --ch-outline: #3e3e52;
  --ch-scrim: rgba(0, 0, 0, 0.6);
  --ch-sheet-shadow: 0 -8px 24px rgba(0, 0, 0, 0.5);
  --ch-tab-track: var(--ch-surface);
  --ch-tab-on: var(--tg-theme-section-bg-color, #33334a);
  --ch-tab-on-text: var(--ch-text);
  --ch-tab-shadow: none;
  --ch-mine-soft: #2c2550;
  --ch-mine-soft-text: #d9cfff;
  --ch-mine-solid: var(--tg-theme-button-color, #6d4ff0);
  --ch-mine-solid-text: var(--ch-button-text);
  --ch-partner-soft: #4a2b12;
  --ch-partner-soft-text: #ffd2a8;
  --ch-partner-line: #d98b4a;
  --ch-partner-line-text: #ffb877;
  --ch-dot-mine: var(--ch-accent);
  --ch-dot-partner: #f0924a;
  --ch-today: var(--tg-theme-button-color, #6d4ff0);
  --ch-today-text: var(--ch-button-text);
  --ch-selected: var(--ch-text);
  --ch-selected-text: var(--ch-bg);
  --ch-pill-bg: var(--ch-card);
  --ch-pill-line: #3a3166;
  --ch-pill-text: var(--ch-accent);
  --ch-disabled: #4a4a5e;
  --ch-month-title: var(--ch-accent);
  --ch-accent-soft: #2c2550;
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

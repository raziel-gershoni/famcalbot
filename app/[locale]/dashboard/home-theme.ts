// The calendar home's look (spec §7.1 Look, §7.7): the colour tokens, mapped onto
// Telegram's theme params with fallbacks, plus the pieces every part of the home shares
// (buttons, chips, the bottom sheet).
//
// The fallbacks: the brand colours are app/globals.css's own tokens (--bg-white,
// --text-primary, --brand-primary-dark, --brand-primary), so the palette lives in one
// place; the layout imports globals.css on every page. The neutral shades globals.css has
// no token for (the hint, surfaces, separators, the danger colour, the whole dark
// palette) are the approved mockups' and belong to the home alone.
//
// The home's root carries it (D6, CalendarHome):
//   <div className="ch-home" data-theme={useTelegramTheme()} dir={…}>
//     <style>{HOME_THEME_CSS}</style>
//     …
// Inside Telegram the SDK writes --tg-theme-* on <html>, so the tokens follow the
// user's Telegram theme, light or dark. In a browser there are no --tg-theme-* values,
// and the fallbacks follow data-theme (prefers-color-scheme).
//
// The page's root takes the same background while the home is mounted (html:has(.ch-home)):
// the home scrolls the document, and on iOS the bounce past either end shows the root,
// which globals.css leaves unpainted (white under a dark theme otherwise).
//
// Rules: nothing smaller than 11 px; every tap target at least 44 px; logical
// properties only, so RTL needs no overrides; no hover styles (touch only).

export const HOME_THEME_CSS = `
.ch-home {
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
.ch-home[data-theme='dark'] {
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
  color-scheme: dark;
}
@supports (color: color-mix(in srgb, red 50%, blue)) {
  .ch-home,
  .ch-home[data-theme='dark'] {
    /* A contrast floor over the theme's hint colour (§7.7): pulled a quarter towards the text. */
    --ch-muted: color-mix(in srgb, var(--ch-hint) 75%, var(--ch-text));
    --ch-card: color-mix(in srgb, var(--ch-accent) 8%, var(--ch-bg));
    --ch-card-separator: color-mix(in srgb, var(--ch-accent) 18%, var(--ch-bg));
    --ch-done: color-mix(in srgb, var(--ch-hint) 80%, var(--ch-bg));
    --ch-outline: color-mix(in srgb, var(--ch-hint) 45%, var(--ch-bg));
  }
}
html:has(.ch-home) {
  background-color: var(--tg-theme-bg-color, var(--bg-white));
}
html:has(.ch-home[data-theme='dark']) {
  background-color: var(--tg-theme-bg-color, #15151d);
  color-scheme: dark;
}
.ch-home *,
.ch-home *::before,
.ch-home *::after {
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
@keyframes ch-sheet-in {
  from { transform: translateY(24px); opacity: 0; }
  to { transform: none; opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .ch-home *,
  .ch-home *::before,
  .ch-home *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}
`;

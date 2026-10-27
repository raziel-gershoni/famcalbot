// The screen frame and the parts every screen shares (spec 2026-10-19 §4): what AppScreen
// (./AppScreen.tsx) renders after the theme (./theme.ts), and the home's shell began with.
// They read the tokens APP_THEME_CSS sets on .ch-app.
//
// - The frame is .ch-screen: document-level scroll, no inner scroller; at least the
//   viewport's stable height; safe areas from --tg-safe-area-inset-* plus
//   --tg-content-safe-area-inset-* (Bot API 8.0), 0 without them. It is never on the
//   theme scope a sheet brings into another page (AppScope), and the page root's paint
//   (html:has(.ch-screen)) follows it, so that page keeps its own look.
// - overflow-x: clip (never overflow: hidden), and no transform or filter on the frame:
//   the sheets are position: fixed, and Plan E's Month bar is sticky.
// - Logical properties only; directional icons flip in RTL (.ch-flip); nothing under
//   11 px; every tap at least 44 px; no hover styles (touch only).
// - The shared parts: the 44 px icon buttons (.ch-icon-btn), a sheet's heading and
//   subheading, the spinner (.ch-spin) and the loader that centres it (.ch-loader), and the
//   card for a state that stands in for a screen (.ch-home-card: busy, retry, a crash, and
//   StateCard's; its actions stack in .ch-home-card-actions when there are two).
// - The grouped ground (.ch-grouped, AppScreen's ground="grouped"): a screen of grouped cards
//   (Settings) sits on the secondary background, as the editor does; the page root paints the
//   same (html:has(.ch-screen.ch-grouped)), and in the dark the page's own ground comes back.
// - The header of a screen with a title (.ch-screen-head, ScreenHeader), a section's label
//   (.ch-section-label, SectionLabel) and a notice on a card (.ch-notice, Notice).

export const APP_SCREEN_CSS = `
.ch-screen {
  min-height: var(--tg-viewport-stable-height, 100dvh);
  padding-block-start: calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px));
  padding-inline: max(
    calc(var(--tg-safe-area-inset-left, 0px) + var(--tg-content-safe-area-inset-left, 0px)),
    calc(var(--tg-safe-area-inset-right, 0px) + var(--tg-content-safe-area-inset-right, 0px))
  );
  overflow-x: clip;
}
/* Only a screen paints the page root: a scope a sheet brings into another page (AppScope) has no .ch-screen, so that page keeps its own look behind the scrim. */
html:has(.ch-screen) {
  background-color: var(--tg-theme-bg-color, var(--bg-white));
}
html:has(.ch-screen.ch-grouped) {
  background-color: var(--tg-theme-secondary-bg-color, #f3f2f8);
}
html:has(.ch-screen[data-theme='dark']) {
  background-color: var(--tg-theme-bg-color, #15151d);
  color-scheme: dark;
}
.ch-screen.ch-grouped {
  background: var(--ch-surface);
}
.ch-app.ch-grouped[data-theme='dark'] {
  background: var(--ch-bg);
}
.ch-app[dir='rtl'] .ch-flip {
  transform: scaleX(-1);
}
.ch-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: 44px;
  block-size: 44px;
  min-width: 44px;
  min-height: 44px;
  padding: 0;
  border: 0;
  border-radius: 12px;
  background: var(--ch-surface);
  color: var(--ch-text);
  cursor: pointer;
  touch-action: manipulation;
}
.ch-icon-btn svg {
  inline-size: 22px;
  block-size: 22px;
}
.ch-icon-btn-accent {
  background: var(--ch-accent-soft);
  color: var(--ch-accent);
}
.ch-icon-btn-plain {
  background: transparent;
}
.ch-icon-btn:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 2px;
}
.ch-screen-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 12px 16px 8px;
}
.ch-screen-head:has(.ch-icon-btn) {
  padding-inline-start: 8px;
}
.ch-screen-title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
}
.ch-section-label {
  margin-block: 14px 6px;
  padding-inline: 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ch-muted);
}
.ch-section-label:first-child {
  margin-block-start: 4px;
}
.ch-notice {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 12px 14px;
  border-radius: 14px;
  background: var(--ch-section);
  color: var(--ch-text);
  font-size: 14px;
}
.ch-notice-error {
  color: var(--ch-danger);
}
.ch-notice-text {
  margin: 0;
}
.ch-notice-action {
  min-block-size: 44px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ch-accent);
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-notice-action:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 2px;
}
.ch-sheet-heading {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 600;
}
.ch-sheet-sub {
  margin: 0 0 10px;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-spin {
  animation: ch-spin 0.9s linear infinite;
}
@keyframes ch-spin {
  to { transform: rotate(360deg); }
}
.ch-home-card {
  margin: 24px 16px 0;
  padding: 24px 16px;
  border-radius: 16px;
  background: var(--ch-surface);
  text-align: center;
}
.ch-home-card-title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}
.ch-home-card-body {
  margin: 8px 0 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-home-card-action {
  min-height: 48px;
  margin-block-start: 16px;
  padding-inline: 24px;
  text-decoration: none;
}
.ch-home-card-actions {
  display: flex;
  flex-direction: column;
}
.ch-loader {
  display: flex;
  align-items: center;
  justify-content: center;
  min-block-size: 60dvh;
  color: var(--ch-accent);
}
`;

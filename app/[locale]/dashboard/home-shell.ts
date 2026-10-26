// The calendar home's shell styles (spec §7.1 Layout, §7.2; the approved layout A): the
// page frame, the header, the banners, the send and menu sheets' options, and the cards
// that stand in for the Agenda (busy, retry, the error boundary). They read the tokens
// HOME_THEME_CSS (./home-theme.ts) sets on .ch-home, and add one: --ch-accent-soft.
//
// - Document-level scroll, no inner scroller; the frame is at least the viewport's
//   stable height; safe areas from --tg-safe-area-inset-* plus
//   --tg-content-safe-area-inset-* (Bot API 8.0), 0 without them.
// - overflow-x: clip (never overflow: hidden), and no transform or filter on the frame:
//   the sheets are position: fixed, and Plan E's Month bar is sticky.
// - Logical properties only; directional icons flip in RTL (.ch-flip); nothing under
//   11 px; every tap at least 44 px; no hover styles (touch only).
// - The header's Hebrew date, this week's parasha (and special Shabbat) and the countdown share a
//   line, joined by dots (.ch-head-line, each part after the date is a .ch-head-next). When
//   they don't fit, a part starts the next line and its dot falls before the line's
//   start, clipped by overflow: clip: no stray dot.

export const HOME_SHELL_CSS = `
.ch-home {
  --ch-accent-soft: #eee9ff;
  min-height: var(--tg-viewport-stable-height, 100dvh);
  padding-block-start: calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px));
  padding-inline: max(
    calc(var(--tg-safe-area-inset-left, 0px) + var(--tg-content-safe-area-inset-left, 0px)),
    calc(var(--tg-safe-area-inset-right, 0px) + var(--tg-content-safe-area-inset-right, 0px))
  );
  overflow-x: clip;
}
.ch-home[data-theme='dark'] {
  --ch-accent-soft: #2c2550;
}
@supports (color: color-mix(in srgb, red 50%, blue)) {
  .ch-home,
  .ch-home[data-theme='dark'] {
    --ch-accent-soft: color-mix(in srgb, var(--ch-accent) 14%, var(--ch-bg));
  }
}
.ch-home[dir='rtl'] .ch-flip {
  transform: scaleX(-1);
}
.ch-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 16px 12px;
}
.ch-head-text {
  flex: 1;
  min-width: 0;
}
.ch-head-title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  line-height: 1.25;
}
.ch-head-title::first-letter {
  text-transform: uppercase;
}
.ch-head-sub {
  margin: 2px 0 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-head-line {
  display: flex;
  flex-wrap: wrap;
  column-gap: 1em;
  overflow: clip;
}
.ch-head-next {
  position: relative;
  margin-inline-start: -1em;
  padding-inline-start: 1em;
}
.ch-head-next::before {
  content: '·';
  content: '·' / '';
  position: absolute;
  inset-inline-start: 0;
  inline-size: 1em;
  text-align: center;
}
.ch-head-zone {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--ch-muted);
}
.ch-head-ghost {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-block-start: 4px;
}
.ch-head-ghost-title,
.ch-head-ghost-sub {
  display: block;
  border-radius: 8px;
  background: var(--ch-surface);
  animation: ch-pulse 1.4s ease-in-out infinite;
}
.ch-head-ghost-title {
  block-size: 22px;
  inline-size: 70%;
}
.ch-head-ghost-sub {
  block-size: 14px;
  inline-size: 40%;
}
.ch-head-buttons {
  display: flex;
  flex: none;
  gap: 8px;
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
.ch-icon-btn:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 2px;
}
.ch-banners {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 4px 16px 0;
}
.ch-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  inline-size: 100%;
  min-height: 56px;
  margin: 0;
  padding: 10px 14px;
  border: 0;
  border-radius: 14px;
  background: var(--ch-surface);
  color: var(--ch-text);
  font-family: inherit;
  font-size: 15px;
  text-align: start;
  text-decoration: none;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-banner-accent,
.ch-banner-telegram {
  background: var(--ch-accent-soft);
}
.ch-banner-icon {
  flex: none;
  inline-size: 22px;
  block-size: 22px;
  color: var(--ch-accent);
}
.ch-banner-warn .ch-banner-icon {
  color: var(--ch-danger);
}
.ch-banner-text {
  display: block;
  flex: 1;
  min-width: 0;
}
.ch-banner-title {
  display: block;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
}
.ch-banner-body {
  display: block;
  margin-block-start: 2px;
  font-size: 13px;
  line-height: 1.35;
  color: var(--ch-muted);
}
.ch-banner-action {
  flex: none;
  max-inline-size: 40%;
  font-size: 14px;
  font-weight: 600;
  color: var(--ch-accent);
  text-align: end;
}
.ch-banner-chevron {
  flex: none;
  inline-size: 18px;
  block-size: 18px;
  color: var(--ch-muted);
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
.ch-options {
  list-style: none;
  margin: 0;
  padding: 0;
}
.ch-option-li {
  border-block-end: 1px solid var(--ch-separator);
}
.ch-option-li:last-child {
  border-block-end: 0;
}
.ch-option {
  display: flex;
  align-items: center;
  gap: 14px;
  inline-size: 100%;
  min-height: 60px;
  margin: 0;
  padding: 8px 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 16px;
  text-align: start;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-option[aria-disabled='true'] {
  opacity: 0.55;
  cursor: default;
}
.ch-option-compact {
  min-height: 52px;
  padding: 4px 0;
}
.ch-option-icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  inline-size: 40px;
  block-size: 40px;
  border-radius: 12px;
  background: var(--ch-surface);
  color: var(--ch-accent);
}
.ch-option-icon svg {
  inline-size: 22px;
  block-size: 22px;
}
.ch-option-icon-sm {
  inline-size: 34px;
  block-size: 34px;
  border-radius: 10px;
}
.ch-option-icon-sm svg {
  inline-size: 19px;
  block-size: 19px;
}
.ch-option-text {
  display: block;
  flex: 1;
  min-width: 0;
}
.ch-option-title {
  display: block;
  font-size: 16px;
  line-height: 1.3;
}
.ch-option-hint {
  display: block;
  margin-block-start: 2px;
  font-size: 13px;
  color: var(--ch-muted);
}
.ch-send-result {
  margin: 12px 0 0;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--ch-surface);
  font-size: 14px;
}
.ch-send-result.is-problem {
  color: var(--ch-danger);
}
.ch-spin {
  animation: ch-spin 0.9s linear infinite;
}
@keyframes ch-spin {
  to { transform: rotate(360deg); }
}
@keyframes ch-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
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
}
`;

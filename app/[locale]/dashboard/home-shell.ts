// The calendar home's own styles (spec §7.1 Layout, §7.2; the approved layout A): the
// header, the banners, the send and menu sheets' options and the holiday cells. The tokens
// are APP_THEME_CSS's (components/app-ui/theme.ts, on .ch-app), the frame and the parts
// every screen shares are APP_SCREEN_CSS's (components/app-ui/screen.ts), and the home's
// root carries all three classes: .ch-app .ch-screen .ch-home.
//
// - Logical properties only; nothing under 11 px; every tap at least 44 px; no hover
//   styles (touch only). The header sits in the frame's document-level scroll.
// - The header's day keeps at least 120 px beside the buttons: the usual three (the + for who can add, Send, the menu)
//   stay beside it from a 320 px phone (128 px are left), and with four of them (the sun for the Jewish calendar) on a
//   360 px phone it would be left 116 px and wrap in three lines, so the buttons drop to a row of their own under the
//   day, at the end; from 364 px the four stay beside it.
// - The header's Hebrew date, this week's parasha (and special Shabbat) and the countdown share a
//   line, joined by dots (.ch-head-line, each part after the date is a .ch-head-next). When
//   they don't fit, a part starts the next line and its dot falls before the line's
//   start, clipped by overflow: clip: no stray dot.
// - The holiday cells (.ch-day-holiday) come first, ahead of the header's rules, as they
//   were ahead of them when the theme held them: a header line that is also a holiday cell
//   keeps the same winner.

export const HOME_SHELL_CSS = `
.ch-day-holiday {
  color: var(--ch-muted);
}
.ch-day-holiday.is-chag {
  color: var(--ch-accent);
}
.ch-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 16px 12px;
}
.ch-head-text {
  flex: 1 1 120px;
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
  margin-inline-start: auto;
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
@keyframes ch-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
`;

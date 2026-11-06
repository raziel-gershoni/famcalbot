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
//   day, at the end; from 364 px the four stay beside it. That wrap is the side column's (.ch-head-side holds the buttons
//   and, under them, the weather block, which is never wider than the buttons' row). The weather block takes the side
//   column's width and adds nothing to it: inline-size: 0 makes its own width count as nothing when the column is sized
//   (so the buttons alone set it, 148 px with three, 200 px with four), and min-inline-size: 100% then stretches it to
//   the column's width. Inside, the place line cuts with an ellipsis and the days strip drops the days that do not fit
//   (it wraps them to a second line its fixed height hides), the later days first: about three days beside four
//   buttons, two beside three, and none beside two (no event or reminder kind, or no Jewish calendar: 96 px leave the
//   strip under 38 px). A wrapped line always keeps its first item, so the strip starts with an empty zero-width one
//   (::before): without it the first day would stay on the line, spilling past the strip's start edge.
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
.ch-head-side {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  margin-inline-start: auto;
}
.ch-head-buttons {
  display: flex;
  gap: 8px;
}
.ch-head-weather,
.ch-head-weather-ghost {
  display: flex;
  flex-direction: column;
  /* Takes the side column's width and adds nothing to it (see the note at the top): its own width counts as 0 when the
     column is sized, and the minimum then stretches it to the column's width. */
  inline-size: 0;
  min-inline-size: 100%;
  font-variant-numeric: tabular-nums;
}
.ch-head-weather {
  gap: 4px;
}
.ch-head-weather-place {
  display: flex;
  align-items: center;
  gap: 4px;
  min-inline-size: 0;
  font-size: 13px;
  line-height: 1.25;
  color: var(--ch-muted);
}
.ch-head-weather-place svg {
  flex: none;
}
.ch-head-weather-place bdi {
  min-inline-size: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ch-head-weather-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.ch-head-weather-today {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: flex-start;
}
.ch-head-weather-now {
  /* The icon is left of the number in every language (the numbers read left to right): the row does not mirror in Hebrew. */
  direction: ltr;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ch-text);
  font-size: 22px;
  font-weight: 600;
  line-height: 1.25;
}
.ch-head-weather-now svg {
  flex: none;
  color: var(--ch-muted);
}
.ch-head-weather-range {
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-head-weather-days {
  /* As many days as fit: a day that does not fit wraps to a second line the fixed height hides, so the later days drop first. */
  display: flex;
  flex: 1 1 0;
  flex-wrap: wrap;
  justify-content: flex-end;
  column-gap: 8px;
  min-width: 0;
  block-size: 52px;
  overflow: hidden;
}
.ch-head-weather-days::before {
  /* A wrapping line always keeps its first item, so with no room for even one column that day would stay on the first line
     and spill past the strip's start edge. This empty first item (0 wide, with the column gap after it) makes the first
     day need 8 + 30 px like any other, so it wraps to the hidden line when it does not fit. It is a column tall: alone on
     the first line it still gives that line a column's height, so the second line starts below the strip, where it is hidden. */
  content: '';
  flex: none;
  inline-size: 0;
  block-size: 52px;
}
.ch-head-weather-day {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  inline-size: 30px;
  block-size: 52px;
  line-height: 16px;
}
.ch-head-weather-day-name {
  font-size: 12px;
  color: var(--ch-muted);
}
.ch-head-weather-day svg {
  flex: none;
  color: var(--ch-muted);
}
.ch-head-weather-day-high {
  font-size: 13px;
  color: var(--ch-text);
}
.ch-head-weather-ghost {
  align-items: flex-end;
  gap: 8px;
  padding-block-start: 4px;
}
.ch-head-weather-ghost-place,
.ch-head-weather-ghost-now,
.ch-head-weather-ghost-range {
  display: block;
  border-radius: 8px;
  background: var(--ch-surface);
  animation: ch-pulse 1.4s ease-in-out infinite;
}
.ch-head-weather-ghost-place {
  block-size: 13px;
  inline-size: 90px;
}
.ch-head-weather-ghost-now {
  block-size: 22px;
  inline-size: 64px;
}
.ch-head-weather-ghost-range {
  block-size: 14px;
  inline-size: 48px;
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
/* Connect Telegram (6c-1): the banner holds its own button and the close, so the banner itself is no button */
.ch-banner-split {
  gap: 0;
  padding: 0;
  cursor: default;
}
.ch-banner-main {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 12px;
  min-inline-size: 0;
  min-height: 56px;
  margin: 0;
  padding-block: 10px;
  padding-inline: 14px 4px;
  border: 0;
  border-radius: 14px;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 15px;
  text-align: start;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-banner-main:disabled {
  cursor: default;
}
.ch-banner-close {
  flex: none;
  display: grid;
  place-items: center;
  inline-size: 44px;
  block-size: 44px;
  margin-inline-end: 6px;
  padding: 0;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--ch-muted);
  cursor: pointer;
  touch-action: manipulation;
}
.ch-banner-close svg {
  inline-size: 18px;
  block-size: 18px;
}
.ch-banner-line {
  margin: 0;
  padding-inline: 14px;
  font-size: 13px;
  line-height: 1.35;
  color: var(--ch-muted);
}
.ch-banner-line.is-problem {
  color: var(--ch-danger);
}
/* Get reminders on this device (6c-2): the icon, the words and the close on top, the iPhone steps under them, and the two
   actions (Turn on, Connect Telegram) in a row that wraps on a narrow phone */
.ch-banner-push {
  flex-direction: column;
  align-items: stretch;
  gap: 0;
  padding: 0;
  cursor: default;
}
.ch-banner-push-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-block-start: 10px;
  padding-inline-start: 14px;
}
.ch-banner-steps {
  margin: 6px 0 0;
  padding-inline: 34px 14px;
  font-size: 13px;
  line-height: 1.35;
  color: var(--ch-muted);
}
.ch-banner-steps li {
  margin-block: 2px;
  overflow-wrap: anywhere;
}
.ch-banner-push-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 14px 10px;
}
.ch-banner-push-actions .ch-btn {
  font-size: 14px;
  font-weight: 600;
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
.ch-send-signin {
  inline-size: 100%;
  margin-block-start: 12px;
}
@keyframes ch-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
`;

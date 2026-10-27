// The admin panel's own CSS (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md): what the kit has no part for,
// on the app's tokens (components/app-ui/theme.ts) and the same rules as the kit's (logical properties only, no hover,
// nothing under 11 px, taps of at least 44 px, no colour but a token).
//
// - The counts card on the Overview: a 2 x 2 grid of four numbers, each a number over a quiet label. A tile that opens
//   something is a button with a chevron in its corner; one that only counts is a plain box. A hairline runs between the
//   tiles (the card's separator colour).
// - A person's profile: a meter inside a row, an id's label above its copy field, and a setup step (a check or a circle, its
//   reminders as a bar of segments: sent in the accent, overdue in the warn colour, the rest in the separator's grey).
// - The spinner while a list loads.
// - A line of text that stops at two lines (a feedback message in a list), the lines of a list row's quiet text, and the
//   full text of a message in a sheet.

export const ADMIN_CSS = `
.ch-admin-counts {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.ch-admin-count {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-block-size: 76px;
  margin: 0;
  padding: 14px;
  border: 0;
  background: transparent;
  color: var(--ch-text);
  font: inherit;
  text-align: start;
}
.ch-admin-count:nth-child(odd) {
  border-inline-end: 1px solid var(--ch-separator);
}
.ch-admin-count:nth-child(-n + 2) {
  border-block-end: 1px solid var(--ch-separator);
}
button.ch-admin-count {
  inline-size: 100%;
  cursor: pointer;
  touch-action: manipulation;
}
button.ch-admin-count:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: -2px;
}
.ch-admin-count-num {
  font-size: 28px;
  font-weight: 600;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.ch-admin-count-label {
  font-size: 13px;
  color: var(--ch-muted);
}
.ch-admin-count .ch-form-chevron {
  position: absolute;
  inset-block-start: 14px;
  inset-inline-end: 12px;
}
.ch-admin-wait {
  display: flex;
  justify-content: center;
  padding-block: 24px;
  color: var(--ch-accent);
}
.ch-admin-line {
  display: block;
}
.ch-admin-clamp {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.ch-admin-meter {
  flex: 1;
  min-inline-size: 0;
  padding-block: 6px;
}
.ch-admin-field-label {
  display: block;
  padding: 10px 14px 0;
  font-size: 13px;
  color: var(--ch-muted);
}
.ch-form-page-grouped .ch-admin-step {
  align-items: flex-start;
  padding-block: 10px;
}
.ch-admin-step-icon {
  flex: none;
  inline-size: 20px;
  block-size: 20px;
  margin-block-start: 1px;
  color: var(--ch-muted);
}
.ch-admin-step-icon.is-done {
  color: var(--ch-accent);
}
.ch-admin-bar {
  display: flex;
  gap: 2px;
  margin-block-start: 4px;
}
.ch-admin-seg {
  flex: 1;
  block-size: 6px;
  border-radius: 3px;
  background: var(--ch-separator);
}
.ch-admin-seg.is-sent {
  background: var(--ch-accent);
}
.ch-admin-seg.is-due {
  background: var(--ch-warn);
}
.ch-admin-text {
  margin: 0 0 10px;
  font-size: 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
`;

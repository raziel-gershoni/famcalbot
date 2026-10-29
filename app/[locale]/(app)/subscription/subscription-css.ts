// The Subscription screen's own layout (plan W1b, Task 2; spec 2026-10-19 §4): the page, the current-plan card's head and
// lines, the plan cards' head, price, list and button. The cards themselves (.ch-panel, .ch-panel-ring), the tag, the
// meters and the outlined button are the kit's (components/app-ui/screen.ts); the spinner in a busy button is the form
// kit's (.ch-form-spinner), so the screen renders FORM_CSS beside this sheet.
//
// - This sheet comes after the theme, the screen and the form kit in the page, so a rule here settles a tie with a kit
//   rule of the same specificity by coming later (.ch-plan-current over .ch-panel's gap, .ch-plan-choose-pro over
//   .ch-btn), never by !important or a longer selector.
// - A plan card's head wraps, and the name keeps its words whole (it sizes to its text and stops at its longest word):
//   the price and the tag drop to a second line when there is no room, where a zero flex basis with a break-anywhere cut
//   "Базовый" in two at 320 px.
// - Logical properties only, no :hover, nothing under 11 px, no colour of its own: the tokens of ./theme.ts.

export const SUBSCRIPTION_CSS = `
.ch-plan-page {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 16px 24px;
}
.ch-plan-current {
  gap: 14px;
}
.ch-plan-top {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ch-plan-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
.ch-plan-head-current {
  align-items: center;
}
.ch-plan-title {
  flex: 1;
  min-inline-size: 0;
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.ch-plan-name {
  flex: 1 1 auto;
  min-inline-size: min-content;
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.ch-plan-note {
  margin: 0;
  font-size: 13px;
  color: var(--ch-muted);
}
.ch-plan-price {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  font-size: 15px;
  font-weight: 600;
}
.ch-plan-star {
  align-self: center;
  flex: none;
  inline-size: 14px;
  block-size: 14px;
  color: var(--ch-accent);
}
.ch-plan-per {
  font-size: 13px;
  font-weight: 400;
  color: var(--ch-muted);
}
.ch-plan-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 14px;
}
.ch-plan-choose {
  inline-size: 100%;
}
.ch-plan-choose:disabled {
  opacity: 0.6;
  cursor: default;
}
.ch-plan-choose-pro {
  min-block-size: 48px;
  font-size: 16px;
  font-weight: 600;
}
.ch-plan-fine {
  margin: 4px 4px 0;
  font-size: 12px;
  color: var(--ch-muted);
}
`;

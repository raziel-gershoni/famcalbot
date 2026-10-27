// What the invite landing adds to the kit (plan W3): a card no wider than a phone's and centred on a desktop browser, a notice
// inside the card, the expiry line under the buttons, and a button that waits. A plain module (no 'use client'), because both
// the server page (its invalid-token card has the same width as the valid one) and InviteClient render it: a string exported
// from a client file reaches a server file as a reference, not as the text.
//
// - This sheet comes after the theme and the screen's, so a rule here settles a tie with a kit rule of the same specificity
//   by coming later, never by !important.
// - Logical properties only, no :hover, nothing under 11 px, no colour of its own.

export const INVITE_CSS = `
.ch-invite-page {
  max-inline-size: 480px;
  margin-inline: auto;
}
.ch-home-card .ch-notice {
  margin-block-start: 12px;
  text-align: start;
}
.ch-invite-expires {
  margin-block-start: 16px;
}
.ch-invite-page .ch-home-card-action:disabled {
  opacity: 0.6;
  cursor: default;
}
`;

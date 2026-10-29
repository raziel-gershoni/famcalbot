// The Google connect pages' own style sheet (plan W4-3), after the kit's (APP_THEME_CSS, APP_SCREEN_CSS, FORM_CSS),
// whose tokens it reads. Its classes are ch-connect-*; everything else on these pages is the kit's.
//
// - The hero (ConnectHero): an icon on the accent's soft ground, the page's title when the page has no header, and the
//   lead, all at the start edge like the header above it; with no header above it, it starts lower.
// - The steps of /refresh-token: a numbered list drawn as a form card, one row per step, its number on the accent's
//   soft ground (they are a sequence, so they are numbered).
// - The actions under a card (the primary button, its notices, the finish page's two buttons and the WhatsApp hint).
// - The loader that says what it waits for (ConnectLoader), under the screen's header.
//
// Rules (lintCss): px sizes of 11 or more, logical properties, no hover, colours only from the tokens.

export const CONNECT_CSS = `
.ch-connect-hero {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 4px 6px;
}
.ch-connect-hero.is-titled {
  /* The hero holds the page's title: there is no header above it (the finish page, the scopes page) */
  padding-block-start: 28px;
}
.ch-connect-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: 48px;
  block-size: 48px;
  border-radius: 50%;
  background: var(--ch-accent-soft);
  color: var(--ch-accent);
}
.ch-connect-icon svg {
  inline-size: 26px;
  block-size: 26px;
}
.ch-connect-title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
}
.ch-connect-lead {
  margin: 0;
  font-size: 16px;
  line-height: 1.45;
  color: var(--ch-muted);
}
.ch-connect-lead b {
  font-weight: 600;
  color: var(--ch-text);
}
.ch-connect-steps {
  margin: 0;
  padding: 0;
  list-style: none;
}
.ch-connect-step {
  gap: 12px;
  padding-block: 10px;
}
.ch-connect-num {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: 28px;
  block-size: 28px;
  border-radius: 50%;
  background: var(--ch-accent-soft);
  color: var(--ch-accent);
  font-size: 14px;
  font-weight: 600;
}
.ch-connect-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-block-start: 14px;
}
.ch-connect-actions a {
  text-decoration: none;
}
.ch-connect-loader {
  flex-direction: column;
  gap: 12px;
}
.ch-connect-loader-text {
  font-size: 15px;
  color: var(--ch-muted);
}
`;

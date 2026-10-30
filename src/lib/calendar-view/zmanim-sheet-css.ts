// The sun sheet's CSS (the .ch-zl-* classes): the sheet's frame and the rows ZmanimRows draws
// (components/app-ui/ZmanimRows.tsx). A plain module, outside the 'use client' sheet, so a server page can include it too
// (the public city pages, spec docs/superpowers/specs/2026-10-30-public-zmanim-design.md §6.1). ZmanimSheet.tsx
// re-exports it, so the smokes that import it from the sheet still read the same string.

export const ZMANIM_SHEET_CSS = `
.ch-zl-place {
  margin: 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-zl-nav {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-block: 12px 4px;
}
.ch-zl-date {
  flex: 1;
  min-inline-size: 0;
  text-align: center;
}
.ch-zl-day {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
}
.ch-zl-day::first-letter {
  text-transform: uppercase;
}
.ch-zl-hebrew {
  margin: 2px 0 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-zl-note {
  margin-block: 8px 4px;
}
.ch-zl-note .ch-notice {
  background: var(--ch-surface);
}
.ch-zl-rows {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}
.ch-zl-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-block-size: 44px;
  padding-block: 6px;
  border-block-end: 1px solid var(--ch-separator);
}
.ch-zl-row:last-child {
  border-block-end: 0;
}
.ch-zl-name {
  flex: 1;
  min-inline-size: 0;
  font-size: 15px;
  line-height: 1.3;
}
.ch-zl-time {
  flex: none;
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.ch-zl-row.is-key .ch-zl-name,
.ch-zl-row.is-key .ch-zl-time {
  color: var(--ch-accent);
  font-weight: 600;
}
.ch-zl-row.is-none .ch-zl-time {
  color: var(--ch-muted);
  font-weight: 400;
}
.ch-zl-hours {
  margin: 12px 0 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-zl-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-block-size: 280px;
  color: var(--ch-accent);
}
.ch-zl .ch-home-card {
  margin: 8px 0 0;
}
`;

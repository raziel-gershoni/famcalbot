// The public site's one style sheet (spec 2026-10-28-public-website §5): the app's own colour values, light and dark
// from the device's setting in CSS alone (no script, so a server-rendered page never flashes), the app's system font
// stack, and the site's layout. Served as /site.css (app/site.css/route.ts), which the (site) layout links in <head>.
//
// - The colours are APP_TOKENS (components/app-ui/tokens.ts), the module the app's theme reads too, set as the app's own
//   --ch-* tokens on :root and again under prefers-color-scheme: dark. So the kit's parts the site uses (the menu's
//   BottomSheet, .ch-btn) and the hero's live app parts paint as they do in the app. The app's brand fallbacks
//   (--bg-white, --text-primary, --brand-primary-dark) are set too, for a .ch-app scope on the page (the hero's demo).
// - The two start buttons are the brands' colours in shades that keep 4.5:1 under their white label (#0088cc and
//   #25D366 do not): --site-telegram and --site-whatsapp.
// - Logical properties only, so Hebrew needs no overrides; nothing under 13 px; every tap target at least 44 px; no
//   hover styles (nothing depends on a pointer); no horizontal overflow at 320 px.
// - One motion on the whole site, the hero's (its own rules); prefers-reduced-motion stops it.
// - The kit's BottomSheet slides in, a second motion: on the site it just appears.

import { createHash } from 'node:crypto';
import { APP_TOKENS } from '@/components/app-ui/tokens';
import { APP_THEME_CSS } from '@/components/app-ui/theme';

const L = APP_TOKENS.light;
const D = APP_TOKENS.dark;

/** The start buttons' brand shades (white label at 5.4:1 and 5.1:1; at least 3:1 against the dark page). */
export const BRAND = { telegram: '#1b6fa8', whatsapp: '#0b7d5e', onBrand: '#ffffff' } as const;

/** The site's colours, light and dark, as the app's token names. Read by the contrast smoke as they are. */
export const SITE_PALETTE = {
  light: {
    '--ch-bg': L.bg,
    '--ch-text': L.text,
    '--ch-hint': L.hint,
    '--ch-muted': L.hint,
    '--ch-accent': L.accent,
    '--ch-surface': L.surface,
    '--ch-section': L.bg,
    '--ch-separator': L.separator,
    '--ch-button': L.button,
    '--ch-button-text': L.buttonText,
    '--ch-card': L.card,
    '--ch-card-separator': L.cardSeparator,
    '--ch-outline': L.outline,
    '--ch-accent-soft': L.accentSoft,
    '--ch-chip-bg': L.chipBg,
    '--ch-chip-text': L.chipText,
    '--ch-danger': L.danger,
  },
  dark: {
    '--ch-bg': D.bg,
    '--ch-text': D.text,
    '--ch-hint': D.hint,
    '--ch-muted': D.hint,
    '--ch-accent': D.accent,
    '--ch-surface': D.surface,
    '--ch-section': D.section,
    '--ch-separator': D.separator,
    '--ch-button': D.button,
    '--ch-button-text': L.buttonText,
    '--ch-card': D.card,
    '--ch-card-separator': D.cardSeparator,
    '--ch-outline': D.outline,
    '--ch-accent-soft': D.accentSoft,
    '--ch-chip-bg': D.chipBg,
    '--ch-chip-text': D.chipText,
    '--ch-danger': D.danger,
  },
} as const;

const declarations = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');

const TOKENS_CSS = `
:root {
  --bg-white: ${L.bg};
  --text-primary: ${L.text};
  --brand-primary-dark: ${L.accent};
  --ch-scrim: ${L.scrim};
  --ch-sheet-shadow: ${L.sheetShadow};
  --site-telegram: ${BRAND.telegram};
  --site-whatsapp: ${BRAND.whatsapp};
  --site-on-brand: ${BRAND.onBrand};
  --site-shadow-bubble: 0 6px 20px rgba(26, 26, 46, 0.08);
  --site-shadow-phone: 0 18px 48px rgba(26, 26, 46, 0.14);
${declarations(SITE_PALETTE.light)}
}
@media (prefers-color-scheme: dark) {
  :root {
    --ch-scrim: ${D.scrim};
    --ch-sheet-shadow: ${D.sheetShadow};
${declarations(SITE_PALETTE.dark)}
  }
}
`;

const BASE_CSS = `
html:has(.site) {
  background-color: var(--ch-bg);
  color-scheme: light dark;
}
body {
  margin: 0;
}
.site,
.site-header,
.site-footer {
  color: var(--ch-text);
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Heebo, Inter, sans-serif;
  line-height: 1.55;
}
.site {
  min-height: 100vh;
  overflow-x: clip;
  background: var(--ch-bg);
  font-size: 17px;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
  -webkit-tap-highlight-color: transparent;
}
.site *,
.site *::before,
.site *::after {
  box-sizing: border-box;
}
/* The resets weigh nothing (:where), so any of the site's classes overrides them. */
:where(.site, .site-header, .site-footer) :where(h1, h2, h3, p, ul, ol, li, dl, dd, figure, blockquote) {
  margin: 0;
}
:where(.site, .site-header, .site-footer) :where(ul, ol) {
  padding: 0;
  list-style: none;
}
:where(.site, .site-header, .site-footer) :where(a) {
  color: inherit;
}
.site :focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 2px;
}
.site-wrap {
  inline-size: 100%;
  max-inline-size: 1120px;
  margin-inline: auto;
  padding-inline: 16px;
}
@media (min-width: 720px) {
  .site-wrap {
    padding-inline: 32px;
  }
}
.site-icon {
  flex: none;
  inline-size: 20px;
  block-size: 20px;
}
`;

const CHROME_CSS = `
.site-header {
  position: sticky;
  inset-block-start: 0;
  z-index: 40;
  background: var(--ch-bg);
  border-block-end: 1px solid var(--ch-separator);
}
.site-header-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-block-size: 64px;
}
.site-logo {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-block-size: 44px;
  color: var(--ch-text);
  font-size: 20px;
  font-weight: 800;
  text-decoration: none;
}
.site-logo img {
  border-radius: 9px;
}
.site-nav {
  display: flex;
  gap: 2px;
  margin-inline-start: 20px;
}
.site-nav a {
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
  padding-inline: 12px;
  border-radius: 10px;
  color: var(--ch-text);
  font-size: 16px;
  font-weight: 500;
  text-decoration: none;
}
.site-header-end {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-inline-start: auto;
}
.site-langs {
  display: flex;
  align-items: center;
  gap: 2px;
}
.site-langs a {
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
  min-inline-size: 44px;
  padding-inline: 10px;
  border-radius: 10px;
  color: var(--ch-text);
  font-size: 15px;
  text-decoration: none;
}
.site-langs a[aria-current='true'] {
  background: var(--ch-surface);
  font-weight: 650;
}
.site-langs-icon {
  color: var(--ch-muted);
  margin-inline-end: 4px;
}
@media (max-width: 959.98px) {
  .site-wide-only {
    display: none !important;
  }
}
@media (min-width: 960px) {
  .site-phone-only {
    display: none !important;
  }
}
.site-jump {
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
  padding-inline: 16px;
  border-radius: 12px;
  background: var(--ch-button);
  color: var(--ch-button-text);
  font-size: 16px;
  font-weight: 600;
  text-decoration: none;
}
.site-menu-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: 44px;
  block-size: 44px;
  padding: 0;
  border: 0;
  border-radius: 12px;
  background: var(--ch-surface);
  color: var(--ch-text);
  font: inherit;
  cursor: pointer;
  touch-action: manipulation;
}
.site-menu-button svg {
  inline-size: 22px;
  block-size: 22px;
}
.site .ch-sheet {
  animation: none;
  font-size: 17px;
}
.site-menu-section + .site-menu-section {
  margin-block-start: 20px;
}
.site-menu-label {
  display: block;
  margin-block-end: 4px;
  color: var(--ch-muted);
  font-size: 14px;
  font-weight: 600;
}
.site-menu-list a {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-block-size: 52px;
  border-block-end: 1px solid var(--ch-separator);
  color: var(--ch-text);
  font-size: 18px;
  text-decoration: none;
}
.site-menu-list li:last-child a {
  border-block-end: 0;
}
.site-menu-list a[aria-current='true'] {
  font-weight: 650;
}
.site-menu-list svg {
  color: var(--ch-accent);
}
.site-starts {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.site-start {
  display: inline-flex;
  flex: 1 1 220px;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-block-size: 56px;
  padding-inline: 22px;
  border-radius: 14px;
  color: var(--site-on-brand);
  font-size: 18px;
  font-weight: 650;
  line-height: 1.2;
  text-align: center;
  text-decoration: none;
}
.site-start[data-channel='telegram'] {
  background: var(--site-telegram);
}
.site-start[data-channel='whatsapp'] {
  background: var(--site-whatsapp);
}
.site-start svg {
  flex: none;
  inline-size: 22px;
  block-size: 22px;
}
.site-starts-compact {
  flex-wrap: nowrap;
  gap: 8px;
}
.site-starts-compact .site-start {
  flex: none;
  gap: 8px;
  min-block-size: 44px;
  padding-inline: 14px;
  border-radius: 12px;
  font-size: 15px;
}
.site-starts-compact .site-start svg {
  inline-size: 18px;
  block-size: 18px;
}
@media (max-width: 559.98px) {
  .site-starts:not(.site-starts-compact) {
    flex-direction: column;
  }
  .site-starts:not(.site-starts-compact) .site-start {
    flex: none;
    inline-size: 100%;
  }
}
.site-honest {
  max-inline-size: 48ch;
  margin-block-start: 12px;
  color: var(--ch-muted);
  font-size: 15px;
  line-height: 1.45;
}
.site-footer {
  margin-block-start: 0;
  padding-block: 40px 32px;
  border-block-start: 1px solid var(--ch-separator);
  background: var(--ch-surface);
  font-size: 15px;
}
.site-footer-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px 32px;
}
.site-footer-links {
  display: flex;
  flex-wrap: wrap;
  gap: 0 4px;
  margin-inline: -10px;
}
.site-footer-links a {
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
  padding-inline: 10px;
  color: var(--ch-text);
  text-decoration: none;
}
.site-footer .site-langs {
  flex-wrap: wrap;
  margin-block-start: 16px;
  margin-inline: -10px;
}
.site-footer .site-langs a[aria-current='true'] {
  background: var(--ch-bg);
}
.site-footer-meta {
  margin-block-start: 20px;
  color: var(--ch-muted);
}
.site-footer-meta p + p {
  margin-block-start: 2px;
}
`;


const LANDING_CSS = `
.site-h1 {
  font-size: 40px;
  font-weight: 800;
  line-height: 1.04;
  letter-spacing: -0.02em;
}
.site-h1-line {
  display: block;
}
.site-h2 {
  font-size: 28px;
  font-weight: 750;
  line-height: 1.15;
  letter-spacing: -0.015em;
}
.site-h3 {
  font-size: 19px;
  font-weight: 650;
  line-height: 1.3;
}
.site-h1:lang(he),
.site-h2:lang(he) {
  letter-spacing: 0;
}
.site-lead {
  max-inline-size: 40em;
  margin-block-start: 12px;
  color: var(--ch-muted);
  font-size: 18px;
}
.site-section {
  padding-block: 64px;
}
.site-band {
  background: var(--ch-surface);
}
.site-final {
  background: var(--ch-card);
}
.site-final .site-starts {
  max-inline-size: 640px;
  margin-block-start: 28px;
}
@media (min-width: 720px) {
  .site-h1 {
    font-size: 48px;
  }
  .site-h2 {
    font-size: 36px;
  }
  .site-section {
    padding-block: 96px;
  }
}
@media (min-width: 1000px) {
  .site-h1 {
    font-size: 58px;
  }
}
.site-hero {
  padding-block: 40px 64px;
}
.site-hero .site-h1 {
  max-inline-size: 22ch;
}
.site-hero-grid {
  display: grid;
  gap: 40px;
  margin-block-start: 24px;
}
.site-hero-text {
  max-inline-size: 36rem;
}
.site-hero-lead {
  margin-block-end: 28px;
  color: var(--ch-muted);
  font-size: 19px;
  line-height: 1.5;
}
@media (min-width: 720px) {
  .site-hero {
    padding-block: 64px 56px;
  }
  .site-hero + .site-section {
    padding-block-start: 48px;
  }
  .site-hero-lead {
    font-size: 21px;
  }
}
@media (min-width: 1000px) {
  .site-hero .site-h1 {
    max-inline-size: none;
  }
  .site-hero-grid {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 56px;
    margin-block-start: 36px;
  }
  .site-hero .site-starts {
    flex-direction: column;
  }
  .site-hero .site-start {
    flex: none;
    inline-size: 100%;
  }
}
.site-demo {
  display: grid;
  gap: 20px;
  margin: 0;
}
.site-demo-chat {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-inline-size: 340px;
}
@media (min-width: 640px) {
  .site-demo {
    grid-template-columns: minmax(0, 270px) minmax(0, 320px);
    align-items: start;
    gap: 24px;
  }
  .site-demo-chat {
    margin-block-start: 32px;
  }
}
.site-bubble {
  padding: 10px 14px;
  border-radius: 18px;
  font-size: 15px;
  line-height: 1.45;
}
.site-bubble-out {
  align-self: flex-end;
  border-end-end-radius: 6px;
  background: var(--ch-accent-soft);
}
.site-bubble-in {
  border: 1px solid var(--ch-separator);
  border-end-start-radius: 6px;
  background: var(--ch-section);
  box-shadow: var(--site-shadow-bubble);
}
.site-voice {
  display: flex;
  align-items: center;
  gap: 10px;
  inline-size: 240px;
  max-inline-size: 100%;
}
.site-voice-play {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  inline-size: 36px;
  block-size: 36px;
  border-radius: 50%;
  background: var(--ch-button);
  color: var(--ch-button-text);
}
.site-voice-play svg {
  inline-size: 16px;
  block-size: 16px;
  margin-inline-start: 2px;
}
.site-voice-wave {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 2px;
  block-size: 28px;
}
.site-voice-wave span {
  flex: 1;
  max-inline-size: 3px;
  block-size: 30%;
  border-radius: 2px;
  background: var(--ch-accent);
}
.site-voice-wave span:nth-child(3n + 1) {
  block-size: 55%;
}
.site-voice-wave span:nth-child(4n + 2) {
  block-size: 85%;
}
.site-voice-wave span:nth-child(5n + 3) {
  block-size: 40%;
}
.site-voice-wave span:nth-child(7n) {
  block-size: 100%;
}
.site-voice-time {
  color: var(--ch-muted);
  font-size: 13px;
}
.site-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.site-card-title,
.site-card-event {
  font-weight: 700;
}
.site-card-event {
  margin-block: 8px 2px;
}
.site-card-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.site-card-icon {
  flex: none;
  inline-size: 16px;
  block-size: 16px;
  color: var(--ch-accent);
}
.site-card-from {
  margin-block-start: 8px;
  color: var(--ch-muted);
  font-size: 14px;
  font-style: italic;
}
.site-keys {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-block-start: 6px;
}
.site-key {
  display: flex;
  align-items: center;
  justify-content: center;
  min-block-size: 40px;
  padding-inline: 8px;
  border-radius: 10px;
  background: var(--ch-accent-soft);
  color: var(--ch-accent);
  font-size: 15px;
  font-weight: 600;
  text-align: center;
}
.site-keys-ping {
  grid-template-columns: repeat(3, 1fr);
}
.site-key-wide {
  grid-column: 1 / -1;
}
.site-phone {
  overflow: hidden;
  inline-size: 100%;
  max-inline-size: 340px;
  border: 1px solid var(--ch-outline);
  border-radius: 28px;
  background: var(--ch-bg);
  box-shadow: var(--site-shadow-phone);
}
.site-phone-screen {
  padding-block: 8px;
}
.site-demo-app {
  background: var(--ch-bg);
}
.site-demo-dark {
  display: none;
}
@media (prefers-color-scheme: dark) {
  .site-demo-light {
    display: none;
  }
  .site-demo-dark {
    display: block;
  }
  .site-bubble-in {
    box-shadow: none;
  }
  .site-phone {
    box-shadow: none;
  }
}
.site-demo-app .ch-more {
  display: none;
}
.site-demo-app .ch-agenda {
  padding-block-end: 8px;
}
.site-demo-app .ch-days > .ch-day:first-child .ch-row-li:first-child {
  border-radius: 12px;
  background: var(--ch-accent-soft);
}
@keyframes site-rise {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes site-tap {
  0%,
  100% {
    background: var(--ch-accent-soft);
    color: var(--ch-accent);
  }
  50% {
    background: var(--ch-button);
    color: var(--ch-button-text);
  }
}
@media (prefers-reduced-motion: no-preference) {
  .site-demo-card {
    animation: site-rise 450ms cubic-bezier(0.2, 0.7, 0.2, 1) 600ms both;
  }
  .site-key-create {
    animation: site-tap 520ms ease-in-out 1500ms both;
  }
  .site-demo-app .ch-days > .ch-day:first-child .ch-row-li:first-child {
    animation: site-rise 500ms ease-out 2100ms both;
  }
}
.site-steps {
  display: grid;
  gap: 32px;
  margin-block-start: 40px;
}
@media (min-width: 860px) {
  .site-steps {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
.site-step p {
  margin-block-start: 8px;
  max-inline-size: 34em;
}
.site-step-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: 40px;
  block-size: 40px;
  margin-block-end: 16px;
  border-radius: 50%;
  background: var(--ch-accent-soft);
  color: var(--ch-accent);
  font-size: 18px;
  font-weight: 700;
}
.site-note {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  max-inline-size: 44em;
  margin-block-start: 40px;
  color: var(--ch-muted);
  font-size: 16px;
}
.site-note .site-icon {
  margin-block-start: 2px;
  color: var(--ch-accent);
}
.site-groups {
  margin-block-start: 40px;
}
@media (min-width: 860px) {
  .site-groups {
    columns: 2;
    column-gap: 24px;
  }
}
.site-group {
  break-inside: avoid;
  margin-block-end: 24px;
  padding: 6px 20px 14px;
  border-radius: 18px;
  background: var(--ch-section);
}
.site-group-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-block: 14px 6px;
  font-size: 18px;
  font-weight: 700;
}
.site-tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--ch-accent-soft);
  color: var(--ch-accent);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  vertical-align: 1px;
}
.site-list-row {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding-block: 12px;
  border-block-start: 1px solid var(--ch-separator);
  font-size: 16px;
  line-height: 1.45;
}
.site-list-row:first-child {
  border-block-start: 0;
}
.site-list-icon {
  margin-block-start: 1px;
  color: var(--ch-accent);
}
/* What a group needs in Settings (the Jewish calendar's culture), under its list */
.site-group-note {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding-block: 12px 4px;
  border-block-start: 1px solid var(--ch-separator);
  color: var(--ch-muted);
  font-size: 15px;
  line-height: 1.45;
}
.site-group-note .site-icon {
  margin-block-start: 1px;
  color: var(--ch-accent);
}
.site-ping {
  margin: 8px 0 6px;
}
.site-ping-message {
  max-inline-size: 320px;
}
.site-ping .site-bubble-in {
  background: var(--ch-surface);
  border-color: transparent;
  box-shadow: none;
}
.site-ping-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
}
.site-ping-for {
  color: var(--ch-muted);
}
.site-ping-caption {
  margin-block-start: 10px;
  color: var(--ch-muted);
  font-size: 14px;
}
.site-table {
  inline-size: 100%;
  margin-block-start: 32px;
  border-collapse: collapse;
  font-size: 16px;
  line-height: 1.45;
}
.site-table th,
.site-table td {
  padding: 14px 12px;
  border-block-end: 1px solid var(--ch-separator);
  text-align: start;
  vertical-align: top;
}
.site-table thead th {
  color: var(--ch-muted);
  font-size: 15px;
  font-weight: 650;
}
.site-table th[scope='row'] {
  inline-size: 34%;
  font-weight: 600;
}
.site-cell {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.site-cell .site-icon {
  margin-block-start: 2px;
}
.site-cell-yes {
  color: var(--ch-accent);
}
.site-cell-no {
  color: var(--ch-muted);
}
@media (max-width: 719.98px) {
  .site-table thead {
    display: none;
  }
  .site-table,
  .site-table tbody,
  .site-table tr,
  .site-table th,
  .site-table td {
    display: block;
  }
  .site-table tr {
    padding-block: 14px;
    border-block-end: 1px solid var(--ch-separator);
  }
  .site-table th,
  .site-table td {
    padding: 0;
    border: 0;
  }
  .site-table th[scope='row'] {
    inline-size: auto;
    margin-block-end: 6px;
  }
  .site-table td {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    gap: 8px;
    padding-block: 3px;
  }
  .site-table td::before {
    content: attr(data-channel);
    color: var(--ch-muted);
    font-size: 15px;
    font-weight: 600;
  }
}
.site-plans {
  display: grid;
  gap: 16px;
  margin-block-start: 32px;
}
@media (min-width: 860px) {
  .site-plans {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 20px;
  }
}
.site-plan {
  padding: 24px;
  border: 1px solid var(--ch-separator);
  border-radius: 20px;
  background: var(--ch-section);
}
.site-plan.is-top {
  border: 2px solid var(--ch-accent);
}
.site-plan-name {
  font-size: 21px;
  font-weight: 750;
}
.site-plan-price {
  margin-block: 4px 18px;
  color: var(--ch-muted);
  font-size: 17px;
  font-weight: 600;
}
.site-plan-bullets {
  display: grid;
  gap: 10px;
  font-size: 16px;
  line-height: 1.45;
}
.site-plan-bullets li,
.site-plan-notes li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.site-plan-check {
  margin-block-start: 1px;
  color: var(--ch-accent);
}
.site-plans-all {
  max-inline-size: 44em;
  margin-block-start: 28px;
  font-size: 16px;
}
.site-plan-notes {
  display: grid;
  gap: 8px;
  margin-block-start: 16px;
  color: var(--ch-muted);
  font-size: 15px;
}
.site-plan-notes .site-icon {
  inline-size: 18px;
  block-size: 18px;
  margin-block-start: 2px;
}
.site-cancel {
  margin-block-start: 20px;
}
.site-cancel-link {
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
  color: var(--ch-accent);
  font-size: 16px;
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.site-cancel-ways {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 24px;
  color: var(--ch-muted);
  font-size: 15px;
}
.site-cancel-ways a {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.site-founder {
  margin: 32px 0 0;
}
.site-founder blockquote {
  max-inline-size: 36em;
  padding-inline-start: 20px;
  border-inline-start: 3px solid var(--ch-accent);
}
.site-founder blockquote p {
  font-size: 21px;
  font-weight: 500;
  line-height: 1.5;
}
.site-founder figcaption {
  margin-block-start: 16px;
  padding-inline-start: 23px;
  color: var(--ch-muted);
  font-size: 16px;
}
@media (min-width: 720px) {
  .site-founder blockquote p {
    font-size: 24px;
  }
}
.site-more {
  margin-block-start: 20px;
  padding-inline-start: 23px;
}
.site-more a {
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
  color: var(--ch-accent);
  font-size: 17px;
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 3px;
}
`;


const PAGES_CSS = `
.site-page-main {
  padding-block-start: 40px;
}
.site-narrow {
  max-inline-size: 760px;
}
.site-page-title {
  font-size: 36px;
}
@media (min-width: 720px) {
  .site-page-main {
    padding-block-start: 64px;
  }
  .site-page-title {
    font-size: 44px;
  }
}
.site-back a {
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
  margin-block-end: 8px;
  color: var(--ch-accent);
  font-weight: 600;
  text-decoration: none;
}
.site-byline {
  margin-block-start: 12px;
  color: var(--ch-muted);
  font-size: 15px;
}
.site-posts {
  display: grid;
  gap: 16px;
  margin-block-start: 32px;
}
.site-post-card {
  padding: 20px 24px;
  border-radius: 18px;
  background: var(--ch-surface);
}
.site-post-card a {
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
  text-decoration: none;
}
.site-post-card p {
  margin-block-start: 8px;
  color: var(--ch-muted);
  font-size: 16px;
}
.site-article {
  margin-block-start: 32px;
  font-size: 18px;
  line-height: 1.7;
}
.site-article h2 {
  margin-block: 40px 12px;
  font-size: 24px;
  font-weight: 700;
  line-height: 1.25;
}
.site-article h3 {
  margin-block: 32px 8px;
  font-size: 20px;
  font-weight: 650;
}
.site-article p,
.site-article ul,
.site-article ol {
  margin-block-end: 18px;
}
.site-article ul,
.site-article ol {
  padding-inline-start: 24px;
}
.site-article ul {
  list-style: disc;
}
.site-article ol {
  list-style: decimal;
}
.site-article li + li {
  margin-block-start: 6px;
}
.site-article a,
.site-legal a {
  color: var(--ch-accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.site-article strong {
  font-weight: 650;
}
.site-article blockquote {
  margin-block: 24px;
  padding-inline-start: 20px;
  border-inline-start: 3px solid var(--ch-accent);
  color: var(--ch-muted);
}
.site-article hr {
  margin-block: 40px;
  border: 0;
  border-block-start: 1px solid var(--ch-separator);
}
.site-cta {
  margin-block-start: 48px;
  padding: 28px 24px;
  border-radius: 20px;
  background: var(--ch-card);
}
.site-cta-text {
  margin-block: 8px 20px;
  color: var(--ch-muted);
}
.site-legal-section {
  margin-block-start: 40px;
}
.site-legal-section p,
.site-legal-list {
  margin-block-start: 12px;
}
.site-legal-h3 {
  margin-block-start: 28px;
  font-size: 17px;
  font-weight: 700;
  line-height: 1.35;
}
.site-legal [id] {
  scroll-margin-block-start: 88px;
}
.site-legal strong {
  font-weight: 650;
}
.site-legal code {
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--ch-surface);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 15px;
}
.site-legal-missing {
  color: var(--ch-muted);
}
.site-legal-list {
  display: grid;
  gap: 8px;
  padding-inline-start: 24px;
}
.site-legal .site-legal-list {
  list-style: disc;
}
.site-legal .site-legal-list .site-legal-list {
  margin-block-start: 8px;
  gap: 6px;
  padding-inline-start: 22px;
  list-style: circle;
}
.site-legal-list li > p {
  margin-block-start: 10px;
}
.site-share-block {
  margin-block-start: 48px;
}
.site-pitches {
  display: grid;
  gap: 16px;
  margin-block-start: 20px;
}
.site-pitch {
  padding: 18px 20px;
  border-radius: 18px;
  background: var(--ch-surface);
}
.site-pitch-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-block-end: 8px;
}
.site-pitch-label,
.site-qr-label {
  color: var(--ch-muted);
  font-size: 15px;
  font-weight: 650;
}
.site-pitch p {
  font-size: 16px;
  line-height: 1.55;
}
.site-copy {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-block-size: 44px;
  min-inline-size: 44px;
  padding-inline: 14px;
  border: 0;
  border-radius: 12px;
  background: var(--ch-accent-soft);
  color: var(--ch-accent);
  font-family: inherit;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  touch-action: manipulation;
}
.site-copy svg {
  inline-size: 18px;
  block-size: 18px;
}
.site-qrs {
  display: grid;
  gap: 24px;
  margin-block-start: 24px;
}
@media (min-width: 640px) {
  .site-qrs {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
.site-qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.site-qr-code {
  padding: 12px;
  border-radius: 16px;
  background: var(--bg-white);
}
.site-qr-code canvas {
  display: block;
}
.site-share-link h2 {
  margin-block-end: 10px;
}
.site-link-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-block: 8px;
  padding-inline: 16px 8px;
  border-radius: 14px;
  background: var(--ch-surface);
}
.site-link-row code {
  flex: 1;
  min-inline-size: 0;
  overflow: hidden;
  color: var(--ch-accent);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;

/** The whole style sheet: the kit's theme (the sheet, the buttons, the demo's .ch-app scope), then the site's own. */
export const SITE_CSS = APP_THEME_CSS + TOKENS_CSS + BASE_CSS + CHROME_CSS + LANDING_CSS + PAGES_CSS;

/** The sheet's address (app/site.css/route.ts), versioned by its content: a new sheet is a new URL. */
export const SITE_CSS_HREF = `/site.css?v=${createHash('sha256').update(SITE_CSS).digest('hex').slice(0, 12)}`;

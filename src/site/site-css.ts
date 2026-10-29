// The public site's one style sheet (spec 2026-10-28-public-website §5): the app's own colour values, light and dark
// from the device's setting in CSS alone (no script, so a server-rendered page never flashes), the app's system font
// stack, and the site's layout. The (site) layout renders it once, in <head>.
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
.site h1,
.site h2,
.site h3,
.site p,
.site ul,
.site ol,
.site li,
.site dl,
.site dd,
.site figure,
.site blockquote {
  margin: 0;
}
.site ul,
.site ol {
  padding: 0;
  list-style: none;
}
.site a {
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

/** The whole style sheet: the kit's theme (the sheet, the buttons, the demo's .ch-app scope), then the site's own. */
export const SITE_CSS = APP_THEME_CSS + TOKENS_CSS + BASE_CSS + CHROME_CSS;

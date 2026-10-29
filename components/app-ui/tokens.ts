// The app's colour values, light and dark (spec 2026-10-28-public-website §5.1): the one place they are written.
// Two style sheets read them, so the public site and the app cannot drift apart:
// - APP_THEME_CSS (./theme.ts) and APP_SCREEN_CSS (./screen.ts): each is the fallback of a --ch-* token for when
//   Telegram sends no theme (a browser, or a theme without that colour);
// - the public site's style sheet (src/site/site-css.ts), which has no Telegram theme at all and follows the
//   device's light or dark setting.
//
// The brand values (bg, text, accent, button, buttonText in light) are also app/globals.css's own tokens
// (--bg-white, --text-primary, --brand-primary-dark), which theme.ts falls back to on the app's pages;
// scripts/smoke-app-ui.ts keeps the two equal. The shadows and scrims are full values, not colours.
// Client-safe: no import.

export const APP_TOKENS = {
  light: {
    bg: '#ffffff',
    text: '#1a1a2e',
    hint: '#5e5e78',
    accent: '#6344E0',
    surface: '#f3f2f8',
    separator: '#eceaf3',
    button: '#6344E0',
    buttonText: '#ffffff',
    danger: '#c62828',
    card: '#f5f2ff',
    cardSeparator: '#e4defa',
    done: '#8a8aa0',
    chipBg: '#ffebd9',
    chipText: '#8a3d00',
    outline: '#d4d2e0',
    scrim: 'rgba(18, 18, 32, 0.45)',
    sheetShadow: '0 -8px 24px rgba(18, 18, 32, 0.18)',
    tabShadow: '0 1px 2px rgba(26, 26, 46, 0.14)',
    mineSoft: '#eee9ff',
    mineSoftText: '#2e1a87',
    partnerSoft: '#ffd9b8',
    partnerSoftText: '#6b2c00',
    partnerLine: '#b05f22',
    partnerLineText: '#7a3500',
    dotPartner: '#b4540b',
    pillLine: '#d9d2fa',
    pillText: '#4b2fc9',
    disabled: '#c9c8d6',
    monthTitle: '#4b2fc9',
    accentSoft: '#eee9ff',
    dangerSoft: '#fdecea',
    switchThumb: '#ffffff',
    switchThumbShadow: '0 1px 3px rgba(0, 0, 0, 0.25)',
    warn: '#c4580a',
    warnText: '#8a3d00',
  },
  dark: {
    bg: '#15151d',
    text: '#f1f0f7',
    hint: '#a6a6be',
    accent: '#bba8ff',
    surface: '#22222e',
    section: '#1e1e29',
    separator: '#2a2a38',
    button: '#6d4ff0',
    danger: '#ff8a80',
    card: '#221d3a',
    cardSeparator: '#332b55',
    done: '#7c7c94',
    chipBg: '#3d2715',
    chipText: '#ffc796',
    outline: '#3e3e52',
    scrim: 'rgba(0, 0, 0, 0.6)',
    sheetShadow: '0 -8px 24px rgba(0, 0, 0, 0.5)',
    tabOn: '#33334a',
    mineSoft: '#2c2550',
    mineSoftText: '#d9cfff',
    partnerSoft: '#4a2b12',
    partnerSoftText: '#ffd2a8',
    partnerLine: '#d98b4a',
    partnerLineText: '#ffb877',
    dotPartner: '#f0924a',
    pillLine: '#3a3166',
    disabled: '#4a4a5e',
    accentSoft: '#2c2550',
    dangerSoft: '#3a2226',
    warn: '#ffb27a',
    warnText: '#ffc796',
  },
} as const;

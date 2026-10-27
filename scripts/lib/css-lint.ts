// The design layer's CSS lint, shared by smoke-app-ui.ts (#2, over the theme, the screen and the form kit) and
// the screens' own smokes (over each screen's CSS). It checks the rules every style sheet of the app lives by
// (spec 2026-10-19 §4):
//  - every font size is in px and at least 11;
//  - .ch-btn, .ch-icon-btn, .ch-sheet-close and .ch-btn-outline, where the sheet has a rule for them, keep a
//    minimum height of 44 px or more;
//  - logical properties only (no margin-left, padding-right, left:, text-align: left, float ...);
//  - no :hover (touch only);
//  - no hex, rgb() or hsl() outside a token block (a declaration of a --custom-property), except the exempt text.
// scripts/lib/ is not a smoke (ci-smokes.sh runs scripts/smoke-*.ts only).
//
// An exempt entry is a piece of the CSS exactly as written (a rule's selector and the one declaration that
// holds a literal): the first occurrence of it is skipped, so the same declaration elsewhere is still found, and
// an entry that is not in the CSS is itself a problem (a stale exemption).

/** The controls whose touch target the lint holds to 44 px, where a sheet declares them. */
const TAP_TARGETS = ['.ch-btn', '.ch-icon-btn', '.ch-sheet-close', '.ch-btn-outline'];
const MIN_TAP = 44;
const MIN_FONT = 11;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The problems found in `css`; [] is clean. */
export function lintCss(css: string, opts: { exempt?: string[] } = {}): string[] {
  const problems: string[] = [];

  // The exempt text out first (the comments come out after, so an exemption can't straddle one)
  let text = css;
  for (const piece of opts.exempt ?? []) {
    const at = text.indexOf(piece);
    if (at === -1) {
      problems.push(`exempt text is not in the CSS: ${JSON.stringify(piece)}`);
      continue;
    }
    text = text.slice(0, at) + text.slice(at + piece.length);
  }
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');

  // Sizes: px, at least 11. `font: inherit` takes the size from the parent and has none of its own; any other shorthand hides one.
  for (const m of text.matchAll(/font-size:\s*([^;}]+)/g)) {
    const px = /^(\d+(?:\.\d+)?)px$/.exec(m[1].trim());
    if (!px) problems.push(`font-size is not in px: ${m[1].trim()}`);
    else if (Number(px[1]) < MIN_FONT) problems.push(`font-size ${px[1]}px is under ${MIN_FONT}px`);
  }
  for (const m of text.matchAll(/(?:^|[\s;{])font:\s*([^;}]+)/g)) {
    if (m[1].trim() !== 'inherit') problems.push(`a font shorthand hides the size: font: ${m[1].trim()}`);
  }

  // Taps: a rule for one of the controls keeps a minimum height of 44 px or more
  for (const selector of TAP_TARGETS) {
    for (const m of text.matchAll(new RegExp(`(?:^|\\n)${escapeRegExp(selector)} \\{([^}]*)\\}`, 'g'))) {
      const min = /min-(?:height|block-size):\s*(\d+(?:\.\d+)?)px/.exec(m[1]);
      if (!min) problems.push(`${selector} has no minimum height (at least ${MIN_TAP}px)`);
      else if (Number(min[1]) < MIN_TAP) problems.push(`${selector} min-height ${min[1]}px is under ${MIN_TAP}px`);
    }
  }

  // Logical properties only, and nothing that needs a hover
  const physical = text.match(/(?:margin|padding|border)-(?:left|right)|(?:^|[\s;{])(?:left|right)\s*:|text-align:\s*(?:left|right)|float:/g);
  if (physical) problems.push(`physical properties: ${JSON.stringify(physical.map((p) => p.trim()))}`);
  if (/:hover/.test(text)) problems.push('a :hover style');

  // Colours live in the token blocks
  const outside = text.replace(/^\s*--[\w-]+\s*:[^;]*;/gm, '');
  const literal = outside.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi);
  if (literal) problems.push(`colour literals outside the token blocks: ${JSON.stringify(literal)}`);

  return problems;
}

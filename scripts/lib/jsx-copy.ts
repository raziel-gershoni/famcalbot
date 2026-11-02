// The copy scanner the smokes share: the user-facing strings written in a TSX source, read with TypeScript's parser
// (smoke-site-truth T3 over the site, smoke-signin-ui U10 over Settings' sign-in group). JSX text, and a string with
// letters shown as a child or through a prop that renders text, is copy; a code prop's value (a class list, a path, an
// id, an input's autofill or keyboard hint) is not, unless it reads like a sentence.
// scripts/lib/ is not a smoke (ci-smokes.sh runs scripts/smoke-*.ts only).

import ts from 'typescript';

/** JSX props whose value is code, never shown: a string with letters in any other prop is copy. */
export const CODE_PROPS = new Set([
  'className', 'id', 'key', 'href', 'src', 'rel', 'type', 'role', 'dir', 'lang', 'scope', 'target', 'variant', 'level', 'path', 'doc', 'focusable',
  'aria-hidden', 'aria-current', 'aria-haspopup', 'aria-expanded', 'aria-live', 'aria-modal', 'aria-labelledby', 'aria-describedby', 'aria-controls',
  // An input's autofill, keyboard and label wiring (the sign-in forms), and the app kit's own code props
  'autoComplete', 'autoCapitalize', 'inputMode', 'enterKeyHint', 'htmlFor', 'name', 'kind', 'tone', 'valueDir',
]);
const BRAND = new Set(['FamCal']);
const hasWords = (text: string) => {
  const t = text.replace(/&[a-z]+;/g, '').trim();
  return t !== '' && /\p{L}/u.test(t) && !BRAND.has(t);
};

/** The strings an expression shows as its value: a literal, or one a ?:, || or ?? (or the right of &&) gives back. */
function shownLiterals(e: ts.Expression): string[] {
  if (ts.isParenthesizedExpression(e)) return shownLiterals(e.expression);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isTemplateExpression(e)) return [e.head.text, ...e.templateSpans.map((span) => span.literal.text)];
  if (ts.isConditionalExpression(e)) return [...shownLiterals(e.whenTrue), ...shownLiterals(e.whenFalse)];
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return [...shownLiterals(e.left), ...shownLiterals(e.right)];
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return shownLiterals(e.right);
  }
  return [];
}

/** The copy written in a TSX source: JSX text, and strings shown as a child or through a prop that renders text. */
export function jsxCopy(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && hasWords(node.text)) found.push(`${file}: "${node.text.trim()}"`);
    if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      for (const text of shownLiterals(node.expression)) if (hasWords(text)) found.push(`${file}: {"${text}"}`);
    }
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      const code = CODE_PROPS.has(name) || /^data-/.test(name);
      const values = ts.isStringLiteral(node.initializer) ? [node.initializer.text] : ts.isJsxExpression(node.initializer) && node.initializer.expression ? shownLiterals(node.initializer.expression) : [];
      for (const text of values) {
        // A code prop's value is a code word (a class list, a path, an id); one with spaces and capitals is copy
        if (code && !/[A-Z][a-z]+ [a-z]/.test(text)) continue;
        if (hasWords(text)) found.push(`${file}: ${name}="${text}"`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

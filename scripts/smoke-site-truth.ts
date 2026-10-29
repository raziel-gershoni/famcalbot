// Smoke test: the public site says only what is true, in every language, and every word of it is a message
// (plan docs/superpowers/plans/2026-10-29-public-website.md, Task 7; spec 2026-10-28-public-website §4).
//
//  - T1 the truth list (UNTRUE in scripts/lib/site-harness.ts: "never stored", feature parity, early access, OpenAI,
//    OpenWeatherMap, Google as a step, two-way sync, events by zman, typed events, WhatsApp photo capture, WhatsApp
//    reminders, auto-renewal, a scheduled weekly summary, the Hebrew date in letters outside Hebrew; and OFF_SITE, event
//    alerts, which only the legal texts may name) over every public
//    string in en, he and ru: the site's namespaces, the bot's WhatsApp welcome and greeting, the WhatsApp onboarding
//    that follows them (bot.onboarding valueProp, sampleSummary, ctaSetup), and the blog's posts. The list finds each claim in a sample of the old copy, so a clean walk means
//    something.
//  - T2 no emoji in the site's strings or posts (the WhatsApp greeting, which the visitor sends, is the bot's).
//  - T3 no user-facing string written in the site's TSX, read with TypeScript's parser: no JSX text (between tags or
//    next to an expression), and no string with letters shown as a child or through a prop that renders text (any prop
//    but the code-like ones: className, href, role, data-*...), beyond the brand name. The scanner is checked on probes.
//  - T4 the copy guards hold the site to their rules: smoke-ru-formal and smoke-he-neutral skip no namespace and exempt
//    no landing or how-it-works key; the share page's friend-to-friend templates are the Russian guard's only
//    exemptions, each with its reason.
//  - T5 the i18n parity check passes (the same keys and ICU arguments in en, he and ru).
//  - T6 Russian site strings bind a one-letter word (в, с, к, о, у, и, а, я) to the next with a no-break space, so none
//    ends a line (the legal texts, owner-approved wording, aside).
//
// Nothing is faked: no DB, Redis or network.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-site-truth.ts

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { assert, check, EMOJI, finish, LOCALES, messages, OFF_SITE, readSource, ROOT, show, UNTRUE, type Row } from './lib/site-harness';

const SITE_NAMESPACES = ['site', 'landing', 'legal', 'blog', 'share'];

function leaves(node: unknown, prefix = ''): [string, string][] {
  if (typeof node === 'string') return [[prefix, node]];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node as Row).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

const posts = () =>
  fs
    .readdirSync(path.join(ROOT, 'content/blog'))
    .flatMap((slug) => fs.readdirSync(path.join(ROOT, 'content/blog', slug)).map((file) => `content/blog/${slug}/${file}`));

const siteFiles = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return siteFiles(rel);
    return /\.tsx$/.test(e.name) ? [rel] : [];
  });

/** JSX props whose value is code, never shown: a string with letters in any other prop is copy. */
const CODE_PROPS = new Set(['className', 'id', 'key', 'href', 'src', 'rel', 'type', 'role', 'dir', 'lang', 'scope', 'target', 'variant', 'level', 'path', 'doc', 'focusable', 'aria-hidden', 'aria-current', 'aria-haspopup', 'aria-expanded', 'aria-live', 'aria-modal', 'aria-labelledby', 'aria-describedby', 'aria-controls']);
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
function jsxCopy(file: string, source: string): string[] {
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

async function main() {
  await check('T1 the truth list finds each claim in the old copy, then none of them in any public string in en, he and ru (the site\'s namespaces, the bot\'s WhatsApp welcome, greeting and onboarding, the blog\'s posts)', () => {
    const old = [
      'Your calendar data is never stored.',
      'Данные календаря никогда не хранятся.',
      'WhatsApp integration with full feature parity',
      'Free during early access',
      'AI by OpenAI',
      'Weather from OpenWeatherMap',
      'Connect your Google Calendars, pick which ones to track',
      'two-way sync with Google',
      'Type events in the chat',
      'Send photos on WhatsApp too',
      'Add events by zman',
      'Get reminders on WhatsApp',
      'Plans renew automatically',
      'A weekly summary every Sunday',
      'The Hebrew date in letters, next to every day.',
      'Готовы? Подключите Google Calendar, чтобы увидеть *своё* расписание (60 секунд):',
      'מוכנים? חברו את Google Calendar כדי לראות את *הלו״ז שלכם* (60 שניות):',
      'Get an alert before every event, on time.',
    ];
    for (const [claim, pattern] of [...UNTRUE, ...OFF_SITE]) assert(old.some((line) => pattern.test(line)), `the pattern for ${claim} finds none of the old copy`);
    const found: string[] = [];
    for (const locale of LOCALES) {
      const strings = [
        ...SITE_NAMESPACES.flatMap((ns) => leaves(messages[locale][ns], ns)),
        ['bot.whatsapp.welcome', messages[locale].bot.whatsapp.welcome] as [string, string],
        ['bot.whatsapp.greeting', messages[locale].bot.whatsapp.greeting] as [string, string],
        // The WhatsApp onboarding after the language buttons (whatsapp-onboarding.ts): what a site visitor gets next
        ...(['valueProp', 'sampleSummary', 'ctaSetup'] as const).map((k) => [`bot.onboarding.${k}`, messages[locale].bot.onboarding[k]] as [string, string]),
      ];
      for (const [key, text] of strings) {
        for (const [claim, pattern] of [...UNTRUE, ...(key.startsWith('legal.') ? [] : OFF_SITE)]) if (pattern.test(text)) found.push(`${locale} ${key}: ${claim}`);
      }
    }
    for (const file of posts()) {
      const text = readSource(file);
      for (const [claim, pattern] of [...UNTRUE, ...OFF_SITE]) if (pattern.test(text)) found.push(`${file}: ${claim}: ${text.match(pattern)?.[0]}`);
    }
    assert(found.length === 0, show(found));
  });

  await check('T2 no emoji in the site\'s strings (en, he, ru) or in the blog\'s posts', () => {
    const found: string[] = [];
    for (const locale of LOCALES) {
      for (const [key, text] of SITE_NAMESPACES.flatMap((ns) => leaves(messages[locale][ns], ns))) if (EMOJI.test(text)) found.push(`${locale} ${key}`);
    }
    for (const file of posts()) if (EMOJI.test(readSource(file))) found.push(file);
    assert(found.length === 0, show(found));
  });

  await check('T3 no user-facing string written in the site\'s TSX (components/site, app/[locale]/(site), the share image): no text in JSX (also next to an expression), and no string with letters in a prop that renders text (any prop but the code-like ones) or as a child, beyond the brand', () => {
    const files = [...siteFiles('components/site'), ...siteFiles('app/[locale]/(site)'), 'app/og/[file]/route.tsx'];
    assert(files.length >= 15, `only ${files.length} files read`);
    const found: string[] = [];
    for (const file of files) found.push(...jsxCopy(file, readSource(file)));
    assert(found.length === 0, show(found));
    // The scanner itself finds what the old regexes missed
    const probes: [string, string][] = [
      ['<p>Copy {n}</p>', 'Copy'],
      ['<p>{x} items left</p>', 'items left'],
      ['<Card label="Hello" />', 'Hello'],
      ['<Card caption={\'Hello\'} />', 'Hello'],
      ['<p>{\'Hello\'}</p>', 'Hello'],
      ['<p>{on ? \'Yes\' : \'No\'}</p>', 'Yes'],
      ['<img alt="A family" />', 'A family'],
    ];
    for (const [probe, word] of probes) assert(jsxCopy('probe.tsx', `const x = ${probe};`).some((f) => f.includes(word)), `the scanner misses ${probe}`);
    for (const fine of ['<p className="site-x" dir="ltr" data-channel="telegram">{t(\'a.b\')}</p>', '<a href="/terms">{t(`x.${n}`)}</a>', '<p>{group === \'jewish\' ? <Note /> : null}</p>', '<span>FamCal</span>', '<p>&quot;{t(\'a\')}&quot;</p>']) {
      assert(jsxCopy('probe.tsx', `const x = ${fine};`).length === 0, `the scanner flags ${fine}: ${show(jsxCopy('probe.tsx', `const x = ${fine};`))}`);
    }
  });

  await check('T4 the copy guards hold the site to their rules: no namespace skipped, no landing or how-it-works key exempted; the Russian guard exempts only the share page\'s friend-to-friend templates, each with its reason', () => {
    const ru = readSource('scripts/smoke-ru-formal.ts');
    const he = readSource('scripts/smoke-he-neutral.ts');
    assert(!/NOT_YET/.test(ru), 'smoke-ru-formal still skips namespaces');
    const ruExempt = /const EXEMPT_KEYS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(ru)?.[1] ?? '';
    const ruKeys = [...ruExempt.matchAll(/'([\w.]+)': '([^']*(?:\\'[^']*)*)'/g)].map((m) => [m[1], m[2]]);
    assert(show(ruKeys.map(([k]) => k).sort()) === show(['share.msgMedium', 'share.msgShort']), `the Russian guard exempts ${show(ruKeys.map(([k]) => k))}`);
    assert(ruKeys.every(([, reason]) => reason.length > 20), 'an exemption without its reason');
    assert(/const NOT_HELD: Record<string, string> = \{\};/.test(he), 'smoke-he-neutral still skips a namespace');
    assert(!/'(?:landing|howItWorksPage)\./.test(he) && !/'(?:landing|howItWorksPage)\./.test(ru), 'a landing or how-it-works key is exempted');
  });

  await check('T5 the i18n parity check passes', () => {
    const out = execFileSync(process.execPath, [...process.execArgv, path.join(ROOT, 'scripts/check-i18n-parity.ts')], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert(/i18n parity OK/.test(out), out.slice(-400));
  });

  await check('T6 Russian typography: no one-letter word (в, с, к, о, у, и, а, я) ends a line, a no-break space binds it to the next in every Russian site string (site, landing, share, blog; the legal texts\' approved wording aside)', () => {
    const found: string[] = [];
    for (const ns of ['site', 'landing', 'share', 'blog']) {
      for (const [key, text] of leaves(messages.ru[ns], ns)) {
        const loose = text.match(/(?:^|[\s«(„"—])[вскоуиая] /giu);
        if (loose) found.push(`${key}: ${show(loose.map((x) => x.trim()))}`);
      }
    }
    assert(found.length === 0, show(found));
  });

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

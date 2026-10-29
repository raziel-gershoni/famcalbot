// Smoke test: the public site says only what is true, in every language, and every word of it is a message
// (plan docs/superpowers/plans/2026-10-29-public-website.md, Task 7; spec 2026-10-28-public-website §4).
//
//  - T1 the truth list (UNTRUE in scripts/lib/site-harness.ts: "never stored", feature parity, early access, OpenAI,
//    OpenWeatherMap, Google as a step, two-way sync, events by zman, typed events, WhatsApp photo capture, WhatsApp
//    reminders, auto-renewal, a scheduled weekly summary, the Hebrew date in letters outside Hebrew) over every public string in en, he and ru: the site's namespaces, the bot's WhatsApp welcome and
//    greeting, and the blog's posts. The list finds each claim in a sample of the old copy, so a clean walk means
//    something.
//  - T2 no emoji in the site's strings or posts (the WhatsApp greeting, which the visitor sends, is the bot's).
//  - T3 no user-facing string written in the site's TSX: no text between tags and no literal aria-label, title, alt or
//    placeholder with letters in it, beyond the brand name.
//  - T4 the copy guards hold the site to their rules: smoke-ru-formal and smoke-he-neutral skip no namespace and exempt
//    no landing or how-it-works key; the share page's friend-to-friend templates are the Russian guard's only
//    exemptions, each with its reason.
//  - T5 the i18n parity check passes (the same keys and ICU arguments in en, he and ru).
//
// Nothing is faked: no DB, Redis or network.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-site-truth.ts

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assert, check, EMOJI, finish, LOCALES, messages, readSource, ROOT, show, UNTRUE, type Row } from './lib/site-harness';

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

async function main() {
  await check('T1 the truth list finds each claim in the old copy, then none of them in any public string in en, he and ru (the site\'s namespaces, the bot\'s WhatsApp welcome and greeting, the blog\'s posts)', () => {
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
    ];
    for (const [claim, pattern] of UNTRUE) assert(old.some((line) => pattern.test(line)), `the pattern for ${claim} finds none of the old copy`);
    const found: string[] = [];
    for (const locale of LOCALES) {
      const strings = [
        ...SITE_NAMESPACES.flatMap((ns) => leaves(messages[locale][ns], ns)),
        ['bot.whatsapp.welcome', messages[locale].bot.whatsapp.welcome] as [string, string],
        ['bot.whatsapp.greeting', messages[locale].bot.whatsapp.greeting] as [string, string],
      ];
      for (const [key, text] of strings) for (const [claim, pattern] of UNTRUE) if (pattern.test(text)) found.push(`${locale} ${key}: ${claim}`);
    }
    for (const file of posts()) {
      const text = readSource(file);
      for (const [claim, pattern] of UNTRUE) if (pattern.test(text)) found.push(`${file}: ${claim}: ${text.match(pattern)?.[0]}`);
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

  await check('T3 no user-facing string written in the site\'s TSX (components/site, app/[locale]/(site), the share image): no text between tags, no literal aria-label, title, alt or placeholder with letters, beyond the brand', () => {
    const files = [...siteFiles('components/site'), ...siteFiles('app/[locale]/(site)'), 'app/og/[file]/route.tsx'];
    assert(files.length >= 15, `only ${files.length} files read`);
    const BRAND = new Set(['FamCal']);
    const found: string[] = [];
    for (const file of files) {
      const src = readSource(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      // Text right after a tag (<x ...> or </x>), up to the next tag, outside braces; code between generics (a ; = ( or ))
      // is not copy
      for (const m of src.matchAll(/(?:<[A-Za-z][\w.]*(?:\s[^<>]*)?>|<\/[A-Za-z][\w.]*>)([^<>{}]+)(?=<)/g)) {
        const text = m[1].replace(/&[a-z]+;/g, '').trim();
        if (!text || !/\p{L}/u.test(text) || /[;=()]/.test(text) || BRAND.has(text)) continue;
        found.push(`${file}: "${text}"`);
      }
      for (const m of src.matchAll(/\b(aria-label|title|alt|placeholder)="([^"]*)"/g)) {
        if (/\p{L}/u.test(m[2]) && !BRAND.has(m[2])) found.push(`${file}: ${m[1]}="${m[2]}"`);
      }
    }
    assert(found.length === 0, show(found));
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

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

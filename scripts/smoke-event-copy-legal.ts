// Smoke test for what the Privacy Policy and the Terms say about sending a copy of an event (spec
// docs/superpowers/specs/2026-11-27-send-event-copy-design.md, "Privacy Policy and Terms"; the owner approved the wording on
// 2026-11-27): scripts/lib/legal-copy.ts holds each sentence and its place, and this holds messages/<lang>.json to it.
//
// What it pins:
//   - L1 the seventeen edits word for word, each in its place, the same places in en, he and ru;
//   - L2 no text still says a sentence the edits replaced;
//   - L3 LEGAL_UPDATED is the day of the change or later for both texts, and not in the future;
//   - L4 the Russian edits bind a one-letter word to the next, and a dash to the word before it, with a no-break space.
// No network, no DB.

import path from 'node:path';
import en from '../messages/en.json';
import he from '../messages/he.json';
import ru from '../messages/ru.json';
import { COPY_LEGAL, COPY_LEGAL_REPLACED } from './lib/legal-copy';
import { nodeAt, plain, problem, type Locale } from './lib/legal-push';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (v: unknown) => JSON.stringify(v);

const MESSAGES: Record<Locale, { legal: Record<string, { sections: unknown }> }> = { en, he, ru } as never;
const LOCALES: Locale[] = ['en', 'he', 'ru'];
/** The day the owner approved the wording ("legal ok"). */
const COPY_WORDING_DAY = '2026-11-27';

const strings = (node: unknown): string[] =>
  typeof node === 'string' ? [node] : node && typeof node === 'object' ? Object.values(node).flatMap(strings) : [];

async function main() {
  await check('L1 each language holds the seventeen edits word for word, each in its place, the same places in en, he and ru', () => {
    const places = (l: Locale) => show(COPY_LEGAL[l].map(op => [op.id, op.doc, op.path, op.kind]));
    assert(places('he') === places('en') && places('ru') === places('en'), 'the edits sit in different places in different languages');
    const problems: string[] = [];
    for (const locale of LOCALES) {
      if (COPY_LEGAL[locale].length !== 17) problems.push(`${locale}: ${COPY_LEGAL[locale].length} edits, want 17`);
      for (const op of COPY_LEGAL[locale]) {
        const why = problem(op, MESSAGES[locale].legal[op.doc].sections);
        if (why) problems.push(`${locale} ${why}`);
      }
    }
    assert(problems.length === 0, problems.join('\n'));
  });

  await check('L2 no text still says a sentence the edits replaced', () => {
    for (const locale of LOCALES) {
      const all = [...strings(MESSAGES[locale].legal.privacy), ...strings(MESSAGES[locale].legal.terms)].map(plain);
      for (const old of COPY_LEGAL_REPLACED[locale]) assert(!all.includes(old), `${locale} still says: ${old.slice(0, 80)}`);
    }
  });

  await check('L3 LEGAL_UPDATED is the day of the change or later for both texts, and not in the future', async () => {
    const { LEGAL_UPDATED } = (await import(path.join(__dirname, '../src/site/legal.ts'))) as { LEGAL_UPDATED: { privacy: string; terms: string } };
    assert(LEGAL_UPDATED.privacy >= COPY_WORDING_DAY && LEGAL_UPDATED.terms >= COPY_WORDING_DAY, show(LEGAL_UPDATED));
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    assert(LEGAL_UPDATED.privacy <= tomorrow && LEGAL_UPDATED.terms <= tomorrow, `in the future: ${show(LEGAL_UPDATED)}`);
  });

  await check('L4 the Russian edits bind a one-letter word to the next, and a dash to the word before it, with a no-break space', () => {
    for (const op of COPY_LEGAL.ru) {
      const node = nodeAt(MESSAGES.ru.legal[op.doc].sections, op.path);
      assert(typeof node === 'string', `${op.id}: nothing at ${op.path}`);
      assert(!/(^|[\s(«])[вскоуиаяВСКОУИАЯ] /.test(node), `${op.id}: a one-letter word before a plain space: ${node.slice(0, 80)}`);
      assert(!/ —/.test(node), `${op.id}: a plain space before a dash`);
    }
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

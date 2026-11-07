// Smoke test: the Privacy Policy and the Terms say what asking FamCal in another chat adds (spec
// docs/superpowers/specs/2026-11-07-ask-in-chat-design.md §9; CLAUDE.md: the legal texts change only on the owner's word,
// in all three languages at once, with a new LEGAL_UPDATED):
//   - G1 each language holds the seven edits of scripts/lib/legal-ask.ts word for word, each in its place, the same
//     places in en, he and ru, and the entry after each new one is the one that moved on;
//   - G2 none still says a sentence an edit replaced;
//   - G3 LEGAL_UPDATED is the day of the change or later, the same day for both texts, and not in the future;
//   - G4 the Russian edits bind a one-letter word and a dash with a no-break space.
// Nothing is faked: no DB, Redis or network.
//
//   npx tsx scripts/smoke-ask-in-chat-legal.ts

import path from 'node:path';
import en from '../messages/en.json';
import he from '../messages/he.json';
import ru from '../messages/ru.json';
import { ASK_LEGAL, ASK_LEGAL_REPLACED } from './lib/legal-ask';
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
/** The day the ask-in-chat wording went in (spec 2026-11-07). */
const ASK_WORDING_DAY = '2026-11-07';

const strings = (node: unknown): string[] =>
  typeof node === 'string' ? [node] : node && typeof node === 'object' ? Object.values(node).flatMap(strings) : [];

async function main() {
  await check('G1 each language holds the seven edits word for word, each in its place, the same places in en, he and ru', () => {
    const places = (l: Locale) => show(ASK_LEGAL[l].map(op => [op.id, op.doc, op.path, op.kind]));
    assert(places('he') === places('en') && places('ru') === places('en'), 'the edits sit in different places in different languages');
    const problems: string[] = [];
    for (const locale of LOCALES) {
      if (ASK_LEGAL[locale].length !== 7) problems.push(`${locale}: ${ASK_LEGAL[locale].length} edits, want 7`);
      for (const op of ASK_LEGAL[locale]) {
        const why = problem(op, MESSAGES[locale].legal[op.doc].sections);
        if (why) problems.push(`${locale} ${why}`);
      }
    }
    assert(problems.length === 0, problems.join('\n'));
  });

  await check('G2 no text still says a sentence an edit replaced', () => {
    for (const locale of LOCALES) {
      const all = [...strings(MESSAGES[locale].legal.privacy), ...strings(MESSAGES[locale].legal.terms)].map(plain);
      for (const old of ASK_LEGAL_REPLACED[locale]) assert(!all.includes(old), `${locale} still says: ${old.slice(0, 80)}`);
    }
  });

  await check('G3 LEGAL_UPDATED is the day of the change or later, the same for both texts, not in the future', async () => {
    const { LEGAL_UPDATED } = (await import(path.join(__dirname, '../src/site/legal.ts'))) as { LEGAL_UPDATED: { privacy: string; terms: string } };
    const today = new Date().toISOString().slice(0, 10);
    assert(LEGAL_UPDATED.privacy >= ASK_WORDING_DAY && LEGAL_UPDATED.terms >= ASK_WORDING_DAY, show(LEGAL_UPDATED));
    assert(LEGAL_UPDATED.privacy === LEGAL_UPDATED.terms, show(LEGAL_UPDATED));
    // One day of slack: the ship day is Israel's, and UTC can still be on the day before.
    assert(LEGAL_UPDATED.privacy <= new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10), `in the future: ${show(LEGAL_UPDATED)}`);
  });

  await check('G4 the Russian edits bind a one-letter word to the next, and a dash to the word before it, with a no-break space', () => {
    for (const op of ASK_LEGAL.ru) {
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
  console.error('smoke crashed:', err);
  process.exit(1);
});

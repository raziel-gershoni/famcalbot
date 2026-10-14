// i18n parity: messages/en.json, he.json and ru.json must hold the same keys, and each
// key the same {param} placeholders. A key missing from one locale reaches the user as
// its own path ("nativeReminders.done") through getBotMessage, or as English through the
// `t.voice?.x || 'English'` fallbacks; a placeholder missing from one locale drops the
// title or name from that language's message. An array counts as one key.
//
// Run: npx tsx scripts/check-i18n-parity.ts

import { readFileSync } from 'node:fs';
import path from 'node:path';

const LOCALES = ['en', 'he', 'ru'] as const;
type Locale = (typeof LOCALES)[number];

/** Every leaf of the message tree, by its dot path. */
function flatten(node: unknown, prefix: string, out: Map<string, unknown>): Map<string, unknown> {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node)) flatten(value, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.set(prefix, node);
  }
  return out;
}

/** The {param} names getBotMessage would fill in, sorted. ICU plurals don't match the pattern. */
function placeholders(value: unknown): string {
  if (typeof value !== 'string') return '';
  return [...new Set(value.match(/\{\w+\}/g) ?? [])].sort().join(' ');
}

const leaves = Object.fromEntries(
  LOCALES.map(locale => {
    const file = path.resolve(__dirname, '../messages', `${locale}.json`);
    return [locale, flatten(JSON.parse(readFileSync(file, 'utf8')), '', new Map())];
  })
) as Record<Locale, Map<string, unknown>>;

const allKeys = [...new Set(LOCALES.flatMap(locale => [...leaves[locale].keys()]))].sort();
const problems: string[] = [];

for (const locale of LOCALES) {
  for (const key of allKeys) {
    if (!leaves[locale].has(key)) problems.push(`${locale}: missing ${key}`);
  }
}

for (const key of allKeys) {
  if (!LOCALES.every(locale => leaves[locale].has(key))) continue;
  const reference = placeholders(leaves.en.get(key));
  for (const locale of LOCALES) {
    const got = placeholders(leaves[locale].get(key));
    if (got !== reference) problems.push(`${locale}: ${key} has placeholders [${got}], en has [${reference}]`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.log(problem);
  console.log(`\ni18n parity FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
  process.exit(1);
}
console.log(`i18n parity OK (${allKeys.length} keys)`);

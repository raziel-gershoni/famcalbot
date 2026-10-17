// i18n parity: messages/en.json, he.json and ru.json must hold the same keys, and each
// key the same ICU arguments. A key missing from one locale reaches the user as its own
// path ("nativeReminders.done") through getBotMessage, or as English through the
// `t.voice?.x || 'English'` fallbacks; an argument missing from one locale drops the
// title or name from that language's message. An array counts as one key.
//
// The arguments are ICU's: {name}, and {count, plural, …} or {x, select, …} together with
// the arguments inside their forms. Only the names must match: a count can be a plain
// {count} in one language and a plural in another. Each message must also be one ICU can
// parse (next-intl formats every web message with it), every select needs an `other`
// form, and every plural gives exactly the forms its language uses (Intl.PluralRules:
// en one/other, he one/two/other, ru one/few/many/other). A Russian plural with no `few`
// form would print "2 напоминаний". An `=N` form is extra, and it stands in for a form
// whose category holds N alone among whole counts: =1 for en and he `one`, =2 for he
// `two`. Nothing stands in for ru `one`, which also holds 21, 31, …
//
// The bot's strings (bot.*) are read the way getBotMessage fills them
// (src/lib/bot-messages.ts): every {word} is an argument and nothing else is special, so
// there is no ICU quoting, plural or select there. getBotMessage fills {word} in
// "Reply '{word}'", which ICU would quote away.
//
// Run: npx tsx scripts/check-i18n-parity.ts [messages-dir]
// The directory defaults to messages/; scripts/smoke-calendar-home-copy.ts passes fixtures.

import { readFileSync } from 'node:fs';
import path from 'node:path';

const LOCALES = ['en', 'he', 'ru'] as const;
type Locale = (typeof LOCALES)[number];

/** One ICU argument: its name, its type (null for a plain {name}) and, for plural and select, its forms. */
interface IcuArgument {
  name: string;
  type: string | null;
  forms: string[];
}

const PLURAL_TYPES = new Set(['plural', 'selectordinal']);
const STYLED_TYPES = new Set(['number', 'date', 'time']);

/** Every ICU argument in a message, nested ones included. Throws on a message ICU can't parse. */
function icuArguments(message: string): IcuArgument[] {
  const found: IcuArgument[] = [];
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`${what} (at character ${i})`);
  };
  const skipSpace = () => {
    while (i < message.length && /\s/.test(message[i])) i++;
  };
  const read = (pattern: RegExp): string => {
    const match = pattern.exec(message.slice(i));
    if (!match) return '';
    i += match[0].length;
    return match[0];
  };

  // Just past the quote that opens at i ("'{…'"): its end is the next apostrophe that isn't
  // one of a pair, because '' inside a quote is one apostrophe too ("'{it''s}'" is {it's}).
  const quoteEnd = (): number => {
    let at = i + 2;
    for (;;) {
      const close = message.indexOf("'", at);
      if (close < 0) return fail('a quote that never closes');
      if (message[close + 1] !== "'") return close + 1;
      at = close + 2;
    }
  };

  // Literal text up to the "}" that closes the enclosing form, or to the end at the top.
  // ICU's quoting: '' is one apostrophe; an apostrophe before { or } (or # in a plural)
  // quotes up to the next lone apostrophe (see quoteEnd); any other apostrophe is plain
  // text ("don't").
  const text = (inForm: boolean, inPlural: boolean): void => {
    while (i < message.length) {
      const c = message[i];
      if (c === "'") {
        const next = message[i + 1];
        if (next === "'") {
          i += 2;
        } else if (next === '{' || next === '}' || (inPlural && next === '#')) {
          i = quoteEnd();
        } else {
          i++;
        }
      } else if (c === '{') {
        argument();
      } else if (c === '}') {
        if (inForm) return;
        fail('a "}" with no "{"');
      } else {
        i++;
      }
    }
    if (inForm) fail('a "{" with no "}"');
  };

  const argument = (): void => {
    i++; // the "{"
    skipSpace();
    const name = read(/^\w+/);
    if (!name) fail('an argument with no name');
    skipSpace();
    if (message[i] === '}') {
      i++;
      found.push({ name, type: null, forms: [] });
      return;
    }
    if (message[i] !== ',') fail(`"{${name}" followed by neither "}" nor ","`);
    i++;
    skipSpace();
    const type = read(/^\w+/);
    skipSpace();
    if (PLURAL_TYPES.has(type) || type === 'select') {
      if (message[i] !== ',') fail(`{${name}, ${type}} with no forms`);
      i++;
      const entry: IcuArgument = { name, type, forms: [] };
      found.push(entry);
      for (;;) {
        skipSpace();
        if (i >= message.length) fail(`{${name}, ${type}, …} never closes`);
        if (message[i] === '}') {
          i++;
          return;
        }
        const selector = read(/^[^\s{}]+/);
        if (!selector) fail(`a form of {${name}} with no name`);
        if (PLURAL_TYPES.has(type) && /^offset:\d+$/.test(selector)) continue;
        skipSpace();
        if (message[i] !== '{') fail(`the "${selector}" form of {${name}} has no message`);
        i++;
        text(true, type !== 'select');
        i++; // the form's "}"
        entry.forms.push(selector);
      }
    }
    if (STYLED_TYPES.has(type)) {
      // An optional style, up to the argument's "}".
      const close = message.indexOf('}', i);
      if (close < 0) fail(`{${name}, ${type}} never closes`);
      i = close + 1;
      found.push({ name, type, forms: [] });
      return;
    }
    fail(`{${name}, ${type || '…'}}: not an ICU argument type`);
  };

  text(false, false);
  return found;
}

/** getBotMessage's rule (src/lib/bot-messages.ts): it fills every {word} and nothing else. */
function botArguments(message: string): IcuArgument[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map(match => ({ name: match[1], type: null, forms: [] }));
}

/** The keys getBotMessage reads: getBotMessages returns the bot subtree. */
const isBotKey = (key: string): boolean => key.startsWith('bot.');

/** Whole counts 0–1000: enough for en, he and ru, whose rules look at n % 10 and n % 100. */
const WHOLE_COUNTS = 1000;
const loneCountCache = new Map<string, Map<string, number>>();

/**
 * The categories that hold one whole count alone, each with that count: en one → 1;
 * he one → 1, two → 2; none in ru, whose `one` also holds 21, 31, … Only whole counts:
 * a fraction can fall in one too (he 0.5), and these messages count whole things.
 */
function loneCounts(locale: Locale, type: 'cardinal' | 'ordinal'): Map<string, number> {
  const cacheKey = `${locale} ${type}`;
  const cached = loneCountCache.get(cacheKey);
  if (cached) return cached;
  const rules = new Intl.PluralRules(locale, { type });
  const first = new Map<string, number | null>(); // its one count, or null once it holds two
  for (let n = 0; n <= WHOLE_COUNTS; n++) {
    const category = rules.select(n);
    first.set(category, first.has(category) ? null : n);
  }
  const lone = new Map<string, number>();
  for (const [category, n] of first) if (n !== null) lone.set(category, n);
  loneCountCache.set(cacheKey, lone);
  return lone;
}

/** What a locale's plural and select forms get wrong in one message. */
function formProblems(locale: Locale, key: string, args: IcuArgument[]): string[] {
  const problems: string[] = [];
  for (const arg of args) {
    if (arg.type === 'select' && !arg.forms.includes('other')) {
      problems.push(`${locale}: ${key} {${arg.name}, select} has no "other" form`);
    }
    if (arg.type && PLURAL_TYPES.has(arg.type)) {
      const type = arg.type === 'plural' ? 'cardinal' : 'ordinal';
      const rules = new Intl.PluralRules(locale, { type });
      const uses: string[] = [...rules.resolvedOptions().pluralCategories];
      const named = arg.forms.filter(form => !/^=\d+$/.test(form));
      const exact = new Set(arg.forms.filter(form => /^=\d+$/.test(form)).map(form => Number(form.slice(1))));
      const lone = loneCounts(locale, type);
      for (const form of uses) {
        const standIn = lone.get(form);
        if (named.includes(form) || (standIn !== undefined && exact.has(standIn))) continue;
        problems.push(`${locale}: ${key} {${arg.name}, ${arg.type}} lacks the "${form}" form`);
      }
      for (const form of named) {
        if (!uses.includes(form)) problems.push(`${locale}: ${key} {${arg.name}, ${arg.type}} has a "${form}" form, which ${locale} never uses`);
      }
    }
  }
  return problems;
}

/** Every leaf of the message tree, by its dot path. */
function flatten(node: unknown, prefix: string, out: Map<string, unknown>): Map<string, unknown> {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node)) flatten(value, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.set(prefix, node);
  }
  return out;
}

const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../messages');

const leaves = Object.fromEntries(
  LOCALES.map(locale => {
    const file = path.join(dir, `${locale}.json`);
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
  // Each locale's argument names, sorted; null where the message doesn't parse.
  const names = {} as Record<Locale, string | null>;
  for (const locale of LOCALES) {
    const value = leaves[locale].get(key);
    if (typeof value !== 'string') {
      names[locale] = '';
      continue;
    }
    try {
      const args = isBotKey(key) ? botArguments(value) : icuArguments(value);
      problems.push(...formProblems(locale, key, args));
      names[locale] = [...new Set(args.map(arg => arg.name))].sort().join(' ');
    } catch (err) {
      problems.push(`${locale}: ${key} is not valid ICU: ${err instanceof Error ? err.message : String(err)}`);
      names[locale] = null;
    }
  }
  const reference = names.en;
  if (reference === null) continue;
  for (const locale of LOCALES) {
    const got = names[locale];
    if (got !== null && got !== reference) problems.push(`${locale}: ${key} has arguments [${got}], en has [${reference}]`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.log(problem);
  console.log(`\ni18n parity FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
  process.exit(1);
}
console.log(`i18n parity OK (${allKeys.length} keys)`);

// Smoke test: the Russian copy speaks to the person formally ("вы"), everywhere but the public landing page.
//
// The owner's rule is formal Russian. A few bot strings had kept the informal "ты" ("Напомню тебе", "Попробуй ещё
// раз"), so one reply could mix the two registers. This walks every string in messages/ru.json and fails on an
// informal pronoun or imperative. The landing page's marketing copy is left out until the public website redesign
// rewrites it.
//
// Nothing is faked: no DB, Redis or network.
//
// Run: npx tsx scripts/smoke-ru-formal.ts

import fs from 'fs';
import path from 'path';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

const ROOT = path.resolve(__dirname, '..');

/** Namespaces whose copy is not yet held to the rule (rewritten by the public website redesign). */
const NOT_YET = ['landing'];

/** An informal pronoun, or an informal imperative a message gives the person. A quoted example of what to say to the bot («напомни …») is the person's own words and does not count. */
const INFORMAL = /(?<![\p{L}])(?:ты|тебе|тебя|тобой|твой|твоя|твоё|твои|твоих|твоего|твоей|твоим|твоими|отправь|нажми|открой|попробуй|проверь|выбери|укажи|скажи|напиши|повтори|свяжи|закрой|скопируй|можешь|хочешь|сможешь|напишешь|отправишь)(?![\p{L}])/iu;

function leaves(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

/** The text with the quoted examples («…») taken out. */
const withoutQuotes = (text: string) => text.replace(/«[^»]*»/g, '');

const ru = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/ru.json'), 'utf8')) as Record<string, unknown>;

check('the matcher finds an informal word and passes a formal one (so a clean walk below means something)', () => {
  for (const informal of ['Напомню тебе завтра.', 'Попробуй ещё раз.', 'Это не для тебя.', 'Твой календарь готов.', 'Повтори и укажи время.', 'Можешь добавить уточнение.', 'Если хочешь, напишешь позже.', 'Ты сможешь отправить, а потом отправишь ещё.']) {
    assert(INFORMAL.test(withoutQuotes(informal)), `missed: ${informal}`);
  }
  for (const formal of ['Напомню вам завтра.', 'Попробуйте ещё раз.', 'Это не для вас.', 'Ваш календарь готов.', 'Скажите, например: «напомни мне завтра».', 'Тыква и твёрдый сыр', 'Можете добавить уточнение.', 'Если хотите, напишите позже.', 'Вы сможете отправить его позже.']) {
    assert(!INFORMAL.test(withoutQuotes(formal)), `flagged: ${formal}`);
  }
});

check('every Russian string outside the landing page is formal', () => {
  const all = leaves(ru);
  assert(all.length > 1000, `only ${all.length} strings read`);
  const informal = all.filter(([key, text]) => !NOT_YET.includes(key.split('.')[0]) && INFORMAL.test(withoutQuotes(text)));
  assert(informal.length === 0, `${informal.length} informal:\n${informal.map(([k, v]) => `  ${k}: ${v}`).join('\n')}`);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

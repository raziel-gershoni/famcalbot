// Smoke test for the Pair and Invite screens' copy (app/[locale]/pair/PairClient.tsx,
// app/[locale]/pair/page.tsx, app/[locale]/invite/[token]/InviteClient.tsx and page.tsx).
//
// Every string those screens show lives in the "pair" and "invite" namespaces of
// messages/{en,he,ru}.json and reaches the page through next-intl. This smoke pins:
//  - the screens hold no inline copy: no COPY table, no text between tags, no aria-label
//    or title in a quoted literal;
//  - every key a screen reads (t('key'), the 'errors.CODE' keys) exists in all three
//    files, and no key sits unused, so a key can't be renamed or dropped on one side;
//  - the three files hold the same keys, and each key formats with the same arguments;
//  - no slash or bracket gender forms in the Hebrew, and no informal "ты" forms in the Russian;
//  - scripts/check-i18n-parity.ts (keys, ICU arguments, plurals) passes on the real files.
//
// Nothing is faked: no DB, Redis or network.
//
// Run: npx tsx scripts/smoke-pair-invite-copy.ts

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
const LOCALES = ['en', 'he', 'ru'] as const;

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
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const SCREENS = [
  { namespace: 'pair', files: ['app/[locale]/pair/PairClient.tsx', 'app/[locale]/pair/page.tsx'] },
  { namespace: 'invite', files: ['app/[locale]/invite/[token]/InviteClient.tsx', 'app/[locale]/invite/[token]/page.tsx'] },
] as const;

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const messages = Object.fromEntries(LOCALES.map(l => [l, JSON.parse(read(`messages/${l}.json`))])) as Record<(typeof LOCALES)[number], Record<string, unknown>>;

/** Every leaf path under a namespace, dotted. */
function leaves(node: unknown, prefix = ''): Record<string, string> {
  if (typeof node === 'string') return { [prefix]: node };
  if (node === null || typeof node !== 'object') return {};
  return Object.assign({}, ...Object.entries(node).map(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k)));
}

/** The keys a screen's source reads: t('x'), t('x', …), and the quoted 'errors.X' keys it maps codes to. */
function usedKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const m of source.matchAll(/\bt\(\s*'([\w.]+)'/g)) keys.add(m[1]);
  for (const m of source.matchAll(/'(errors\.[\w]+)'/g)) keys.add(m[1]);
  return [...keys];
}

for (const { namespace, files } of SCREENS) {
  check(`${namespace}: the screens hold no inline copy and read the ${namespace} namespace`, () => {
    for (const file of files) {
      const source = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert(!/\bCOPY\b/.test(source), `${file} still has a COPY table`);
      assert(!/locale === 'he' \?/.test(source.replace(/toLocale\w*String\([\s\S]*?\)/g, '').replace(/'he-IL'/g, '')), `${file} still picks copy by locale`);
      const text = [...source.matchAll(/>([^<>{}=;()]*[A-Za-z֐-׿Ѐ-ӿ][^<>{}=;()]*)</g)].map(m => m[1].trim()).filter(Boolean);
      assert(text.length === 0, `${file} has text between tags: ${JSON.stringify(text)}`);
      const attrs = [...source.matchAll(/\b(?:aria-label|title|placeholder|alt)="([^"]+)"/g)].map(m => m[1]);
      assert(attrs.length === 0, `${file} has quoted attribute text: ${JSON.stringify(attrs)}`);
    }
    assert(files.some(f => /useTranslations|getTranslations/.test(read(f))), `no screen file reads ${namespace} through next-intl`);
  });

  check(`${namespace}: the three files hold the same keys, and every key a screen reads exists and is read`, () => {
    const byLocale = Object.fromEntries(LOCALES.map(l => [l, leaves(messages[l][namespace])]));
    const want = Object.keys(byLocale.en).sort();
    assert(want.length > 0, `messages/en.json has no "${namespace}" namespace`);
    for (const l of LOCALES) {
      assert(JSON.stringify(Object.keys(byLocale[l]).sort()) === JSON.stringify(want), `${l} keys differ from en: ${JSON.stringify(Object.keys(byLocale[l]).sort().filter(k => !want.includes(k)))} extra, ${JSON.stringify(want.filter(k => !(k in byLocale[l])))} missing`);
      for (const [k, v] of Object.entries(byLocale[l])) assert(v.trim() !== '', `${namespace}.${k} is empty in ${l}`);
    }
    const used = [...new Set(files.flatMap(f => usedKeys(read(f))))].sort();
    assert(JSON.stringify(used.filter(k => !want.includes(k))) === '[]', `read but not defined: ${JSON.stringify(used.filter(k => !want.includes(k)))}`);
    assert(JSON.stringify(want.filter(k => !used.includes(k))) === '[]', `defined but never read: ${JSON.stringify(want.filter(k => !used.includes(k)))}`);
  });

  check(`${namespace}: each key formats with the same arguments in every language`, () => {
    const { createTranslator } = nodeRequire('next-intl');
    const args = { name: 'Dana', when: '1 Jan' };
    for (const l of LOCALES) {
      const t = createTranslator({ locale: l, messages: { [namespace]: messages[l][namespace] }, namespace });
      for (const [k, v] of Object.entries(leaves(messages.en[namespace]))) {
        const want = [...v.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join();
        const got = [...leaves(messages[l][namespace])[k].matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join();
        assert(want === got, `${namespace}.${k} takes {${got}} in ${l}, {${want}} in en`);
        const out = t(k, args);
        assert(!/[{}]/.test(out), `${namespace}.${k} left a brace in ${l}: ${out}`);
      }
    }
  });

  check(`${namespace}: the Hebrew has no slash or bracket gender forms, the Russian no informal "ты" forms`, () => {
    for (const [k, v] of Object.entries(leaves(messages.he[namespace]))) {
      assert(!/[֐-׿]\/[֐-׿]|\([א-ת]\)/.test(v), `he ${namespace}.${k} has a gender form: ${v}`);
    }
    for (const [k, v] of Object.entries(leaves(messages.ru[namespace]))) {
      assert(!/(?:^|\s)(?:Отправь|Нажми|Открой|Попробуй|Свяжи|Закрой|Проверь|Скопируй)(?:\s|$)/.test(v) && !/\b(?:тебе|тебя|твой|твоя)\b/i.test(v), `ru ${namespace}.${k} is informal: ${v}`);
    }
  });
}

check('the Russian invite title asks to join calendars, not to "get in touch"', () => {
  const ru = JSON.parse(read('messages/ru.json')) as { invite: { title: string } };
  assert(ru.invite.title === 'Объединить календари с {name}?', ru.invite.title);
});

check('the Hebrew week-ahead note uses the app\'s own name for the block, \u05de\u05d1\u05d8 \u05dc\u05e9\u05d1\u05d5\u05e2 \u05d4\u05e7\u05e8\u05d5\u05d1', () => {
  const he = JSON.parse(read('messages/he.json')) as { bot: { errors: { weekAheadNote: string } }; };
  assert(he.bot.errors.weekAheadNote.includes('\u05d4\u05de\u05d1\u05d8 \u05dc\u05e9\u05d1\u05d5\u05e2 \u05d4\u05e7\u05e8\u05d5\u05d1') && !he.bot.errors.weekAheadNote.includes('\u05de\u05d1\u05d8 \u05d4\u05e9\u05d1\u05d5\u05e2'), he.bot.errors.weekAheadNote);
});

check('scripts/check-i18n-parity.ts passes on the real messages', () => {
  const run = spawnSync('npx', ['tsx', 'scripts/check-i18n-parity.ts'], { cwd: ROOT, encoding: 'utf8' });
  assert(run.status === 0, `exit ${run.status}: ${(run.stdout + run.stderr).slice(-400)}`);
});

for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
const passed = results.filter(r => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);

// Smoke test for the calendar home's Daf Yomi page (daf-yomi spec §6, release 1, Task 1):
// src/lib/calendar-view/daf-yomi.ts on @hebcal/learning's dafYomiBase subpath, and the
// tractate table in messages/{en,he,ru}.json (calendarHome.dafYomi).
//
// A day key is a calendar day, so the same key gives the same page whatever zone the
// device is in: the parent re-runs this file under UTC, Pacific/Kiritimati (UTC+14) and
// America/Los_Angeles (the way scripts/smoke-dst.ts does), and fails if any child fails.
// The Month reaches back to 1900 and Daf Yomi began on 11 September 1923: the days before
// give null, never hebcal's RangeError.
//
// Pure: no database, Redis, network or AI. Run with the fake env of scripts/ci-smokes.sh:
//   npx tsx scripts/smoke-daf-yomi.ts

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const ZONES = ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles'] as const;
const CHILD = 'DAF_SMOKE_CHILD';
const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

// ---- The parent: one child per process zone ----

async function runChildren(): Promise<void> {
  const outputs = await Promise.all(
    ZONES.map(
      zone =>
        new Promise<{ zone: string; code: number; text: string }>(resolve => {
          // process.execArgv carries tsx's loader flags, so the child compiles TypeScript the same way.
          const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], {
            env: { ...process.env, TZ: zone, [CHILD]: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let text = '';
          child.stdout.on('data', chunk => (text += chunk));
          child.stderr.on('data', chunk => (text += chunk));
          child.on('close', code => resolve({ zone, code: code ?? 1, text }));
        })
    )
  );
  let failed = 0;
  for (const { zone, code, text } of outputs) {
    console.log(`\n===== process TZ=${zone} =====\n${text.trimEnd()}`);
    if (code !== 0) failed++;
  }
  console.log(`\n${ZONES.length - failed}/${ZONES.length} process zones passed (${ZONES.join(', ')})`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---- The checks, in one process zone ----

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: { name: string; ok: boolean; reason?: string }[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

const messagesOf = (lang: string): Row => JSON.parse(readFileSync(path.join(ROOT, `messages/${lang}.json`), 'utf8'));

async function runChecks(): Promise<void> {
  const daf = nodeRequire('../src/lib/calendar-view/daf-yomi') as typeof import('../src/lib/calendar-view/daf-yomi');
  const { dafYomiOf, dafPageText, dafYomiWords } = daf;

  await check('D1 known days', () => {
    const rows: [string, string | null, number?][] = [
      ['1923-09-10', null],
      ['1923-09-11', 'Berachot', 2],
      ['1975-06-23', 'Niddah', 73],
      ['1975-06-24', 'Berachot', 2],
      ['2020-01-04', 'Niddah', 73],
      ['2020-01-05', 'Berachot', 2],
      ['2020-01-18', 'Berachot', 15],
      ['2021-04-12', 'Shekalim', 22],
      ['2021-04-13', 'Yoma', 2],
      ['2026-10-15', 'Bechorot', 27],
      ['2026-11-20', 'Arachin', 3],
      ['2027-03-13', 'Kinnim', 23],
      ['2027-03-23', 'Tamid', 33],
      ['2027-03-24', 'Midot', 34],
      ['2100-12-31', 'Bechorot', 22],
    ];
    const problems: string[] = [];
    for (const [day, tractate, page] of rows) {
      const got = dafYomiOf(day);
      const ok = tractate === null ? got === null : got !== null && got.tractate === tractate && got.page === page;
      if (!ok) problems.push(`${day}: want ${tractate} ${page ?? ''}, got ${JSON.stringify(got)}`);
    }
    for (const bad of ['2026-02-30', '2026-11-2', '']) {
      if (dafYomiOf(bad) !== null) problems.push(`"${bad}" should be null`);
    }
    // The Month reaches back to 1900: no day before the first cycle throws.
    for (const early of ['1900-01-01', '1900-01-02', '1923-09-10']) {
      try {
        if (dafYomiOf(early) !== null) problems.push(`${early} should be null`);
      } catch (err) {
        problems.push(`${early} threw ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('D2 the page in each language', () => {
    const cases: [number, string, string][] = [
      [3, 'he', 'ג׳'], [15, 'he', 'ט״ו'], [16, 'he', 'ט״ז'], [73, 'he', 'ע״ג'], [3, 'en', '3'], [3, 'ru', '3'],
    ];
    for (const [page, lang, want] of cases) {
      assert(dafPageText(page, lang) === want, `dafPageText(${page}, ${lang}) = "${dafPageText(page, lang)}", want "${want}"`);
    }
  });

  await check('D3 the table covers hebcal', () => {
    const { TRACTATE_NAMES } = nodeRequire('@hebcal/learning/dafYomiBase') as { TRACTATE_NAMES: readonly string[] };
    assert(TRACTATE_NAMES.length === 40, `hebcal lists ${TRACTATE_NAMES.length} tractates, expected 40`);
    const spot: Record<string, Record<string, string>> = {
      ru: { Berachot: 'Брахот', Beitzah: 'Бейца', Taanit: 'Таанит', Megillah: 'Мегила', 'Rosh Hashana': 'Рош а-Шана', 'Baba Kamma': 'Бава Кама', 'Avodah Zarah': 'Авода Зара' },
      he: { Shabbat: 'שבת', 'Rosh Hashana': 'ראש השנה' },
    };
    const problems: string[] = [];
    for (const lang of ['en', 'he', 'ru']) {
      const table = messagesOf(lang).calendarHome?.dafYomi?.tractates as Record<string, string> | undefined;
      if (!table) { problems.push(`${lang}: no calendarHome.dafYomi.tractates`); continue; }
      const keys = Object.keys(table);
      if (JSON.stringify(keys) !== JSON.stringify(TRACTATE_NAMES)) {
        problems.push(`${lang}: keys differ from hebcal's TRACTATE_NAMES (missing ${TRACTATE_NAMES.filter(n => !keys.includes(n)).join(', ') || 'none'}; extra ${keys.filter(k => !TRACTATE_NAMES.includes(k)).join(', ') || 'none'}; or the order)`);
      }
      for (const [key, value] of Object.entries(table)) {
        if (typeof value !== 'string' || value === '' || value !== value.trim()) problems.push(`${lang} ${key}: empty or untrimmed`);
        else if (lang === 'en' && value !== key) problems.push(`en ${key}: "${value}" is not its key`);
        else if (lang === 'he' && !/^[א-ת ]+$/.test(value)) problems.push(`he ${key}: "${value}" is not plain Hebrew letters`);
        else if (lang === 'ru' && !/^[А-Яа-яЁё\- ]+$/.test(value)) problems.push(`ru ${key}: "${value}" is not Cyrillic`);
      }
      for (const [key, want] of Object.entries(spot[lang] ?? {})) {
        if (table[key] !== want) problems.push(`${lang} ${key}: "${table[key]}", want "${want}"`);
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('D4 the line', () => {
    const { createTranslator } = nodeRequire('next-intl');
    const want: Record<string, Record<string, string>> = {
      '2026-11-20': { en: 'Daf Yomi · Arachin 3', he: 'דף יומי · ערכין ג׳', ru: 'Даф йоми · Арахин 3' },
      '2026-10-15': { en: 'Daf Yomi · Bechorot 27', he: 'דף יומי · בכורות כ״ז', ru: 'Даф йоми · Бехорот 27' },
    };
    const problems: string[] = [];
    for (const lang of ['en', 'he', 'ru']) {
      const t = createTranslator({ locale: lang, messages: messagesOf(lang), namespace: 'calendarHome', onError: (e: Error) => problems.push(`${lang}: ${e.message}`) });
      for (const [day, byLang] of Object.entries(want)) {
        const words = dafYomiWords(day, lang, t.raw('dafYomi.tractates'));
        const line = words ? t('dafYomi.line', words) : null;
        if (line !== byLang[lang]) problems.push(`${lang} ${day}: "${line}", want "${byLang[lang]}"`);
      }
      if (dafYomiWords('1923-09-10', lang, t.raw('dafYomi.tractates')) !== null) problems.push(`${lang}: 1923-09-10 should be null`);
    }
    const bare = dafYomiWords('2026-11-20', 'en', {});
    if (JSON.stringify(bare) !== JSON.stringify({ tractate: 'Arachin', page: '3' })) problems.push(`a table without Arachin: ${JSON.stringify(bare)}`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('D5 client-safe: the subpath is in the module graph, the main entry and @hebcal/core are not', () => {
    const root = path.join(ROOT, 'src/lib/calendar-view/daf-yomi.ts');
    assert(require.cache[root] !== undefined, 'daf-yomi.ts is not in require.cache: the check would be empty');
    const loaded = new Set<string>();
    const walk = (id: string) => {
      for (const child of require.cache[id]?.children ?? []) {
        if (loaded.has(child.id)) continue;
        loaded.add(child.id);
        walk(child.id);
      }
    };
    walk(root);
    const files = [...loaded].map(p => p.split(path.sep).join('/'));
    assert(files.some(p => p.endsWith('@hebcal/learning/dist/esm/dafYomiBase.js')), 'dafYomiBase.js is not in the graph: the check would be empty');
    const forbidden = files.filter(p => p.endsWith('@hebcal/learning/dist/esm/index.js') || p.includes('/@hebcal/core/'));
    assert(forbidden.length === 0, `server-side hebcal modules in the graph: ${forbidden.join(', ')}`);
  });

  await check('D6 one @hebcal/hdate: @hebcal/learning resolves the repo root\'s copy', () => {
    const learningDir = path.dirname(nodeRequire.resolve('@hebcal/learning/dafYomiBase'));
    const fromLearning = nodeRequire.resolve('@hebcal/hdate', { paths: [learningDir] });
    const fromRoot = nodeRequire.resolve('@hebcal/hdate');
    assert(fromLearning === fromRoot, `@hebcal/learning resolves ${fromLearning}, the home ${fromRoot}`);
  });

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.reason}`}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.env[CHILD] === '1') {
  void runChecks();
} else {
  void runChildren();
}

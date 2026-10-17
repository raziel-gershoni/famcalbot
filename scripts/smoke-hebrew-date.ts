// Smoke test for the calendar home's Hebrew dates (spec §7.8, Plan D):
// src/lib/calendar-view/hebrew-date.ts, on @hebcal/hdate.
//
// The home shows the Hebrew date under its header ("4 Cheshvan 5787") and beside each
// Agenda day ("4 Cheshvan"), in the viewer's language. Hebrew uses gematriya and month
// names without nikud ("ד׳ בחשון תשפ״ז"). English uses the number and hebcal's month
// name. Russian uses the genitive from calendarHome.hebrewMonthGenitive ("4 хешвана",
// Ruling R9). A day key is a calendar day, so its Hebrew date never depends on the
// device's clock, and it is the daytime date (no sunset shift).
//
// It also guards the dependency. @hebcal/hdate is a direct dependency pinned to ^0.21.1,
// the one copy @hebcal/core and @hebcal/locales share. A second copy would register
// Russian on a different Locale, and the bot's Russian Hebrew month names
// (src/services/claude.ts:46) would fall back to English.
//
// Pure: no database, Redis, network or AI. Run it under four clocks:
//   TZ=UTC npx tsx scripts/smoke-hebrew-date.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-hebrew-date.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-hebrew-date.ts
//   TZ=America/Los_Angeles npx tsx scripts/smoke-hebrew-date.ts

import fs from 'fs';
import path from 'path';
import Module from 'module';
import { HDate, Locale } from '@hebcal/hdate';
import { HEBREW_MONTHS, hebrewDayLabel, hebrewFullDate } from '../src/lib/calendar-view/hebrew-date';

const ROOT = path.resolve(__dirname, '..');

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

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function assertEqual<T>(got: T, want: T, label: string) {
  assert(JSON.stringify(got) === JSON.stringify(want), `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

/** A natural Russian genitive list in HEBREW_MONTHS order, so the checks don't depend on messages/ru.json. */
const RU_GENITIVE = [
  'тишрея', 'хешвана', 'кислева', 'тевета', 'швата', 'адара', 'адара I',
  'адара II', 'нисана', 'ияра', 'сивана', 'тамуза', 'ава', 'элула',
];

/** [day key, en, he, ru]: the day label in each language. */
type Row = [string, string, string, string];

function checkLabels(rows: Row[]) {
  for (const [key, en, he, ru] of rows) {
    assertEqual(hebrewDayLabel(key, 'en'), en, `${key} en`);
    assertEqual(hebrewDayLabel(key, 'he'), he, `${key} he`);
    assertEqual(hebrewDayLabel(key, 'ru', RU_GENITIVE), ru, `${key} ru`);
  }
}

function checkFull(rows: Row[]) {
  for (const [key, en, he, ru] of rows) {
    assertEqual(hebrewFullDate(key, 'en'), en, `${key} en`);
    assertEqual(hebrewFullDate(key, 'he'), he, `${key} he`);
    assertEqual(hebrewFullDate(key, 'ru', RU_GENITIVE), ru, `${key} ru`);
  }
}

/** The Gregorian day key of a Hebrew date, read the way hebcal hands it back (local midnight). */
function keyOf(hd: HDate): string {
  const d = hd.greg();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function main() {
  await check('15 October 2026 (a Thursday) is 4 Cheshvan 5787 in en, he and ru', () => {
    checkLabels([['2026-10-15', '4 Cheshvan', 'ד׳ בחשון', '4 хешвана']]);
    checkFull([['2026-10-15', '4 Cheshvan 5787', 'ד׳ בחשון תשפ״ז', '4 хешвана 5787']]);
  });

  await check("every month's name in each language, Adar I and Adar II 5787 and plain Adar 5786 included", () => {
    const rows: Row[] = [
      ['2026-09-12', '1 Tishrei', 'א׳ בתשרי', '1 тишрея'],
      ['2026-10-12', '1 Cheshvan', 'א׳ בחשון', '1 хешвана'],
      ['2026-11-11', '1 Kislev', 'א׳ בכסלו', '1 кислева'],
      ['2026-12-11', '1 Tevet', 'א׳ בטבת', '1 тевета'],
      ['2027-01-09', "1 Sh'vat", 'א׳ בשבט', '1 швата'],
      ['2026-02-18', '1 Adar', 'א׳ באדר', '1 адара'],
      ['2027-02-08', '1 Adar I', 'א׳ באדר א׳', '1 адара I'],
      ['2027-03-10', '1 Adar II', 'א׳ באדר ב׳', '1 адара II'],
      ['2027-04-08', '1 Nisan', 'א׳ בניסן', '1 нисана'],
      ['2027-05-08', '1 Iyyar', 'א׳ באייר', '1 ияра'],
      ['2027-06-06', '1 Sivan', 'א׳ בסיון', '1 сивана'],
      ['2027-07-06', '1 Tamuz', 'א׳ בתמוז', '1 тамуза'],
      ['2027-08-04', '1 Av', 'א׳ באב', '1 ава'],
      ['2027-09-03', '1 Elul', 'א׳ באלול', '1 элула'],
    ];
    checkLabels(rows);
    const reached = rows.map(([, en]) => en.replace(/^1 /, ''));
    assertEqual([...reached].sort(), [...HEBREW_MONTHS].sort(), 'the rows reach every entry of HEBREW_MONTHS once');
  });

  await check('Adar I and Adar II in 5787, a leap year: 30 days of Adar I, then Adar II, then Nisan; 5786 has one Adar', () => {
    checkFull([
      ['2027-03-09', '30 Adar I 5787', 'ל׳ באדר א׳ תשפ״ז', '30 адара I 5787'],
      ['2027-03-10', '1 Adar II 5787', 'א׳ באדר ב׳ תשפ״ז', '1 адара II 5787'],
      ['2027-03-23', '14 Adar II 5787', 'י״ד באדר ב׳ תשפ״ז', '14 адара II 5787'],
      ['2027-04-07', '29 Adar II 5787', 'כ״ט באדר ב׳ תשפ״ז', '29 адара II 5787'],
      ['2027-04-08', '1 Nisan 5787', 'א׳ בניסן תשפ״ז', '1 нисана 5787'],
      ['2026-03-03', '14 Adar 5786', 'י״ד באדר תשפ״ו', '14 адара 5786'],
    ]);
  });

  await check('Cheshvan and Kislev of 29 and 30 days (5786, 5787 and 5784)', () => {
    assert(HDate.daysInMonth(8, 5786) === 29 && HDate.daysInMonth(8, 5787) === 30, 'fixture: Cheshvan 5786 has 29 days, 5787 has 30');
    assert(HDate.daysInMonth(9, 5784) === 29 && HDate.daysInMonth(9, 5787) === 30, 'fixture: Kislev 5784 has 29 days, 5787 has 30');
    checkFull([
      ['2025-11-20', '29 Cheshvan 5786', 'כ״ט בחשון תשפ״ו', '29 хешвана 5786'],
      ['2025-11-21', '1 Kislev 5786', 'א׳ בכסלו תשפ״ו', '1 кислева 5786'],
      ['2026-11-10', '30 Cheshvan 5787', 'ל׳ בחשון תשפ״ז', '30 хешвана 5787'],
      ['2026-11-11', '1 Kislev 5787', 'א׳ בכסלו תשפ״ז', '1 кислева 5787'],
      ['2023-12-12', '29 Kislev 5784', 'כ״ט בכסלו תשפ״ד', '29 кислева 5784'],
      ['2023-12-13', '1 Tevet 5784', 'א׳ בטבת תשפ״ד', '1 тевета 5784'],
      ['2026-12-10', '30 Kislev 5787', 'ל׳ בכסלו תשפ״ז', '30 кислева 5787'],
      ['2026-12-11', '1 Tevet 5787', 'א׳ בטבת תשפ״ז', '1 тевета 5787'],
    ]);
  });

  await check('the Tishrei year boundary: 29 Elul 5786, then 1 Tishrei 5787', () => {
    checkFull([
      ['2026-09-11', '29 Elul 5786', 'כ״ט באלול תשפ״ו', '29 элула 5786'],
      ['2026-09-12', '1 Tishrei 5787', 'א׳ בתשרי תשפ״ז', '1 тишрея 5787'],
    ]);
  });

  await check('Hebrew days 15 and 16 are ט״ו and ט״ז', () => {
    assertEqual(hebrewDayLabel('2026-10-26', 'he'), 'ט״ו בחשון', '15 Cheshvan');
    assertEqual(hebrewDayLabel('2026-10-27', 'he'), 'ט״ז בחשון', '16 Cheshvan');
  });

  await check("every day from 1 Tishrei 5786 to 29 Elul 5788 matches hebcal's own calendar", () => {
    let hd = new HDate(1, 7, 5786);
    let days = 0;
    while (hd.getFullYear() <= 5788) {
      const key = keyOf(hd);
      const want = `${hd.getDate()} ${hd.getMonthName()} ${hd.getFullYear()}`;
      const got = hebrewFullDate(key, 'en');
      assert(got === want, `${key}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      hd = hd.next();
      days++;
    }
    assert(days === 354 + 385 + 355, `walked ${days} days, want 1094 (5786: 354, 5787: 385, 5788: 355)`);
  });

  await check('the same labels on five device clocks: a day key is a calendar day, never an instant', () => {
    const keys = ['2026-10-15', '2026-09-11', '2026-09-12', '2027-03-10', '2026-03-27', '2026-11-01', '2026-09-06'];
    const labelsNow = () =>
      keys.flatMap(k => [hebrewFullDate(k, 'en'), hebrewFullDate(k, 'he'), hebrewFullDate(k, 'ru', RU_GENITIVE)]);
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const reference = labelsNow();
      assertEqual(reference.slice(0, 3), ['4 Cheshvan 5787', 'ד׳ בחשון תשפ״ז', '4 хешвана 5787'], 'reference under UTC');
      // Los Angeles is west of Greenwich (a UTC midnight is the day before there);
      // Kiritimati is UTC+14; Santiago has no 00:00 on 2026-09-06 (DST starts at midnight).
      for (const tz of ['Asia/Jerusalem', 'Pacific/Kiritimati', 'America/Los_Angeles', 'America/Santiago']) {
        process.env.TZ = tz;
        assertEqual(labelsNow(), reference, `labels with the clock in ${tz}`);
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  await check('Russian: the genitive list is read only in Russian; with no list or a broken one, the nominative', () => {
    for (const lang of ['en', 'he']) {
      assertEqual(hebrewDayLabel('2026-10-15', lang, RU_GENITIVE), hebrewDayLabel('2026-10-15', lang), `${lang} label ignores the list`);
      assertEqual(hebrewFullDate('2026-10-15', lang, RU_GENITIVE), hebrewFullDate('2026-10-15', lang), `${lang} full date ignores the list`);
    }
    // The nominative is today's bot wording (claude.ts:46), from @hebcal/locales.
    assertEqual(hebrewDayLabel('2026-10-15', 'ru'), '4 Хешван', 'ru without a list');
    assertEqual(hebrewFullDate('2026-10-15', 'ru'), '4 Хешван 5787', 'ru full date without a list');
    const broken: unknown[] = [RU_GENITIVE.slice(0, 13), RU_GENITIVE.map((s, i) => (i === 1 ? ' ' : s)), 'хешвана', {}, null];
    for (const list of broken) {
      assertEqual(hebrewDayLabel('2026-10-15', 'ru', list as string[]), '4 Хешван', `ru with ${JSON.stringify(list)}`);
    }
  });

  await check("an unknown language gets English; a day key that isn't a real day gets an empty string", () => {
    assertEqual(hebrewDayLabel('2026-10-15', 'de'), '4 Cheshvan', 'de');
    assertEqual(hebrewFullDate('2026-10-15', ''), '4 Cheshvan 5787', 'empty language');
    for (const key of ['', '2026-13-01', '2026-02-30', '2026-00-10', '15/10/2026', '2026-10-15T00:00', '0026-10-15']) {
      assertEqual(hebrewDayLabel(key, 'en'), '', `label of ${JSON.stringify(key)}`);
      assertEqual(hebrewFullDate(key, 'he'), '', `full date of ${JSON.stringify(key)}`);
    }
  });

  await check("messages/ru.json's calendarHome.hebrewMonthGenitive lines up with HEBREW_MONTHS (Task D1)", () => {
    const ru = readJson('messages/ru.json') as { calendarHome?: { hebrewMonthGenitive?: unknown } };
    const list = ru.calendarHome?.hebrewMonthGenitive;
    assert(Array.isArray(list), 'messages/ru.json has no calendarHome.hebrewMonthGenitive array (Task D1 adds it)');
    assert(list.length === 14, `the list has ${list.length} entries, want 14`);
    HEBREW_MONTHS.forEach((name, i) => {
      const entry = list[i];
      assert(typeof entry === 'string' && entry.trim() !== '', `entry ${i} (${name}) is empty`);
      // 'Тишрей' → 'тишре', 'Адар II' → 'адар': every genitive form starts from it.
      const nominative = Locale.lookupTranslation(name, 'ru') ?? '';
      const stem = nominative.split(' ')[0].toLowerCase().replace(/й$/, '');
      assert(stem !== '' && entry.toLowerCase().includes(stem), `entry ${i} is ${JSON.stringify(entry)}, not a form of ${nominative} (${name})`);
    });
    const [adar, adar1, adar2] = [list[5], list[6], list[7]];
    assert(new Set([adar, adar1, adar2]).size === 3, `Adar, Adar I and Adar II must differ: ${JSON.stringify([adar, adar1, adar2])}`);
    assert(/II|втор|бет/i.test(adar2) && !/II|втор|бет/i.test(adar1), `entry 6 must be Adar I and entry 7 Adar II: ${JSON.stringify([adar1, adar2])}`);
    assertEqual(hebrewDayLabel('2026-10-15', 'ru', list), '4 хешвана', 'the header day with the shipped list (R9)');
  });

  await check("one Locale: the Russian that hebrew-date.ts registers is what @hebcal/core sees ('Хешван')", () => {
    assertEqual(Locale.lookupTranslation('Cheshvan', 'ru'), 'Хешван', 'through @hebcal/hdate');
    // @hebcal/core ships ESM only with no require entry, and tsx loads this script as
    // CommonJS: load its ESM build through require, so it shares the require cache
    // (and @hebcal/hdate) with hebrew-date.ts. Nothing here imports @hebcal/locales itself.
    const internals = Module as unknown as { _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string };
    const resolveFilename = internals._resolveFilename;
    internals._resolveFilename = function (request, parent, isMain) {
      if (request === '@hebcal/core') return path.join(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
      return resolveFilename.call(this, request, parent, isMain);
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const core = require('@hebcal/core') as typeof import('@hebcal/core');
      assert(core.Locale === Locale, '@hebcal/core has its own Locale: a second @hebcal/hdate is installed');
      assertEqual(core.Locale.lookupTranslation('Cheshvan', 'ru'), 'Хешван', 'through @hebcal/core');
    } finally {
      internals._resolveFilename = resolveFilename;
    }
  });

  await check('@hebcal/hdate is a direct dependency pinned to ^0.21.1, with one copy in the lock and in node_modules', () => {
    const pkg = readJson('package.json') as { dependencies?: Record<string, string> };
    assertEqual(pkg.dependencies?.['@hebcal/hdate'], '^0.21.1', 'package.json dependencies');
    const lock = readJson('package-lock.json') as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
    assertEqual(lock.packages['']?.dependencies?.['@hebcal/hdate'], '^0.21.1', 'package-lock.json root dependencies');
    const copies = Object.keys(lock.packages).filter(k => k.endsWith('node_modules/@hebcal/hdate'));
    assertEqual(copies, ['node_modules/@hebcal/hdate'], 'package-lock.json @hebcal/hdate entries');
    const locked = lock.packages['node_modules/@hebcal/hdate'].version ?? '';
    assert(/^0\.21\.([1-9]|\d{2,})$/.test(locked), `the lock has @hebcal/hdate ${locked}, want ^0.21.1`);
    const installed = (readJson('node_modules/@hebcal/hdate/package.json') as { version: string }).version;
    assertEqual(installed, locked, 'node_modules/@hebcal/hdate version');
    for (const owner of ['core', 'locales']) {
      const nested = path.join(ROOT, 'node_modules/@hebcal', owner, 'node_modules/@hebcal/hdate');
      assert(!fs.existsSync(nested), `@hebcal/${owner} has its own copy: ${nested}`);
    }
  });

  await check('hebrew-date.ts imports only @hebcal/hdate, @hebcal/locales/ru and the DTO types (no @hebcal/core on the home)', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/lib/calendar-view/hebrew-date.ts'), 'utf8');
    const imports = [...source.matchAll(/^import\s+(type\s+)?(?:[^'"]*?\s+from\s+)?'([^']+)';/gm)].map(m => `${m[1] ? 'type ' : ''}${m[2]}`);
    assertEqual(imports.sort(), ['@hebcal/hdate', '@hebcal/locales/ru', 'type ./types'], 'imports');
    assert(!/require\(|import\(/.test(source), 'no require() or import() in hebrew-date.ts');
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

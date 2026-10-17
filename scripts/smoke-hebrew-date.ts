// Smoke test for the calendar home's Hebrew dates (spec §7.8, Plans D and E):
// src/lib/calendar-view/hebrew-date.ts, on @hebcal/hdate.
//
// The home shows the Hebrew date under its header ("4 Cheshvan 5787") and beside each
// Agenda day ("4 Cheshvan"), in the viewer's language. Hebrew uses gematriya and month
// names without nikud ("ד׳ בחשון תשפ״ז"). English uses the number and hebcal's month
// name. Russian uses the genitive from calendarHome.hebrewMonthGenitive ("4 хешвана",
// Ruling R9). A day key is a calendar day, so its Hebrew date never depends on the
// device's clock, and it is the daytime date (no sunset shift).
//
// The Month (Plan E) adds two things. Each month's header names the first and last
// Hebrew months it touches, with the year on both sides only when it differs ("Elul
// 5786 – Tishrei 5787", "Tishrei – Cheshvan 5787"; Russian in the nominative, R9). Each
// cell shows the Hebrew day ("16", "ט״ז"), with a short month name on Hebrew day 1 and
// on the month's first cell ("1 Chesh.", "א׳ חשון", "1 хешв.", from
// calendarHome.hebrewMonthShort).
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
import {
  HEBREW_MONTHS,
  hebrewCellLabel,
  hebrewCellMonth,
  hebrewDayLabel,
  hebrewFullDate,
  hebrewMonthHeader,
  hebrewMonthRange,
  isHebrewMonthStart,
} from '../src/lib/calendar-view/hebrew-date';

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

/** Short month names for the Month's cells, in HEBREW_MONTHS order, so the checks don't depend on messages/*.json. */
const EN_SHORT = ['Tish.', 'Chesh.', 'Kis.', 'Tev.', "Sh'vat", 'Adar', 'Adar I', 'Adar II', 'Nis.', 'Iyar', 'Siv.', 'Tam.', 'Av', 'Elul'];
const HE_SHORT = ['תשרי', 'חשון', 'כסלו', 'טבת', 'שבט', 'אדר', 'אדר א׳', 'אדר ב׳', 'ניסן', 'אייר', 'סיון', 'תמוז', 'אב', 'אלול'];
const RU_SHORT = ['тишр.', 'хешв.', 'кисл.', 'тев.', 'шват', 'адар', 'адар I', 'адар II', 'нис.', 'ияр', 'сив.', 'там.', 'ав', 'элул'];

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

  await check('Month headers (Plan E): the first and last Hebrew months a month touches, the year on both sides only when it differs; he gematriya, ru nominative (R9)', () => {
    // [month, en, he, ru]
    const rows: Row[] = [
      ['2026-09', 'Elul 5786 – Tishrei 5787', 'אלול תשפ״ו – תשרי תשפ״ז', 'Элул 5786 – Тишрей 5787'],
      ['2026-10', 'Tishrei – Cheshvan 5787', 'תשרי – חשון תשפ״ז', 'Тишрей – Хешван 5787'],
      // July 2030 runs from 30 Sivan through all of Tamuz to 1 Av: the middle month is skipped.
      ['2030-07', 'Sivan – Av 5790', 'סיון – אב תש״צ', 'Сиван – Ав 5790'],
      ['2027-11', 'Cheshvan 5788', 'חשון תשפ״ח', 'Хешван 5788'],
      ['2025-02', "Sh'vat 5785", 'שבט תשפ״ה', 'Шват 5785'],
      // 5787 is a leap year: Adar I, then Adar II.
      ['2027-02', "Sh'vat – Adar I 5787", 'שבט – אדר א׳ תשפ״ז', 'Шват – Адар I 5787'],
      ['2027-03', 'Adar I – Adar II 5787', 'אדר א׳ – אדר ב׳ תשפ״ז', 'Адар I – Адар II 5787'],
    ];
    for (const [month, en, he, ru] of rows) {
      assertEqual(hebrewMonthHeader(month, 'en'), en, `${month} en`);
      assertEqual(hebrewMonthHeader(month, 'he'), he, `${month} he`);
      assertEqual(hebrewMonthHeader(month, 'ru'), ru, `${month} ru`);
    }
    assertEqual(
      ['2030-07-01', '2030-07-15', '2030-07-31'].map(k => hebrewFullDate(k, 'en')),
      ['30 Sivan 5790', '14 Tamuz 5790', '1 Av 5790'],
      'fixture: July 2030 touches three Hebrew months'
    );
  });

  await check("hebrewMonthRange on any run of days; '' for a bad key or a backwards run; an unknown language reads English", () => {
    assertEqual(hebrewMonthRange('2026-10-15', '2026-10-15', 'en'), 'Cheshvan 5787', 'one day');
    assertEqual(hebrewMonthRange('2026-09-11', '2026-09-12', 'en'), 'Elul 5786 – Tishrei 5787', 'across the Tishrei year boundary');
    assertEqual(hebrewMonthRange('2026-09-12', '2026-10-12', 'he'), 'תשרי – חשון תשפ״ז', '1 Tishrei to 1 Cheshvan');
    assertEqual(hebrewMonthRange('2026-10-01', '2026-10-31', 'de'), 'Tishrei – Cheshvan 5787', 'de');
    const bad: [string, string][] = [
      ['2026-10-15', '2026-10-14'],
      ['', '2026-10-31'],
      ['2026-10-01', '2026-02-30'],
      ['2026-10-01', '2026-10'],
    ];
    for (const [a, b] of bad) assertEqual(hebrewMonthRange(a, b, 'en'), '', `hebrewMonthRange(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    for (const month of ['2026-13', '2026-00', '2026-1', '', '2026-10-01']) {
      assertEqual(hebrewMonthHeader(month, 'he'), '', `hebrewMonthHeader(${JSON.stringify(month)})`);
    }
  });

  await check("every month from 2025-01 to 2030-12 against hebcal's own calendar, three-month ones included", () => {
    let three = 0;
    for (let y = 2025; y <= 2030; y++) {
      for (let m = 1; m <= 12; m++) {
        const month = `${y}-${String(m).padStart(2, '0')}`;
        const days = new Date(y, m, 0, 12).getDate();
        const touched: HDate[] = [];
        for (let d = 1; d <= days; d++) {
          const hd = new HDate(new Date(y, m - 1, d, 12));
          const prev = touched[touched.length - 1];
          if (!prev || prev.getMonth() !== hd.getMonth() || prev.getFullYear() !== hd.getFullYear()) touched.push(hd);
        }
        if (touched.length === 3) three++;
        const a = touched[0];
        const b = touched[touched.length - 1];
        const want =
          touched.length === 1
            ? `${a.getMonthName()} ${a.getFullYear()}`
            : a.getFullYear() !== b.getFullYear()
              ? `${a.getMonthName()} ${a.getFullYear()} – ${b.getMonthName()} ${b.getFullYear()}`
              : `${a.getMonthName()} – ${b.getMonthName()} ${b.getFullYear()}`;
        assertEqual(hebrewMonthHeader(month, 'en'), want, month);
      }
    }
    assert(three > 0, 'fixture: no month from 2025 to 2030 touches three Hebrew months');
  });

  await check('isHebrewMonthStart is Hebrew day 1, on every day from 1 Tishrei 5786 to 29 Elul 5788', () => {
    assertEqual(
      ['2026-10-12', '2026-10-11', '2026-09-12', '2027-02-08', '2027-03-10', '2026-10-15'].map(isHebrewMonthStart),
      [true, false, true, true, true, false],
      '1 Cheshvan, 30 Tishrei, 1 Tishrei, 1 Adar I, 1 Adar II, 4 Cheshvan'
    );
    let hd = new HDate(1, 7, 5786);
    while (hd.getFullYear() <= 5788) {
      const key = keyOf(hd);
      assert(isHebrewMonthStart(key) === (hd.getDate() === 1), `${key} (${hd.toString()})`);
      hd = hd.next();
    }
    for (const bad of ['', '2026-13-01', '2026-02-30']) assertEqual(isHebrewMonthStart(bad), false, `isHebrewMonthStart(${JSON.stringify(bad)})`);
  });

  await check("hebrewCellLabel without the month: the day alone, '16' / 'ט״ז' / '16' (and ט״ו for 15)", () => {
    // [day key, en and ru, he]
    const rows: [string, string, string][] = [
      ['2026-10-27', '16', 'ט״ז'],
      ['2026-10-26', '15', 'ט״ו'],
      ['2026-10-12', '1', 'א׳'],
      ['2026-10-15', '4', 'ד׳'],
      ['2026-11-10', '30', 'ל׳'],
    ];
    for (const [key, digits, he] of rows) {
      assertEqual(hebrewCellLabel(key, 'en', false, EN_SHORT), digits, `${key} en`);
      assertEqual(hebrewCellLabel(key, 'he', false, HE_SHORT), he, `${key} he`);
      assertEqual(hebrewCellLabel(key, 'ru', false, RU_SHORT), digits, `${key} ru`);
      assertEqual(hebrewCellLabel(key, 'he', false), he, `${key} he without a list`);
    }
  });

  await check("hebrewCellLabel with the month, and hebrewCellMonth alone, read the short list ('1 Chesh.' / 'א׳ חשון' / '1 хешв.'); a missing or broken list falls back to hebrewDayLabel's month names", () => {
    const rows: Row[] = [
      ['2026-10-12', '1 Chesh.', 'א׳ חשון', '1 хешв.'],
      ['2026-09-12', '1 Tish.', 'א׳ תשרי', '1 тишр.'],
      ['2027-02-08', '1 Adar I', 'א׳ אדר א׳', '1 адар I'],
      ['2027-03-10', '1 Adar II', 'א׳ אדר ב׳', '1 адар II'],
      ['2026-02-18', '1 Adar', 'א׳ אדר', '1 адар'],
      // A month's first cell names the month too (Ruling 3), whatever its Hebrew day.
      ['2026-10-01', '20 Tish.', 'כ׳ תשרי', '20 тишр.'],
    ];
    for (const [key, en, he, ru] of rows) {
      assertEqual(hebrewCellLabel(key, 'en', true, EN_SHORT), en, `${key} en`);
      assertEqual(hebrewCellLabel(key, 'he', true, HE_SHORT), he, `${key} he`);
      assertEqual(hebrewCellLabel(key, 'ru', true, RU_SHORT), ru, `${key} ru`);
      // Ruling 3's browse cell: the day number on the head line, the month alone on the second.
      const lists: [string, string[]][] = [['en', EN_SHORT], ['he', HE_SHORT], ['ru', RU_SHORT]];
      for (const [lang, list] of lists) {
        assertEqual(`${hebrewCellLabel(key, lang, false, list)} ${hebrewCellMonth(key, lang, list)}`, hebrewCellLabel(key, lang, true, list), `${key} ${lang}: the day, then hebrewCellMonth`);
      }
    }
    assertEqual(['en', 'he', 'ru'].map((l, i) => hebrewCellMonth('2026-10-12', l, [EN_SHORT, HE_SHORT, RU_SHORT][i])), ['Chesh.', 'חשון', 'хешв.'], 'hebrewCellMonth on 1 Cheshvan');
    // The fallback is the month as hebrewDayLabel names it without a genitive list: hebcal's
    // English name, the Hebrew without nikud (and without "ב"), the Russian nominative.
    const broken: unknown[] = [
      undefined,
      RU_SHORT.slice(0, 13),
      RU_SHORT.map((s, i) => (i === 1 ? ' ' : s)),
      RU_SHORT.map((s, i) => (i === 1 ? 7 : s)),
      'хешв.',
      {},
      null,
    ];
    for (const list of broken) {
      const l = list as string[] | undefined;
      assertEqual(hebrewCellLabel('2026-10-12', 'en', true, l), '1 Cheshvan', `en with ${JSON.stringify(list)}`);
      assertEqual(hebrewCellLabel('2026-10-12', 'he', true, l), 'א׳ חשון', `he with ${JSON.stringify(list)}`);
      assertEqual(hebrewCellLabel('2026-10-12', 'ru', true, l), '1 Хешван', `ru with ${JSON.stringify(list)}`);
      assertEqual(['en', 'he', 'ru'].map(lang => hebrewCellMonth('2026-10-12', lang, l)), ['Cheshvan', 'חשון', 'Хешван'], `hebrewCellMonth with ${JSON.stringify(list)}`);
    }
    assertEqual(hebrewCellLabel('2026-10-12', 'ru', true), hebrewDayLabel('2026-10-12', 'ru'), "ru's fallback is hebrewDayLabel's month");
    assertEqual(hebrewCellLabel('2026-10-12', 'de', true, EN_SHORT), '1 Chesh.', 'an unknown language reads English');
    for (const bad of ['', '2026-13-01', '2026-02-30', '0026-10-15']) {
      assertEqual(hebrewCellLabel(bad, 'he', true, HE_SHORT), '', `hebrewCellLabel(${JSON.stringify(bad)}) with the month`);
      assertEqual(hebrewCellLabel(bad, 'en', false), '', `hebrewCellLabel(${JSON.stringify(bad)}) without it`);
      assertEqual(hebrewCellMonth(bad, 'ru', RU_SHORT), '', `hebrewCellMonth(${JSON.stringify(bad)})`);
    }
  });

  await check("the Month's headers and cell labels on five device clocks", () => {
    const months = ['2026-09', '2026-10', '2030-07', '2027-02', '2027-03', '2026-04'];
    // Santiago changes at midnight on 2026-04-05 and 2026-09-06; Jerusalem on 2026-10-25.
    const keys = ['2026-10-12', '2026-10-27', '2026-09-06', '2026-04-05', '2026-10-25', '2026-10-01'];
    const labelsNow = () =>
      JSON.stringify([
        months.flatMap(m => ['en', 'he', 'ru'].map(l => hebrewMonthHeader(m, l))),
        keys.flatMap(k => [
          hebrewCellLabel(k, 'en', true, EN_SHORT),
          hebrewCellLabel(k, 'he', false),
          hebrewCellLabel(k, 'ru', true, RU_SHORT),
          hebrewCellMonth(k, 'he', HE_SHORT),
          isHebrewMonthStart(k),
        ]),
      ]);
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const reference = labelsNow();
      assert(reference.startsWith('[["Elul 5786 – Tishrei 5787","אלול תשפ״ו – תשרי תשפ״ז"'), `reference under UTC: ${reference.slice(0, 80)}`);
      for (const tz of ['Asia/Jerusalem', 'Pacific/Kiritimati', 'America/Los_Angeles', 'America/Santiago']) {
        process.env.TZ = tz;
        assertEqual(labelsNow(), reference, `with the clock in ${tz}`);
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  await check("messages' calendarHome.hebrewMonthShort lines up with HEBREW_MONTHS in en, he and ru (Task E1)", () => {
    for (const lang of ['en', 'he', 'ru']) {
      const messages = readJson(`messages/${lang}.json`) as { calendarHome?: { hebrewMonthShort?: unknown } };
      const list = messages.calendarHome?.hebrewMonthShort;
      assert(Array.isArray(list), `messages/${lang}.json has no calendarHome.hebrewMonthShort array (Task E1 adds it)`);
      assert(list.length === 14, `${lang}: the list has ${list.length} entries, want 14`);
      HEBREW_MONTHS.forEach((name, i) => {
        const entry = list[i];
        assert(typeof entry === 'string' && entry.trim() !== '', `${lang} entry ${i} (${name}) is empty`);
        const full = lang === 'en' ? name : (Locale.lookupTranslation(name, lang === 'he' ? 'he-x-NoNikud' : 'ru') ?? '');
        // A short form starts as the name does: "Chesh." / "חשון" / "хешв." for Cheshvan.
        assert(
          full !== '' && entry.charAt(0).toLowerCase() === full.charAt(0).toLowerCase(),
          `${lang} entry ${i} is ${JSON.stringify(entry)}, not a short form of ${full} (${name})`
        );
      });
      assert(new Set(list.slice(5, 8)).size === 3, `${lang}: Adar, Adar I and Adar II must differ: ${JSON.stringify(list.slice(5, 8))}`);
      if (lang === 'he') assert(!list.some(e => /[֑-ׇ]/.test(String(e))), 'he: no nikud in the short names');
      // Read as it is, never the fallback.
      const day = lang === 'he' ? 'א׳' : '1';
      assertEqual(hebrewCellLabel('2026-10-12', lang, true, list as string[]), `${day} ${list[1]}`, `${lang}: 1 Cheshvan with the shipped list`);
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

  await check("hebrew-date.ts imports only @hebcal/hdate, @hebcal/locales/ru, the Month's grid and the DTO types (no @hebcal/core on the home)", () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/lib/calendar-view/hebrew-date.ts'), 'utf8');
    const imports = [...source.matchAll(/^import\s+(type\s+)?(?:[^'"]*?\s+from\s+)?'([^']+)';/gm)].map(m => `${m[1] ? 'type ' : ''}${m[2]}`);
    // grid.ts imports only the DTO types (smoke-calendar-grid.ts checks it), so this pulls in nothing else.
    assertEqual(imports.sort(), ['./grid', '@hebcal/hdate', '@hebcal/locales/ru', 'type ./types'], 'imports');
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

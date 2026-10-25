// Smoke test for the home header's "Chanukah in 12 days" (nextHoliday in src/services/hebrew-holidays.ts
// and GET /api/calendar/holidays?next=yyyy-MM-dd[&lang=]).
//
// The next day after a given day with a holiday worth counting down to: every yom tov, Chanukah, Purim,
// Tu BiShvat, Lag BaOmer, Tu B'Av and the four national days; never a fast, an eve, a chol hamoed day,
// Rosh Chodesh or the other minor days (Pesach Sheni, Purim Katan, Leil Selichot, Shushan Purim...).
// The name is the holiday's base name in the language, the words of the holiday line.
//
// Pure: no database, Redis, network or env. Run under three clocks (the day keys never depend on TZ):
//   TZ=UTC npx tsx scripts/smoke-next-holiday.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-next-holiday.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-next-holiday.ts

import path from 'path';
import Module from 'module';

const ROOT = path.resolve(__dirname, '..');

// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-hebrew-holidays.ts), so point
// it at its ESM build before the module under test is loaded.
const ModuleInternals = Module as unknown as {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.resolve(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};

type Next = { day: string; name: string } | null;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { nextHoliday } = require('../src/services/hebrew-holidays') as {
  nextHoliday: (after: string, lang: string, maxDays?: number) => Next;
};

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

function assertEqual<T>(got: T, want: T, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

/** GET /api/calendar/holidays with this query, through the real route. */
async function ask(query: string): Promise<{ status: number; body: Record<string, unknown>; cache: string | null }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require('next/server') as typeof import('next/server');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GET } = require('../app/api/calendar/holidays/route') as { GET: (req: import('next/server').NextRequest) => Promise<Response> };
  const res = await GET(new NextRequest(`http://localhost/api/calendar/holidays${query}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, cache: res.headers.get('Cache-Control') };
}

async function main() {
  await check('Chanukah 2026 (5 Dec): from 12 days out and from the day before, in en, he and ru', () => {
    assertEqual(nextHoliday('2026-11-22', 'en'), { day: '2026-12-05', name: 'Chanukah' }, 'en');
    assertEqual(nextHoliday('2026-12-04', 'en'), { day: '2026-12-05', name: 'Chanukah' }, 'the day before');
    assertEqual(nextHoliday('2026-11-22', 'he'), { day: '2026-12-05', name: 'חנוכה' }, 'he');
    assertEqual(nextHoliday('2026-11-22', 'ru'), { day: '2026-12-05', name: 'Ханука' }, 'ru');
  });

  await check('strictly after: the holiday\'s own day gives the next day or holiday', () => {
    assertEqual(nextHoliday('2026-12-05', 'en'), { day: '2026-12-06', name: 'Chanukah' }, 'day 1 to day 2');
    assertEqual(nextHoliday('2026-12-12', 'en'), { day: '2027-01-23', name: 'Tu BiShvat' }, 'after the last day (Rosh Chodesh Tevet and the Tevet fast are skipped)');
  });

  await check('across the Gregorian year end', () => {
    assertEqual(nextHoliday('2026-12-31', 'en'), { day: '2027-01-23', name: 'Tu BiShvat' }, '31 Dec');
  });

  await check('yom tov base names: no number, no year', () => {
    assertEqual(nextHoliday('2027-09-20', 'en'), { day: '2027-10-02', name: 'Rosh Hashana' }, 'Rosh Hashana 5788, en (no year)');
    assertEqual(nextHoliday('2027-09-20', 'he'), { day: '2027-10-02', name: 'ראש השנה' }, 'he');
    assertEqual(nextHoliday('2027-09-20', 'ru'), { day: '2027-10-02', name: 'Рош а-Шана' }, 'ru');
    assertEqual(nextHoliday('2027-04-10', 'en'), { day: '2027-04-22', name: 'Pesach' }, 'Pesach I (Erev Pesach skipped)');
    assertEqual(nextHoliday('2027-04-10', 'ru')?.name, 'Песах', 'Pesach ru');
    assertEqual(nextHoliday('2027-04-10', 'he')?.name, 'פסח', 'Pesach he');
        assertEqual(nextHoliday('2026-09-22', 'en'), { day: '2026-09-26', name: 'Sukkot' }, 'Sukkot after Yom Kippur (the eve is skipped)');
    assertEqual(nextHoliday('2026-09-21', 'en'), { day: '2026-09-26', name: 'Sukkot' }, 'after Yom Kippur');
    assertEqual(nextHoliday('2026-09-13', 'en'), { day: '2026-09-21', name: 'Yom Kippur' }, 'Rosh Hashana II, then the Fast of Gedaliah, Erev Yom Kippur skipped');
    assertEqual(nextHoliday('2026-09-21', 'ru')?.name, 'Суккот', 'Sukkot ru');
    assertEqual(nextHoliday('2026-09-02', 'ru'), { day: '2026-09-12', name: 'Рош а-Шана' }, 'ru (Rosh Hashana 5787 starts on the 12th: Leil Selichot and Erev skipped)');
  });

  await check('Purim, Lag BaOmer, Tu B\'Av and the national days', () => {
    assertEqual(nextHoliday('2027-03-15', 'en'), { day: '2027-03-23', name: 'Purim' }, 'Purim 5787 (Adar II)');
    assertEqual(nextHoliday('2027-05-20', 'en'), { day: '2027-05-25', name: 'Lag BaOmer' }, 'Lag BaOmer');
    assertEqual(nextHoliday('2027-05-20', 'ru')?.name, 'Лаг ба-Омер', 'Lag BaOmer ru');
    assertEqual(nextHoliday('2027-07-20', 'en'), { day: '2027-08-18', name: 'Tu B’Av' }, 'Tu B’Av (the holiday line writes ’)');
    assertEqual(nextHoliday('2027-07-20', 'he')?.name, 'ט״ו באב', 'Tu B’Av he');
    assertEqual(nextHoliday('2027-04-29', 'en'), { day: '2027-05-04', name: 'Yom HaShoah' }, 'a national day (the dates move in some years)');
    assertEqual(nextHoliday('2027-04-29', 'ru')?.name, 'День Катастрофы', 'a national day, ru');
  });

  await check('skipped: fasts, eves, Rosh Chodesh, Pesach Sheni, Purim Katan, Shushan Purim, Leil Selichot, the other Knesset days', () => {
    // Between Sukkot's end and Chanukah only Rosh Chodesh Cheshvan/Kislev, Sigd, Ben-Gurion Day... lie.
    assertEqual(nextHoliday('2026-10-04', 'en'), { day: '2026-12-05', name: 'Chanukah' }, 'from after Shmini Atzeret');
    assertEqual(nextHoliday('2027-01-23', 'en'), { day: '2027-03-23', name: 'Purim' }, 'Purim Katan (14 Adar I), Rosh Chodesh Adar I and II skipped');
    assertEqual(nextHoliday('2027-03-23', 'en'), { day: '2027-04-22', name: 'Pesach' }, 'after Purim: Shushan Purim, Erev Pesach and the Fast of Esther skipped');
    assertEqual(nextHoliday('2027-05-11', 'en'), { day: '2027-05-12', name: "Yom HaAtzma'ut" }, 'the national days follow each other');
    assertEqual(nextHoliday('2027-05-12', 'en'), { day: '2027-05-25', name: 'Lag BaOmer' }, 'Pesach Sheni (14 Iyar) and Rosh Chodesh are skipped');
    assertEqual(nextHoliday('2027-09-01', 'en')?.name, 'Rosh Hashana', 'Leil Selichot and Erev Rosh Hashana are skipped');
  });

  await check('the look-ahead cap: nothing within maxDays gives null; the default is 400 days', () => {
    assertEqual(nextHoliday('2026-10-04', 'en', 5), null, '5 days of a quiet stretch');
    assertEqual(nextHoliday('2026-10-04', 'en', 62)?.day, '2026-12-05', 'exactly in reach');
    assertEqual(nextHoliday('2026-10-04', 'en', 61), null, 'one day short');
  });

  await check('an unknown language reads as English; a bad date gives null', () => {
    assertEqual(nextHoliday('2026-11-22', 'de')?.name, 'Chanukah', 'de');
    assertEqual(nextHoliday('2026-13-45', 'en'), null, 'bad date');
    assertEqual(nextHoliday('nope', 'en'), null, 'bad key');
  });

  await check('the same answer under any clock (the day keys come from hebcal civil dates)', () => {
    assertEqual(nextHoliday('2026-11-22', 'en')?.day, '2026-12-05', `TZ=${process.env.TZ ?? '(unset)'}`);
  });

  await check('GET ?next: valid, cached a day, lang defaults to en', async () => {
    const ok = await ask('?next=2026-11-22&lang=he');
    assertEqual([ok.status, ok.body, ok.cache], [200, { next: { day: '2026-12-05', name: 'חנוכה' } }, 'public, max-age=86400, s-maxage=86400'], 'valid');
    assertEqual((await ask('?next=2026-11-22')).body, { next: { day: '2026-12-05', name: 'Chanukah' } }, 'lang defaults to en');
  });

  await check('GET ?next: a bad date is 400, and next with from or to is 400', async () => {
    for (const q of ['?next=nope', '?next=', '?next=2026-02-30', '?next=2026-11-22&from=2026-11-01&to=2026-11-30', '?next=2026-11-22&to=2026-11-30']) {
      const res = await ask(q);
      assertEqual([res.status, res.body, res.cache], [400, { error: 'invalid', field: 'next' }, 'no-store'], q);
    }
    assertEqual((await ask('?from=2026-11-01&to=2026-11-02')).status, 200, 'the range query still works');
  });

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.reason ? `\n      ${r.reason}` : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed) process.exit(1);
}

void main();

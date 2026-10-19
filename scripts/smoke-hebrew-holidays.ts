// Smoke test for the holidays of a day (docs/superpowers/specs/2026-10-19-hebrew-holidays-design.md):
// src/services/hebrew-holidays.ts, computed in-process on @hebcal/core with the Israel schedule.
//
// One definition of "the holidays of a day" serves the bot's summaries (getHolidaysForDate) and
// the home (holidaysInRange, behind GET /api/calendar/holidays). Every hebcal event that is a
// yom tov, a fast, an eve, a chol hamoed day, a minor or modern holiday or a Rosh Chodesh
// is kept and ranked; everything else (parashot, special Shabbatot, the Omer) is dropped.
// (hebcal writes its English apostrophes as ’.) Hebrew titles are written without nikud and with the year in gematriya.
//
// Pure: no database, Redis, network or env, and nothing is stubbed. Run it under three clocks;
// the day keys must not depend on the server's timezone (they come from hebcal's own civil
// dates, never through ISO or UTC):
//   TZ=UTC npx tsx scripts/smoke-hebrew-holidays.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-hebrew-holidays.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-hebrew-holidays.ts

import fs from 'fs';
import path from 'path';
import Module from 'module';

const ROOT = path.resolve(__dirname, '..');

// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-week-lookahead.ts), so point
// it at its ESM build before the module under test is loaded.
const ModuleInternals = Module as unknown as {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.resolve(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};

type Holiday = { title: string; brief: string; chag: boolean; kind: string };
type Mod = {
  holidaysInRange: (from: string, to: string, lang: string) => Record<string, Holiday[]>;
  getHolidaysForDate: (date: Date, language: string, timezone: string) => Promise<string[]>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { holidaysInRange, getHolidaysForDate } = require('../src/services/hebrew-holidays') as Mod;

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

/** The holidays of one day, in a language. */
function on(day: string, lang: string): Holiday[] {
  return holidaysInRange(day, day, lang)[day] ?? [];
}

const ZONES = ['UTC', 'Asia/Jerusalem', 'Pacific/Kiritimati'];

async function main() {
  await check('Rosh Hashana 5787 (2026-09-12) is a chag, with the year in gematriya in Hebrew', () => {
    const [he] = on('2026-09-12', 'he');
    assertEqual(he.title, 'ראש השנה תשפ״ז', 'he title');
    assertEqual(he.brief, 'ראש השנה תשפ״ז', 'he brief');
    assertEqual(he.kind, 'chag', 'kind');
    assertEqual(he.chag, true, 'chag');
    const [en] = on('2026-09-12', 'en');
    assertEqual(en.title, 'Rosh Hashana 5787', 'en title');
    assertEqual(on('2026-09-12', 'en').length, 1, 'one holiday');
    assert(!/\b5\d{3}\b/.test(he.title + he.brief), 'no Arabic-numeral year in Hebrew');
  });

  await check('Erev Yom Kippur, Yom Kippur (a chag, though also a fast) and Erev Sukkot', () => {
    const [erev] = on('2026-09-20', 'en');
    assertEqual([erev.title, erev.kind, erev.chag], ['Erev Yom Kippur', 'erev', false], 'erev');
    assertEqual(on('2026-09-20', 'he')[0].title, 'ערב יום כפור', 'he erev');
    const [yk] = on('2026-09-21', 'en');
    assertEqual([yk.title, yk.kind, yk.chag], ['Yom Kippur', 'chag', true], 'yk');
    assertEqual(on('2026-09-25', 'en')[0].kind, 'erev', 'erev sukkot');
  });

  await check("Sukkot's Israel days: day 1 a chag, chol hamoed, Hoshana Raba, Shmini Atzeret a chag", () => {
    assertEqual(on('2026-09-26', 'en').map(h => [h.title, h.kind]), [['Sukkot I', 'chag']], 'sukkot I');
    assertEqual(on('2026-09-27', 'en').map(h => h.kind), ['cholHamoed'], 'sukkot II is chol hamoed in Israel');
    assertEqual(on('2026-09-28', 'en').map(h => [h.title, h.kind]), [["Sukkot III (CH’’M)", 'cholHamoed']], 'sukkot III');
    assertEqual(on('2026-10-02', 'en').map(h => h.title), ['Sukkot VII (Hoshana Raba)'], 'hoshana raba');
    assertEqual(on('2026-10-03', 'en').map(h => [h.title, h.kind]), [['Shmini Atzeret', 'chag']], 'shmini atzeret');
    assertEqual(on('2026-10-04', 'en'), [], 'no second day of Shmini Atzeret in Israel');
  });

  await check('a Hanukkah day that is also Rosh Chodesh Tevet gives both, the minor holiday before Rosh Chodesh', () => {
    const day = on('2026-12-11', 'en');
    assertEqual(day.map(h => [h.title, h.kind]), [['Chanukah: 8 Candles', 'minor'], ['Rosh Chodesh Tevet', 'roshChodesh']], '11 Dec');
    // 10 Dec: Chag HaBanot and Hanukkah (both minor, hebcal order) before Rosh Chodesh Tevet's first day.
    assertEqual(on('2026-12-10', 'en').map(h => h.kind), ['minor', 'minor', 'roshChodesh'], '10 Dec kinds');
    assertEqual(on('2026-12-11', 'he')[1].title, 'ראש חודש טבת', 'he rosh chodesh');
  });

  await check('5787 is a leap year: Rosh Chodesh Adar I and Adar II, Purim in Adar II (not Purim Katan)', () => {
    assertEqual(on('2027-02-08', 'en').map(h => h.title), ['Rosh Chodesh Adar I'], 'adar I');
    assertEqual(on('2027-03-09', 'en').map(h => h.title), ['Rosh Chodesh Adar II'], 'adar II');
    assertEqual(on('2027-03-09', 'he').map(h => h.title), ['ראש חודש אדר ב׳'], 'adar II he');
    assertEqual(on('2027-03-22', 'en').map(h => [h.title, h.kind]), [['Ta’anit Esther', 'fast'], ['Erev Purim', 'erev']], 'Ta’anit Esther before Erev Purim');
    assertEqual(on('2027-03-23', 'en').map(h => [h.title, h.kind]), [['Purim', 'minor']], 'purim');
    assertEqual(on('2027-03-24', 'en').map(h => h.title), ['Shushan Purim'], 'shushan purim');
  });

  await check("Yom HaZikaron and Yom HaAtzma'ut are modern holidays", () => {
    assertEqual(on('2027-05-11', 'en').map(h => [h.title, h.kind]), [['Yom HaZikaron', 'modern']], 'zikaron');
    assertEqual(on('2027-05-12', 'en').map(h => [h.title, h.kind]), [['Yom HaAtzma’ut', 'modern']], 'atzma’ut');
    assertEqual(on('2027-05-12', 'he').map(h => h.title), ['יום העצמאות'], 'atzma ut he');
  });

  await check("Tish'a B'Av is a fast; a plain day, a Shabbat and a special Shabbat have none", () => {
    assertEqual(on('2027-08-12', 'en').map(h => [h.title, h.kind, h.chag]), [['Tish’a B’Av', 'fast', false]], 'tish’a b’av');
    assertEqual(on('2026-09-16', 'en'), [], 'plain Wednesday');
    assertEqual(on('2026-10-10', 'en'), [], 'a Shabbat with a parasha has no holiday');
    assertEqual(on('2026-09-19', 'en'), [], 'Shabbat Shuva is dropped');
  });

  await check('ru differs from en and from hebcal-less fallbacks; any other language reads as en', () => {
    const ru = on('2026-09-21', 'ru')[0];
    const en = on('2026-09-21', 'en')[0];
    assert(ru.title !== en.title && /[а-яё]/i.test(ru.title), `ru title is Russian: ${ru.title}`);
    assertEqual(on('2026-09-21', 'fr'), on('2026-09-21', 'en'), 'fr reads as en');
    assertEqual(on('2026-09-21', ''), on('2026-09-21', 'en'), 'empty reads as en');
  });

  await check('a range returns only days with holidays, inside the range, with sorted keys', () => {
    const days = holidaysInRange('2026-09-18', '2026-09-22', 'en');
    assertEqual(Object.keys(days), ['2026-09-20', '2026-09-21'], 'keys');
    assertEqual(holidaysInRange('2026-09-22', '2026-09-18', 'en'), {}, 'reversed range is empty');
    const year = holidaysInRange('2026-09-12', '2027-09-11', 'en');
    const keys = Object.keys(year);
    assert(keys.every(k => k >= '2026-09-12' && k <= '2027-09-11'), 'all keys inside the range');
    assertEqual([...keys].sort(), keys, 'keys ascend');
    // Every holiday of the year has a title and a brief and a valid kind.
    const kinds = new Set(['chag', 'fast', 'erev', 'cholHamoed', 'minor', 'modern', 'roshChodesh']);
    for (const list of Object.values(year)) for (const h of list) {
      assert(h.title.length > 0 && h.brief.length > 0 && kinds.has(h.kind) && h.chag === (h.kind === 'chag'), `shape: ${JSON.stringify(h)}`);
    }
  });

  await check('the day keys are the same under UTC, Asia/Jerusalem and Pacific/Kiritimati', () => {
    const original = process.env.TZ;
    try {
      const snapshots = ZONES.map(zone => {
        process.env.TZ = zone;
        assertEqual(new Date(2026, 8, 12, 12).getTimezoneOffset(), { 'UTC': 0, 'Asia/Jerusalem': -180, 'Pacific/Kiritimati': -840 }[zone], `${zone} offset applied`);
        return JSON.stringify(['he', 'en', 'ru'].map(lang => holidaysInRange('2026-09-01', '2027-09-30', lang)));
      });
      assertEqual(snapshots[1] === snapshots[0], true, 'Jerusalem = UTC');
      assertEqual(snapshots[2] === snapshots[0], true, 'Kiritimati = UTC');
      process.env.TZ = 'Pacific/Kiritimati';
      assertEqual(Object.keys(holidaysInRange('2026-09-12', '2026-09-12', 'en')), ['2026-09-12'], 'Rosh Hashana on its own day in Kiritimati');
      process.env.TZ = 'Pacific/Pago_Pago';
      assertEqual(Object.keys(holidaysInRange('2026-09-12', '2026-09-12', 'en')), ['2026-09-12'], 'and in Pago Pago');
    } finally {
      if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    }
  });

  await check("getHolidaysForDate reads the user's local day: 22:30Z on the 11th is the 12th in Jerusalem", async () => {
    const at = new Date('2026-09-11T22:30:00Z');
    assertEqual(await getHolidaysForDate(at, 'he', 'Asia/Jerusalem'), ['ראש השנה תשפ״ז'], 'Jerusalem is already the 12th');
    // New York is still the 11th (evening): that is Erev Rosh Hashana.
    assertEqual(await getHolidaysForDate(at, 'en', 'America/New_York'), ['Erev Rosh Hashana'], 'New York is the 11th');
    assertEqual(await getHolidaysForDate(new Date('2026-09-16T10:00:00Z'), 'en', 'Asia/Jerusalem'), [], 'a plain day');
    assertEqual(await getHolidaysForDate(new Date('2026-12-11T10:00:00Z'), 'en', 'Asia/Jerusalem'), ['Chanukah: 8 Candles', 'Rosh Chodesh Tevet'], 'two titles');
  });

  await check('the module is pure: no CalBrew, no Redis, no network, no timeout, no empty catch', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/services/hebrew-holidays.ts'), 'utf8');
    for (const banned of [/calbrew/i, /redis/i, /fetch\(/, /AbortSignal/, /process\.env/, /catch\s*(\([^)]*\))?\s*\{\s*(\/\*[^*]*\*\/)?\s*\}/, /toISOString/]) {
      assert(!banned.test(source), `hebrew-holidays.ts has ${banned}`);
    }
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

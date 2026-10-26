// Smoke test for the weekly parasha (owner, 2026-10-26): src/services/hebrew-holidays.ts.
//
// The portion and the special Shabbatot (Shuva, Shirah, Shekalim...) are two more kinds of the
// holiday layer, ranked below every holiday (parasha, then specialShabbat), on the Israel schedule,
// named in en/he/ru. They are no holidays: getHolidaysForDate and the countdown (nextHoliday) leave
// them out, and the daily summary gets the week's portion on its own line (weekParashaFor,
// Sunday to Friday; Saturday and a holiday Shabbat give null). The summary prompt's side of it is in
// scripts/smoke-summary-prompt-parity.ts; the calendar home's in scripts/smoke-calendar-home-render.ts.
//
// Pure: no database, Redis, network or env. Run it under three clocks:
//   TZ=UTC npx tsx scripts/smoke-parasha.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-parasha.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-parasha.ts

import path from 'path';
import Module from 'module';

const ROOT = path.resolve(__dirname, '..');

// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-hebrew-holidays.ts).
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
  weekParashaFor: (date: Date, language: string, timezone: string) => string | null;
  nextHoliday: (after: string, lang: string) => { day: string; name: string } | null;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { holidaysInRange, getHolidaysForDate, weekParashaFor, nextHoliday } = require('../src/services/hebrew-holidays') as Mod;

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

const IL = 'Asia/Jerusalem';
const PARASHA = ['parasha', 'specialShabbat'];
const on = (day: string, lang: string): Holiday[] => holidaysInRange(day, day, lang)[day] ?? [];
const portion = (day: string, lang: string): Holiday[] => on(day, lang).filter(h => h.kind === 'parasha');
/** A Date at 10:00 UTC of a day: the same civil day in Israel and in New York. */
const noon = (day: string): Date => new Date(`${day}T10:00:00Z`);
const list = (lang: string, titles: string[]) => new Intl.ListFormat(lang, { style: 'long', type: 'unit' }).format(titles);

async function main() {
  await check('a Saturday has its parasha: title "Parashat X" and brief "X" in en, he and ru (Vayera 2026-10-31)', () => {
    const want = {
      en: ['Parashat Vayera', 'Vayera'],
      he: ['פרשת וירא', 'וירא'],
      ru: ['Глава Ваера', 'Ваера'],
    };
    for (const [lang, [title, brief]] of Object.entries(want)) {
      assertEqual(on('2026-10-31', lang).map(h => [h.title, h.brief, h.chag, h.kind]), [[title, brief, false, 'parasha']], lang);
    }
    // The next Saturdays, in order.
    const next = ['Chayei Sara', 'Toldot', 'Vayetzei', 'Vayishlach', 'Vayeshev'];
    ['2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28', '2026-12-05'].forEach((day, i) => {
      assertEqual(portion(day, 'en').map(h => h.title), [`Parashat ${next[i]}`], day);
    });
    // A weekday has none.
    assertEqual(on('2026-11-03', 'en'), [], 'a Tuesday');
  });

  await check('a doubled week is one portion with both names (Matot-Masei 2026-07-11)', () => {
    assertEqual(on('2026-07-11', 'en').map(h => [h.title, h.brief]), [['Parashat Matot-Masei', 'Matot-Masei']], 'en');
    assertEqual(on('2026-07-11', 'he').map(h => [h.title, h.brief]), [['פרשת מטות-מסעי', 'מטות-מסעי']], 'he');
    assertEqual(on('2026-07-11', 'ru').map(h => [h.title, h.brief]), [['Глава Матот-Масей', 'Матот-Масей']], 'ru');
    assertEqual(portion('2026-03-14', 'ru').map(h => [h.title, h.brief]), [['Глава Ваякгель-Пкудей', 'Ваякгель-Пкудей']], 'ru Vayakhel-Pekudei');
  });

  await check('Russian fixes only the real glitches: Behar and Behar-Bechukotai lose the doubled "Бе-ар", Shabbat Shirah is no longer English', () => {
    assertEqual(on('2026-05-09', 'ru').map(h => [h.title, h.brief]), [['Глава Беар-Бехукотай', 'Беар-Бехукотай']], 'doubled');
    // A year in which Behar stands alone.
    const single = Object.entries(holidaysInRange('2027-05-01', '2027-05-31', 'ru')).flatMap(([day, l]) => l.filter(h => h.kind === 'parasha' && /Беар/.test(h.title)).map(h => [day, h.title, h.brief]));
    assertEqual(single, [['2027-05-22', 'Глава Беар', 'Беар']], 'single Behar');
    assertEqual(on('2027-01-23', 'ru').filter(h => h.kind === 'specialShabbat').map(h => [h.title, h.brief]), [['Шаббат Шира', 'Шаббат Шира']], 'Shirah ru');
    assertEqual(on('2027-01-23', 'en').filter(h => h.kind === 'specialShabbat').map(h => h.title), ['Shabbat Shirah'], 'Shirah en');
    assertEqual(on('2027-01-23', 'he').filter(h => h.kind === 'specialShabbat').map(h => h.title), ['שבת שירה'], 'Shirah he');
    // en keeps hebcal's apostrophe in a brief, as in a title.
    assertEqual(portion('2027-06-19', 'en').map(h => [h.title, h.brief]), [['Parashat Beha’alotcha', 'Beha’alotcha']], 'en apostrophe');
  });

  await check('a Shabbat that is a holiday has no portion (Sukkot 2026-09-26, Pesach 2027-04-24)', () => {
    for (const day of ['2026-09-26', '2027-04-24']) {
      for (const lang of ['en', 'he', 'ru']) assertEqual(on(day, lang).filter(h => h.kind === 'parasha'), [], `${day} ${lang}`);
      assert(on(day, 'en').some(h => h.kind !== 'parasha'), `${day} still has its holiday`);
    }
  });

  await check('the Israel schedule: after Shavuot 2027 the Israeli portion reads (2027-06-12 Nasso)', () => {
    assertEqual(portion('2027-06-12', 'en').map(h => h.title), ['Parashat Nasso'], '06-12');
    assertEqual(portion('2027-06-19', 'en').map(h => h.title), ['Parashat Beha’alotcha'], '06-19');
    assertEqual(portion('2027-06-26', 'en').map(h => h.title), ['Parashat Sh’lach'], '06-26');
  });

  await check('a special Shabbat shows after the portion of its day (Vayakhel + Shekalim 2027-03-06), muted kinds, all nine in en/he/ru', () => {
    for (const lang of ['en', 'he', 'ru']) {
      const day = on('2027-03-06', lang);
      assertEqual(day.map(h => h.kind), ['parasha', 'specialShabbat'], `${lang} kinds`);
      assert(day.every(h => !h.chag), `${lang}: not a chag`);
    }
    assertEqual(on('2027-03-06', 'en').map(h => [h.title, h.brief]), [['Parashat Vayakhel', 'Vayakhel'], ['Shabbat Shekalim', 'Shabbat Shekalim']], 'en');
    assertEqual(on('2027-03-06', 'he').map(h => h.title), ['פרשת ויקהל', 'שבת שקלים'], 'he');
    assertEqual(on('2027-03-06', 'ru').map(h => h.title), ['Глава Ваякгель', 'Шаббат Шкалим'], 'ru');
    const specials = new Set<string>();
    for (const lang of ['en', 'he', 'ru']) {
      const seen = Object.values(holidaysInRange('2026-09-01', '2027-09-30', lang)).flat().filter(h => h.kind === 'specialShabbat');
      assertEqual(seen.length, 9, `${lang}: nine special Shabbatot in 5787`);
      seen.forEach(h => specials.add(`${lang}|${h.title}`));
      if (lang === 'ru') assert(seen.every(h => /[А-Яа-я]/.test(h.title) && !/[A-Za-z]/.test(h.title)), `ru specials are Russian: ${seen.map(h => h.title)}`);
    }
  });

  await check('they rank below every holiday: Shabbat Chanukah and Shabbat Rosh Chodesh', () => {
    assertEqual(on('2026-12-12', 'en').map(h => h.kind), ['minor', 'parasha'], 'Shabbat Chanukah (2026-12-12)');
    // Every Saturday of 5787 that is also a Rosh Chodesh, a fast or a Chanukah day lists the holiday first.
    const days = holidaysInRange('2026-09-01', '2028-09-30', 'en');
    let mixed = 0;
    for (const list of Object.values(days)) {
      const kinds = list.map(h => h.kind);
      const first = kinds.findIndex(k => PARASHA.includes(k));
      if (first < 0 || first === 0) continue;
      mixed++;
      assert(kinds.slice(first).every(k => PARASHA.includes(k)), `a holiday after a portion: ${kinds}`);
      assert(!kinds.slice(0, first).some(k => PARASHA.includes(k)), `order: ${kinds}`);
    }
    assert(mixed >= 5, `only ${mixed} Saturdays mix a holiday with a portion`);
    const rc = Object.entries(days).find(([, l]) => l[0].kind === 'roshChodesh' && l.some(h => h.kind === 'parasha'));
    assert(!!rc, 'a Shabbat Rosh Chodesh exists in the range');
    assertEqual(rc![1].map(h => h.kind).slice(0, 2), ['roshChodesh', 'parasha'], `Rosh Chodesh before the portion (${rc![0]})`);
  });

  await check('the portions are no holidays: getHolidaysForDate leaves them out, and the countdown ignores them', async () => {
    assertEqual(await getHolidaysForDate(noon('2026-10-31'), 'en', IL), [], 'a plain Saturday');
    assertEqual(await getHolidaysForDate(noon('2027-03-06'), 'en', IL), [], 'Vayakhel + Shekalim');
    assertEqual(await getHolidaysForDate(noon('2026-12-12'), 'ru', IL), ['Ханука: 8-й день'], 'Shabbat Chanukah');
    // The countdown from the day before Shekalim and Zachor still names Purim, not a Shabbat.
    assertEqual(nextHoliday('2027-03-05', 'en'), { day: '2027-03-23', name: 'Purim' }, 'next holiday after 2027-03-05');
    assertEqual(nextHoliday('2026-10-30', 'en')?.name, 'Chanukah', 'next holiday after 2026-10-30');
  });

  await check('weekParashaFor: Sunday to Friday name the coming Saturday\'s portion, Saturday gives null', () => {
    // Sunday 25 Oct .. Friday 30 Oct 2026 -> Vayera (31 Oct).
    ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'].forEach(day => {
      assertEqual(weekParashaFor(noon(day), 'en', IL), 'Parashat Vayera', day);
    });
    assertEqual(weekParashaFor(noon('2026-10-31'), 'en', IL), null, 'Saturday');
    assertEqual(weekParashaFor(noon('2026-11-01'), 'he', IL), 'פרשת חיי שרה', 'the next Sunday');
    assertEqual(weekParashaFor(noon('2026-10-28'), 'ru', IL), 'Глава Ваера', 'ru');
    assertEqual(weekParashaFor(noon('2026-10-28'), 'fr', IL), 'Parashat Vayera', 'an unknown language reads as en');
  });

  await check('weekParashaFor: the special Shabbat joins it the way the holiday titles join; a holiday Shabbat week gives null', () => {
    assertEqual(weekParashaFor(noon('2027-03-02'), 'en', IL), list('en', ['Parashat Vayakhel', 'Shabbat Shekalim']), 'en');
    assertEqual(weekParashaFor(noon('2027-03-02'), 'he', IL), list('he', ['פרשת ויקהל', 'שבת שקלים']), 'he');
    assertEqual(weekParashaFor(noon('2027-03-02'), 'ru', IL), list('ru', ['Глава Ваякгель', 'Шаббат Шкалим']), 'ru');
    // Sukkot I falls on Shabbat 2026-09-26; Pesach CH"M on Shabbat 2027-04-24.
    assertEqual(weekParashaFor(noon('2026-09-22'), 'en', IL), null, 'Sukkot week');
    assertEqual(weekParashaFor(noon('2027-04-20'), 'en', IL), null, 'Pesach week');
  });

  await check('weekParashaFor reads the user\'s local day: Friday 22:00 UTC is already Saturday in Israel (null), Sunday 22:00 UTC is Monday there', () => {
    assertEqual(weekParashaFor(new Date('2026-10-30T22:30:00Z'), 'en', IL), null, 'Saturday 00:30 in Israel');
    assertEqual(weekParashaFor(new Date('2026-10-30T22:30:00Z'), 'en', 'America/New_York'), 'Parashat Vayera', 'Friday 18:30 in New York');
    assertEqual(weekParashaFor(new Date('2026-10-25T22:30:00Z'), 'en', IL), 'Parashat Vayera', 'Monday in Israel');
  });

  await check('the range answer carries the new kinds in the shape the client validates (title, brief, chag, kind)', () => {
    const days = holidaysInRange('2026-10-25', '2026-11-08', 'en');
    assertEqual(Object.keys(days), ['2026-10-31', '2026-11-07'], 'only the Saturdays');
    for (const list of Object.values(days)) for (const h of list) {
      assert(typeof h.title === 'string' && typeof h.brief === 'string' && h.chag === false && PARASHA.includes(h.kind), JSON.stringify(h));
    }
  });

  const failed = results.filter(r => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

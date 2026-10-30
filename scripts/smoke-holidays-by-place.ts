// Smoke test for the holidays by place (src/services/hebrew-holidays.ts, the { il } option of holidaysInRange and
// nextHoliday). Spec: docs/superpowers/specs/2026-10-30-public-zmanim-design.md §6.2; plan Task 2.
//
// What it pins:
//   - the default is the Israel schedule, byte for byte what it was before the option (SHA-256 of every day 2026-2030 in
//     en, he and ru, and of nextHoliday for every day of 2026-2027, taken at HEAD ef987cc1), and { il: true } is the same;
//   - { il: false } is the diaspora schedule: the second days of Sukkot 2026, Pesach 2027 and Shavuot 2027 are Yom Tov,
//     Simchat Torah is its own day, chol hamoed starts a day later, the four national days still show, and the summer
//     2027 portions diverge (Shavuot II on Shabbat, then Nasso a week later, through Chukat-Balak);
//   - the names: every holiday of both schedules 2026-2030 reads in Hebrew and Russian, the Russian never "Пэсах" and
//     never a Latin word of hebcal's (roman numerals aside); the two names FamCal writes for the diaspora days
//     (holidays.names.pesachIi, pesachViii) read "Песах" in Russian and mirror hebcal's own wording in en and he.
//
// Pure: no database, Redis, network or env, and nothing is stubbed. The day keys must not depend on the server's zone:
//   TZ=UTC npx tsx scripts/smoke-holidays-by-place.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-holidays-by-place.ts

import crypto from 'node:crypto';
import Module from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

// @hebcal/core is ESM-only and tsx loads src/ as CommonJS, so point it at its ESM build before the module under test loads.
const internals = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const resolveFilename = internals._resolveFilename;
internals._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.resolve(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};

type Holiday = { title: string; brief: string; chag: boolean; kind: string };
type Options = { il?: boolean };
type Mod = {
  holidaysInRange: (from: string, to: string, lang: string, options?: Options) => Record<string, Holiday[]>;
  nextHoliday: (after: string, lang: string, maxDays?: number, options?: Options) => { day: string; name: string } | null;
  holidayNameKey: (desc: string, locale: string) => { id: string; args: Record<string, string> };
};
type HebcalEvent = { getDesc(): string; render(locale: string): string; getDate(): { greg(): Date } };
/* eslint-disable @typescript-eslint/no-require-imports */
const { holidaysInRange, nextHoliday, holidayNameKey } = require('../src/services/hebrew-holidays') as Mod;
const { HebrewCalendar } = require('@hebcal/core') as { HebrewCalendar: { calendar: (options: object) => HebcalEvent[] } };
const messages = { en: require('../messages/en.json'), he: require('../messages/he.json'), ru: require('../messages/ru.json') } as Record<string, { holidays: { names: Record<string, string> } }>;
/* eslint-enable @typescript-eslint/no-require-imports */

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

const ABROAD: Options = { il: false };
const LANGS = ['en', 'he', 'ru'] as const;
const sha = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** [title, kind] of each holiday on a day. */
const on = (day: string, lang: string, options?: Options): Array<[string, string]> => (holidaysInRange(day, day, lang, options)[day] ?? []).map(h => [h.title, h.kind]);
/** The portion's brief on a Saturday, or '' when that Shabbat has none. */
const portion = (day: string, lang: string, options?: Options): string => (holidaysInRange(day, day, lang, options)[day] ?? []).filter(h => h.kind === 'parasha').map(h => h.brief).join();

/** Taken at HEAD ef987cc1 (before the option): holidaysInRange('2026-01-01', '2030-12-31', lang), and nextHoliday(day, lang) for every day of 2026-2027. */
const HEAD_RANGE: Record<string, string> = {
  en: '6fcaa938e22e87c5d5dab2e65aabcbf9d1757dce9bfb5757e224ebb7c17c824e',
  he: '4fbbd7b8bf9db3605be177da8234a51a40f35ce520e718e7346a41ff33ab7066',
  ru: '8d307508a3ed48a68e6f59bcfa4e2bcd54e06cf5b0537171448f4fa7f88ae31f',
};
const HEAD_NEXT: Record<string, string> = {
  en: 'e52eac4a045371ceed7266ec63dbd0ff90d960bb5a4480a88ad1d4f87129417f',
  he: '8b96b36f98dcee69b976e849bdd7a36f7f75a6d0f0f18dc7aa7c980e005d4fd7',
  ru: '4639b9cfa63982c675432cff929470eb7242a2c745dbf0334ce70af428d2d8e2',
};

async function main() {
  await check('the default is the Israel schedule, byte for byte what it was (every day 2026-2030, and the next holiday from every day of 2026-2027, in en, he and ru), and { il: true } is the same', () => {
    for (const lang of LANGS) {
      const range = holidaysInRange('2026-01-01', '2030-12-31', lang);
      assertEqual(sha(range), HEAD_RANGE[lang], `${lang} holidaysInRange`);
      assertEqual(sha(holidaysInRange('2026-01-01', '2030-12-31', lang, { il: true })), HEAD_RANGE[lang], `${lang} { il: true }`);
      const nexts: unknown[] = [];
      for (let t = Date.UTC(2026, 0, 1); t <= Date.UTC(2027, 11, 31); t += 86_400_000) nexts.push(nextHoliday(new Date(t).toISOString().slice(0, 10), lang));
      assertEqual(sha(nexts), HEAD_NEXT[lang], `${lang} nextHoliday`);
    }
  });

  await check('Sukkot 2026 abroad: the second day (Sunday the 27th) is Yom Tov, and chol hamoed starts on the 28th with day III; in Israel the 27th is chol hamoed', () => {
    assertEqual(on('2026-09-26', 'en', ABROAD), [['Sukkot I', 'chag']], 'the first day');
    assertEqual(on('2026-09-27', 'en', ABROAD), [['Sukkot II', 'chag']], 'the second day');
    assertEqual(on('2026-09-27', 'he', ABROAD), [['סוכות ב׳', 'chag']], 'he');
    assertEqual(on('2026-09-27', 'ru', ABROAD), [['Суккот II', 'chag']], 'ru');
    assertEqual(on('2026-09-28', 'en', ABROAD), [['Sukkot III (CH’’M)', 'cholHamoed']], 'chol hamoed');
    assertEqual(on('2026-09-27', 'en'), [['Sukkot II (CH’’M)', 'cholHamoed']], 'Israel');
  });

  await check('Simchat Torah abroad is its own Yom Tov the day after Shemini Atzeret (Sunday 2026-10-04), and it is the next holiday after the Saturday; in Israel the day is plain and the next holiday is Chanukah', () => {
    assertEqual(on('2026-10-03', 'en', ABROAD), [['Shmini Atzeret', 'chag']], 'Shemini Atzeret');
    assertEqual(on('2026-10-04', 'en', ABROAD), [['Simchat Torah', 'chag']], 'en');
    assertEqual(on('2026-10-04', 'he', ABROAD), [['שמחת תורה', 'chag']], 'he');
    assertEqual(on('2026-10-04', 'ru', ABROAD), [['Симхат Тора', 'chag']], 'ru');
    assertEqual(on('2026-10-04', 'en'), [], 'Israel');
    assertEqual(nextHoliday('2026-10-03', 'en', undefined, ABROAD), { day: '2026-10-04', name: 'Simchat Torah' }, 'next abroad');
    assertEqual(nextHoliday('2026-10-03', 'en'), { day: '2026-12-05', name: 'Chanukah' }, 'next in Israel');
  });

  await check('Pesach 2027 abroad: the second day (Friday the 23rd) and the eighth (Thursday the 29th) are Yom Tov, named "Песах" in Russian; in Israel the 23rd is chol hamoed and the 29th is plain', () => {
    assertEqual(on('2027-04-23', 'en', ABROAD), [['Pesach II', 'chag']], 'en II');
    assertEqual(on('2027-04-23', 'he', ABROAD), [['פסח ב׳', 'chag']], 'he II');
    assertEqual(on('2027-04-23', 'ru', ABROAD), [['Песах II', 'chag']], 'ru II');
    assertEqual(on('2027-04-29', 'en', ABROAD), [['Pesach VIII', 'chag']], 'en VIII');
    assertEqual(on('2027-04-29', 'he', ABROAD), [['פסח ח׳', 'chag']], 'he VIII');
    assertEqual(on('2027-04-29', 'ru', ABROAD), [['Песах VIII', 'chag']], 'ru VIII');
    assertEqual(on('2027-04-24', 'en', ABROAD), [['Pesach III (CH’’M)', 'cholHamoed']], 'chol hamoed starts on Shabbat the 24th');
    assertEqual(on('2027-04-23', 'ru'), [['Песах II (холь а-моэд)', 'cholHamoed']], 'Israel: chol hamoed');
    assertEqual(on('2027-04-29', 'en'), [], 'Israel: the eighth day is plain');
    assertEqual(nextHoliday('2027-04-28', 'ru', undefined, ABROAD), { day: '2027-04-29', name: 'Песах' }, 'the countdown\'s base name');
  });

  await check('Shavuot 2027 abroad is two days (Friday the 11th and Shabbat the 12th, which has no portion); in Israel it is one day and Shabbat reads Nasso', () => {
    assertEqual(on('2027-06-11', 'en', ABROAD), [['Shavuot I', 'chag']], 'the first day');
    assertEqual(on('2027-06-12', 'en', ABROAD), [['Shavuot II', 'chag']], 'the second day, no portion');
    assertEqual(on('2027-06-12', 'he', ABROAD), [['שבועות ב׳', 'chag']], 'he');
    assertEqual(on('2027-06-12', 'ru', ABROAD), [['Шавуот II', 'chag']], 'ru');
    assertEqual(on('2027-06-11', 'en'), [['Shavuot', 'chag']], 'Israel');
    assertEqual(on('2027-06-12', 'en'), [['Parashat Nasso', 'parasha']], 'Israel reads Nasso');
  });

  await check('the summer 2027 portions diverge abroad after Shavuot II and meet again with Chukat-Balak on 17 July', () => {
    const saturdays: Array<[string, string, string]> = [
      ['2027-06-12', 'Nasso', ''],
      ['2027-06-19', 'Beha’alotcha', 'Nasso'],
      ['2027-06-26', 'Sh’lach', 'Beha’alotcha'],
      ['2027-07-03', 'Korach', 'Sh’lach'],
      ['2027-07-10', 'Chukat', 'Korach'],
      ['2027-07-17', 'Balak', 'Chukat-Balak'],
      ['2027-07-24', 'Pinchas', 'Pinchas'],
    ];
    for (const [day, israel, abroad] of saturdays) {
      assertEqual(portion(day, 'en'), israel, `${day} Israel`);
      assertEqual(portion(day, 'en', ABROAD), abroad, `${day} abroad`);
    }
    assertEqual(portion('2027-07-17', 'he', ABROAD), 'חוקת-בלק', 'he');
    assertEqual(portion('2027-07-17', 'ru', ABROAD), 'Хукат-Балак', 'ru');
  });

  await check('the four national days show abroad too (spec §2.9), and no other modern day does', () => {
    assertEqual(on('2027-05-04', 'en', ABROAD), [['Yom HaShoah', 'modern']], 'Yom HaShoah');
    assertEqual(on('2027-05-11', 'en', ABROAD), [['Yom HaZikaron', 'modern']], 'Yom HaZikaron');
    assertEqual(on('2027-05-12', 'en', ABROAD), [['Yom HaAtzma’ut', 'modern']], 'Yom HaAtzma\'ut');
    assertEqual(on('2027-06-04', 'en', ABROAD), [['Yom Yerushalayim', 'modern']], 'Yom Yerushalayim');
    const modern = Object.values(holidaysInRange('2026-01-01', '2030-12-31', 'en', ABROAD)).flat().filter(h => h.kind === 'modern').map(h => h.title);
    assertEqual([...new Set(modern)].sort(), ['Yom HaAtzma’ut', 'Yom HaShoah', 'Yom HaZikaron', 'Yom Yerushalayim'], 'only the four');
  });

  await check('every holiday title and brief of both schedules, 2026-2030, reads in Hebrew and Russian: no Latin word of hebcal\'s (roman numerals aside), and no Russian "Пэсах"', () => {
    const left: string[] = [];
    for (const options of [{ il: true }, ABROAD]) {
      for (const lang of ['he', 'ru']) {
        for (const [day, list] of Object.entries(holidaysInRange('2026-01-01', '2030-12-31', lang, options))) {
          for (const h of list) {
            for (const text of [h.title, h.brief]) {
              if (/[A-Za-z]/.test(text.replace(/\b[IVX]+\b/g, '')) || /Пэсах/.test(text)) left.push(`${options.il === false ? 'abroad' : 'Israel'} ${lang} ${day}: ${text}`);
            }
          }
        }
      }
    }
    assertEqual([...new Set(left)], [], 'titles that are not Hebrew or Russian');
  });

  await check('the diaspora days FamCal names (holidays.names.pesachIi, pesachViii) mirror hebcal\'s own wording in en and he, and are the ids the module\'s slug rule gives', () => {
    const wanted = new Map([['Pesach II', 'pesachIi'], ['Pesach VIII', 'pesachViii']]);
    const events = HebrewCalendar.calendar({ start: new Date(2027, 3, 20), end: new Date(2027, 3, 30), il: false }).filter(ev => wanted.has(ev.getDesc()));
    assertEqual(events.map(ev => ev.getDesc()), ['Pesach II', 'Pesach VIII'], 'hebcal has both');
    for (const ev of events) {
      const id = wanted.get(ev.getDesc()) ?? '';
      assertEqual(holidayNameKey(ev.getDesc(), 'en').id, id, `${ev.getDesc()} id`);
      assertEqual(messages.en.holidays.names[id], ev.render('en'), `en.${id}`);
      assertEqual(messages.he.holidays.names[id], ev.render('he-x-NoNikud'), `he.${id}`);
      assert(/^Песах /.test(messages.ru.holidays.names[id] ?? ''), `ru.${id}: ${messages.ru.holidays.names[id]}`);
    }
  });

  await check('the day keys abroad are the same under UTC, Asia/Jerusalem and Pacific/Kiritimati', () => {
    const original = process.env.TZ;
    try {
      const snapshots = ['UTC', 'Asia/Jerusalem', 'Pacific/Kiritimati'].map(zone => {
        process.env.TZ = zone;
        return JSON.stringify(LANGS.map(lang => holidaysInRange('2026-09-01', '2027-09-30', lang, ABROAD)));
      });
      assertEqual(snapshots[1] === snapshots[0] && snapshots[2] === snapshots[0], true, 'the same in every zone');
    } finally {
      if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
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

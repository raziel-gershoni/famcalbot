// Smoke test for the holidays of a day (docs/superpowers/specs/2026-10-19-hebrew-holidays-design.md):
// src/services/hebrew-holidays.ts, computed in-process on @hebcal/core with the Israel schedule.
//
// One definition of "the holidays of a day" serves the bot's summaries (getHolidaysForDate) and
// the home (holidaysInRange, behind GET /api/calendar/holidays). Every hebcal event that is a
// yom tov, a fast, an eve, a chol hamoed day, a minor or modern holiday or a Rosh Chodesh
// is kept and ranked; everything else (parashot, special Shabbatot, the Omer) is dropped.
// (hebcal writes its English apostrophes as ’.) Hebrew titles are written without nikud and with the year in gematriya.
//
// GET /api/calendar/holidays?from&to&lang (app/api/calendar/holidays/route.ts) serves it to the
// home: public data with no user in it, so no auth, at most 100 days a request, a day's cache.
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

type HebcalEvent = { getDesc(): string; getFlags(): number; render(locale: string): string; getDate(): { greg(): Date } };
type Holiday = { title: string; brief: string; chag: boolean; kind: string };
type Mod = {
  holidaysInRange: (from: string, to: string, lang: string) => Record<string, Holiday[]>;
  holidayNameKey: (desc: string, locale: string) => { id: string; args: Record<string, string> };
  getHolidaysForDate: (date: Date, language: string, timezone: string) => Promise<string[]>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { holidaysInRange, getHolidaysForDate, holidayNameKey } = require('../src/services/hebrew-holidays') as Mod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { HebrewCalendar, flags } = require('@hebcal/core') as {
  HebrewCalendar: { calendar: (options: object) => HebcalEvent[] };
  flags: Record<string, number>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { gematriya } = require('@hebcal/hdate') as { gematriya: (n: number) => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const messages = { en: require('../messages/en.json'), he: require('../messages/he.json'), ru: require('../messages/ru.json') } as Record<string, { holidays: { names: Record<string, string> } }>;

/** Hebcal's own events for 5787 (Elul 5786 through Elul 5787), the kinds the module keeps (of the modern days, the four majors). */
function hebcalYear(): HebcalEvent[] {
  const kept = flags.CHAG | flags.MAJOR_FAST | flags.MINOR_FAST | flags.EREV | flags.CHOL_HAMOED | flags.MINOR_HOLIDAY | flags.MODERN_HOLIDAY | flags.ROSH_CHODESH;
  return HebrewCalendar.calendar({ start: new Date(2026, 8, 1), end: new Date(2027, 9, 31), il: true }).filter(ev => (ev.getFlags() & kept) && (!(ev.getFlags() & flags.MODERN_HOLIDAY) || ['Yom HaShoah', 'Yom HaZikaron', "Yom HaAtzma'ut", 'Yom Yerushalayim'].includes(ev.getDesc())));
}

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

/** GET /api/calendar/holidays with this query, through the real route. */
async function ask(query: string): Promise<{ status: number; body: Record<string, unknown>; cache: string | null }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require('next/server') as typeof import('next/server');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GET } = require('../app/api/calendar/holidays/route') as { GET: (req: import('next/server').NextRequest) => Promise<Response> };
  const res = await GET(new NextRequest(`http://localhost/api/calendar/holidays${query}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, cache: res.headers.get('Cache-Control') };
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

  await check('Russian reads the way Russian speakers in Israel say it (holidays.names overrides)', () => {
    const ru = (day: string) => on(day, 'ru').map(h => h.title);
    // The name stays undeclined after Канун (owner, 2026-10-26): «Канун Рош а-Шана», not «Рош а-Шаны».
    assertEqual(ru('2026-09-11'), ['Канун Рош а-Шана'], 'erev rosh hashana');
    assertEqual(ru('2026-09-12'), ['Рош а-Шана 5787'], 'rosh hashana');
    assertEqual(ru('2026-09-13'), ['Рош а-Шана II'], 'rosh hashana II');
    assertEqual(ru('2026-09-20'), ['Канун Йом-Кипура'], 'erev yom kippur');
    assertEqual(ru('2026-09-21'), ['Йом-Кипур'], 'yom kippur');
    assertEqual(ru('2026-09-28'), ['Суккот III (холь а-моэд)'], 'sukkot chol hamoed');
    assertEqual(ru('2026-10-02'), ['Хошана раба'], 'hoshana raba');
    assertEqual(ru('2026-12-11'), ['Ханука: 8-я свеча', 'Рош ходеш Тевет'], 'hanukkah and rosh chodesh');
    assertEqual(ru('2026-12-12'), ['Ханука: 8-й день'], 'hanukkah 8th day');
    assertEqual(ru('2027-04-23'), ['Песах II (холь а-моэд)'], 'pesach chol hamoed');
    assertEqual(ru('2027-03-09'), ['Рош ходеш Адар II'], 'rosh chodesh adar II');
    assertEqual(ru('2026-02-18'), ['Рош ходеш Адар'], 'rosh chodesh adar of a common year');
    assertEqual(ru('2027-08-12'), ['Тиша бе-Ав'], "tish'a b'av");
    assertEqual(ru('2027-05-11'), ['День памяти павших'], 'yom hazikaron: a common noun in lower case');
    assertEqual(ru('2027-05-25'), ['Лаг ба-Омер'], 'lag ba-omer: hyphenated like the other names');
    assertEqual(on('2027-04-23', 'ru')[0].brief, 'Песах II (холь а-моэд)', 'brief mirrors the title');
    assertEqual(on('2026-09-28', 'he').map(h => h.title), ['סוכות ג׳ (חוה״מ)'], 'he chol hamoed letter');
  });

  await check("of hebcal's modern holidays only the four major national days show (owner, 2026-10-21)", () => {
    assertEqual(on('2026-10-21', 'he'), [], 'Rabin Memorial Day 5787 shows nothing');
    const major = ['Yom HaShoah', 'Yom HaZikaron', "Yom HaAtzma'ut", 'Yom Yerushalayim'];
    const seen = new Set<string>();
    // 2024 to 2035 covers the years Yom HaZikaron and Yom HaAtzma'ut are moved off Shabbat.
    for (let year = 2024; year <= 2035; year++) {
      for (const ev of HebrewCalendar.calendar({ year, isHebrewYear: false, il: true })) {
        if (!(ev.getFlags() & flags.MODERN_HOLIDAY)) continue;
        const d = ev.getDate().greg();
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        // A left-out day can share its date with another holiday (Family Day with Rosh Chodesh), so count by name.
        const shown = ['en', 'he', 'ru'].map(lang => on(key, lang).filter(h => h.kind === 'modern').length);
        seen.add(ev.getDesc());
        if (major.includes(ev.getDesc())) {
          assertEqual(shown, [1, 1, 1], `${ev.getDesc()} ${key} shows in en, he, ru`);
          assertEqual(on(key, 'en')[0].kind, 'modern', `${ev.getDesc()} ${key} kind`);
        } else {
          assertEqual(shown, [0, 0, 0], `${ev.getDesc()} ${key} is left out`);
        }
      }
    }
    assertEqual(major.filter(m => !seen.has(m)), [], 'hebcal still names the four majors');
    assert(seen.size > major.length, 'hebcal still lists other modern days, so the test means something');
    assertEqual(on('2027-05-11', 'he').map(h => h.title), ['יום הזכרון'], 'he zikaron');
    assertEqual(on('2027-06-04', 'en').map(h => h.title), ['Yom Yerushalayim'], 'en yerushalayim');
    assertEqual(on('2027-06-04', 'ru').length, 1, 'ru yerushalayim');
  });

  await check('the eight Hanukkah nights read in Russian with a lower-case noun, not hebcal\'s "1 Свеча" / "5 Свечей"', () => {
    const nights = holidaysInRange('2026-12-04', '2026-12-11', 'ru');
    const titles = Object.values(nights).flat().filter(h => h.title.startsWith('Ханука')).map(h => [h.title, h.brief]);
    assertEqual(titles.map(t => t[0]), [1, 2, 3, 4, 5, 6, 7, 8].map(n => `Ханука: ${n}-я свеча`), 'titles');
    assertEqual(titles.map(t => t[1]), titles.map(t => t[0]), 'briefs mirror the titles');
    assert(!titles.some(t => /Свеч/.test(t[0])), 'no capitalised noun');
  });

  await check('no Russian title keeps a Latin word of hebcal (roman numerals aside)', () => {
    const year = holidaysInRange('2026-09-01', '2027-10-31', 'ru');
    const left: string[] = [];
    for (const list of Object.values(year)) for (const h of list) {
      if (/[A-Za-z]/.test(h.title.replace(/\b[IVX]+\b/g, ''))) left.push(h.title);
    }
    assertEqual([...new Set(left)], [], 'Latin titles in ru');
  });

  await check("English and Hebrew overrides mirror hebcal's own wording for the whole year", () => {
    for (const [lang, locale] of [['en', 'en'], ['he', 'he-x-NoNikud']] as const) {
      const days = holidaysInRange('2026-09-01', '2027-10-31', lang);
      const want: Record<string, string[]> = {};
      for (const ev of hebcalYear()) {
        const d = ev.getDate().greg();
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        (want[key] ??= []).push(ev.render(locale).replace(/\b5\d{3}\b/g, y => (lang === 'he' ? gematriya(Number(y)) : y)));
      }
      for (const [key, titles] of Object.entries(want)) {
        assertEqual([...(days[key] ?? []).map(h => h.title)].sort(), [...titles].sort(), `${lang} ${key}`);
      }
      assertEqual(Object.keys(days), Object.keys(want).sort(), `${lang} day keys`);
    }
  });

  await check('every holidays.names entry is used by some holiday of the year, and en, he and ru hold the same ids', () => {
    // The countdown's base names (nextHoliday) read the same table: by the base name's id, or "<id>Base".
    const used = new Set(hebcalYear().flatMap(ev => {
      const base = holidayNameKey((ev as unknown as { basename(): string }).basename(), 'en').id;
      return [holidayNameKey(ev.getDesc(), 'en').id, base, `${base}Base`];
    }));
    const ids = Object.keys(messages.en.holidays.names);
    assertEqual(ids.filter(id => !used.has(id)), [], 'ids no holiday uses');
    assertEqual(Object.keys(messages.he.holidays.names).sort(), [...ids].sort(), 'he ids');
    assertEqual(Object.keys(messages.ru.holidays.names).sort(), [...ids].sort(), 'ru ids');
    for (const lang of ['en', 'he', 'ru']) {
      for (const [id, text] of Object.entries(messages[lang].holidays.names)) {
        assert(!/'/.test(text), `${lang}.${id} has an ASCII apostrophe`);
        const unknown = [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).filter(a => !['year', 'month', 'n'].includes(a));
        assertEqual(unknown, [], `${lang}.${id} arguments`);
      }
    }
  });

  await check('the route answers a month of holidays, with a day of public cache and no auth', async () => {
    const res = await ask('?from=2026-09-01&to=2026-09-30&lang=he');
    assertEqual(res.status, 200, 'status');
    assertEqual(res.cache, 'public, max-age=86400, s-maxage=86400', 'Cache-Control');
    const days = res.body.days as Record<string, Holiday[]>;
    assertEqual(days['2026-09-12'].map(h => h.title), ['ראש השנה תשפ״ז'], 'rosh hashana in he');
    assertEqual(days, holidaysInRange('2026-09-01', '2026-09-30', 'he'), 'the same as the module');
    assertEqual(Object.keys(res.body), ['days'], 'only days');
    const noLang = await ask('?from=2026-09-12&to=2026-09-12');
    assertEqual((noLang.body.days as Record<string, Holiday[]>)['2026-09-12'][0].title, 'Rosh Hashana 5787', 'no lang reads as en');
    const unknown = await ask('?from=2026-09-12&to=2026-09-12&lang=fr');
    assertEqual((unknown.body.days as Record<string, Holiday[]>)['2026-09-12'][0].title, 'Rosh Hashana 5787', 'an unknown lang reads as en');
    const ru = await ask('?from=2026-09-21&to=2026-09-21&lang=ru');
    assertEqual((ru.body.days as Record<string, Holiday[]>)['2026-09-21'][0].title, 'Йом-Кипур', 'ru');
    const empty = await ask('?from=2026-09-16&to=2026-09-16&lang=en');
    assertEqual([empty.status, empty.body], [200, { days: {} }], 'a plain day is an empty map');
  });

  await check('the route takes up to 100 days and answers 400 invalid with the field for anything else', async () => {
    assertEqual((await ask('?from=2026-09-01&to=2026-12-09&lang=en')).status, 200, '100 days');
    const long = await ask('?from=2026-09-01&to=2026-12-10&lang=en');
    assertEqual([long.status, long.body, long.cache], [400, { error: 'invalid', field: 'to' }, 'no-store'], '101 days');
    const bad: [string, string][] = [
      ['', 'from'], ['?to=2026-09-12', 'from'], ['?from=2026-09-12', 'to'],
      ['?from=2026-02-30&to=2026-03-02', 'from'], ['?from=2026-1-05&to=2026-03-02', 'from'],
      ['?from=2026-09-12&to=nope', 'to'], ['?from=2026-09-12&to=2026-13-01', 'to'],
      ['?from=2026-09-13&to=2026-09-12', 'to'],
    ];
    for (const [query, field] of bad) {
      const res = await ask(query);
      assertEqual([res.status, res.body, res.cache], [400, { error: 'invalid', field }, 'no-store'], `query "${query}"`);
    }
  });

  await check('a failure inside hebcal answers 500 { error: "failed" } uncached and is captured (logged to the console and Sentry)', async () => {
    const calendar = HebrewCalendar.calendar;
    const consoleError = console.error;
    const logged: unknown[][] = [];
    HebrewCalendar.calendar = () => { throw new Error('hebcal exploded'); };
    console.error = (...args: unknown[]) => { logged.push(args); };
    let res: Awaited<ReturnType<typeof ask>>;
    try {
      res = await ask('?from=2026-09-12&to=2026-09-12&lang=en');
    } finally {
      HebrewCalendar.calendar = calendar;
      console.error = consoleError;
    }
    assertEqual([res.status, res.body, res.cache], [500, { error: 'failed' }, 'no-store'], '500');
    assertEqual(logged.length, 1, 'one capture');
    assertEqual(logged[0][0], '[calendar-holidays]', 'the capture context');
    assert(logged[0][1] instanceof Error && logged[0][1].message === 'hebcal exploded', 'the error itself is captured');
    // Restored: the route answers again.
    assertEqual((await ask('?from=2026-09-12&to=2026-09-12&lang=en')).status, 200, 'back to 200');
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
    // The summaries' call (src/services/claude.ts), unstubbed: no env, no network, no Redis.
    assertEqual(await getHolidaysForDate(new Date('2026-09-12T09:00:00Z'), 'en', 'Asia/Jerusalem'), ['Rosh Hashana 5787'], 'the summary entry point for 2026-09-12');
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

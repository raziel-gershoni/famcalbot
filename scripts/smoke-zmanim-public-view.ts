// Smoke test for a city's zmanim page as data, src/site/zmanim/city-view.ts (plan 6a Task 5; spec
// 2026-10-30-public-zmanim §4.2, §4.3, §6.1, §6.2).
//
//  - V1 a city's place, its default community, its today in its own zone (summer time too), the public range (and 29 February);
//  - V2 the parameters: a good date and community kept; a repeated, bad, out-of-range or default-equal one dropped;
//  - V3 Jerusalem, Sephardi: the day's list is zmanDayForPlace's for the city's point and height, and the height counts;
//  - V4 a Friday: candle lighting in the day, the coming Shabbat named by its parasha, its rows the day lists' own;
//  - V5 New York, Ashkenazi: Pesach 2027's two days of Yom Tov abroad ("not before" on the first night), against Jerusalem's one;
//  - V6 Rosh Hashana: the second night's candles "not before" the first day's end, then the end of Yom Tov;
//  - V7 London in June: dawn has no time and the view says so (hasDash); Moscow in June: tallit and tefillin too;
//  - V8 Saint Petersburg on a June 2027 Friday: candle lighting, and the Shabbat's end has no time (endMissing);
//  - V9 the range's edges: no previous or next day or month past them; the previous month's link clamped to the range;
//  - V10 the month: Sunday-first weeks, today and the day shown marked, a mark for each holiday (a parasha is none), the
//    list of every holiday, fast and Rosh Chodesh and every Shabbat with its parasha and rows; Israel and abroad differ
//    on 3 and 4 October 2026;
//  - V11 the names follow the page's language;
//  - V12 the bot's process memo is untouched, and a quiet build logs no missing zman (where an unquiet one does);
//  - V13 (review focus a) just after midnight in a far zone (Sydney at 00:30 on 3 November while UTC is still on the 2nd):
//    today, the day shown, its links, the range and the month are the city's;
//  - V14 (review focus b) a summer/winter time change day in the city's zone (New York 2026-11-01, Jerusalem 2026-10-25,
//    Sydney 2026-10-04): the rows in the order of the day, none twice and none an hour off, and the previous and next
//    days neither skip nor repeat a day;
//  - V15 (review focus d) repeated or odd query values are ignored, and nothing throws.
//
// The whole smoke runs twice: first as a child under TZ=UTC (prod's zone, review focus a), then in the zone it was started
// in (ci-smokes.sh: Asia/Jerusalem). Nothing here may read the process's own zone.
//
// Pure: no DB, Redis or network. Run with the fake env (never the real one), from the repo root, as ci-smokes.sh does.

import { execFileSync } from 'node:child_process';
import { assert, check, finish, load, show, type Row } from './lib/site-harness';

if (process.env.TZ !== 'UTC') {
  // A failing run under UTC throws here, so the smoke exits 1 with that run's output above.
  execFileSync(process.execPath, [...process.execArgv, __filename], { env: { ...process.env, TZ: 'UTC' }, stdio: 'inherit' });
}

/** Friday 30 October 2026, 11:00 in Jerusalem. */
const NOW = new Date('2026-10-30T09:00:00Z');
const WINDOW = ['CANDLE_LIGHTING', 'CANDLE_LIGHTING_NOT_BEFORE', 'SHABBAT_ENDS', 'YOM_TOV_ENDS', 'SHABBAT_YOM_TOV_ENDS'];

async function main() {
  const { cityBySlug } = await load('src/site/cities.ts');
  const v = await load('src/site/zmanim/city-view.ts');
  const { zmanDayForPlace } = await load('src/services/zmanim/day-list.ts');
  const { holidaysInRange } = await load('src/services/hebrew-holidays.ts');
  const { ZMAN_KEYS } = await load('src/services/zmanim/sets.ts');
  const { instantToWallTime } = await load('src/utils/wall-time.ts');
  const { addDaysToDate } = await load('src/utils/day-events.ts');

  const city = (slug: string): Row => {
    const found = cityBySlug(slug);
    assert(found, `no city ${slug} in the table`);
    return found;
  };
  const build = (slug: string, search: Row = {}, locale = 'en', now = NOW): Row => {
    const c = city(slug);
    return v.buildCityView(c, v.readCityParams(c, search, now), locale);
  };
  const fresh = (slug: string, community: string, day: string): Row => zmanDayForPlace(v.cityPlace(city(slug)), community, day, { memo: new Map(), quiet: true });
  const windowRows = (slug: string, community: string, day: string) => fresh(slug, community, day).rows.filter((r: Row) => WINDOW.includes(r.key));
  const keysOf = (w: Row) => w.days.map((d: Row) => d.rows.map((r: Row) => r.key));
  const spans = (view: Row) => view.ahead.map((w: Row) => [w.eve, w.last]);
  const row = (view: Row, key: string): Row | undefined => view.list.rows.find((r: Row) => r.key === key);
  const cell = (view: Row, day: string): Row => view.month.weeks.flat().find((c: Row) => c.day === day);
  const entry = (view: Row, day: string): Row | undefined => view.month.entries.find((e: Row) => e.day === day);
  const ok = (view: Row, where: string) => assert(view.failures.length === 0, `${where}: failed sections ${show(view.failures.map((f: Row) => `${f.section}: ${String(f.error)}`))}`);

  await check('V1 a city\'s place, default community, today in its own zone (summer time too) and the public range (29 February too)', () => {
    const jlm = city('jerusalem');
    assert(show(v.cityPlace(jlm)) === show({ latitude: jlm.latitude, longitude: jlm.longitude, elevationM: jlm.elevationM, timeZone: 'Asia/Jerusalem' }), `the place ${show(v.cityPlace(jlm))}`);
    assert(v.defaultCommunity(jlm) === 'sephardi' && v.defaultCommunity(city('new-york')) === 'ashkenazi' && v.defaultCommunity(city('moscow')) === 'ashkenazi', 'the default community');
    const late = new Date('2026-10-30T22:30:00Z');
    assert(v.cityToday(jlm, NOW) === '2026-10-30' && v.cityToday(jlm, late) === '2026-10-31', `Jerusalem's today ${v.cityToday(jlm, late)}`);
    assert(v.cityToday(city('new-york'), late) === '2026-10-30', 'New York is still on the 30th (summer time until 1 November)');
    assert(v.cityToday(city('sydney'), new Date('2026-10-30T14:00:00Z')) === '2026-10-31', 'Sydney is already on the 31st');
    assert(show(v.publicRange(jlm, NOW)) === show({ first: '2025-10-30', last: '2029-10-30' }), `the range ${show(v.publicRange(jlm, NOW))}`);
    assert(show(v.publicRange(jlm, new Date('2028-02-29T10:00:00Z'))) === show({ first: '2027-02-28', last: '2031-02-28' }), 'the range from a 29 February');
  });

  await check('V2 the parameters: a good date and community kept; a repeated, bad, out-of-range or default-equal one dropped', () => {
    const jlm = city('jerusalem');
    const read = (search: Row, c: Row = jlm) => v.readCityParams(c, search, NOW);
    const none = read({});
    assert(none.day === '2026-10-30' && none.today === '2026-10-30' && none.community === 'sephardi' && !none.dayFromParam && !none.communityFromParam, show(none));
    const good = read({ date: '2026-11-03', community: 'chabad' });
    assert(good.day === '2026-11-03' && good.dayFromParam && good.community === 'chabad' && good.communityFromParam, show(good));
    assert(read({ date: ['2026-11-03', '2026-11-04'] }).day === '2026-10-30' && !read({ date: ['2026-11-03', '2026-11-04'] }).dayFromParam, 'a repeated date is not ignored');
    for (const bad of ['2026-13-45', '2026-02-30', 'tomorrow', '', '20261103', '2026-11-3']) {
      const p = read({ date: bad });
      assert(p.day === '2026-10-30' && !p.dayFromParam, `${bad}: ${show(p)}`);
    }
    for (const [date, kept] of [['2025-10-29', false], ['2025-10-30', true], ['2029-10-30', true], ['2029-10-31', false]] as const) {
      const p = read({ date });
      assert(p.dayFromParam === kept && p.day === (kept ? date : '2026-10-30'), `${date}: ${show(p)}`);
    }
    assert(read({ community: 'sephardi' }).community === 'sephardi' && !read({ community: 'sephardi' }).communityFromParam, 'Jerusalem\'s default, named, is dropped');
    assert(read({ community: 'reform' }).community === 'sephardi' && !read({ community: 'reform' }).communityFromParam, 'an unknown community');
    const ny = city('new-york');
    assert(!read({ community: 'ashkenazi' }, ny).communityFromParam && read({ community: 'sephardi' }, ny).community === 'sephardi' && read({ community: 'sephardi' }, ny).communityFromParam, 'New York\'s');
  });

  await check('V3 Jerusalem, Sephardi: the list is zmanDayForPlace\'s for the city\'s point and height; the height counts and is named only for Sephardi in Israel', () => {
    const jlm = city('jerusalem');
    assert(Number.isInteger(jlm.elevationM) && jlm.elevationM > 100, `Jerusalem's height ${jlm.elevationM}`);
    const view = build('jerusalem', { date: '2026-10-28' });
    ok(view, 'Jerusalem');
    assert(view.community === 'sephardi' && view.isDefaultCommunity && view.il && view.heightM === jlm.elevationM && !view.hasDash, show({ community: view.community, heightM: view.heightM, hasDash: view.hasDash }));
    assert(show(view.list) === show(fresh('jerusalem', 'sephardi', '2026-10-28')), 'the list is not zmanDayForPlace\'s');
    const sea = zmanDayForPlace({ ...v.cityPlace(jlm), elevationM: 0 }, 'sephardi', '2026-10-28', { memo: new Map(), quiet: true });
    assert(row(view, 'SHKIA')?.at !== sea.rows.find((r: Row) => r.key === 'SHKIA')?.at, 'the height does not count');
    assert(build('jerusalem', { date: '2026-10-28', community: 'chabad' }).heightM === null && build('jerusalem', { date: '2026-10-28', community: 'ashkenazi' }).heightM === null, 'a height named for a set that does not use it');
    assert(build('london', { date: '2026-10-28', community: 'sephardi' }).heightM === null, 'a height named abroad');
  });

  await check('V4 a Friday: candle lighting in the day; the coming Shabbat named by its parasha, its rows the day lists\' own', () => {
    const view = build('jerusalem');
    ok(view, 'Friday');
    assert(view.isToday && view.day === '2026-10-30' && view.prevDay === '2026-10-29' && view.nextDay === '2026-10-31', show({ day: view.day, prev: view.prevDay, next: view.nextDay }));
    const candle = row(view, 'CANDLE_LIGHTING');
    assert(candle && candle.at, 'no candle lighting on the Friday');
    assert(show(spans(view)) === show([['2026-10-30', '2026-10-31'], ['2026-11-06', '2026-11-07']]), `the windows ${show(spans(view))}`);
    const [shabbat] = view.ahead;
    assert(shabbat.parasha?.title === 'Parashat Vayera' && shabbat.holidays.length === 0 && !shabbat.endMissing, show(shabbat));
    assert(show(keysOf(shabbat)) === show([['CANDLE_LIGHTING'], ['SHABBAT_ENDS']]), show(keysOf(shabbat)));
    for (const d of shabbat.days) assert(show(d.rows) === show(windowRows('jerusalem', 'sephardi', d.day)), `${d.day}: not the day list's window rows`);
    assert(candle.at === shabbat.days[0].rows[0].at, 'the day and the window disagree on the candles');
  });

  await check('V5 New York, Ashkenazi: Pesach 2027\'s two days of Yom Tov abroad, against Jerusalem\'s one', () => {
    const ny = build('new-york', { date: '2027-04-21' });
    ok(ny, 'New York');
    assert(!ny.il && ny.community === 'ashkenazi', 'New York\'s schedule');
    assert(show(spans(ny)) === show([['2027-04-21', '2027-04-24'], ['2027-04-27', '2027-04-29']]), `New York's windows ${show(spans(ny))}`);
    assert(show(keysOf(ny.ahead[0])) === show([['CANDLE_LIGHTING'], ['CANDLE_LIGHTING_NOT_BEFORE'], ['CANDLE_LIGHTING'], ['SHABBAT_ENDS']]), show(keysOf(ny.ahead[0])));
    assert(ny.ahead[0].holidays.length === 2 && ny.ahead[0].holidays.every((h: Row) => h.chag) && ny.ahead[0].parasha === null, show(ny.ahead[0].holidays));
    assert(show(keysOf(ny.ahead[1])) === show([['CANDLE_LIGHTING'], ['CANDLE_LIGHTING_NOT_BEFORE'], ['YOM_TOV_ENDS']]), show(keysOf(ny.ahead[1])));
    for (const w of ny.ahead) for (const d of w.days) assert(show(d.rows) === show(windowRows('new-york', 'ashkenazi', d.day)), `New York ${d.day}: not the day list's rows`);
    const jlm = build('jerusalem', { date: '2027-04-21' });
    ok(jlm, 'Jerusalem at Pesach');
    assert(show(spans(jlm)) === show([['2027-04-21', '2027-04-22'], ['2027-04-23', '2027-04-24'], ['2027-04-27', '2027-04-28']]), `Jerusalem's windows ${show(spans(jlm))}`);
    assert(show(keysOf(jlm.ahead[0])) === show([['CANDLE_LIGHTING'], ['YOM_TOV_ENDS']]), show(keysOf(jlm.ahead[0])));
    assert(show(jlm.ahead[1].holidays.map((h: Row) => h.kind)) === show(['cholHamoed']), 'Shabbat chol hamoed is named by its day');
    assert(cell(ny, '2027-04-23').yomTov && !cell(jlm, '2027-04-23').yomTov, 'the second day is Yom Tov abroad only');
  });

  await check('V6 Rosh Hashana: the second night\'s candles "not before" the first day\'s end, then the end of Yom Tov', () => {
    const view = build('jerusalem', { date: '2026-09-10' });
    ok(view, 'Rosh Hashana');
    const [rh] = view.ahead;
    assert(rh.eve === '2026-09-11' && rh.last === '2026-09-13' && rh.parasha === null, show([rh.eve, rh.last, rh.parasha]));
    assert(show(keysOf(rh)) === show([['CANDLE_LIGHTING'], ['CANDLE_LIGHTING_NOT_BEFORE'], ['YOM_TOV_ENDS']]), show(keysOf(rh)));
    assert(rh.holidays.length === 2 && rh.holidays.every((h: Row) => h.chag), show(rh.holidays));
    const notBefore = rh.days[1].rows[0];
    assert(notBefore.at !== null && notBefore.at === fresh('jerusalem', 'sephardi', '2026-09-12').rows.find((r: Row) => r.key === 'CANDLE_LIGHTING_NOT_BEFORE')?.at, 'the "not before" is not the day list\'s');
  });

  await check('V7 London in June: dawn has no time and the view says so; Moscow in June: tallit and tefillin too', () => {
    const london = build('london', { date: '2027-06-21' });
    ok(london, 'London');
    assert(london.community === 'ashkenazi' && london.hasDash, 'London has no dash');
    assert(row(london, 'ALOT')?.at === null && row(london, 'NETZ')?.at, `London's dawn ${show(row(london, 'ALOT'))}`);
    assert(show(london.list) === show(fresh('london', 'ashkenazi', '2027-06-21')), 'London\'s list is not zmanDayForPlace\'s');
    const moscow = build('moscow', { date: '2027-06-21' });
    ok(moscow, 'Moscow');
    assert(row(moscow, 'MISHEYAKIR')?.at === null && moscow.hasDash, `Moscow's tallit and tefillin ${show(row(moscow, 'MISHEYAKIR'))}`);
    assert(!build('jerusalem', { date: '2027-06-21' }).hasDash, 'Jerusalem in June has a dash');
  });

  await check('V8 Saint Petersburg on a June 2027 Friday: candle lighting, and the Shabbat\'s end has no time', () => {
    const spb = build('saint-petersburg', { date: '2027-06-18' });
    ok(spb, 'Saint Petersburg');
    const candle = row(spb, 'CANDLE_LIGHTING');
    assert(candle && candle.at !== null, 'no candle lighting on the Friday');
    const [shabbat] = spb.ahead;
    assert(shabbat.eve === '2027-06-18' && shabbat.last === '2027-06-19' && shabbat.endMissing, show([shabbat.eve, shabbat.last, shabbat.endMissing]));
    assert(show(keysOf(shabbat)) === show([['CANDLE_LIGHTING'], ['SHABBAT_ENDS']]), show(keysOf(shabbat)));
    assert(shabbat.days[0].rows[0].at === candle.at && shabbat.days[1].rows[0].at === null, show(shabbat.days));
  });

  await check('V9 the range\'s edges: no previous or next day or month past them; the previous month\'s link clamped to the range', () => {
    const first = build('jerusalem', { date: '2025-10-30' });
    assert(first.prevDay === null && first.nextDay === '2025-10-31' && first.month.key === '2025-10' && first.month.prevMonthDay === null && first.month.nextMonthDay === '2025-11-01', show([first.prevDay, first.month]));
    assert(!cell(first, '2025-10-29').inRange && cell(first, '2025-10-30').inRange, 'the cells outside the range');
    assert(build('jerusalem', { date: '2025-11-15' }).month.prevMonthDay === '2025-10-30', 'the previous month is not clamped to the range');
    const last = build('jerusalem', { date: '2029-10-30' });
    assert(last.nextDay === null && last.prevDay === '2029-10-29' && last.month.nextMonthDay === null && last.month.prevMonthDay === '2029-09-01', show([last.nextDay, last.month.prevMonthDay, last.month.nextMonthDay]));
  });

  await check('V10 the month: Sunday-first weeks, today and the day shown, a mark per holiday (none for a parasha), the list of holidays and Shabbatot; Israel and abroad differ on 3 and 4 October 2026', () => {
    const jlm = build('jerusalem', { date: '2026-10-28' });
    const ny = build('new-york', { date: '2026-10-28' });
    for (const [slug, view] of [['jerusalem', jlm], ['moscow', build('moscow', { date: '2026-10-28' })], ['new-york', ny]] as [string, Row][]) {
      ok(view, slug);
      assert(view.month.weekStart === 0 && view.month.weeks.length >= 4 && view.month.weeks.every((w: Row[]) => w.length === 7 && new Date(`${w[0].day}T00:00:00Z`).getUTCDay() === 0), `${slug}: not Sunday-first`);
    }
    const cells = jlm.month.weeks.flat();
    assert(jlm.month.key === '2026-10' && cells.filter((c: Row) => c.inMonth).length === 31, 'October\'s days');
    assert(cells.filter((c: Row) => c.isToday).map((c: Row) => c.day).join() === '2026-10-30' && cells.filter((c: Row) => c.isShown).map((c: Row) => c.day).join() === '2026-10-28', 'today and the day shown');
    assert(cell(jlm, '2026-10-03').yomTov && cell(jlm, '2026-10-11').holidays.some((h: Row) => h.kind === 'roshChodesh') && cell(jlm, '2026-10-31').holidays.length === 0, 'the marks');
    assert(cells.filter((c: Row) => !c.inMonth).every((c: Row) => c.holidays.length === 0), 'a mark outside the month');
    const all = holidaysInRange('2026-10-01', '2026-10-31', 'en', { il: true });
    const want = [...new Set([...Object.keys(all).filter((d) => all[d].some((h: Row) => h.kind !== 'parasha')), '2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31'])].sort();
    assert(show(jlm.month.entries.map((e: Row) => e.day)) === show(want), `the list ${show(jlm.month.entries.map((e: Row) => e.day))}`);
    const sat = entry(jlm, '2026-10-31');
    assert(sat?.shabbat?.parasha?.title === 'Parashat Vayera', show(sat));
    assert(show(sat.shabbat.rows) === show([...windowRows('jerusalem', 'sephardi', '2026-10-30'), ...windowRows('jerusalem', 'sephardi', '2026-10-31')]), 'the Shabbat\'s rows are not the day lists\'');
    const oct3 = (view: Row) => entry(view, '2026-10-03')?.shabbat;
    assert(show(oct3(jlm)?.rows.map((r: Row) => r.key)) === show(['CANDLE_LIGHTING', 'SHABBAT_YOM_TOV_ENDS']) && oct3(jlm)?.parasha === null, `Jerusalem, 3 October ${show(oct3(jlm))}`);
    assert(show(oct3(ny)?.rows.map((r: Row) => r.key)) === show(['CANDLE_LIGHTING', 'CANDLE_LIGHTING_NOT_BEFORE']), `New York, 3 October ${show(oct3(ny))}`);
    assert(entry(ny, '2026-10-04')?.holidays.some((h: Row) => h.chag) && cell(ny, '2026-10-04').yomTov && !cell(jlm, '2026-10-04').yomTov, 'Simchat Torah is Yom Tov abroad only');
  });

  await check('V11 the names follow the page\'s language', () => {
    const he = build('jerusalem', { date: '2026-10-28' }, 'he');
    const ru = build('jerusalem', { date: '2026-10-28' }, 'ru');
    assert(entry(he, '2026-10-31')?.shabbat?.parasha?.title === 'פרשת וירא' && entry(ru, '2026-10-31')?.shabbat?.parasha?.title === 'Глава Ваера', 'the parasha\'s name');
    assert(build('jerusalem', {}, 'ru').ahead[0].parasha?.title === 'Глава Ваера', 'the window\'s name');
  });

  await check('V12 the bot\'s process memo is untouched, and a quiet build logs no missing zman (where an unquiet one does)', () => {
    const shared = globalThis as { __zmanReminderAnswers?: Map<string, number | null> };
    // The bot's path (no memo given) fills the process memo, as the sun sheet does
    zmanDayForPlace(v.cityPlace(city('haifa')), 'sephardi', '2026-10-28');
    const before = show([...(shared.__zmanReminderAnswers ?? new Map()).entries()]);
    assert(before !== '[]', 'the process memo is not on globalThis.__zmanReminderAnswers');
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(' '));
    try {
      build('london', { date: '2027-06-21' });
      build('moscow', { date: '2027-06-21' });
      build('saint-petersburg', { date: '2027-06-18' });
      build('jerusalem', { date: '2026-10-28' });
    } finally {
      console.warn = warn;
    }
    assert(show([...(shared.__zmanReminderAnswers ?? new Map()).entries()]) === before, 'a public view wrote the process memo');
    assert(warned.filter((line) => line.includes('[zmanim]')).length === 0, `a quiet build logged ${show(warned)}`);
    // The same day, asked as the bot asks it, does log: the check above means something
    const loud: string[] = [];
    console.warn = (...args: unknown[]) => void loud.push(args.map(String).join(' '));
    try {
      zmanDayForPlace(v.cityPlace(city('london')), 'ashkenazi', '2027-06-21', { memo: new Map() });
    } finally {
      console.warn = warn;
    }
    assert(loud.some((line) => line.includes('[zmanim]')), 'an unquiet list for London in June logs nothing');
  });

  await check('V13 (review focus a) just after midnight in a far zone, the smoke also running under TZ=UTC: at 2026-11-02T13:30:00Z it is 00:30 on 3 November in Sydney and still the 2nd in UTC, so today, the day shown, its links, the range and the month are Sydney\'s', () => {
    const syd = city('sydney');
    const now = new Date('2026-11-02T13:30:00Z');
    assert(instantToWallTime(now, 'Australia/Sydney').startsWith('2026-11-03T00:30') && instantToWallTime(now, 'UTC').startsWith('2026-11-02'), 'the fixture');
    const p = v.readCityParams(syd, {}, now);
    assert(v.cityToday(syd, now) === '2026-11-03' && p.today === '2026-11-03' && p.day === '2026-11-03' && !p.dayFromParam, show(p));
    assert(show(v.publicRange(syd, now)) === show({ first: '2025-11-03', last: '2029-11-03' }), `the range ${show(v.publicRange(syd, now))}`);
    const view = v.buildCityView(syd, p, 'en');
    ok(view, 'Sydney');
    assert(view.isToday && view.list.day === '2026-11-03' && view.list.tz === 'Australia/Sydney' && view.prevDay === '2026-11-02' && view.nextDay === '2026-11-04', show([view.list.day, view.prevDay, view.nextDay]));
    assert(view.month.key === '2026-11' && view.month.weeks.flat().filter((c: Row) => c.isToday).map((c: Row) => c.day).join() === '2026-11-03', 'today\'s cell');
    assert(!v.buildCityView(syd, v.readCityParams(syd, { date: '2026-11-02' }, now), 'en').isToday, 'the server\'s date is taken for Sydney\'s today');
  });

  await check('V14 (review focus b) a summer/winter time change day in the city\'s zone (New York 2026-11-01, Jerusalem 2026-10-25, Sydney 2026-10-04, Simchat Torah there): the rows in the order of the day, each key once, each time on the city\'s clock within 3 minutes of the next day\'s (never an hour off), the hour unchanged; the previous and next days are the calendar\'s neighbours, none skipped or repeated', () => {
    const STANDS_AT: Record<string, string> = { YOM_TOV_ENDS: 'SHABBAT_ENDS', SHABBAT_YOM_TOV_ENDS: 'SHABBAT_ENDS', CANDLE_LIGHTING_NOT_BEFORE: 'SHABBAT_ENDS' };
    const orderOf = (key: string): number => ZMAN_KEYS.indexOf(STANDS_AT[key] ?? key);
    const minutesOf = (at: string, zone: string): number => {
      const [h, m] = instantToWallTime(new Date(at), zone).slice(11, 16).split(':').map(Number);
      return h * 60 + m;
    };
    for (const [slug, day] of [['new-york', '2026-11-01'], ['jerusalem', '2026-10-25'], ['sydney', '2026-10-04']] as const) {
      const c = city(slug);
      const where = `${slug} ${day}`;
      const view = build(slug, { date: day });
      ok(view, where);
      assert(show(view.list) === show(fresh(slug, view.community, day)), `${where}: not zmanDayForPlace's list`);
      const keys: string[] = view.list.rows.map((r: Row) => r.key);
      assert(new Set(keys).size === keys.length, `${where}: a row twice ${show(keys)}`);
      assert(keys.every((k, i) => i === 0 || orderOf(keys[i - 1]) <= orderOf(k)), `${where}: not in the order of the day ${show(keys)}`);
      const atOf = (key: string): string | null => view.list.rows.find((r: Row) => r.key === key)?.at ?? null;
      const chain = ['ALOT', 'NETZ', 'CHATZOT', 'SHKIA', 'TZEIT'].map(atOf).filter((x): x is string => x !== null).map((x) => Date.parse(x));
      assert(chain.length >= 4 && chain.every((t, i) => i === 0 || chain[i - 1] < t), `${where}: dawn, sunrise, midday, sunset and nightfall out of order`);
      const next = fresh(slug, view.community, addDaysToDate(day, 1));
      for (const row of view.list.rows) {
        if (row.at === null) continue;
        const wallDay = instantToWallTime(new Date(row.at), c.timeZone).slice(0, 10);
        const late = row.key === 'CHATZOT_HALAYLA' || row.key === 'SHABBAT_ENDS' || row.key in STANDS_AT;
        assert(wallDay === day || (late && wallDay === addDaysToDate(day, 1)), `${where}: ${row.key} falls on ${wallDay}`);
        const twin = next.rows.find((r: Row) => r.key === row.key);
        if (!twin?.at) continue;
        const gap = Math.abs(minutesOf(row.at, c.timeZone) - minutesOf(twin.at, c.timeZone));
        assert(Math.min(gap, 1440 - gap) <= 3, `${where}: ${row.key} is ${Math.min(gap, 1440 - gap)} minutes from the next day's on the city's clock`);
      }
      assert(Math.abs(view.list.hours[0].ms - next.hours[0].ms) < 60_000, `${where}: the halachic hour jumps`);
      assert(view.prevDay === addDaysToDate(day, -1) && view.nextDay === addDaysToDate(day, 1), `${where}: ${show([view.prevDay, view.nextDay])}`);
      assert(build(slug, { date: view.prevDay }).nextDay === day && build(slug, { date: view.nextDay }).prevDay === day, `${where}: the neighbours do not point back`);
      const walked: string[] = [addDaysToDate(day, -2)];
      for (let i = 0; i < 4; i++) walked.push(build(slug, { date: walked[walked.length - 1] }).nextDay);
      assert(show(walked) === show([-2, -1, 0, 1, 2].map((n) => addDaysToDate(day, n))), `${where}: the next-day links walk ${show(walked)}`);
    }
    assert(build('sydney', { date: '2026-10-04' }).list.rows.some((r: Row) => r.key === 'YOM_TOV_ENDS'), 'Sydney\'s Simchat Torah has no end of Yom Tov');
  });

  await check('V15 (review focus d) repeated or odd values are ignored and nothing throws: a repeated date or community, community[]=x, date[]=..., a 10,000-character date, 30 February', () => {
    const jlm = city('jerusalem');
    const odd: Array<Record<string, string | string[] | undefined>> = [
      { date: ['2026-11-01', '2026-11-02'] },
      { community: ['chabad', 'ashkenazi'] },
      { 'community[]': 'x' },
      { 'date[]': '2026-11-01' },
      { date: '2'.repeat(10_000) },
      { date: `2026-11-01${'0'.repeat(9_990)}` },
      { date: '2026-02-30' },
      { date: undefined, community: undefined },
    ];
    for (const search of odd) {
      const label = show(search).slice(0, 60);
      let p: Row = {};
      try {
        p = v.readCityParams(jlm, search, NOW);
      } catch (error) {
        throw new Error(`${label} threw: ${String(error)}`);
      }
      assert(p.day === '2026-10-30' && p.today === '2026-10-30' && !p.dayFromParam && p.community === 'sephardi' && !p.communityFromParam, `${label}: ${show(p)}`);
      ok(v.buildCityView(jlm, p, 'en'), label);
    }
  });

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

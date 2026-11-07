// Smoke test for the Jewish times API (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3, §4; plan
// docs/superpowers/plans/2026-11-07-zmanim-api.md, Tasks 4 and 5): the parameters, the place, the credits and the answers
// (src/lib/api-v1/*, src/services/zmanim/api-view.ts) and the routes (app/api/v1/*).
//
// What it pins:
//   - P1 the place: a city, coordinates in Israel (Israel's zone and the point's own height), abroad (no height), at sea
//     (NO_TIME_ZONE), in Hebron (abroad), an unknown city; a height map that fails counts at sea level and is reported
//     without the place; the default community by place;
//   - P2 the parameters: every 400 code, an unknown or repeated parameter, the date bounds and the 366-day range, coordinates
//     rounded to 4 places, slugs and coordinates as people mistype them (Review Focus 1 and 2);
//   - P3 the credits by place;
//   - V1 one code path: /shabbat's blocks are the city page's "ahead" windows over 400 days, the candle lighting is the eve's
//     own, 20 minutes before its sunset, the start is restDayBlocks', and /day's rows and hours are zmanDayForPlace's;
//   - V2 the golden answers: Jerusalem 13-14 November 2026 (as spec §3.1), Yom Kippur, Shavuot on a Friday in Israel, Pesach
//     and Sukkot in New York (the second night's "candle lighting after"), a range that ends on an eve, the far north (a
//     null end);
//   - V3 the times: `local` is the place's clock, `at` its offset on both sides of each clock change, in every process zone;
//   - V4 /day in New York in Hebrew (spec §3.1 b): rows, hours, the Hebrew date in letters, the parasha;
//   - V5 the languages; /day in the far north (Review Focus 5); V6 the bot's process memo is untouched;
//   - (Task 5) H1-H10 the routes, Z1 no place, key or origin in any log or Sentry field.
//
// Real: the engine, the city list, the zone map (geo-tz), the views, and from Task 5 the routes, the key store and lookup.
// Faked at the boundaries (scripts/lib/api-world.ts over scripts/lib/signin-world.ts): Prisma and Redis in memory with every
// Redis command counted, error capture, the clock; the Israel height map is a recorded stand-in. No network, no database.
//
// This file re-runs itself once per process zone (UTC, Asia/Jerusalem, America/New_York) as child processes, so one command
// covers all three; nothing here may depend on the zone the process has:
//   npx tsx scripts/smoke-api-v1.ts

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { installApiWorld, resetApiWorld } from './lib/api-world';
import { assert, captured, check, load, report, ROOT, show, stubModule, type Row } from './lib/signin-world';

const ZONES = ['UTC', 'Asia/Jerusalem', 'America/New_York'] as const;
const CHILD = 'API_V1_SMOKE_CHILD';

async function runChildren(): Promise<void> {
  const outputs = await Promise.all(
    ZONES.map(
      (zone) =>
        new Promise<{ zone: string; code: number; text: string }>((resolve) => {
          const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], { env: { ...process.env, TZ: zone, [CHILD]: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
          let text = '';
          child.stdout.on('data', (chunk) => (text += chunk));
          child.stderr.on('data', (chunk) => (text += chunk));
          child.on('close', (code) => resolve({ zone, code: code ?? 1, text }));
        }),
    ),
  );
  let failed = 0;
  for (const { zone, code, text } of outputs) {
    process.stdout.write(`\n===== process TZ=${zone} =====\n${text.trimEnd()}\n`);
    if (code !== 0) failed++;
  }
  process.stdout.write(`\n${ZONES.length - failed}/${ZONES.length} process zones passed (${ZONES.join(', ')})\n`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---- Fixtures ----

const HEIGHT = 270;
const heightReads: Row[][] = [];
let heightFails = false;

const HARISH = { lat: '32.4618', lon: '35.0456' };
const NY = { lat: '40.7128', lon: '-74.0060' };
const HEBRON = { lat: '31.5326', lon: '35.0998' };
const SEA = { lat: '33.1234', lon: '32.5678' };

/** No log line or Sentry field of the run may hold these (Z1): the coordinates, slugs and names the run uses. */
const PLACES = ['32.4618', '35.0456', '40.7128', '74.006', '31.5326', '35.0998', '33.1234', '32.5678', '31.769', '35.2163', 'jerusalem', 'haifa', 'new-york', 'saint-petersburg', 'atlantis', 'Jerusalem', 'Haifa', 'New York', 'Saint Petersburg'];

/** Spec §3.1 (a), as the engine gives it: Jerusalem at 828 m, Sephardi, 13 to 14 November 2026. */
const GOLDEN_BLOCKS = [
  {
    eve: '2026-11-13',
    last: '2026-11-14',
    candleLighting: { at: '2026-11-13T16:25:00+02:00', local: '16:25' },
    start: { at: '2026-11-13T16:45:00+02:00', local: '16:45' },
    end: { key: 'SHABBAT_ENDS', name: 'Shabbat ends', at: '2026-11-14T17:16:00+02:00', local: '17:16' },
    parasha: { title: 'Parashat Toldot', brief: 'Toldot' },
    holidays: [],
    days: [
      { date: '2026-11-13', rows: [{ key: 'CANDLE_LIGHTING', opinion: null, name: 'Candle lighting', at: '2026-11-13T16:25:00+02:00', local: '16:25' }] },
      { date: '2026-11-14', rows: [{ key: 'SHABBAT_ENDS', opinion: null, name: 'Shabbat ends', at: '2026-11-14T17:16:00+02:00', local: '17:16' }] },
    ],
  },
];

function assertSame(got: unknown, want: unknown, label: string): void {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

function codeOfSync(fn: () => unknown): string {
  try {
    fn();
    return 'none';
  } catch (error) {
    return String((error as Row).code ?? (error as Error).name);
  }
}

async function runChecks(): Promise<void> {
  await installApiWorld();
  stubModule('src/services/zmanim/heights.ts', {
    highestHeight: (points: Row[]) => {
      heightReads.push(points);
      if (heightFails) throw new Error('the smoke height map is missing');
      return HEIGHT;
    },
    heightMapLoads: () => 0,
  });
  const { cityBySlug, CITIES } = await load('src/site/cities.ts');
  const { buildCityView, defaultCommunityIn } = await load('src/site/zmanim/city-view.ts');
  const { zmanDayForPlace } = await load('src/services/zmanim/day-list.ts');
  const { restDayBlocks } = await load('src/services/zmanim/compute.ts');
  const { holidaysInRange } = await load('src/services/hebrew-holidays.ts');
  const { instantToWallTime } = await load('src/utils/wall-time.ts');
  const { addDaysToDate, startOfLocalDay } = await load('src/utils/day-events.ts');
  const params = await load('src/lib/api-v1/params.ts');
  const { resolveApiPlace } = await load('src/lib/api-v1/place.ts');
  const { creditsFor } = await load('src/lib/api-v1/credits.ts');
  const { COPERNICUS_NOTICE } = await load('src/site/zmanim/sources.ts');
  const { dayView, shabbatView, isoWithOffset } = await load('src/services/zmanim/api-view.ts');
  const messages: Record<string, Row> = Object.fromEntries(['en', 'he', 'ru'].map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))]));
  const memoSize = () => ((globalThis as Row).__zmanReminderAnswers as Map<string, unknown> | undefined)?.size ?? 0;
  const memoBefore = memoSize();

  const city = (slug: string) => ({ kind: 'city', slug });
  const coords = (p: { lat: string; lon: string }) => ({ kind: 'coords', latitude: Number(p.lat), longitude: Number(p.lon) });
  const shabbat = async (q: { place: Row; community?: string; lang?: string; from: string; to: string }): Promise<Row> => {
    const place = resolveApiPlace(q.place);
    return shabbatView({ place, community: q.community ?? defaultCommunityIn(place.place.timeZone), lang: q.lang ?? 'en', from: q.from, to: q.to, credits: creditsFor(place) });
  };
  const day = async (q: { place: Row; community?: string; lang?: string; date: string }): Promise<Row> => {
    const place = resolveApiPlace(q.place);
    return dayView({ place, community: q.community ?? defaultCommunityIn(place.place.timeZone), lang: q.lang ?? 'en', date: q.date, credits: creditsFor(place) });
  };
  /** A block's days as [date, [key, local]] pairs. */
  const locals = (block: Row) => block.days.map((d: Row) => [d.date, d.rows.map((r: Row) => [r.key, r.local])]);
  const search = (qs: string) => new URLSearchParams(qs);

  await check('P1 the place: a city is its stored point, height and zone; coordinates in Israel get Israel\'s zone and the height at the point itself (one read of exactly that point); abroad and in Hebron no height; at sea NO_TIME_ZONE; an unknown city UNKNOWN_CITY; a failing height map counts at sea level and is reported without the place; the default community follows the zone', () => {
    resetApiWorld();
    heightReads.length = 0;
    const jlm = resolveApiPlace(city('jerusalem'));
    assertSame(jlm, { source: 'city', slug: 'jerusalem', place: { latitude: 31.769, longitude: 35.2163, elevationM: 828, timeZone: 'Asia/Jerusalem' }, il: true }, 'Jerusalem');
    const harish = resolveApiPlace(coords(HARISH));
    assertSame(harish, { source: 'coords', slug: null, place: { latitude: 32.4618, longitude: 35.0456, timeZone: 'Asia/Jerusalem', elevationM: HEIGHT }, il: true }, 'Harish by coordinates');
    assertSame(heightReads, [[{ latitude: 32.4618, longitude: 35.0456 }]], 'the height read');
    const ny = resolveApiPlace(coords(NY));
    assert(ny.place.timeZone === 'America/New_York' && ny.place.elevationM === null && !ny.il && heightReads.length === 1, `New York: ${show(ny)}`);
    const hebron = resolveApiPlace(coords(HEBRON));
    assert(hebron.place.timeZone === 'Asia/Hebron' && !hebron.il && hebron.place.elevationM === null && heightReads.length === 1, `Hebron: ${show(hebron)}`);
    assert(codeOfSync(() => resolveApiPlace(coords(SEA))) === 'NO_TIME_ZONE', 'at sea');
    assert(codeOfSync(() => resolveApiPlace(city('atlantis'))) === 'UNKNOWN_CITY', 'an unknown city');
    heightFails = true;
    captured.length = 0;
    const failed = resolveApiPlace(coords(HARISH));
    heightFails = false;
    assert(failed.place.elevationM === null && failed.il, 'a failing map: sea level');
    assert(captured.length === 1 && captured[0].context === 'api-v1' && captured[0].message === 'the Israel height map could not be read: counted at sea level: Error' && show(captured[0].extra) === show({ service: 'api-v1', step: 'height' }), `the report: ${show(captured)}`);
    assert(defaultCommunityIn('Asia/Jerusalem') === 'sephardi' && defaultCommunityIn('America/New_York') === 'ashkenazi' && defaultCommunityIn('Asia/Hebron') === 'ashkenazi', 'the default community');
  });

  await check('P2 the parameters: every 400 code by its rule; an unknown or a repeated parameter; coordinates rounded to 4 places and checked before any lookup; the date bounds; to at most 366 days after from; a slug or coordinates as people mistype them', () => {
    const shab = (qs: string) => codeOfSync(() => params.readShabbatParams(search(qs)));
    const dayq = (qs: string) => codeOfSync(() => params.readDayParams(search(qs)));
    const cases: [string, string][] = [
      [shab(''), 'INVALID_PLACE'],
      [shab('city=jerusalem&lat=31.7&lon=35.2'), 'INVALID_PLACE'],
      [dayq('lat=31.7'), 'INVALID_PLACE'],
      [dayq('lon=35.2'), 'INVALID_PLACE'],
      [shab('city=Jerusalem'), 'UNKNOWN_CITY'],
      [shab('city=tel%20aviv'), 'UNKNOWN_CITY'],
      [shab('city='), 'UNKNOWN_CITY'],
      [dayq('lat=91&lon=0'), 'INVALID_COORDINATES'],
      [dayq('lat=0&lon=-180.5'), 'INVALID_COORDINATES'],
      [dayq('lat=abc&lon=0'), 'INVALID_COORDINATES'],
      [dayq('lat=32,46&lon=35'), 'INVALID_COORDINATES'],
      [dayq('lat=%2B32.4&lon=35'), 'INVALID_COORDINATES'],
      [dayq('lat=32.4%20&lon=35'), 'INVALID_COORDINATES'],
      [dayq('lat=1e1&lon=35'), 'INVALID_COORDINATES'],
      [dayq('lat=&lon=35'), 'INVALID_COORDINATES'],
      [dayq('city=jerusalem&date=2026-02-30'), 'INVALID_DATE'],
      [dayq('city=jerusalem&date=2026-2-3'), 'INVALID_DATE'],
      [dayq('city=jerusalem&date=1999-12-31'), 'OUT_OF_RANGE'],
      [shab('city=jerusalem&to=2100-01-01'), 'OUT_OF_RANGE'],
      [shab('city=jerusalem&from=2026-11-20&to=2026-11-13'), 'INVALID_RANGE'],
      [shab('city=jerusalem&from=2026-01-01&to=2027-01-03'), 'INVALID_RANGE'],
      [dayq('city=jerusalem&community=yemenite'), 'INVALID_COMMUNITY'],
      [dayq('city=jerusalem&lang=fr'), 'INVALID_LANG'],
      [dayq('city=jerusalem&from=2026-11-13'), 'UNKNOWN_PARAMETER'],
      [shab('city=jerusalem&date=2026-11-13'), 'UNKNOWN_PARAMETER'],
      [dayq('city=jerusalem&lang=en&lang=he'), 'UNKNOWN_PARAMETER'],
    ];
    cases.forEach(([got, want], i) => assert(got === want, `case ${i}: ${got}, wanted ${want}`));
    assert(shab('city=jerusalem&from=2026-01-01&to=2027-01-02') === 'none', '366 days is one range');
    assertSame(params.readShabbatParams(search('city=jerusalem')), { place: { kind: 'city', slug: 'jerusalem' }, community: null, lang: 'en', from: null, to: null }, 'the defaults');
    assertSame(params.readDayParams(search('lat=40.71284&lon=-74.00606&community=chabad&lang=ru&date=2026-11-14')), { place: { kind: 'coords', latitude: 40.7128, longitude: -74.0061 }, community: 'chabad', lang: 'ru', date: '2026-11-14' }, 'rounded to 4 places');
    let message = '';
    try {
      params.readShabbatParams(search('city=Jerusalem'));
    } catch (error) {
      message = (error as Error).message;
    }
    assert(/city list/.test(message) && !/Jerusalem/.test(message), `the slug message: ${message}`);
    assert(params.daysBetween('2026-01-01', '2027-01-02') === 366 && params.daysBetween('2026-03-27', '2026-03-28') === 1, 'daysBetween');
  });

  await check('P3 the credits: the Copernicus notice wherever a height is given, GeoNames for a city, OpenStreetMap for coordinates', () => {
    const sources = (p: Row) => creditsFor(resolveApiPlace(p)).map((c: Row) => c.source);
    assertSame(sources(city('jerusalem')), ['copernicus-dem', 'geonames'], 'Jerusalem');
    assertSame(sources(city('new-york')), ['geonames'], 'New York');
    assertSame(sources(coords(HARISH)), ['copernicus-dem', 'openstreetmap'], 'Harish');
    assertSame(sources(coords(NY)), ['openstreetmap'], 'New York by coordinates');
    const [copernicus, geonames] = creditsFor(resolveApiPlace(city('jerusalem')));
    assert(copernicus.text === COPERNICUS_NOTICE && copernicus.url === undefined, 'the Copernicus text is the site\'s own');
    assertSame(geonames, { source: 'geonames', text: 'City positions: GeoNames, under CC BY 4.0.', url: 'https://www.geonames.org/' }, 'GeoNames');
    assertSame(creditsFor(resolveApiPlace(coords(NY)))[0], { source: 'openstreetmap', text: 'Time zone map © OpenStreetMap contributors, under ODbL.', url: 'https://www.openstreetmap.org/copyright' }, 'OpenStreetMap');
  });

  await check('V1 one code path: for Jerusalem and Haifa (Sephardi), Haifa (Ashkenazi) and New York (Ashkenazi), every week over 400 days, /shabbat\'s blocks are the city page\'s "ahead" windows row for row and instant for instant; each candle lighting is its eve\'s CANDLE_LIGHTING, 20 minutes before that day\'s SHKIA; each start is restDayBlocks\' start; every day\'s /day rows and hours (Jerusalem, New York) are zmanDayForPlace\'s', async () => {
    const instants = (rows: Row[]) => rows.map((r: Row) => [r.key, r.at === null ? null : Date.parse(r.at)]);
    for (const [slug, community] of [['jerusalem', 'sephardi'], ['haifa', 'sephardi'], ['haifa', 'ashkenazi'], ['new-york', 'ashkenazi']] as const) {
      const c = cityBySlug(slug);
      const apiPlace = resolveApiPlace(city(slug));
      const zone = apiPlace.place.timeZone;
      for (let i = 0; i < 400; i += 7) {
        const from = addDaysToDate('2026-11-01', i);
        const to = addDaysToDate(from, 8);
        const view = buildCityView(c, { day: from, community, today: from, dayFromParam: true, communityFromParam: false }, 'en');
        const answer = await shabbat({ place: city(slug), community, from, to });
        const ours = answer.blocks.map((b: Row) => [b.eve, b.last, b.days.map((d: Row) => [d.date, instants(d.rows)])]);
        const page = view.ahead.map((w: Row) => [w.eve, w.last, w.days.map((d: Row) => [d.day, instants(d.rows)])]);
        assertSame(ours, page, `${slug} ${community} from ${from}`);
        for (const block of answer.blocks) {
          const eve = zmanDayForPlace(apiPlace.place, community, block.eve, { memo: new Map(), quiet: true });
          const candle = eve.rows.find((r: Row) => r.key === 'CANDLE_LIGHTING');
          const sunset = eve.rows.find((r: Row) => r.key === 'SHKIA');
          assert(candle?.at && block.candleLighting.at !== null && Date.parse(block.candleLighting.at) === Date.parse(candle.at), `${slug} ${block.eve}: the candle lighting`);
          assert(sunset?.at && Date.parse(sunset.at) - Date.parse(candle.at) === 20 * 60_000, `${slug} ${block.eve}: not 20 minutes before sunset`);
          const own = restDayBlocks({ from: startOfLocalDay(addDaysToDate(block.eve, -3), zone), to: startOfLocalDay(addDaysToDate(block.eve, 4), zone) }, apiPlace.place, community).find((b: Row) => b.eve === block.eve);
          assert((own?.start?.getTime() ?? null) === (block.start.at === null ? null : Date.parse(block.start.at)), `${slug} ${block.eve}: the start`);
        }
      }
    }
    for (const slug of ['jerusalem', 'new-york']) {
      const apiPlace = resolveApiPlace(city(slug));
      const community = defaultCommunityIn(apiPlace.place.timeZone);
      for (let i = 0; i < 400; i++) {
        const date = addDaysToDate('2026-11-01', i);
        const answer = await day({ place: city(slug), date });
        const list = zmanDayForPlace(apiPlace.place, community, date, { memo: new Map(), quiet: true });
        assertSame(instants(answer.rows), instants(list.rows), `${slug} ${date}: the rows`);
        assertSame(answer.rows.map((r: Row) => r.opinion), list.rows.map((r: Row) => r.opinion), `${slug} ${date}: the opinions`);
        assertSame(answer.hours.map((h: Row) => [h.opinion, h.ms]), list.hours.map((h: Row) => [h.opinion, h.ms]), `${slug} ${date}: the hours`);
      }
    }
  });

  await check('V2 the golden answers: Jerusalem 13-14 November 2026 as spec §3.1; a range that ends on an eve still lists that block whole; Yom Kippur; Shavuot on a Friday in Israel; Pesach and Sukkot in New York with the second night\'s "candle lighting after"; the far north with a null end', async () => {
    const jlm = await shabbat({ place: city('jerusalem'), from: '2026-11-13', to: '2026-11-14' });
    assertSame(jlm.blocks, GOLDEN_BLOCKS, 'Jerusalem');
    assertSame({ place: jlm.place, community: jlm.community, lang: jlm.lang, from: jlm.from, to: jlm.to }, { place: { city: 'jerusalem', timeZone: 'Asia/Jerusalem', inIsrael: true, elevationM: 828 }, community: 'sephardi', lang: 'en', from: '2026-11-13', to: '2026-11-14' }, 'Jerusalem\'s frame');
    assertSame(jlm.credits.map((c: Row) => c.source), ['copernicus-dem', 'geonames'], 'Jerusalem\'s credits');
    assertSame((await shabbat({ place: city('jerusalem'), from: '2026-11-13', to: '2026-11-13' })).blocks, GOLDEN_BLOCKS, 'a range that ends on the eve');
    assertSame((await shabbat({ place: city('jerusalem'), from: '2026-11-14', to: '2026-11-14' })).blocks, GOLDEN_BLOCKS, 'a block under way on from');

    const [yk] = (await shabbat({ place: city('jerusalem'), from: '2026-09-20', to: '2026-09-20' })).blocks;
    assertSame([yk.eve, yk.last, locals(yk), yk.holidays.map((h: Row) => h.title), yk.parasha, yk.end.key, yk.end.name], ['2026-09-20', '2026-09-21', [['2026-09-20', [['CANDLE_LIGHTING', '18:23']]], ['2026-09-21', [['YOM_TOV_ENDS', '19:12']]]], ['Yom Kippur'], null, 'YOM_TOV_ENDS', 'Yom Tov ends'], 'Yom Kippur');

    const [shavuot] = (await shabbat({ place: city('jerusalem'), from: '2026-05-21', to: '2026-05-21' })).blocks;
    assertSame([shavuot.eve, shavuot.last, locals(shavuot), shavuot.holidays.map((h: Row) => h.title), shavuot.parasha?.title], ['2026-05-21', '2026-05-23', [['2026-05-21', [['CANDLE_LIGHTING', '19:17']]], ['2026-05-22', [['CANDLE_LIGHTING', '19:18']]], ['2026-05-23', [['SHABBAT_ENDS', '20:10']]]], ['Shavuot'], 'Parashat Nasso'], 'Shavuot on a Friday in Israel');

    const [pesach] = (await shabbat({ place: city('new-york'), from: '2027-04-21', to: '2027-04-21' })).blocks;
    assertSame([pesach.eve, pesach.last, locals(pesach), pesach.holidays.map((h: Row) => h.title)], ['2027-04-21', '2027-04-24', [['2027-04-21', [['CANDLE_LIGHTING', '19:21']]], ['2027-04-22', [['CANDLE_LIGHTING_NOT_BEFORE', '20:26']]], ['2027-04-23', [['CANDLE_LIGHTING', '19:23']]], ['2027-04-24', [['SHABBAT_ENDS', '20:29']]]], ['Pesach I', 'Pesach II']], 'Pesach in New York');
    assert(pesach.days[1].rows[0].name === 'Candle lighting after', `the second night's row: ${pesach.days[1].rows[0].name}`);

    const [sukkot] = (await shabbat({ place: city('new-york'), from: '2026-09-25', to: '2026-09-25' })).blocks;
    assertSame([sukkot.eve, sukkot.last, locals(sukkot), sukkot.holidays.map((h: Row) => h.title), sukkot.end.key], ['2026-09-25', '2026-09-27', [['2026-09-25', [['CANDLE_LIGHTING', '18:28']]], ['2026-09-26', [['CANDLE_LIGHTING_NOT_BEFORE', '19:27']]], ['2026-09-27', [['YOM_TOV_ENDS', '19:26']]]], ['Sukkot I', 'Sukkot II'], 'YOM_TOV_ENDS'], 'Sukkot in New York');

    const north = await shabbat({ place: city('saint-petersburg'), from: '2027-06-18', to: '2027-06-19' });
    assertSame(north.blocks.map((b: Row) => [b.eve, b.last, b.candleLighting, b.start, b.end]), [['2027-06-18', '2027-06-19', { at: '2027-06-18T22:04:00+03:00', local: '22:04' }, { at: '2027-06-18T22:24:00+03:00', local: '22:24' }, { key: 'SHABBAT_ENDS', name: 'Shabbat ends', at: null, local: null }]], 'the far north');
    assert(north.community === 'ashkenazi', 'the far north\'s default community');
  });

  await check('V3 the times: every at is the place\'s wall clock with the zone\'s offset at that instant and parses back to the engine\'s instant, local is its hh:mm; on both sides of each clock change in Israel and New York; isoWithOffset by itself', async () => {
    const checkAll = (answer: Row, zone: string) => {
      for (const block of answer.blocks) {
        for (const t of [block.candleLighting, block.start, block.end, ...block.days.flatMap((d: Row) => d.rows)].filter(Boolean)) {
          if (t.at === null) continue;
          const instant = new Date(Date.parse(t.at));
          assert(t.at.slice(0, 19) === instantToWallTime(instant, zone) && t.local === t.at.slice(11, 16), `${zone} ${t.at} ${t.local}`);
        }
      }
    };
    const offsets = (answer: Row) => answer.blocks.map((b: Row) => [b.candleLighting.at, b.end.at]);
    const jlmAutumn = await shabbat({ place: city('jerusalem'), from: '2026-10-23', to: '2026-10-30' });
    assertSame(offsets(jlmAutumn), [['2026-10-23T17:42:00+03:00', '2026-10-24T18:32:00+03:00'], ['2026-10-30T16:36:00+02:00', '2026-10-31T17:26:00+02:00']], 'Jerusalem in October');
    const jlmSpring = await shabbat({ place: city('jerusalem'), from: '2027-03-19', to: '2027-03-26' });
    assert(jlmSpring.blocks.length === 2 && jlmSpring.blocks[0].candleLighting.at.endsWith('+02:00') && jlmSpring.blocks[1].candleLighting.at === '2027-03-26T18:38:00+03:00', `Jerusalem in March: ${show(offsets(jlmSpring))}`);
    const nyAutumn = await shabbat({ place: city('new-york'), from: '2026-10-30', to: '2026-11-06' });
    assertSame(offsets(nyAutumn), [['2026-10-30T17:34:00-04:00', '2026-10-31T18:36:00-04:00'], ['2026-11-06T16:26:00-05:00', '2026-11-07T17:28:00-05:00']], 'New York in the autumn');
    const nySpring = await shabbat({ place: city('new-york'), from: '2027-03-12', to: '2027-03-19' });
    assert(nySpring.blocks[0].candleLighting.at === '2027-03-12T17:39:00-05:00' && nySpring.blocks[0].end.at === '2027-03-13T18:41:00-05:00' && nySpring.blocks[1].candleLighting.at.endsWith('-04:00'), `New York in March: ${show(offsets(nySpring))}`);
    for (const [answer, zone] of [[jlmAutumn, 'Asia/Jerusalem'], [jlmSpring, 'Asia/Jerusalem'], [nyAutumn, 'America/New_York'], [nySpring, 'America/New_York']] as const) checkAll(answer, zone);
    const changeDay = await day({ place: city('new-york'), date: '2026-11-01' });
    for (const r of changeDay.rows) assert(r.at === null || (r.at.slice(0, 19) === instantToWallTime(new Date(Date.parse(r.at)), 'America/New_York') && r.local === r.at.slice(11, 16)), `New York on its change day: ${show(r)}`);
    assert(isoWithOffset(new Date('2026-11-14T22:17:30.500Z'), 'UTC') === '2026-11-14T22:17:30+00:00', 'UTC, the seconds kept and the milliseconds dropped');
    assert(isoWithOffset(new Date('2026-11-14T10:00:00Z'), 'Asia/Kolkata') === '2026-11-14T15:30:00+05:30', 'a half-hour zone');
  });

  await check('V4 /day in New York by coordinates, in Hebrew (spec §3.1 b): the place, Ashkenazi by default, the rows in the order of the day with their opinions and Hebrew names, the hours, the Hebrew date in letters, the parasha, the OpenStreetMap credit', async () => {
    const ny = await day({ place: coords(NY), lang: 'he', date: '2026-11-14' });
    assertSame(ny.place, { latitude: 40.7128, longitude: -74.006, timeZone: 'America/New_York', inIsrael: false, elevationM: null }, 'the place');
    assert(ny.community === 'ashkenazi' && ny.lang === 'he' && ny.date === '2026-11-14', 'the frame');
    assertSame(ny.rows.map((r: Row) => [r.key, r.opinion, r.local]), [['ALOT', null, '05:17'], ['MISHEYAKIR', null, '05:43'], ['NETZ', null, '06:42'], ['SOF_SHMA_MGA', 'mga', '08:28'], ['SOF_SHMA_GRA', 'gra', '09:10'], ['SOF_TFILA', null, '10:00'], ['CHATZOT', null, '11:40'], ['MINCHA_GEDOLA', null, '12:11'], ['MINCHA_KETANA', null, '14:35'], ['PLAG_GRA', 'gra', '15:37'], ['SHKIA', null, '16:38'], ['TZEIT', null, '17:22'], ['SHABBAT_ENDS', null, '17:22'], ['CHATZOT_HALAYLA', null, '23:41']], 'the rows');
    assertSame(ny.rows[0], { key: 'ALOT', opinion: null, name: 'עלות השחר', at: '2026-11-14T05:17:00-05:00', local: '05:17' }, 'the first row');
    assert(ny.rows[3].name === 'סוף זמן קריאת שמע (מג״א)' && ny.rows[12].name === 'צאת השבת' && ny.rows[12].at === '2026-11-14T17:22:00-05:00', `the names: ${ny.rows[3].name} | ${ny.rows[12].name}`);
    assertSame(ny.hours, [{ opinion: 'gra', name: 'גר״א', ms: 2985250, text: '49:45' }, { opinion: 'mga', name: 'מג״א', ms: 3830083, text: '63:50' }], 'the hours');
    assertSame(ny.hebrewDate, { text: 'ד׳ בכסלו תשפ״ז', gematriya: 'ד׳ בכסלו תשפ״ז', day: 4, month: 'Kislev', year: 5787 }, 'the Hebrew date');
    assertSame(ny.holidays, [{ title: 'פרשת תולדות', brief: 'תולדות', kind: 'parasha', chag: false }], 'the parasha');
    assertSame(ny.credits.map((c: Row) => c.source), ['openstreetmap'], 'the credits');
  });

  await check('V5 the languages: row names, opinions and the Hebrew date in en, he and ru (Russian in the genitive, the Hebrew date always in letters), holidays as holidaysInRange gives them; and /day in the far north on a summer day is an answer with null times, never a failure (Review Focus 5)', async () => {
    for (const lang of ['en', 'he', 'ru']) {
      const answer = await day({ place: city('jerusalem'), lang, date: '2026-11-14' });
      const words = messages[lang].calendarHome;
      const end = answer.rows.find((r: Row) => r.key === 'SHABBAT_ENDS');
      assert(end.name === words.zmanimList.shabbatEnds, `${lang}: ${end.name}`);
      assertSame(answer.hours.map((h: Row) => h.name), answer.hours.map((h: Row) => words.zmanim.opinions[h.opinion]), `${lang}: the opinions`);
      assertSame(answer.holidays.map((h: Row) => h.title), (holidaysInRange('2026-11-14', '2026-11-14', lang, { il: true })['2026-11-14'] ?? []).map((h: Row) => h.title), `${lang}: the holidays`);
      assert(answer.hebrewDate.gematriya === 'ד׳ בכסלו תשפ״ז' && answer.hebrewDate.month === 'Kislev', `${lang}: the gematriya`);
    }
    assert((await day({ place: city('jerusalem'), lang: 'en', date: '2026-11-14' })).hebrewDate.text === '4 Kislev 5787', 'English');
    assert((await day({ place: city('jerusalem'), lang: 'ru', date: '2026-11-14' })).hebrewDate.text === '4 кислева 5787', 'Russian, genitive');
    const north = await day({ place: city('saint-petersburg'), date: '2027-06-19' });
    assert(north.rows.some((r: Row) => r.at === null && r.local === null) && north.rows.some((r: Row) => r.at !== null), `the far north: ${show(north.rows.map((r: Row) => [r.key, r.local]))}`);
  });

  await check('V6 the bot\'s process memo of zmanim is untouched by every answer of the run', () => {
    assert(memoSize() === memoBefore, `the process memo grew from ${memoBefore} to ${memoSize()}`);
  });

  // ---- Task 5: the routes (H1-H10) and the whole run's logs (Z1) ----

  void CITIES;
  void PLACES; // Task 5 (Z1) reads it
  report();
}

if (process.env[CHILD] !== '1') {
  void runChildren();
} else {
  runChecks().catch((err) => {
    process.stderr.write(String((err as Error).stack ?? err) + "\n");
    process.exit(1);
  });
}

// Smoke test for the public zmanim pages' city data (spec docs/superpowers/specs/2026-10-30-public-zmanim-design.md §5,
// §4.1 and §9 "The city table"):
//   - src/site/cities.ts: the 135 rows of Appendix A, Israel first; unique lowercase ASCII slugs that no route takes;
//     a name for every slug and every country in en, he and ru (messages cities.* and countries.*); the zone is the
//     Israel flag (IL <=> inIsrael) and every zone is one Intl knows; an integer height in every Israeli row (written by
//     scripts/build-city-heights.ts) and none abroad; coordinates in range, at most 4 decimals;
//   - src/site/near-city.ts: the haversine distance, the UTC offset read from the zone's clock, and the three answers of
//     "Near me" (open within 30 km, near within 100 km in the same offset, else none) at concrete points, and with a
//     missing or odd device zone (review focus e: 30 km still opens by distance alone, and nothing throws);
//   - the layering: cities.ts imports nothing, near-city.ts only the pure clock reader, and the bot's elevationGrid lives
//     in the pure src/services/zmanim/elevation-grid.ts that place.ts re-exports (the heights script loads no database).
// Pure: no database, Redis, network or env.
//   npx tsx scripts/smoke-cities.ts

import fs from 'node:fs';
import path from 'node:path';
import { CITIES, cityBySlug, type City } from '../src/site/cities';
import { NEAR_KM, OPEN_KM, haversineKm, nearAnswer, utcOffsetMinutes } from '../src/site/near-city';
import { inIsrael } from '../src/utils/locale-rules';

const ROOT = path.resolve(__dirname, '..');
const LOCALES = ['en', 'he', 'ru'] as const;
type Locale = (typeof LOCALES)[number];
type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (value: unknown): string => JSON.stringify(value);
const readSource = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const messages = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(readSource(`messages/${l}.json`))])) as Record<Locale, { cities?: Record<string, unknown>; countries?: Record<string, unknown> }>;
/** The import lines of a file (comments dropped). */
const importsOf = (rel: string): string[] =>
  readSource(rel)
    .split('\n')
    .filter((l) => /^\s*(import|export)\b.*\bfrom\s+['"]/.test(l));
const city = (slug: string): City => {
  const found = cityBySlug(slug);
  assert(found, `no city ${slug}`);
  return found;
};
const at = (lat: number, lon: number) => ({ latitude: lat, longitude: lon });
const WINTER = new Date('2026-12-01T10:00:00Z');
const SUMMER = new Date('2026-07-01T10:00:00Z');
/** Degrees of latitude for `km` along a meridian, on near-city's Earth radius. */
const degreesFor = (km: number): number => ((km / 6371.0088) * 180) / Math.PI;

async function main() {
  await check('the table: 135 rows, the 51 Israeli cities first and then the 84 abroad, in the spec\'s order (Jerusalem first, Hong Kong last)', () => {
    assert(CITIES.length === 135, `${CITIES.length} rows`);
    const firstAbroad = CITIES.findIndex((c) => c.country !== 'IL');
    assert(firstAbroad === 51, `the first city abroad is row ${firstAbroad}`);
    assert(CITIES.slice(51).every((c) => c.country !== 'IL'), 'an Israeli row after the first city abroad');
    assert(CITIES[0].slug === 'jerusalem' && CITIES[50].slug === 'zichron-yaakov' && CITIES[51].slug === 'new-york' && CITIES[134].slug === 'hong-kong', show([CITIES[0].slug, CITIES[50].slug, CITIES[51].slug, CITIES[134].slug]));
  });

  await check('slugs: unique, lowercase ASCII words joined by single hyphens, never a locale or a route of the app (en, he, ru, dashboard, settings, admin); cityBySlug finds each row and nothing else', () => {
    const slugs = CITIES.map((c) => c.slug);
    assert(new Set(slugs).size === slugs.length, `duplicates: ${show(slugs.filter((s, i) => slugs.indexOf(s) !== i))}`);
    const bad = slugs.filter((s) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s));
    assert(bad.length === 0, `not lowercase ASCII: ${show(bad)}`);
    const reserved = slugs.filter((s) => ['en', 'he', 'ru', 'dashboard', 'settings', 'admin'].includes(s));
    assert(reserved.length === 0, `reserved: ${show(reserved)}`);
    for (const c of CITIES) assert(cityBySlug(c.slug) === c, `cityBySlug(${c.slug})`);
    for (const other of ['', 'Jerusalem', 'jerusalem ', 'brooklyn', 'toString', '__proto__']) assert(cityBySlug(other) === undefined, `cityBySlug(${show(other)}) found a city`);
  });

  await check('names: messages cities.* holds exactly the slugs and countries.* exactly the country codes, in en, he and ru, each a real name (Hebrew letters in he, Cyrillic in ru, no Latin letter in either)', () => {
    const slugs = CITIES.map((c) => c.slug).sort();
    const codes = [...new Set(CITIES.map((c) => c.country))].sort();
    assert(codes.length === 40, `${codes.length} countries`);
    const problems: string[] = [];
    for (const l of LOCALES) {
      for (const [ns, want] of [['cities', slugs], ['countries', codes]] as const) {
        const table = messages[l][ns] ?? {};
        const have = Object.keys(table).sort();
        if (show(have) !== show(want)) problems.push(`${l} ${ns}: missing ${show(want.filter((k) => !have.includes(k)))}, extra ${show(have.filter((k) => !want.includes(k)))}`);
        for (const [key, name] of Object.entries(table)) {
          if (typeof name !== 'string' || name.trim() !== name || name === '') problems.push(`${l} ${ns}.${key}: ${show(name)}`);
          else if (l === 'he' && (!/\p{Script=Hebrew}/u.test(name) || /[A-Za-z]/.test(name))) problems.push(`he ${ns}.${key} is not Hebrew: ${name}`);
          else if (l === 'ru' && (!/\p{Script=Cyrillic}/u.test(name) || /[A-Za-z]/.test(name))) problems.push(`ru ${ns}.${key} is not Russian: ${name}`);
          else if (l === 'en' && !/^[\p{Script=Latin} .,’-]+$/u.test(name)) problems.push(`en ${ns}.${key}: ${name}`);
        }
      }
    }
    assert(problems.length === 0, problems.join('; '));
    assert(messages.he.cities?.tiberias === 'טבריה' && messages.ru.cities?.tiberias === 'Тверия' && messages.ru.cities?.tzfat === 'Цфат' && messages.ru.cities?.['beer-sheva'] === 'Беэр-Шева', 'the Israeli names as Israelis write them');
  });

  await check('the zone is the Israel flag: country IL <=> inIsrael(zone), every Israeli row is Asia/Jerusalem (Judea and Samaria too), and no row uses an old spelling', () => {
    const wrong = CITIES.filter((c) => (c.country === 'IL') !== inIsrael(c.timeZone)).map((c) => c.slug);
    assert(wrong.length === 0, `IL and inIsrael disagree: ${show(wrong)}`);
    const notJerusalem = CITIES.filter((c) => c.country === 'IL' && c.timeZone !== 'Asia/Jerusalem').map((c) => c.slug);
    assert(notJerusalem.length === 0, show(notJerusalem));
    const old = CITIES.filter((c) => ['Europe/Kiev', 'Asia/Hebron', 'Asia/Gaza', 'Asia/Tel_Aviv', 'Israel', 'America/Buenos_Aires', 'Asia/Calcutta'].includes(c.timeZone)).map((c) => c.slug);
    assert(old.length === 0, `old spellings: ${show(old)}`);
    assert(city('kyiv').timeZone === 'Europe/Kyiv' && city('maale-adumim').timeZone === 'Asia/Jerusalem' && city('ariel').country === 'IL', 'Kyiv, Ma\'ale Adumim, Ariel');
  });

  await check('every zone is one Intl knows: new Intl.DateTimeFormat("en", { timeZone }) accepts it', () => {
    const refused: string[] = [];
    for (const c of CITIES) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: c.timeZone });
      } catch {
        refused.push(`${c.slug}: ${c.timeZone}`);
      }
    }
    assert(refused.length === 0, show(refused));
  });

  await check('heights: every Israeli row has a whole number of metres from the heights script (a negative one would be kept as read), no row abroad has one', () => {
    const missing = CITIES.filter((c) => c.country === 'IL' && !(Number.isInteger(c.elevationM) && (c.elevationM as number) >= -430 && (c.elevationM as number) <= 1200)).map((c) => `${c.slug}: ${c.elevationM}`);
    assert(missing.length === 0, `Israeli rows without a height (run npx tsx scripts/build-city-heights.ts): ${show(missing)}`);
    const abroad = CITIES.filter((c) => c.country !== 'IL' && c.elevationM !== null).map((c) => c.slug);
    assert(abroad.length === 0, `heights abroad: ${show(abroad)}`);
  });

  await check('coordinates: latitude in [-90, 90], longitude in [-180, 180], at most 4 decimals; the Israeli rows inside Israel\'s box; GeoNames ids are unique positive integers', () => {
    const bad: string[] = [];
    for (const c of CITIES) {
      if (!(c.latitude >= -90 && c.latitude <= 90) || !(c.longitude >= -180 && c.longitude <= 180)) bad.push(`${c.slug}: out of range`);
      if (Math.round(c.latitude * 1e4) / 1e4 !== c.latitude || Math.round(c.longitude * 1e4) / 1e4 !== c.longitude) bad.push(`${c.slug}: more than 4 decimals`);
      if (c.country === 'IL' && !(c.latitude > 29.4 && c.latitude < 33.4 && c.longitude > 34.2 && c.longitude < 35.9)) bad.push(`${c.slug}: outside Israel`);
      if (!Number.isInteger(c.geonameId) || c.geonameId <= 0) bad.push(`${c.slug}: geonameId ${c.geonameId}`);
    }
    assert(bad.length === 0, bad.join('; '));
    assert(new Set(CITIES.map((c) => c.geonameId)).size === CITIES.length, 'a GeoNames id is used twice');
    assert(show(city('jerusalem')) === show({ slug: 'jerusalem', geonameId: 281184, country: 'IL', latitude: 31.769, longitude: 35.2163, timeZone: 'Asia/Jerusalem', elevationM: city('jerusalem').elevationM }), `Jerusalem: ${show(city('jerusalem'))}`);
    assert(city('new-york').geonameId === 5128581 && city('saint-petersburg').latitude === 59.9386, 'New York and Saint Petersburg from GeoNames');
  });

  await check('the haversine distance: 0 from a point to itself, the same both ways, Jerusalem to Tel Aviv 53.8 km, New York to Lakewood 70.8 km', () => {
    const j = city('jerusalem');
    const t = city('tel-aviv');
    assert(haversineKm(j, j) === 0, 'to itself');
    assert(Math.abs(haversineKm(j, t) - haversineKm(t, j)) < 1e-9, 'both ways');
    assert(Math.abs(haversineKm(j, t) - 53.79) < 0.05, `Jerusalem to Tel Aviv: ${haversineKm(j, t)}`);
    assert(Math.abs(haversineKm(city('new-york'), city('lakewood')) - 70.84) < 0.05, `New York to Lakewood: ${haversineKm(city('new-york'), city('lakewood'))}`);
  });

  await check('the UTC offset is read from the zone\'s clock: Israel 120 in winter and 180 in summer, switching at 2026-10-24T23:00Z; New York -300, Kolkata 330, Kathmandu 345, St John\'s -210, Sydney 660 in December; an unknown zone throws RangeError', () => {
    const want: Array<[string, Date, number]> = [
      ['Asia/Jerusalem', WINTER, 120],
      ['Asia/Jerusalem', SUMMER, 180],
      ['Asia/Jerusalem', new Date('2026-10-24T22:59:59Z'), 180],
      ['Asia/Jerusalem', new Date('2026-10-24T23:00:00Z'), 120],
      ['America/New_York', WINTER, -300],
      ['Asia/Kolkata', WINTER, 330],
      ['Asia/Kathmandu', WINTER, 345],
      ['America/St_Johns', WINTER, -210],
      ['Australia/Sydney', WINTER, 660],
      ['Asia/Amman', WINTER, 180],
      ['Europe/Kyiv', WINTER, 120],
      ['UTC', new Date('2026-12-01T10:00:00.999Z'), 0],
    ];
    const wrong = want.filter(([zone, when, minutes]) => utcOffsetMinutes(zone, when) !== minutes).map(([zone, when, minutes]) => `${zone} ${when.toISOString()}: ${utcOffsetMinutes(zone, when)}, want ${minutes}`);
    assert(wrong.length === 0, wrong.join('; '));
    let thrown: unknown = null;
    try {
      utcOffsetMinutes('Not/AZone', WINTER);
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof RangeError, `an unknown zone: ${String(thrown)}`);
  });

  await check('"Near me": within 30 km it opens the city (central Jerusalem); within 100 km and the same offset it names the city and the km (Mitzpe Ramon: Dimona, 56; Princeton: Lakewood, 48); far away it is none (Reykjavik); no city at all is none', () => {
    assert(OPEN_KM === 30 && NEAR_KM === 100, `${OPEN_KM} and ${NEAR_KM}`);
    assert(show(nearAnswer(at(31.778, 35.235), 'Asia/Jerusalem', WINTER, CITIES)) === show({ kind: 'open', slug: 'jerusalem' }), 'central Jerusalem');
    assert(show(nearAnswer(at(30.6094, 34.8011), 'Asia/Jerusalem', WINTER, CITIES)) === show({ kind: 'near', slug: 'dimona', km: 56 }), `Mitzpe Ramon: ${show(nearAnswer(at(30.6094, 34.8011), 'Asia/Jerusalem', WINTER, CITIES))}`);
    assert(show(nearAnswer(at(40.3573, -74.6672), 'America/New_York', WINTER, CITIES)) === show({ kind: 'near', slug: 'lakewood', km: 48 }), `Princeton: ${show(nearAnswer(at(40.3573, -74.6672), 'America/New_York', WINTER, CITIES))}`);
    assert(show(nearAnswer(at(64.1466, -21.9426), 'Atlantic/Reykjavik', WINTER, CITIES)) === show({ kind: 'none' }), 'Reykjavik');
    assert(show(nearAnswer(at(0, 0), 'UTC', WINTER, [])) === show({ kind: 'none' }), 'an empty list');
  });

  await check('"Near me" at the edges, south of Eilat (no other city near): 29.9 km opens it, 30.1 km and 99.9 km name it (30 and 100 km), 100.1 km is none', () => {
    const eilat = city('eilat');
    const south = (km: number) => at(eilat.latitude - degreesFor(km), eilat.longitude);
    const answers = [29.9, 30.1, 99.9, 100.1].map((km) => nearAnswer(south(km), 'Asia/Jerusalem', WINTER, CITIES));
    assert(
      show(answers) === show([{ kind: 'open', slug: 'eilat' }, { kind: 'near', slug: 'eilat', km: 30 }, { kind: 'near', slug: 'eilat', km: 100 }, { kind: 'none' }]),
      show(answers),
    );
  });

  await check('"Near me" in another offset is none: Amman (Asia/Amman, UTC+3 all year) is 64 km from Ma\'ale Adumim, none in December while Israel is on UTC+2, near in July when both are on UTC+3', () => {
    const amman = at(31.9552, 35.945);
    assert(show(nearAnswer(amman, 'Asia/Amman', WINTER, CITIES)) === show({ kind: 'none' }), `December: ${show(nearAnswer(amman, 'Asia/Amman', WINTER, CITIES))}`);
    assert(show(nearAnswer(amman, 'Asia/Amman', SUMMER, CITIES)) === show({ kind: 'near', slug: 'maale-adumim', km: 64 }), `July: ${show(nearAnswer(amman, 'Asia/Amman', SUMMER, CITIES))}`);
  });

  await check('"Near me" with a missing or odd device zone (review focus e: UTC while in Tel Aviv, empty, unknown, none at all): within 30 km it still opens the city, by distance alone; the near band needs a known zone in the city\'s offset, else none; nothing throws', () => {
    const telAviv = at(32.0809, 34.7806);
    const mitzpeRamon = at(30.6094, 34.8011);
    const reykjavik = at(64.1466, -21.9426);
    for (const zone of ['UTC', '', 'Not/AZone', 'garbage zone', undefined as unknown as string]) {
      let answers: unknown[] = [];
      try {
        answers = [nearAnswer(telAviv, zone, WINTER, CITIES), nearAnswer(mitzpeRamon, zone, WINTER, CITIES), nearAnswer(reykjavik, zone, WINTER, CITIES)];
      } catch (error) {
        throw new Error(`the device zone ${show(zone)} threw: ${String(error)}`);
      }
      assert(show(answers) === show([{ kind: 'open', slug: 'tel-aviv' }, { kind: 'none' }, { kind: 'none' }]), `the device zone ${show(zone)}: ${show(answers)}`);
    }
    assert(show(nearAnswer(mitzpeRamon, 'Asia/Jerusalem', WINTER, CITIES)) === show({ kind: 'near', slug: 'dimona', km: 56 }), 'a known zone in the city\'s offset still names it');
  });

  await check('the layering: cities.ts imports nothing; near-city.ts imports only the pure clock reader; elevation-grid.ts only a type; place.ts re-exports elevationGrid from it and defines none of its own', () => {
    assert(importsOf('src/site/cities.ts').length === 0, `cities.ts imports: ${show(importsOf('src/site/cities.ts'))}`);
    const near = importsOf('src/site/near-city.ts');
    assert(show(near) === show(["import { instantToWallTime } from '../utils/wall-time';"]), `near-city.ts imports: ${show(near)}`);
    assert(importsOf('src/utils/wall-time.ts').length === 0, 'wall-time.ts gained an import');
    const grid = importsOf('src/services/zmanim/elevation-grid.ts');
    assert(grid.length === 1 && /^import type \{ BoundingBox \} from '\.\.\/\.\.\/lib\/timezone';$/.test(grid[0]), `elevation-grid.ts imports: ${show(grid)}`);
    const place = readSource('src/services/zmanim/place.ts');
    assert(/export \{ elevationGrid, type Coordinates \} from '\.\/elevation-grid';/.test(place) && !/function elevationGrid\(/.test(place) && !/const GRID_SIDE/.test(place), 'place.ts still defines the grid');
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

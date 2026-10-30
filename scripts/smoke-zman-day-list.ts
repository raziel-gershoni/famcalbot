// Smoke test for the day's zmanim list at a place with no person in it (src/services/zmanim/day-list.ts,
// zmanDayForPlace) and the rest-day blocks it reads (src/services/zmanim/compute.ts, restDayBlocks). Spec:
// docs/superpowers/specs/2026-10-30-public-zmanim-design.md §6.1 and §8; plan Task 1.
//
// What it pins:
//   - restDayBlocks: the calendar's blocks of rest days with the set's edges (the eve's SHKIA, the last day's
//     SHABBAT_ENDS), two-day Yom Tov abroad and one in Israel, and every block whole even where the scan starts or
//     stops inside it;
//   - the pause is unchanged: shabbatYomTovWindows gives exactly what the function gave before the blocks (a frozen
//     copy below) over 400 days in Israel, New York and Saint Petersburg, in the three sets, for one civil day, one UTC
//     day (the pause's own ask), one instant and one 14-month range;
//   - the bot's sun sheet is unchanged: zmanDayForPlace gives exactly the list the old zmanDayList body gave (a frozen
//     copy below) for 400 days in Harish and New York, in the three sets;
//   - the far north: an eve whose block the sun gives no end still lights its candles (the day's own time, or a dash
//     where the sun makes no sunset), the last day has its end row with no time, and the pause holds no such window;
//     an end that falls after midnight (Riga in June) stays on its own Saturday;
//   - a caller's own memo and quiet: the process memo is left untouched and no missing zman is logged, with the same
//     rows as the process path.
//
// Pure: no database, Redis, network or env. This file re-runs itself once per server zone (UTC, Asia/Jerusalem,
// America/New_York) as child processes, so one command covers all three; nothing here may depend on the one the
// process has:
//   npx tsx scripts/smoke-zman-day-list.ts

import { spawn } from 'node:child_process';
import Module from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const ZONES = ['UTC', 'Asia/Jerusalem', 'America/New_York'] as const;
const CHILD = 'ZMAN_DAY_LIST_SMOKE_CHILD';

// ---- The parent: one child per process zone ----

async function runChildren(): Promise<void> {
  const outputs = await Promise.all(
    ZONES.map(
      zone =>
        new Promise<{ zone: string; code: number; text: string }>(resolve => {
          // process.execArgv carries tsx's loader flags, so the child compiles TypeScript the same way.
          const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], {
            env: { ...process.env, TZ: zone, [CHILD]: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let text = '';
          child.stdout.on('data', chunk => (text += chunk));
          child.stderr.on('data', chunk => (text += chunk));
          child.on('close', code => resolve({ zone, code: code ?? 1, text }));
        })
    )
  );
  let failed = 0;
  for (const { zone, code, text } of outputs) {
    console.log(`\n===== process TZ=${zone} =====\n${text.trimEnd()}`);
    if (code !== 0) failed++;
  }
  console.log(`\n${ZONES.length - failed}/${ZONES.length} process zones passed (${ZONES.join(', ')})`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---- Checks ----

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

function assertSame(got: unknown, want: unknown, label: string): void {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

/** Console output the call made, and what it returned. */
function logged<T>(fn: () => T): { value: T; lines: string[] } {
  const lines: string[] = [];
  const kept = { log: console.log, warn: console.warn, info: console.info, error: console.error };
  const take = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.log = take; console.warn = take; console.info = take; console.error = take;
  try {
    return { value: fn(), lines };
  } finally {
    Object.assign(console, kept);
  }
}

// ---- @hebcal/core is ESM-only and tsx loads src/ as CommonJS: point it at its ESM build before the modules under test load ----

const internals = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const resolveFilename = internals._resolveFilename;
internals._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.resolve(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};

type Place = { latitude: number; longitude: number; elevationM: number | null; timeZone: string };
type Community = 'sephardi' | 'ashkenazi' | 'chabad';
type Range = { from: Date; to: Date };
type Block = { eve: string; last: string; start: Date | null; end: Date | null };
type Row = { key: string; opinion: string | null; at: string | null };
type List = { community: Community; day: string; tz: string; rows: Row[]; hours: Array<{ opinion: string; ms: number | null }> };
type Memo = Map<string, number | null>;
type Compute = {
  zmanimForDay: (date: string, place: Place, community: Community, options?: { quiet?: boolean }) => Record<string, Date | null | undefined>;
  zmanInstant: (date: string, spec: { zman: string; offsetMin: number }, place: Place, community: Community) => Date | null;
  halachicHourMs: (date: string, place: Place, community: Community) => { day: number | null; mga: number | null };
  isYomTovAt: (day: string, place: Place) => boolean;
  restDayBlocks: (range: Range, place: Place, community: Community) => Block[];
  shabbatYomTovWindows: (range: Range, place: Place, community: Community, options?: { quiet?: boolean }) => Array<[Date, Date]>;
  inIsrael: (zone: string) => boolean;
};
type DayList = {
  zmanDayForPlace: (place: Place, community: Community, day: string, options?: { memo?: Memo; quiet?: boolean }) => List;
  lightsCandles: (blocks: readonly Block[], day: string) => boolean;
  __resetZmanClockForTests: () => void;
};
type Sets = {
  zmanimOfSet: (community: Community) => string[];
  zmanimSet: (community: Community) => { mgaDay?: unknown; zmanim: Record<string, { opinion?: string } | undefined> };
  communityCounting: (zman: string, community: Community) => Community | null;
  ZMAN_KEYS: readonly string[];
};
type Hebcal = {
  HDate: new (abs: number) => unknown;
  HebrewCalendar: { getHolidaysOnDate: (date: unknown, il: boolean) => Array<{ getFlags(): number }> | undefined };
  flags: { CHAG: number };
};

/* eslint-disable @typescript-eslint/no-require-imports */
const compute = require('../src/services/zmanim/compute') as Compute;
const dayList = require('../src/services/zmanim/day-list') as DayList;
const sets = require('../src/services/zmanim/sets') as Sets;
const days = require('../src/utils/day-events') as { addDaysToDate: (day: string, n: number) => string; localDate: (at: Date, zone: string) => string; startOfLocalDay: (day: string, zone: string) => Date };
const wall = require('../src/utils/wall-time') as { instantToWallTime: (instant: Date, zone: string) => string };
const hebcal = require('@hebcal/core') as Hebcal;
/* eslint-enable @typescript-eslint/no-require-imports */

// ---- Places ----

const HARISH: Place = { latitude: 32.46182, longitude: 35.04555, elevationM: 270, timeZone: 'Asia/Jerusalem' };
const JERUSALEM: Place = { latitude: 31.778, longitude: 35.235, elevationM: 754, timeZone: 'Asia/Jerusalem' };
const NEW_YORK: Place = { latitude: 40.7127, longitude: -74.006, elevationM: 10, timeZone: 'America/New_York' };
const LONDON: Place = { latitude: 51.50853, longitude: -0.12574, elevationM: null, timeZone: 'Europe/London' };
const SAINT_PETERSBURG: Place = { latitude: 59.93863, longitude: 30.31413, elevationM: null, timeZone: 'Europe/Moscow' };
const RIGA: Place = { latitude: 56.946, longitude: 24.10589, elevationM: null, timeZone: 'Europe/Riga' };
const SVALBARD: Place = { latitude: 78.22, longitude: 15.65, elevationM: 0, timeZone: 'Arctic/Longyearbyen' };
const COMMUNITIES: Community[] = ['sephardi', 'ashkenazi', 'chabad'];
const DAY_MS = 86_400_000;
const MINUTE = 60_000;

/** The civil day n days after 2026-09-01. */
const dayFrom = (n: number): string => new Date(Date.UTC(2026, 8, 1 + n)).toISOString().slice(0, 10);
const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();
const span = (blocks: Block[]): string[] => blocks.map(b => `${b.eve} -> ${b.last}`);
const isoPairs = (windows: Array<[Date, Date]>): string[][] => windows.map(([a, b]) => [a.toISOString(), b.toISOString()]);
const keysOf = (list: List): string[] => list.rows.map(r => r.key);
const rowOf = (list: List, key: string): Row => {
  const found = list.rows.find(r => r.key === key);
  assert(found, `${list.day}: no ${key} row in ${show(keysOf(list))}`);
  return found;
};
const processMemo = (): Memo => {
  const memo = (globalThis as { __zmanReminderAnswers?: Memo }).__zmanReminderAnswers;
  assert(memo instanceof Map, 'the process memo is on globalThis.__zmanReminderAnswers');
  return memo;
};

// ---- Frozen copies of the code before the blocks (HEAD ef987cc1): what the pause and the sun sheet must still give ----

/** compute.ts isRestDay, as it was. */
function legacyIsRestDay(day: string, il: boolean): boolean {
  if (weekdayOf(day) === 6) return true;
  const hdate = new hebcal.HDate(Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS) + 719_163);
  return (hebcal.HebrewCalendar.getHolidaysOnDate(hdate, il) ?? []).some(event => (event.getFlags() & hebcal.flags.CHAG) !== 0);
}

/** compute.ts shabbatYomTovWindows, as it was (without its log line). */
function legacyWindows(range: Range, place: Place, community: Community): Array<[Date, Date]> {
  const il = compute.inIsrael(place.timeZone);
  const fromDay = days.localDate(range.from, place.timeZone);
  const toDay = days.localDate(range.to, place.timeZone);
  const first = days.addDaysToDate(fromDay, -3);
  const last = days.addDaysToDate(toDay, 4);
  const windows: Array<[Date, Date]> = [];
  for (let day = first; day <= last; ) {
    if (!legacyIsRestDay(day, il)) {
      day = days.addDaysToDate(day, 1);
      continue;
    }
    let blockEnd = day;
    while (blockEnd < last && legacyIsRestDay(days.addDaysToDate(blockEnd, 1), il)) blockEnd = days.addDaysToDate(blockEnd, 1);
    const start = compute.zmanimForDay(days.addDaysToDate(day, -1), place, community, { quiet: true }).SHKIA ?? null;
    const end = compute.zmanimForDay(blockEnd, place, community, { quiet: true }).SHABBAT_ENDS ?? null;
    if (start && end && start.getTime() <= range.to.getTime() && end.getTime() > range.from.getTime()) windows.push([start, end]);
    day = days.addDaysToDate(blockEnd, 1);
  }
  return windows;
}

/** reminder-times.ts zmanDayList's body, as it was (the instants straight from zmanInstant, which the memo only remembers). */
function legacyList(place: Place, community: Community, day: string): List {
  const zone = place.timeZone;
  const set = sets.zmanimSet(community);
  const at = (zman: string): string | null => {
    const counting = sets.communityCounting(zman, community);
    return counting ? (compute.zmanInstant(day, { zman, offsetMin: 0 }, place, counting)?.toISOString() ?? null) : null;
  };
  const rows: Row[] = sets.zmanimOfSet(community).filter(key => key !== 'CANDLE_LIGHTING' && key !== 'SHABBAT_ENDS').map(key => ({ key, opinion: set.zmanim[key]?.opinion ?? null, at: at(key) }));
  const windows = legacyWindows({ from: days.startOfLocalDay(day, zone), to: days.startOfLocalDay(days.addDaysToDate(day, 1), zone) }, place, community);
  const weekday = weekdayOf(day);
  for (const [start, end] of windows) {
    const eve = days.localDate(start, zone);
    const last = days.localDate(end, zone);
    if (eve === day) rows.push({ key: 'CANDLE_LIGHTING', opinion: null, at: at('CANDLE_LIGHTING') });
    else if (eve < day && day < last) rows.push(weekday === 5 ? { key: 'CANDLE_LIGHTING', opinion: null, at: at('CANDLE_LIGHTING') } : { key: 'CANDLE_LIGHTING_NOT_BEFORE', opinion: null, at: at('SHABBAT_ENDS') });
    if (last === day) rows.push({ key: weekday !== 6 ? 'YOM_TOV_ENDS' : compute.isYomTovAt(day, place) ? 'SHABBAT_YOM_TOV_ENDS' : 'SHABBAT_ENDS', opinion: null, at: end.toISOString() });
  }
  const standsAt: Record<string, string> = { YOM_TOV_ENDS: 'SHABBAT_ENDS', SHABBAT_YOM_TOV_ENDS: 'SHABBAT_ENDS', CANDLE_LIGHTING_NOT_BEFORE: 'SHABBAT_ENDS' };
  const orderOf = (key: string) => sets.ZMAN_KEYS.indexOf(standsAt[key] ?? key);
  rows.sort((a, b) => orderOf(a.key) - orderOf(b.key));
  const hour = compute.halachicHourMs(day, place, community);
  const hours: List['hours'] = [{ opinion: set.zmanim.SOF_SHMA_GRA?.opinion ?? 'gra', ms: hour.day }];
  if (set.mgaDay) hours.push({ opinion: 'mga', ms: hour.mga });
  return { community, day, tz: zone, rows, hours };
}

async function runChecks(): Promise<void> {
  console.log(`process TZ=${process.env.TZ} (Intl: ${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  const noon = (from: string, to: string): Range => ({ from: new Date(`${from}T12:00:00Z`), to: new Date(`${to}T12:00:00Z`) });

  // ============ The blocks ============

  await check('restDayBlocks: the calendar\'s blocks with the set\'s edges, the eve\'s sunset row and the last day\'s end of Shabbat (Rosh Hashana 5787 with Shabbat as one block, then Shabbat Shuva and Yom Kippur)', () => {
    const blocks = compute.restDayBlocks(noon('2026-09-14', '2026-09-17'), JERUSALEM, 'sephardi');
    assertSame(span(blocks), ['2026-09-11 -> 2026-09-13', '2026-09-18 -> 2026-09-19', '2026-09-20 -> 2026-09-21'], 'the blocks');
    for (const block of blocks) {
      assert(block.start?.getTime() === compute.zmanimForDay(block.eve, JERUSALEM, 'sephardi').SHKIA?.getTime(), `${block.eve}: the start is the eve's SHKIA`);
      assert(block.end?.getTime() === compute.zmanimForDay(block.last, JERUSALEM, 'sephardi').SHABBAT_ENDS?.getTime(), `${block.last}: the end is the last day's SHABBAT_ENDS`);
    }
  });

  await check('restDayBlocks follows the place: Sukkot 2026 is one day in Jerusalem and two in New York', () => {
    assertSame(span(compute.restDayBlocks(noon('2026-09-24', '2026-09-24'), JERUSALEM, 'sephardi')), ['2026-09-20 -> 2026-09-21', '2026-09-25 -> 2026-09-26'], 'Jerusalem');
    assertSame(span(compute.restDayBlocks(noon('2026-09-24', '2026-09-24'), NEW_YORK, 'sephardi')), ['2026-09-20 -> 2026-09-21', '2026-09-25 -> 2026-09-27'], 'New York');
  });

  await check('a block is listed whole where the scan starts or stops inside it: Pesach 2027 in New York (Thursday, Friday and Shabbat) from a range that starts on Monday the 26th (the scan begins on the Friday) and from one that ends on Sunday the 18th (the scan stops on the Thursday)', () => {
    assertSame(span(compute.restDayBlocks(noon('2027-04-26', '2027-04-26'), NEW_YORK, 'sephardi')), ['2027-04-21 -> 2027-04-24', '2027-04-27 -> 2027-04-29'], 'the scan starts inside it');
    assertSame(span(compute.restDayBlocks(noon('2027-04-18', '2027-04-18'), NEW_YORK, 'sephardi')), ['2027-04-16 -> 2027-04-17', '2027-04-21 -> 2027-04-24'], 'the scan stops inside it');
  });

  // ============ The pause is unchanged ============

  for (const [label, place] of [['Israel', HARISH], ['New York', NEW_YORK], ['Saint Petersburg', SAINT_PETERSBURG]] as const) {
    await check(`the pause's windows are what they were, over 400 days from 2026-09-01 in ${label}, in the three sets: one civil day, one UTC day (as the pause asks), one instant, and one 14-month range`, () => {
      for (const community of COMMUNITIES) {
        for (let n = 0; n < 400; n++) {
          const day = dayFrom(n);
          const ranges: Range[] = [
            { from: days.startOfLocalDay(day, place.timeZone), to: days.startOfLocalDay(days.addDaysToDate(day, 1), place.timeZone) },
            { from: new Date(Date.parse(`${day}T00:00:00Z`)), to: new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS - 1) },
            { from: new Date(`${day}T17:30:00Z`), to: new Date(`${day}T17:30:00Z`) },
          ];
          for (const range of ranges) {
            const now = logged(() => compute.shabbatYomTovWindows(range, place, community)).value;
            assertSame(isoPairs(now), isoPairs(legacyWindows(range, place, community)), `${community} ${day} ${range.from.toISOString()}`);
          }
        }
        const long: Range = { from: new Date(Date.UTC(2026, 7, 28)), to: new Date(Date.UTC(2027, 10, 5)) };
        assertSame(isoPairs(logged(() => compute.shabbatYomTovWindows(long, place, community)).value), isoPairs(legacyWindows(long, place, community)), `${community}: 14 months`);
      }
    });
  }

  // ============ The sun sheet is unchanged ============

  for (const [label, place] of [['Harish', HARISH], ['New York', NEW_YORK]] as const) {
    await check(`the day list is what the sun sheet gave before, row for row, over 400 days from 2026-09-01 in ${label}, in the three sets`, () => {
      for (const community of COMMUNITIES) {
        for (let n = 0; n < 400; n++) {
          const day = dayFrom(n);
          assertSame(dayList.zmanDayForPlace(place, community, day, { memo: new Map() }), legacyList(place, community, day), `${community} ${day}`);
        }
      }
    });
  }

  await check('lightsCandles is the list\'s candle row: over 400 days in Harish and New York, a day has CANDLE_LIGHTING exactly when the blocks light candles on it, and every Friday does', () => {
    for (const place of [HARISH, NEW_YORK]) {
      for (let n = 0; n < 400; n++) {
        const day = dayFrom(n);
        const blocks = compute.restDayBlocks({ from: days.startOfLocalDay(day, place.timeZone), to: days.startOfLocalDay(days.addDaysToDate(day, 1), place.timeZone) }, place, 'sephardi');
        const lit = keysOf(dayList.zmanDayForPlace(place, 'sephardi', day, { memo: new Map() })).includes('CANDLE_LIGHTING');
        assert(lit === dayList.lightsCandles(blocks, day), `${place.timeZone} ${day}: the row ${lit}, the blocks ${dayList.lightsCandles(blocks, day)}`);
        if (weekdayOf(day) === 5) assert(lit, `${place.timeZone} ${day}: a Friday without candles`);
      }
    }
  });

  // ============ The far north ============

  await check('Saint Petersburg in June 2027 (Ashkenazi, 8.5 degrees never reached): Friday the 18th lights its candles at its own time, 20 minutes before the sunset row; Saturday the 19th has its end of Shabbat with no time, once, where the end stands; the pause holds no window it cannot end and says so, unless quiet', () => {
    const friday = dayList.zmanDayForPlace(SAINT_PETERSBURG, 'ashkenazi', '2027-06-18', { memo: new Map(), quiet: true });
    const own = compute.zmanimForDay('2027-06-18', SAINT_PETERSBURG, 'ashkenazi', { quiet: true });
    assert(rowOf(friday, 'CANDLE_LIGHTING').at === own.CANDLE_LIGHTING?.toISOString(), `the Friday's own candle lighting: ${rowOf(friday, 'CANDLE_LIGHTING').at}`);
    assert(Date.parse(rowOf(friday, 'SHKIA').at ?? '') - Date.parse(rowOf(friday, 'CANDLE_LIGHTING').at ?? '') === 20 * MINUTE, '20 minutes before the sunset row');
    assert(keysOf(friday).indexOf('CANDLE_LIGHTING') === keysOf(friday).indexOf('SHKIA') - 1, `in the order of the day: ${show(keysOf(friday))}`);
    const saturday = dayList.zmanDayForPlace(SAINT_PETERSBURG, 'ashkenazi', '2027-06-19', { memo: new Map(), quiet: true });
    assert(rowOf(saturday, 'SHABBAT_ENDS').at === null && keysOf(saturday).filter(k => k === 'SHABBAT_ENDS').length === 1, 'the end, with no time');
    assertSame(keysOf(saturday).slice(-2), ['SHABBAT_ENDS', 'CHATZOT_HALAYLA'], 'where the end stands');
    assert(!keysOf(saturday).includes('CANDLE_LIGHTING_NOT_BEFORE') && !keysOf(saturday).includes('CANDLE_LIGHTING'), `nothing else on the Saturday: ${show(keysOf(saturday))}`);
    const range = noon('2027-06-18', '2027-06-19');
    const said = logged(() => compute.shabbatYomTovWindows(range, SAINT_PETERSBURG, 'ashkenazi'));
    assertSame(said.value, [], 'no window');
    assertSame(said.lines, ['[zmanim] no end of Shabbat for the rest days 2027-06-19 to 2027-06-19: that window is left out'], 'logged');
    const quiet = logged(() => compute.shabbatYomTovWindows(range, SAINT_PETERSBURG, 'ashkenazi', { quiet: true }));
    assert(quiet.value.length === 0 && quiet.lines.length === 0, `quiet: ${show(quiet.lines)}`);
  });

  await check('Shavuot 2027 in Saint Petersburg (abroad: Thursday evening to Shabbat, no end): the eve lights, the Friday inside lights the Shabbat\'s candles, and the Saturday ends Shabbat and Yom Tov together with no time', () => {
    const at = (day: string) => dayList.zmanDayForPlace(SAINT_PETERSBURG, 'ashkenazi', day, { memo: new Map(), quiet: true });
    assert(typeof rowOf(at('2027-06-10'), 'CANDLE_LIGHTING').at === 'string', 'the eve');
    assert(typeof rowOf(at('2027-06-11'), 'CANDLE_LIGHTING').at === 'string' && !keysOf(at('2027-06-11')).includes('CANDLE_LIGHTING_NOT_BEFORE'), 'the Friday');
    assert(rowOf(at('2027-06-12'), 'SHABBAT_YOM_TOV_ENDS').at === null, 'the end');
  });

  await check('no sunset at all (Svalbard, June 2026): the Friday still has its candle row and the Saturday its end row, both a dash', () => {
    const friday = dayList.zmanDayForPlace(SVALBARD, 'sephardi', '2026-06-19', { memo: new Map(), quiet: true });
    const saturday = dayList.zmanDayForPlace(SVALBARD, 'sephardi', '2026-06-20', { memo: new Map(), quiet: true });
    assertSame(friday.rows.filter(r => r.key === 'CANDLE_LIGHTING'), [{ key: 'CANDLE_LIGHTING', opinion: null, at: null }], 'Friday');
    assertSame(saturday.rows.filter(r => r.key === 'SHABBAT_ENDS'), [{ key: 'SHABBAT_ENDS', opinion: null, at: null }], 'Saturday');
  });

  await check('an end after midnight stays on its own Saturday: Riga, Ashkenazi, 19 June 2027 ends at 00:21 on Sunday; the Saturday carries the end of Shabbat (not the candles "not before") and the Sunday carries no end', () => {
    const saturday = dayList.zmanDayForPlace(RIGA, 'ashkenazi', '2027-06-19', { memo: new Map(), quiet: true });
    const sunday = dayList.zmanDayForPlace(RIGA, 'ashkenazi', '2027-06-20', { memo: new Map(), quiet: true });
    const end = rowOf(saturday, 'SHABBAT_ENDS').at;
    assert(end !== null && wall.instantToWallTime(new Date(end), RIGA.timeZone).startsWith('2027-06-20T00:21'), `the end ${end}`);
    assert(!keysOf(saturday).includes('CANDLE_LIGHTING_NOT_BEFORE'), `Saturday ${show(keysOf(saturday))}`);
    assert(!keysOf(sunday).some(k => ['SHABBAT_ENDS', 'YOM_TOV_ENDS', 'SHABBAT_YOM_TOV_ENDS', 'CANDLE_LIGHTING_NOT_BEFORE'].includes(k)), `Sunday ${show(keysOf(sunday))}`);
    const windows = compute.shabbatYomTovWindows(noon('2027-06-18', '2027-06-20'), RIGA, 'ashkenazi');
    assert(windows.length === 1 && windows[0][1].toISOString() === end, 'the same instant the pause ends at');
  });

  // ============ The memo and the logs ============

  await check('a caller\'s own memo and quiet (the public pages): London on 21 June 2027 (Ashkenazi, no 16.1 degree dawn) leaves the process memo empty and logs nothing, with the same rows as the process path, which remembers and logs', () => {
    dayList.__resetZmanClockForTests();
    const own: Memo = new Map();
    const page = logged(() => dayList.zmanDayForPlace(LONDON, 'ashkenazi', '2027-06-21', { memo: own, quiet: true }));
    assert(processMemo().size === 0, `the process memo has ${processMemo().size} answers`);
    assert(own.size > 0, 'the page\'s memo has the answers');
    assertSame(page.lines, [], 'nothing logged');
    assert(rowOf(page.value, 'ALOT').at === null, 'dawn is a dash');
    const bot = logged(() => dayList.zmanDayForPlace(LONDON, 'ashkenazi', '2027-06-21'));
    assertSame(bot.value, page.value, 'the same list');
    assert(processMemo().size > 0, 'the process path remembers');
    assert(bot.lines.some(l => l.startsWith('[zmanim] no ALOT')), `the process path logs: ${show(bot.lines)}`);
    dayList.__resetZmanClockForTests();
    assert(processMemo().size === 0, 'reset');
  });

  report();
}

function report(): void {
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.env[CHILD] !== '1') {
  runChildren();
} else {
  runChecks().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

// Smoke test for zmanim (halachic times): src/services/zmanim/ (the three communities' sets as data,
// the one computation on @hebcal/core, the Shabbat and Yom Tov windows, and the place: coordinates and
// the highest ground, saved with a location and filled lazily). Plan:
// docs/superpowers/plans/2026-10-28-zmanim-reminders.md, Task 1.
//
// What it pins:
//   - Harish, 2026-10-28, 270 m, the Sephardi set, against the owner's Zmanei Yosef screenshot: every
//     zman within one minute after our rounding, and exactly what the independent derivation gives;
//   - Jerusalem and Bnei Brak on three days, to the second, against the research probe's hebcal table
//     (scratchpad zmanim-probe/out.json, values copied below);
//   - each set's formula on one day, re-derived here from hebcal's own methods and plain arithmetic;
//   - the direction each zman rounds, as Zmanei Yosef rounds it;
//   - the windows: sunset on the eve (the owner's ruling 2026-10-28; candle lighting is 20 minutes earlier and is
//     not the start) to the end of the last rest day, two-day Yom Tov abroad and one day in Israel, Yom Tov next
//     to Shabbat as one window, Rosh Hashana's two days, the minute either side of a window;
//   - DST days, a polar day (null and a log), elevation rules, the server's own zone never mattering;
//   - the location save (coordinates, the highest of the 25 sampled points, logged) and the lazy fill (once).
//
// Pure for the computation. The place's lookups run with Redis, Prisma, the geocoding fetch and
// error capture faked (the Nominatim and Open-Meteo answers are stubbed), so nothing reaches the network or a
// database. Process zone: this file re-runs itself once per server zone (UTC, Asia/Jerusalem,
// America/New_York) as child processes, so a plain `npx tsx scripts/smoke-zmanim.ts` and
// `bash scripts/ci-smokes.sh` both cover all three; nothing here may depend on the one the process has.
//   npx tsx scripts/smoke-zmanim.ts

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const ZONES = ['UTC', 'Asia/Jerusalem', 'America/New_York'] as const;
const CHILD = 'ZMANIM_SMOKE_CHILD';

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

// ---- @hebcal/core is ESM-only and tsx loads src/ as CommonJS: point it at its ESM build before the module under test loads ----

const internals = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string; _cache: Record<string, unknown> };
const resolveFilename = internals._resolveFilename;
internals._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.resolve(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};

type Place = { latitude: number; longitude: number; elevationM: number | null; timeZone: string };
type Community = 'sephardi' | 'ashkenazi' | 'chabad';
type ZmanSpec = { zman: string; offsetMin: number } | { halachicHours: number; offsetMin: number };
type Day = Record<string, Date | null | undefined>;
type Compute = {
  zmanimForDay: (date: string, place: Place, community: Community) => Day;
  exactZmanimForDay: (date: string, place: Place, community: Community) => Day;
  zmanInstant: (date: string, spec: ZmanSpec, place: Place, community: Community) => Date | null;
  shabbatYomTovWindows: (range: { from: Date; to: Date }, place: Place, community: Community) => Array<[Date, Date]>;
  halachicHourMs: (date: string, place: Place, community: Community) => { day: number | null; mga: number | null };
  inIsrael: (zone: string) => boolean;
};
type Sets = {
  zmanimOfSet: (community: Community) => string[];
  zmanimSet: (community: Community) => { frame: unknown; mgaDay?: unknown; zmanim: Record<string, { rule: { op: string; zman?: string }; round: string; opinion?: string }> };
  ZMAN_KEYS: readonly string[];
  COMMUNITIES: readonly string[];
  isCommunity: (value: unknown) => boolean;
  isZmanKey: (value: unknown) => boolean;
  DEFAULT_COMMUNITY: string;
};
type WallTime = { instantToWallTime: (instant: Date, zone: string) => string };
type Hebcal = {
  GeoLocation: new (name: string | null, lat: number, lon: number, elevation: number, tz: string) => unknown;
  Zmanim: new (gloc: unknown, date: Date, useElevation: boolean) => HebcalZmanim;
};
interface HebcalZmanim {
  sunrise(): Date; sunset(): Date; seaLevelSunrise(): Date; seaLevelSunset(): Date; timeAtAngle(angle: number, rising: boolean): Date;
  alotHaShachar(): Date; misheyakir(): Date; sofZmanShma(): Date; sofZmanTfilla(): Date; sofZmanShmaMGA16Point1(): Date;
  minchaKetana(): Date; plagHaMincha(): Date; tzeit(angle?: number): Date;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const compute = require('../src/services/zmanim/compute') as Compute;
const sets = require('../src/services/zmanim/sets') as Sets;
const wall = require('../src/utils/wall-time') as WallTime;
const hebcal = require('@hebcal/core') as Hebcal;
/* eslint-enable @typescript-eslint/no-require-imports */

// ---- Places ----

const HARISH: Place = { latitude: 32.46182, longitude: 35.04555, elevationM: 270, timeZone: 'Asia/Jerusalem' };
const JERUSALEM: Place = { latitude: 31.778, longitude: 35.235, elevationM: 754, timeZone: 'Asia/Jerusalem' };
const BNEI_BRAK: Place = { latitude: 32.083, longitude: 34.833, elevationM: 40, timeZone: 'Asia/Jerusalem' };
const NEW_YORK: Place = { latitude: 40.7127, longitude: -74.006, elevationM: 10, timeZone: 'America/New_York' };
const SVALBARD: Place = { latitude: 78.22, longitude: 15.65, elevationM: 0, timeZone: 'Arctic/Longyearbyen' };
const REYKJAVIK: Place = { latitude: 64.1466, longitude: -21.9426, elevationM: 20, timeZone: 'Atlantic/Reykjavik' };
const EIN_GEDI: Place = { latitude: 31.4614, longitude: 35.3898, elevationM: -400, timeZone: 'Asia/Jerusalem' };

const MINUTE = 60_000;

/** A clock reading in `zone`: 'HH:mm:ss', 'HH:mm' or the whole 'yyyy-MM-ddTHH:mm:ss'. */
const clock = (at: Date | null | undefined, zone = 'Asia/Jerusalem'): string => {
  assert(at instanceof Date && !Number.isNaN(at.getTime()), `not an instant: ${String(at)}`);
  return wall.instantToWallTime(at, zone).slice(11);
};
const hm = (at: Date | null | undefined, zone = 'Asia/Jerusalem'): string => clock(at, zone).slice(0, 5);
const wallOf = (at: Date, zone: string): string => wall.instantToWallTime(at, zone).slice(0, 16);
const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Console output the call made, and what it returned. */
async function logged<T>(fn: () => T | Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const kept = { log: console.log, warn: console.warn, info: console.info, error: console.error };
  const take = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.log = take; console.warn = take; console.info = take; console.error = take;
  try {
    return { value: await fn(), lines };
  } finally {
    Object.assign(console, kept);
  }
}

// ---- Independent derivations: hebcal's own methods and plain arithmetic, never the module's rules ----

/** hebcal's Zmanim for a civil day: handed a UTC noon, whose local date is the same day in every zone the smoke re-runs in. */
const hz = (place: Place, day: string, useElevation: boolean): HebcalZmanim =>
  new hebcal.Zmanim(new hebcal.GeoLocation(null, place.latitude, place.longitude, useElevation ? Math.max(0, place.elevationM ?? 0) : 0, place.timeZone), new Date(`${day}T12:00:00Z`), useElevation);
const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const ms = (d: Date): number => d.getTime();
const secondFloor = (value: number): number => Math.floor(value / 1000) * 1000;
const roundMinute = (value: number, direction: 'earlier' | 'later'): number => (direction === 'earlier' ? Math.floor(value / MINUTE) : Math.ceil(value / MINUTE)) * MINUTE;

/** Zmanei Yosef's direction for each zman (its published data's `round`): the one table every set shares. */
const DIRECTION: Record<string, 'earlier' | 'later'> = {
  ALOT: 'earlier', MISHEYAKIR: 'later', NETZ: 'later', SOF_SHMA_MGA: 'earlier', SOF_SHMA_GRA: 'earlier', SOF_TFILA: 'earlier',
  CHATZOT: 'earlier', MINCHA_GEDOLA: 'later', MINCHA_KETANA: 'later', PLAG_HALACHA_BERURA: 'later', PLAG_YALKUT_YOSEF: 'later',
  PLAG_GRA: 'later', CANDLE_LIGHTING: 'earlier', SHKIA: 'earlier', TZEIT: 'later', TZEIT_LECHUMRA: 'later', SHABBAT_ENDS: 'later',
  CHATZOT_HALAYLA: 'later',
};

/** The Sephardi set (Zmanei Yosef, Ohr HaChaim), derived from hebcal's sunrise and sunset with the elevation on in Israel and off abroad. */
function sephardiByHand(place: Place, day: string): Record<string, number> {
  const elevated = compute.inIsrael(place.timeZone);
  const z = hz(place, day, elevated);
  const rise = ms(z.sunrise()), set = ms(z.sunset());
  const hour = (set - rise) / 12, zm = hour / 60;
  const alot = rise - 72 * zm, tzeit = set + 13.5 * zm;
  const mgaHour = (set + 72 * zm - alot) / 12;
  const midday = (rise + set) / 2;
  const nextRise = ms(hz(place, nextDay(day), elevated).sunrise());
  return {
    ALOT: alot, MISHEYAKIR: rise - 60 * zm, NETZ: ms(hz(place, day, false).seaLevelSunrise()),
    SOF_SHMA_MGA: alot + 3 * mgaHour, SOF_SHMA_GRA: rise + 3 * hour, SOF_TFILA: rise + 4 * hour,
    CHATZOT: midday, MINCHA_GEDOLA: midday + Math.max(30 * MINUTE, hour / 2), MINCHA_KETANA: rise + 9.5 * hour,
    PLAG_HALACHA_BERURA: set - 1.25 * hour, PLAG_YALKUT_YOSEF: tzeit - 1.25 * hour,
    CANDLE_LIGHTING: set - 20 * MINUTE, SHKIA: set, TZEIT: tzeit, TZEIT_LECHUMRA: set + 20 * zm,
    // Zmanei Yosef's melakha: 30 clock minutes after the elevation sunset in Israel, the sun 7.165 degrees below the horizon abroad
    SHABBAT_ENDS: elevated ? set + 30 * MINUTE : ms(z.timeAtAngle(7.165, false)), CHATZOT_HALAYLA: (set + nextRise) / 2,
  };
}

/** The Israeli Ashkenazi set (sea level; 16.1, 11.5 and 8.5 degrees), from hebcal's own methods. */
function ashkenaziByHand(place: Place, day: string): Record<string, number> {
  const z = hz(place, day, false);
  const rise = ms(z.seaLevelSunrise()), set = ms(z.seaLevelSunset());
  const midday = (rise + set) / 2;
  const hour = (set - rise) / 12;
  const nextRise = ms(hz(place, nextDay(day), false).seaLevelSunrise());
  return {
    ALOT: ms(z.alotHaShachar()), MISHEYAKIR: ms(z.misheyakir()), NETZ: rise, SOF_SHMA_MGA: ms(z.sofZmanShmaMGA16Point1()),
    SOF_SHMA_GRA: ms(z.sofZmanShma()), SOF_TFILA: ms(z.sofZmanTfilla()), CHATZOT: midday,
    MINCHA_GEDOLA: midday + Math.max(30 * MINUTE, hour / 2), MINCHA_KETANA: ms(z.minchaKetana()), PLAG_GRA: ms(z.plagHaMincha()),
    CANDLE_LIGHTING: set - 20 * MINUTE, SHKIA: set, TZEIT: ms(z.tzeit(8.5)), SHABBAT_ENDS: ms(z.tzeit(8.5)), CHATZOT_HALAYLA: (set + nextRise) / 2,
  };
}

/** The Chabad set: the Baal HaTanya's day from netz amiti to shkiah amitis (1.583 degrees), by timeAtAngle. */
function chabadByHand(place: Place, day: string): Record<string, number> {
  const z = hz(place, day, false);
  const rise = ms(z.timeAtAngle(1.583, true)), set = ms(z.timeAtAngle(1.583, false));
  const hour = (set - rise) / 12;
  const nextRise = ms(hz(place, nextDay(day), false).timeAtAngle(1.583, true));
  return {
    ALOT: ms(z.timeAtAngle(16.9, true)), MISHEYAKIR: ms(z.timeAtAngle(10.2, true)), NETZ: ms(z.seaLevelSunrise()),
    SOF_SHMA_GRA: rise + 3 * hour, SOF_TFILA: rise + 4 * hour, CHATZOT: (rise + set) / 2, MINCHA_GEDOLA: rise + 6.5 * hour,
    MINCHA_KETANA: set - 2.5 * hour, PLAG_GRA: set - 1.25 * hour, CANDLE_LIGHTING: ms(z.seaLevelSunset()) - 20 * MINUTE,
    SHKIA: ms(z.seaLevelSunset()), TZEIT: ms(z.timeAtAngle(6, false)), SHABBAT_ENDS: ms(z.timeAtAngle(8.5, false)), CHATZOT_HALAYLA: (set + nextRise) / 2,
  };
}

const BY_HAND: Record<Community, (place: Place, day: string) => Record<string, number>> = { sephardi: sephardiByHand, ashkenazi: ashkenaziByHand, chabad: chabadByHand };

// ---- The location part: faked Redis, Prisma, geocoding fetch and error capture ----

type Row = Record<string, unknown>;
const stubbed = { redis: new Map<string, unknown>() };
const redisSets: { key: string; value: unknown; opts: unknown }[] = [];
const users = new Map<number, Row>();
const writes: { where: Row; data: Row }[] = [];
type Request = { url: string; timeoutMs: unknown; maxRetries: unknown };
const requests: Request[] = [];
const captured: { kind: string; context: string; message: string }[] = [];

type Answers = { nominatim: () => Response; zone: () => Response; elevation: (lats: number[], lons: number[]) => Response };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** Harish as Nominatim sends it: a 4 km box around the centre. */
const HARISH_BOX = ['32.4418', '32.4818', '35.0255', '35.0655'];
let answers: Answers;
let heldNominatim: Promise<void> | null = null;
/** Runs just before the next updateMany: a save that lands between the check and the write. */
let beforeWrite: (() => void) | null = null;

function seedAnswers(): void {
  answers = {
    nominatim: () => json([{ lat: '32.46182', lon: '35.04555', boundingbox: HARISH_BOX }]),
    zone: () => json({ timezone: 'Asia/Jerusalem' }),
    // Rising ground: the last of the 25 points is the highest, 289.6 m.
    elevation: lats => json({ elevation: lats.map((_lat, index) => 265 + index + (index === lats.length - 1 ? 0.6 : 0)) }),
  };
}

async function fakeFetchWithTimeout(url: string, _options?: unknown, timeoutMs?: unknown, maxRetries?: unknown): Promise<Response> {
  requests.push({ url, timeoutMs, maxRetries });
  const parsed = new URL(url);
  if (parsed.host === 'nominatim.openstreetmap.org') {
    if (heldNominatim) await heldNominatim;
    return answers.nominatim();
  }
  if (parsed.host === 'api.open-meteo.com' && parsed.pathname === '/v1/elevation') {
    const lats = (parsed.searchParams.get('latitude') ?? '').split(',').map(Number);
    const lons = (parsed.searchParams.get('longitude') ?? '').split(',').map(Number);
    return answers.elevation(lats, lons);
  }
  if (parsed.host === 'api.open-meteo.com') return answers.zone();
  throw new Error(`unexpected request: ${url}`);
}

function installStubs(): void {
  const stub = (rel: string, exports: Row) => {
    const filename = path.join(ROOT, rel);
    const mod = new (Module as unknown as new (id: string) => Row)(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    internals._cache[filename] = mod;
  };
  stub('src/utils/redis.ts', {
    redis: {
      get: async (key: string) => (stubbed.redis.has(key) ? stubbed.redis.get(key) : null),
      set: async (key: string, value: unknown, opts?: unknown) => { redisSets.push({ key, value, opts }); stubbed.redis.set(key, value); return 'OK'; },
      del: async (key: string) => (stubbed.redis.delete(key) ? 1 : 0),
    },
  });
  stub('src/utils/prisma.ts', {
    prisma: {
      user: {
        findUnique: async (args: { where: { id: number }; select: Row }) => {
          const row = users.get(args.where.id);
          return row ? Object.fromEntries(Object.keys(args.select).map(key => [key, row[key]])) : null;
        },
        updateMany: async (args: { where: { id: number; location: string }; data: Row }) => {
          writes.push({ where: args.where, data: args.data });
          beforeWrite?.();
          beforeWrite = null;
          const row = users.get(args.where.id);
          if (!row || row.location !== args.where.location) return { count: 0 };
          Object.assign(row, args.data);
          return { count: 1 };
        },
      },
    },
  });
  stub('src/lib/error-capture.ts', {
    captureError: (error: unknown, context: string) => { captured.push({ kind: 'error', context, message: error instanceof Error ? error.message : String(error) }); },
    captureWarning: (message: string, context: string) => { captured.push({ kind: 'warning', context, message }); },
    captureInfo: (message: string, context: string) => { captured.push({ kind: 'info', context, message }); },
  });
  stub('src/services/calendar.ts', { getUserCalendarTimezone: async () => null });
  stub('src/services/weather/geocoding.ts', {
    fetchWithTimeout: fakeFetchWithTimeout,
    geocodeLocation: async () => { throw new Error('the cached geocode path was used'); },
  });
}

function resetWorld(): void {
  stubbed.redis.clear();
  redisSets.length = 0;
  users.clear();
  writes.length = 0;
  requests.length = 0;
  captured.length = 0;
  heldNominatim = null;
  beforeWrite = null;
  seedAnswers();
  // The lazy fill's memory is on globalThis; each scenario starts without it.
  const fills = (globalThis as unknown as { __zmanimPlaceFill?: { running: Map<string, unknown>; filled: Map<string, unknown>; failedAt: Map<string, number> } }).__zmanimPlaceFill;
  fills?.running.clear();
  fills?.filled.clear();
  fills?.failedAt.clear();
}

// The golden tables --------------------------------------------------------------------------------------

/** The owner's Zmanei Yosef screenshot: Harish, 2026-10-28, elevation 270 m (minutes, 24-hour). */
const SCREENSHOT: Record<string, string> = {
  ALOT: '04:44', MISHEYAKIR: '04:56', NETZ: '05:53', SOF_SHMA_MGA: '08:04', SOF_SHMA_GRA: '08:37', SOF_TFILA: '09:32', CHATZOT: '11:23',
  MINCHA_GEDOLA: '11:54', MINCHA_KETANA: '14:38', PLAG_HALACHA_BERURA: '15:47', PLAG_YALKUT_YOSEF: '15:59', SHKIA: '16:56',
  TZEIT: '17:09', TZEIT_LECHUMRA: '17:14', CHATZOT_HALAYLA: '23:24',
};
/** What we show for Harish, pinned: the screenshot's rows within one minute (NETZ, MGA Shema, sunset and the stricter nightfall each differ by one: ZY's own solar calculator vs NOAA's, not the rounding). */
const OURS: Record<string, string> = {
  ALOT: '04:44', MISHEYAKIR: '04:56', NETZ: '05:54', SOF_SHMA_MGA: '08:03', SOF_SHMA_GRA: '08:37', SOF_TFILA: '09:32', CHATZOT: '11:23',
  MINCHA_GEDOLA: '11:54', MINCHA_KETANA: '14:38', PLAG_HALACHA_BERURA: '15:47', PLAG_YALKUT_YOSEF: '15:59', SHKIA: '16:55',
  TZEIT: '17:09', TZEIT_LECHUMRA: '17:15', CHATZOT_HALAYLA: '23:24', CANDLE_LIGHTING: '16:35', SHABBAT_ENDS: '17:26',
};

type Probe = { place: Place; day: string; zman: string; at: string };
/**
 * The zmanim hebcal derives from its sunrise and sunset to the millisecond (Shema, tefila, plag, mincha). We count from the same
 * times cut to whole seconds, so they may differ from hebcal's own methods by a second; every other row is equal to the second.
 */
const DERIVED = new Set(['SOF_SHMA_GRA', 'SOF_SHMA_MGA', 'SOF_TFILA', 'PLAG_GRA', 'MINCHA_GEDOLA', 'CHATZOT']);
const withinSecond = (got: Date | null | undefined, want: string, derived: boolean): boolean => {
  if (!got) return false;
  const wantMs = Date.parse(`${wall.instantToWallTime(got, 'Asia/Jerusalem').slice(0, 11)}${want}Z`); // the probe's clock, on the same date
  const gotMs = Date.parse(`${wall.instantToWallTime(got, 'Asia/Jerusalem')}Z`);
  return derived ? Math.abs(gotMs - wantMs) <= 1000 : gotMs === wantMs;
};
/** The research probe's hebcal values (zmanim-probe/out.json), sea level: they are the Ashkenazi set's exact values. */
const PROBE_SEA_LEVEL: Probe[] = [];
/** The same probe with the elevation on: the Sephardi set's sunset and GRA Shema. */
const PROBE_ELEVATION: Probe[] = [];
(function loadProbe(): void {
  const J = JERUSALEM, B = BNEI_BRAK;
  // [place, day, ALOT, NETZ, SOF_SHMA_GRA, SOF_SHMA_MGA, SOF_TFILA, CHATZOT, MINCHA_GEDOLA (null where half an hour is under the 30-minute floor), PLAG_GRA, SHKIA, TZEIT]
  const sea: Array<[Place, string, ...Array<string | null>]> = [
    [J, '2026-10-28', '04:38:48', '05:51:55', '08:37:15', '08:00:41', '09:32:22', '11:22:36', null, '15:44:23', '16:53:17', '17:30:15'],
    [J, '2026-03-27', '05:21:32', '06:34:11', '09:39:25', '09:03:08', '10:41:10', '12:44:40', '13:15:32', '17:37:58', '18:55:09', '19:31:28'],
    [J, '2026-06-21', '04:06:18', '05:34:02', '09:07:26', '08:23:34', '10:18:35', '12:40:51', '13:16:25', '18:18:46', '19:47:41', '20:29:59'],
    [B, '2026-10-28', '04:40:33', '05:53:54', '08:39:03', '08:02:22', '09:34:06', '11:24:12', null, '15:45:41', '16:54:30', '17:31:36'],
    [B, '2026-03-27', '05:22:47', '06:35:42', '09:40:59', '09:04:34', '10:42:45', '12:46:16', '13:17:09', '17:39:39', '18:56:51', '19:33:18'],
    [B, '2026-06-21', '04:06:38', '05:34:51', '09:08:39', '08:24:33', '10:19:56', '12:42:28', '13:18:06', '18:20:59', '19:50:04', '20:32:34'],
  ];
  const keys = ['ALOT', 'NETZ', 'SOF_SHMA_GRA', 'SOF_SHMA_MGA', 'SOF_TFILA', 'CHATZOT', 'MINCHA_GEDOLA', 'PLAG_GRA', 'SHKIA', 'TZEIT'];
  for (const [place, day, ...values] of sea) values.forEach((at, i) => { if (at) PROBE_SEA_LEVEL.push({ place, day, zman: keys[i], at }); });
  // [place, day, sunset with elevation, GRA Shema with elevation]
  const elevation: Array<[Place, string, string, string]> = [
    [J, '2026-10-28', '16:57:35', '08:35:07'], [J, '2026-03-27', '18:59:19', '09:37:21'], [J, '2026-06-21', '19:52:25', '09:05:04'],
    [B, '2026-10-28', '16:55:30', '08:38:34'], [B, '2026-03-27', '18:57:49', '09:40:30'], [B, '2026-06-21', '19:51:10', '09:08:07'],
  ];
  for (const [place, day, sunset, shema] of elevation) {
    PROBE_ELEVATION.push({ place, day, zman: 'SHKIA', at: sunset }, { place, day, zman: 'SOF_SHMA_GRA', at: shema });
  }
})();
/** The probe's GRA hour at sea level, in minutes (hebcal's column). */
const PROBE_HOUR_MIN: Array<[Place, string, number]> = [
  [JERUSALEM, '2026-10-28', 55.114], [JERUSALEM, '2026-03-27', 61.747], [JERUSALEM, '2026-06-21', 71.138],
  [BNEI_BRAK, '2026-10-28', 55.05], [BNEI_BRAK, '2026-03-27', 61.763], [BNEI_BRAK, '2026-06-21', 71.268],
];

// ---- The checks, in one process zone ----

async function runChecks(): Promise<void> {
  console.log(`process TZ=${process.env.TZ} (Intl: ${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  // Function reads: TypeScript would otherwise keep a length narrowed by an earlier assert across resetWorld().
  const nWrites = () => writes.length, nRequests = () => requests.length, nRedisSets = () => redisSets.length, nCaptured = () => captured.length;

  // ============ The sets ============

  await check('the three communities and their zmanim: Sephardi has all 17, Ashkenazi and Chabad leave out the second plag and the stricter nightfall, Chabad the Magen Avraham too; the keys are the ones a reminder stores', () => {
    assertSame([...sets.COMMUNITIES], ['sephardi', 'ashkenazi', 'chabad'], 'communities');
    assert(sets.DEFAULT_COMMUNITY === 'sephardi', 'the default is Sephardi (owner decision 1)');
    assert(sets.isCommunity('chabad') && !sets.isCommunity('yemenite') && !sets.isCommunity(null), 'isCommunity');
    assert(sets.isZmanKey('SOF_SHMA_GRA') && !sets.isZmanKey('SOF_SHEMA') && !sets.isZmanKey(3), 'isZmanKey');
    assertSame(sets.zmanimOfSet('sephardi'), ['ALOT', 'MISHEYAKIR', 'NETZ', 'SOF_SHMA_MGA', 'SOF_SHMA_GRA', 'SOF_TFILA', 'CHATZOT', 'MINCHA_GEDOLA', 'MINCHA_KETANA', 'PLAG_HALACHA_BERURA', 'PLAG_YALKUT_YOSEF', 'CANDLE_LIGHTING', 'SHKIA', 'TZEIT', 'TZEIT_LECHUMRA', 'SHABBAT_ENDS', 'CHATZOT_HALAYLA'], 'sephardi');
    assertSame(sets.zmanimOfSet('ashkenazi'), ['ALOT', 'MISHEYAKIR', 'NETZ', 'SOF_SHMA_MGA', 'SOF_SHMA_GRA', 'SOF_TFILA', 'CHATZOT', 'MINCHA_GEDOLA', 'MINCHA_KETANA', 'PLAG_GRA', 'CANDLE_LIGHTING', 'SHKIA', 'TZEIT', 'SHABBAT_ENDS', 'CHATZOT_HALAYLA'], 'ashkenazi');
    assertSame(sets.zmanimOfSet('chabad'), ['ALOT', 'MISHEYAKIR', 'NETZ', 'SOF_SHMA_GRA', 'SOF_TFILA', 'CHATZOT', 'MINCHA_GEDOLA', 'MINCHA_KETANA', 'PLAG_GRA', 'CANDLE_LIGHTING', 'SHKIA', 'TZEIT', 'SHABBAT_ENDS', 'CHATZOT_HALAYLA'], 'chabad');
    // Candle lighting and the end of Shabbat are in every set: the windows need them.
    for (const community of sets.COMMUNITIES as Community[]) {
      const keys = sets.zmanimOfSet(community);
      assert(keys.includes('CANDLE_LIGHTING') && keys.includes('SHABBAT_ENDS'), `${community} has candle lighting and the end of Shabbat`);
      for (const [key, entry] of Object.entries(sets.zmanimSet(community).zmanim)) {
        if (entry.rule.op === 'hoursFromZman') assert(entry.rule.zman !== undefined && keys.includes(entry.rule.zman), `${community} ${key} reads a zman the set has`);
        if (entry.rule.op === 'mgaHours') assert(sets.zmanimSet(community).mgaDay !== undefined, `${community} ${key} needs the Magen Avraham's day`);
      }
    }
  });

  await check('each zman rounds the way Zmanei Yosef rounds it, in every set: ends earlier (Shema, tefila, midday, sunset, candles), starts later (tallit, mincha, plag, nightfall, the end of Shabbat); dawn earlier and netz and midnight later are its exceptions', () => {
    for (const community of sets.COMMUNITIES as Community[]) {
      for (const [key, entry] of Object.entries(sets.zmanimSet(community).zmanim)) {
        assert(entry.round === DIRECTION[key], `${community} ${key} rounds ${entry.round}, Zmanei Yosef rounds it ${DIRECTION[key]}`);
      }
    }
  });

  await check('the opinion a zman is named with is in the set: GRA and Magen Avraham Shema, the two plags (Chabad: the Baal HaTanya\'s)', () => {
    const opinion = (community: Community, key: string) => sets.zmanimSet(community).zmanim[key]?.opinion;
    assertSame([opinion('sephardi', 'SOF_SHMA_GRA'), opinion('sephardi', 'SOF_SHMA_MGA'), opinion('sephardi', 'PLAG_HALACHA_BERURA'), opinion('sephardi', 'PLAG_YALKUT_YOSEF')], ['gra', 'mga', 'halachaBerura', 'yalkutYosef'], 'sephardi');
    assertSame([opinion('ashkenazi', 'SOF_SHMA_GRA'), opinion('ashkenazi', 'SOF_SHMA_MGA'), opinion('ashkenazi', 'PLAG_GRA')], ['gra', 'mga', 'gra'], 'ashkenazi');
    assertSame([opinion('chabad', 'SOF_SHMA_GRA'), opinion('chabad', 'PLAG_GRA')], ['baalHatanya', 'baalHatanya'], 'chabad');
  });

  // ============ Review Focus 1: Harish ============

  await check('Harish, 2026-10-28, elevation 270 m, the Sephardi set: every zman of the owner\'s Zmanei Yosef screenshot is within one minute of it', () => {
    const day = compute.zmanimForDay('2026-10-28', HARISH, 'sephardi');
    for (const [key, want] of Object.entries(SCREENSHOT)) {
      const got = hm(day[key]);
      const off = minutesOf(got) - minutesOf(want);
      assert(Math.abs(off) <= 1, `${key}: we show ${got}, the screenshot ${want}`);
    }
    // The hours: 55:25 (GRA) and 66:30 (Magen Avraham), to two seconds.
    const hours = compute.halachicHourMs('2026-10-28', HARISH, 'sephardi');
    assert(hours.day !== null && Math.abs(hours.day - (55 * 60 + 25) * 1000) <= 2000, `GRA hour ${hours.day}`);
    assert(hours.mga !== null && Math.abs(hours.mga - (66 * 60 + 30) * 1000) <= 2000, `MGA hour ${hours.mga}`);
  });

  await check('Harish: what we show is pinned (the rounding of each zman, candle lighting and the end of Shabbat included), and equals the independent derivation rounded the Zmanei Yosef way', () => {
    const day = compute.zmanimForDay('2026-10-28', HARISH, 'sephardi');
    const byHand = sephardiByHand(HARISH, '2026-10-28');
    for (const [key, want] of Object.entries(OURS)) {
      assert(hm(day[key]) === want, `${key}: shows ${hm(day[key])}, pinned ${want}`);
      const derived = new Date(roundMinute(secondFloor(byHand[key]), DIRECTION[key]));
      assert(hm(derived) === want, `${key}: the independent derivation rounds to ${hm(derived)}, pinned ${want}`);
    }
    // The rounded values sit on whole minutes.
    for (const key of Object.keys(OURS)) assert(day[key]!.getTime() % MINUTE === 0, `${key} is a whole minute`);
  });

  // ============ Probe tables, to the second ============

  await check('Jerusalem and Bnei Brak on 2026-10-28, 03-27 and 06-21: the Ashkenazi set\'s unrounded zmanim equal the research probe\'s hebcal values to the second, and the Sephardi sunset and GRA Shema (elevation 754 m and 40 m) equal its elevation columns', () => {
    for (const row of PROBE_SEA_LEVEL) {
      const exact = compute.exactZmanimForDay(row.day, row.place, 'ashkenazi');
      assert(withinSecond(exact[row.zman], row.at, DERIVED.has(row.zman)), `${row.place.elevationM === 754 ? 'Jerusalem' : 'Bnei Brak'} ${row.day} ${row.zman}: ${clock(exact[row.zman])}, the probe ${row.at}`);
    }
    for (const row of PROBE_ELEVATION) {
      const exact = compute.exactZmanimForDay(row.day, row.place, 'sephardi');
      assert(withinSecond(exact[row.zman], row.at, DERIVED.has(row.zman)), `${row.place.elevationM === 754 ? 'Jerusalem' : 'Bnei Brak'} ${row.day} ${row.zman} with elevation: ${clock(exact[row.zman])}, the probe ${row.at}`);
    }
  });

  await check('the 30-minute floor on mincha gedola: in October, when half an hour is 27.5 minutes, it is midday plus 30 minutes (hebcal alone gives 11:50:09 in Jerusalem); in March and June, when half an hour is longer, it is hebcal\'s', () => {
    const october = compute.exactZmanimForDay('2026-10-28', JERUSALEM, 'ashkenazi');
    assert(clock(october.CHATZOT) === '11:22:36' && clock(october.MINCHA_GEDOLA) === '11:52:36', `October: midday ${clock(october.CHATZOT)}, gedola ${clock(october.MINCHA_GEDOLA)}`);
    const sephardi = compute.exactZmanimForDay('2026-10-28', JERUSALEM, 'sephardi');
    assert(ms(sephardi.MINCHA_GEDOLA!) - ms(sephardi.CHATZOT!) === 30 * MINUTE, 'Sephardi: midday plus 30 minutes');
  });

  await check('the halachic hour: the Ashkenazi day hour equals the probe\'s sea-level GRA hour in Jerusalem and Bnei Brak on all three days; Chabad\'s netz amiti to shkiah amitis day is the longer one', () => {
    for (const [place, day, minutes] of PROBE_HOUR_MIN) {
      const hour = compute.halachicHourMs(day, place, 'ashkenazi').day;
      assert(hour !== null && Math.abs(hour / MINUTE - minutes) < 0.0015, `${day}: ${hour! / MINUTE} min, the probe ${minutes}`);
    }
    const gra = compute.halachicHourMs('2026-10-28', HARISH, 'ashkenazi');
    const baal = compute.halachicHourMs('2026-10-28', HARISH, 'chabad');
    assert(gra.day !== null && baal.day !== null && baal.day > gra.day && baal.mga === null, 'Chabad\'s hour is longer and has no Magen Avraham hour');
    assert(gra.mga !== null && gra.mga > gra.day!, 'the Magen Avraham\'s hour is longer than the GRA\'s');
  });

  // ============ Each set's formula on one day ============

  await check('the Sephardi set on Jerusalem 2026-03-27, 754 m: every zman equals the independent derivation to the second (dawn 72, tallit 60, nightfall 13.5 and 20 halachic minutes; Magen Avraham 72 to 72; two plags; Shabbat ends 30 minutes after sunset in Israel)', () => {
    const exact = compute.exactZmanimForDay('2026-03-27', JERUSALEM, 'sephardi');
    const byHand = sephardiByHand(JERUSALEM, '2026-03-27');
    for (const key of sets.zmanimOfSet('sephardi')) {
      assert(Math.abs(ms(exact[key]!) - byHand[key]) <= 1000, `${key}: ${clock(exact[key])} vs ${new Date(byHand[key]).toISOString()}`);
    }
  });

  await check('the Sephardi end of Shabbat follows Zmanei Yosef\'s melakha: 30 clock minutes after the elevation sunset in Israel, the sun 7.165 degrees below the horizon abroad (New York in winter, spring and summer, against hebcal\'s own timeAtAngle); 30 minutes after sunset would let a message out up to ten minutes early', () => {
    const israel = compute.exactZmanimForDay('2026-03-27', JERUSALEM, 'sephardi');
    assert(ms(israel.SHABBAT_ENDS!) - ms(israel.SHKIA!) === 30 * MINUTE, 'Israel: 30 minutes after sunset');
    for (const day of ['2026-12-19', '2027-03-20', '2027-06-19']) {
      const z = hz(NEW_YORK, day, false);
      const exact = compute.exactZmanimForDay(day, NEW_YORK, 'sephardi').SHABBAT_ENDS!;
      assert(Math.abs(ms(exact) - ms(z.timeAtAngle(7.165, false))) <= 1000, `${day}: ${clock(exact, 'America/New_York')} vs 7.165 degrees ${clock(z.timeAtAngle(7.165, false), 'America/New_York')}`);
      const shown = compute.zmanimForDay(day, NEW_YORK, 'sephardi').SHABBAT_ENDS!;
      assert(ms(shown) === roundMinute(secondFloor(ms(z.timeAtAngle(7.165, false))), 'later'), `${day}: shown ${hm(shown, 'America/New_York')}`);
      // 7, 3 and 10 minutes later than 30 minutes after the sea-level sunset (what a message would have been sent in).
      assert(ms(shown) - roundMinute(ms(z.sunset()) + 30 * MINUTE, 'later') >= 3 * MINUTE, `${day}: ${hm(shown, 'America/New_York')} is not 3 minutes or more after sunset plus 30`);
    }
    assert(hm(compute.zmanimForDay('2026-12-19', NEW_YORK, 'sephardi').SHABBAT_ENDS, 'America/New_York') === '17:09', 'New York, 19 December 2026');
    // Only the end of Shabbat changes abroad: the rest of the Sephardi set there still equals the hand derivation.
    const abroad = compute.exactZmanimForDay('2026-12-19', NEW_YORK, 'sephardi');
    const byHand = sephardiByHand(NEW_YORK, '2026-12-19');
    for (const key of sets.zmanimOfSet('sephardi')) assert(Math.abs(ms(abroad[key]!) - byHand[key]) <= 1000, `${key} abroad: ${clock(abroad[key], 'America/New_York')} vs ${new Date(byHand[key]).toISOString()}`);
  });

  await check('the Ashkenazi set on Bnei Brak 2026-06-21 and the Chabad set on Jerusalem 2026-03-27: every zman equals the independent derivation to the second', () => {
    for (const [community, place, day] of [['ashkenazi', BNEI_BRAK, '2026-06-21'], ['chabad', JERUSALEM, '2026-03-27']] as Array<[Community, Place, string]>) {
      const exact = compute.exactZmanimForDay(day, place, community);
      const byHand = BY_HAND[community](place, day);
      for (const key of sets.zmanimOfSet(community)) {
        assert(Math.abs(ms(exact[key]!) - byHand[key]) <= 1000, `${community} ${key}: ${clock(exact[key])} vs ${new Date(byHand[key]).toISOString()}`);
      }
    }
  });

  await check('the rounding is the set\'s direction and only that: shown is the exact value floored (earlier) or ceiled (later) to the minute, for every zman of every set', () => {
    for (const [community, place, day] of [['sephardi', HARISH, '2026-10-28'], ['ashkenazi', JERUSALEM, '2026-06-21'], ['chabad', BNEI_BRAK, '2026-03-27']] as Array<[Community, Place, string]>) {
      const exact = compute.exactZmanimForDay(day, place, community);
      const shown = compute.zmanimForDay(day, place, community);
      for (const key of sets.zmanimOfSet(community)) {
        assert(ms(shown[key]!) === roundMinute(ms(exact[key]!), DIRECTION[key]), `${community} ${key}: shown ${clock(shown[key])} for exact ${clock(exact[key])}`);
      }
    }
  });

  // ============ Elevation ============

  await check('elevation follows the set: Sephardi uses it in Israel (sunset later, hours longer) and ignores it abroad; Ashkenazi and Chabad never use it; no elevation or null reads as sea level; below sea level (the Dead Sea) is sea level and does not throw', () => {
    const at = (place: Place, community: Community) => compute.exactZmanimForDay('2026-10-28', place, community).SHKIA!.getTime();
    const sea = { ...HARISH, elevationM: 0 };
    assert(at(HARISH, 'sephardi') > at(sea, 'sephardi'), 'Sephardi in Israel at 270 m sets later than at sea level');
    assert(at(HARISH, 'ashkenazi') === at(sea, 'ashkenazi'), 'Ashkenazi ignores elevation in Israel');
    assert(at(HARISH, 'chabad') === at(sea, 'chabad'), 'Chabad ignores elevation in Israel');
    assert(at(HARISH, 'sephardi') === compute.exactZmanimForDay('2026-10-28', HARISH, 'sephardi').SHKIA!.getTime(), 'repeatable');
    assert(at({ ...HARISH, elevationM: null }, 'sephardi') === at(sea, 'sephardi'), 'null elevation is sea level');
    const abroad = { ...NEW_YORK, elevationM: 500 };
    assert(at(abroad, 'sephardi') === at({ ...abroad, elevationM: 0 }, 'sephardi'), 'Sephardi abroad uses sea level (Zmanei Yosef)');
    assert(compute.inIsrael('Asia/Jerusalem') && !compute.inIsrael('America/New_York'), 'inIsrael');
    assert(at(EIN_GEDI, 'sephardi') === at({ ...EIN_GEDI, elevationM: 0 }, 'sephardi'), 'below sea level reads as sea level');
  });

  // ============ The reminder\'s time ============

  await check('zmanInstant: "10 minutes before sof zman Shema (GRA)" on Harish is 08:27 (the plan\'s example), "at" is the zman as shown, a later offset adds clock minutes, and "3 halachic hours after sunrise" is the elevation sunrise plus three hours, rounded earlier', () => {
    const before = compute.zmanInstant('2026-10-28', { zman: 'SOF_SHMA_GRA', offsetMin: -10 }, HARISH, 'sephardi');
    assert(hm(before) === '08:27', `10 minutes before: ${hm(before)}`);
    assert(hm(compute.zmanInstant('2026-10-28', { zman: 'SOF_SHMA_GRA', offsetMin: 0 }, HARISH, 'sephardi')) === '08:37', 'at the zman');
    assert(hm(compute.zmanInstant('2026-10-28', { zman: 'PLAG_HALACHA_BERURA', offsetMin: 25 }, HARISH, 'sephardi')) === '16:12', 'after the zman');
    // The elevation sunrise 05:50:57 plus 3 x 55:24 is 08:37:09: the same minute as Shema (GRA).
    assert(hm(compute.zmanInstant('2026-10-28', { halachicHours: 3, offsetMin: 0 }, HARISH, 'sephardi')) === '08:37', '3 halachic hours');
    assert(hm(compute.zmanInstant('2026-10-28', { halachicHours: 0, offsetMin: 0 }, HARISH, 'sephardi')) === '05:50', 'the elevation sunrise, rounded earlier');
    assert(hm(compute.zmanInstant('2026-10-28', { halachicHours: 6, offsetMin: 5 }, HARISH, 'sephardi')) === '11:28', 'six hours and 5 minutes');
  });

  await check('a zman reminder across places and days: two people in different cities get two times, each day differs, and the zman is the one their community\'s set computes', () => {
    const spec = { zman: 'SOF_SHMA_GRA', offsetMin: -10 };
    const israel = compute.zmanInstant('2026-10-28', spec, HARISH, 'sephardi')!;
    const newYork = compute.zmanInstant('2026-10-28', spec, NEW_YORK, 'sephardi')!;
    assert(hm(israel) === '08:27' && israel.getTime() !== newYork.getTime(), 'two places, two instants');
    const newYorkWant = new Date(roundMinute(secondFloor(sephardiByHand(NEW_YORK, '2026-10-28').SOF_SHMA_GRA), 'earlier') - 10 * MINUTE);
    assert(newYork.getTime() === newYorkWant.getTime(), `New York: ${hm(newYork, 'America/New_York')}, derived ${hm(newYorkWant, 'America/New_York')}`);
    // Day to day the time moves by less than a minute, so days ten apart: each differs.
    const days = ['2026-10-18', '2026-10-28', '2026-11-07'].map(day => compute.zmanInstant(day, spec, HARISH, 'sephardi')!.getTime());
    assert(new Set(days.map(t => t % 86_400_000)).size === 3, `each day's time differs: ${show(days.map(t => new Date(t).toISOString()))}`);
    const ashkenazi = compute.zmanInstant('2026-10-28', spec, HARISH, 'ashkenazi')!;
    assert(ashkenazi.getTime() !== israel.getTime(), 'the community changes the zman');
    const ashkenaziWant = new Date(roundMinute(secondFloor(ashkenaziByHand(HARISH, '2026-10-28').SOF_SHMA_GRA), 'earlier') - 10 * MINUTE);
    assert(ashkenazi.getTime() === ashkenaziWant.getTime(), `the Ashkenazi 10 minutes before: ${hm(ashkenazi)}, derived ${hm(ashkenaziWant)}`);
  });

  await check('zmanInstant refuses what it cannot answer, null and logged: a zman the set does not have, a polar day, an offset that is no number, hours out of range', async () => {
    const none = await logged(() => compute.zmanInstant('2026-10-28', { zman: 'PLAG_YALKUT_YOSEF', offsetMin: 0 }, HARISH, 'ashkenazi'));
    assert(none.value === null && none.lines.some(l => l.startsWith('[zmanim]') && l.includes('PLAG_YALKUT_YOSEF')), `no such zman: ${show(none)}`);
    const polar = await logged(() => compute.zmanInstant('2026-06-21', { zman: 'SOF_SHMA_GRA', offsetMin: -10 }, SVALBARD, 'sephardi'));
    assert(polar.value === null && polar.lines.length === 1 && polar.lines[0].startsWith('[zmanim]') && polar.lines[0].includes('SOF_SHMA_GRA'), `polar: ${show(polar)}`);
    const polarHours = await logged(() => compute.zmanInstant('2026-06-21', { halachicHours: 3, offsetMin: 0 }, SVALBARD, 'sephardi'));
    assert(polarHours.value === null && polarHours.lines.length === 1 && polarHours.lines[0].startsWith('[zmanim]'), `polar hours: ${show(polarHours)}`);
    for (const spec of [{ zman: 'SOF_SHMA_GRA', offsetMin: Number.NaN }, { halachicHours: 13, offsetMin: 0 }, { halachicHours: -1, offsetMin: 0 }, { halachicHours: Number.NaN, offsetMin: 0 }] as ZmanSpec[]) {
      const bad = await logged(() => compute.zmanInstant('2026-10-28', spec, HARISH, 'sephardi'));
      assert(bad.value === null && bad.lines.length === 1 && bad.lines[0].startsWith('[zmanim]'), `${show(spec)}: ${show(bad)}`);
    }
    let thrown = '';
    try { compute.zmanimForDay('2026-02-30', HARISH, 'sephardi'); } catch (error) { thrown = (error as Error).message; }
    assert(thrown.includes('[zmanim]') && thrown.includes('2026-02-30'), `a day that is not a real one is refused: ${thrown}`);
  });

  await check('a polar day: the zman that does not exist is null and the call logs it once ([zmanim]); the ones that do exist stay (Reykjavik in June has a sunrise but no 16.1 degree dawn, no nightfall)', async () => {
    const svalbard = await logged(() => compute.zmanimForDay('2026-06-21', SVALBARD, 'sephardi'));
    assert(svalbard.value.NETZ === null && svalbard.value.SHKIA === null && svalbard.value.SOF_SHMA_GRA === null, 'no sunrise or sunset at 78 degrees north on the solstice');
    assert(svalbard.lines.length === 1 && svalbard.lines[0].startsWith('[zmanim]') && svalbard.lines[0].includes('NETZ'), `one log line: ${show(svalbard.lines)}`);
    const reykjavik = await logged(() => compute.zmanimForDay('2026-06-21', REYKJAVIK, 'ashkenazi'));
    assert(reykjavik.value.NETZ instanceof Date && reykjavik.value.SHKIA instanceof Date && reykjavik.value.SOF_SHMA_GRA instanceof Date, 'sunrise, sunset and Shema exist');
    assert(reykjavik.value.ALOT === null && reykjavik.value.TZEIT === null && reykjavik.value.SHABBAT_ENDS === null, 'the sun never gets 16.1 or 8.5 degrees below the horizon');
    assert(reykjavik.lines.length === 1 && reykjavik.lines[0].includes('ALOT') && reykjavik.lines[0].includes('TZEIT'), `one log line: ${show(reykjavik.lines)}`);
    const quiet = await logged(() => compute.zmanimForDay('2026-10-28', HARISH, 'sephardi'));
    assert(quiet.lines.length === 0, `an ordinary day logs nothing: ${show(quiet.lines)}`);
  });

  // ============ The server's own zone never matters ============

  await check('summer/winter time days: the instants are right on the days Israel and New York change their clocks, read on the person\'s clock through the resolver (not the server\'s)', () => {
    const cases: Array<[Place, string]> = [
      [JERUSALEM, '2026-03-27'], [JERUSALEM, '2026-03-28'], [JERUSALEM, '2026-10-25'], [JERUSALEM, '2026-10-24'],
      [NEW_YORK, '2026-03-08'], [NEW_YORK, '2026-11-01'], [NEW_YORK, '2026-03-07'], [NEW_YORK, '2026-11-02'],
    ];
    for (const [place, day] of cases) {
      const shown = compute.zmanimForDay(day, place, 'sephardi');
      const byHand = sephardiByHand(place, day);
      for (const key of ['NETZ', 'SOF_SHMA_GRA', 'SHKIA', 'TZEIT']) {
        const want = new Date(roundMinute(secondFloor(byHand[key]), DIRECTION[key]));
        assert(shown[key]!.getTime() === want.getTime(), `${place.timeZone} ${day} ${key}: ${hm(shown[key], place.timeZone)} vs ${hm(want, place.timeZone)}`);
      }
      // A morning clock for the sunrise and an evening one for the sunset: a day built on the wrong offset would read an hour out.
      assert(minutesOf(hm(shown.NETZ, place.timeZone)) >= 5 * 60 && minutesOf(hm(shown.NETZ, place.timeZone)) <= 7 * 60 + 30, `${day} sunrise reads ${hm(shown.NETZ, place.timeZone)}`);
      assert(minutesOf(hm(shown.SHKIA, place.timeZone)) >= 16 * 60 && minutesOf(hm(shown.SHKIA, place.timeZone)) <= 19 * 60 + 30, `${day} sunset reads ${hm(shown.SHKIA, place.timeZone)}`);
    }
    // Israel springs forward on the morning of 2026-03-27: that day's sunrise is on the summer clock (UTC+3).
    assert(wallOf(compute.zmanimForDay('2026-03-27', JERUSALEM, 'sephardi').NETZ!, 'Asia/Jerusalem') === '2026-03-27T06:35', 'the jump day\'s sunrise');
    assert(wallOf(compute.zmanimForDay('2026-10-25', JERUSALEM, 'sephardi').NETZ!, 'Asia/Jerusalem') === '2026-10-25T05:50', 'the fall-back day\'s sunrise (UTC+2: 05:49:34 sea level, shown later)');
    assert(wallOf(compute.zmanimForDay('2026-10-24', JERUSALEM, 'sephardi').NETZ!, 'Asia/Jerusalem') === '2026-10-24T06:49', 'the day before it is still on the summer clock (UTC+3: 06:48:47)');
    // The same zman computed in this process and reading the person's clock is the same instant whatever the process zone.
    assert(compute.zmanimForDay('2026-10-28', HARISH, 'sephardi').SOF_SHMA_GRA!.toISOString() === '2026-10-28T06:37:00.000Z', 'Shema (GRA) in Harish is 06:37Z');
  });

  // ============ The windows ============

  const windowsAround = (from: string, to: string, place: Place, community: Community = 'sephardi') =>
    compute.shabbatYomTovWindows({ from: new Date(`${from}T00:00:00Z`), to: new Date(`${to}T00:00:00Z`) }, place, community);
  /** Windows as local 'start date -> end date'. */
  const dates = (windows: Array<[Date, Date]>, zone: string) => windows.map(([a, b]) => `${wallOf(a, zone).slice(0, 10)} -> ${wallOf(b, zone).slice(0, 10)}`);
  const inside = (windows: Array<[Date, Date]>, at: number) => windows.some(([a, b]) => a.getTime() <= at && at < b.getTime());

  await check('a plain Shabbat: sunset on Friday (the plain sunset row, rounded earlier; candle lighting is 20 minutes before it and is not the start) to the end of Shabbat on Saturday (sunset plus 30, rounded later); the minute before it starts and the minute it ends are outside, the edges inside', () => {
    const windows = windowsAround('2026-10-29', '2026-11-02', JERUSALEM);
    assertSame(dates(windows, 'Asia/Jerusalem'), ['2026-10-30 -> 2026-10-31'], 'one window');
    const [start, end] = windows[0];
    const friday = sephardiByHand(JERUSALEM, '2026-10-30'), saturday = sephardiByHand(JERUSALEM, '2026-10-31');
    assert(start.getTime() === roundMinute(secondFloor(friday.SHKIA), 'earlier'), `starts at sunset ${hm(start)}`);
    assert(end.getTime() === roundMinute(secondFloor(saturday.SHABBAT_ENDS), 'later'), `ends at the end of Shabbat ${hm(end)}`);
    const shownFriday = compute.zmanimForDay('2026-10-30', JERUSALEM, 'sephardi');
    assert(start.getTime() === shownFriday.SHKIA!.getTime(), 'the same sunset zmanimForDay shows as the plain sunset row');
    assert(shownFriday.CANDLE_LIGHTING!.getTime() === start.getTime() - 20 * MINUTE, `candle lighting is 20 minutes before the start: ${hm(shownFriday.CANDLE_LIGHTING!)} ${hm(start)}`);
    assert(!inside(windows, start.getTime() - MINUTE) && inside(windows, start.getTime()) && inside(windows, start.getTime() + MINUTE), 'the start');
    assert(!inside(windows, shownFriday.CANDLE_LIGHTING!.getTime()) && !inside(windows, start.getTime() - 5 * MINUTE), 'candle lighting and the minutes after it are outside the window');
    assert(inside(windows, end.getTime() - 1) && !inside(windows, end.getTime()) && !inside(windows, end.getTime() + MINUTE), 'the end: the minute after the window is outside');
    assertSame(windowsAround('2026-10-26', '2026-10-29', JERUSALEM), [], 'a weekday has none');
  });

  await check('a window is found from any instant in it: a range that is one instant (Friday evening at sunset, Saturday noon, Saturday evening before the end) returns it; a range wholly before or after does not', () => {
    const [start, end] = windowsAround('2026-10-29', '2026-11-02', JERUSALEM)[0];
    for (const at of [start.getTime(), start.getTime() + 3 * 3_600_000, end.getTime() - 1]) {
      const found = compute.shabbatYomTovWindows({ from: new Date(at), to: new Date(at) }, JERUSALEM, 'sephardi');
      assertSame(found.map(([a, b]) => [a.toISOString(), b.toISOString()]), [[start.toISOString(), end.toISOString()]], `at ${new Date(at).toISOString()}`);
    }
    for (const at of [start.getTime() - MINUTE, end.getTime()]) {
      assertSame(compute.shabbatYomTovWindows({ from: new Date(at), to: new Date(at) }, JERUSALEM, 'sephardi'), [], `at ${new Date(at).toISOString()}`);
    }
    const two = windowsAround('2026-10-29', '2026-11-08', JERUSALEM);
    assertSame(dates(two, 'Asia/Jerusalem'), ['2026-10-30 -> 2026-10-31', '2026-11-06 -> 2026-11-07'], 'two Shabbatot in order');
  });

  await check('Rosh Hashana\'s two days in Israel: one window from the eve to the end of the second day, on a Saturday-Sunday year (5787) and on a weekday year (5786, Tuesday and Wednesday); Yom Kippur is a window of its own', () => {
    assertSame(dates(windowsAround('2026-09-09', '2026-09-15', JERUSALEM), 'Asia/Jerusalem'), ['2026-09-11 -> 2026-09-13'], '5787: Friday evening to Sunday night (Shabbat and the two days are one)');
    assertSame(dates(windowsAround('2025-09-21', '2025-09-26', JERUSALEM), 'Asia/Jerusalem'), ['2025-09-22 -> 2025-09-24'], '5786: Monday evening to Wednesday night');
    assertSame(dates(windowsAround('2027-09-30', '2027-10-05', JERUSALEM), 'Asia/Jerusalem'), ['2027-10-01 -> 2027-10-03'], '5788');
    assertSame(dates(windowsAround('2026-09-19', '2026-09-23', JERUSALEM), 'Asia/Jerusalem'), ['2026-09-18 -> 2026-09-19', '2026-09-20 -> 2026-09-21'], 'Shabbat, then Yom Kippur on Monday');
  });

  await check('Yom Tov abroad is two days and in Israel one, by the place: Sukkot 2026 (Saturday and Sunday abroad), Shemini Atzeret and Simchat Torah, Pesach 2027 (the second day next to Shabbat is one window abroad; in Israel Friday is a weekday and Shabbat its own window)', () => {
    assertSame(dates(windowsAround('2026-09-24', '2026-09-29', JERUSALEM), 'Asia/Jerusalem'), ['2026-09-25 -> 2026-09-26'], 'Sukkot in Israel');
    assertSame(dates(windowsAround('2026-09-24', '2026-09-29', NEW_YORK), 'America/New_York'), ['2026-09-25 -> 2026-09-27'], 'Sukkot abroad');
    assertSame(dates(windowsAround('2026-10-01', '2026-10-06', JERUSALEM), 'Asia/Jerusalem'), ['2026-10-02 -> 2026-10-03'], 'Shemini Atzeret in Israel');
    assertSame(dates(windowsAround('2026-10-01', '2026-10-06', NEW_YORK), 'America/New_York'), ['2026-10-02 -> 2026-10-04'], 'Shemini Atzeret and Simchat Torah abroad');
    assertSame(dates(windowsAround('2027-04-19', '2027-04-27', JERUSALEM), 'Asia/Jerusalem'), ['2027-04-21 -> 2027-04-22', '2027-04-23 -> 2027-04-24'], 'Pesach in Israel: Thursday, then Shabbat');
    assertSame(dates(windowsAround('2027-04-19', '2027-04-27', NEW_YORK), 'America/New_York'), ['2027-04-21 -> 2027-04-24'], 'Pesach abroad: Thursday and Friday Yom Tov with Shabbat, one window');
    assertSame(dates(windowsAround('2027-06-08', '2027-06-14', JERUSALEM), 'Asia/Jerusalem'), ['2027-06-10 -> 2027-06-12'], 'Shavuot on a Friday, then Shabbat: one window');
  });

  await check('a window\'s edges are the set\'s: the Ashkenazi window ends at 8.5 degrees, the Chabad one at 8.5 and both start at their own sunset (the Chabad one the sea-level sunset); the same Shabbat is a different window in each set', () => {
    for (const community of ['ashkenazi', 'chabad'] as Community[]) {
      const [start, end] = windowsAround('2026-10-29', '2026-11-02', NEW_YORK, community)[0];
      const shown = compute.zmanimForDay('2026-10-30', NEW_YORK, community);
      assert(start.getTime() === shown.SHKIA!.getTime(), `${community} start is its sunset`);
      assert(start.getTime() - shown.CANDLE_LIGHTING!.getTime() === 20 * MINUTE, `${community}: candle lighting is 20 minutes before the start`);
      assert(end.getTime() === compute.zmanimForDay('2026-10-31', NEW_YORK, community).SHABBAT_ENDS!.getTime(), `${community} end`);
    }
    const end = (window: [Date, Date]) => window[1].getTime();
    const sephardi = windowsAround('2026-10-29', '2026-11-02', NEW_YORK, 'sephardi')[0];
    const ashkenazi = windowsAround('2026-10-29', '2026-11-02', NEW_YORK, 'ashkenazi')[0];
    assert(sephardi[1].getTime() < ashkenazi[1].getTime(), 'Sephardi Shabbat ends at 7.165 degrees abroad, earlier than 8.5 degrees in New York in autumn');
    assert(end(sephardi) === compute.zmanimForDay('2026-10-31', NEW_YORK, 'sephardi').SHABBAT_ENDS!.getTime(), 'and the window ends at the set\'s end of Shabbat');
    assert(sephardi[0].getTime() === compute.zmanimForDay('2026-10-30', NEW_YORK, 'sephardi').SHKIA!.getTime(), 'the Sephardi start abroad is the sea-level sunset');
  });

  await check('the start is the set\'s own sunset where the sets differ in the height: Jerusalem (754 m) on Friday 2026-10-30, the Sephardi window starts at the elevation sunset and the Chabad one at the sea-level sunset, earlier; each is the plain sunset row of its set', () => {
    const sephardi = windowsAround('2026-10-29', '2026-11-02', JERUSALEM, 'sephardi')[0];
    const chabad = windowsAround('2026-10-29', '2026-11-02', JERUSALEM, 'chabad')[0];
    assert(sephardi[0].getTime() === compute.zmanimForDay('2026-10-30', JERUSALEM, 'sephardi').SHKIA!.getTime(), 'Sephardi: the elevation sunset');
    assert(chabad[0].getTime() === compute.zmanimForDay('2026-10-30', JERUSALEM, 'chabad').SHKIA!.getTime(), 'Chabad: the sea-level sunset');
    assert(chabad[0].getTime() < sephardi[0].getTime(), `Chabad ${hm(chabad[0])} starts before Sephardi ${hm(sephardi[0])}`);
  });

  await check('the windows on a change-of-clock Friday (Israel 2026-03-27) read on the person\'s clock: sunset is after the jump (UTC+3), and the window still ends the next night', () => {
    const windows = windowsAround('2026-03-26', '2026-03-30', JERUSALEM);
    assertSame(dates(windows, 'Asia/Jerusalem'), ['2026-03-27 -> 2026-03-28'], 'the jump Friday');
    assert(minutesOf(hm(windows[0][0])) >= 18 * 60 + 35 && minutesOf(hm(windows[0][0])) <= 19 * 60 + 15, `sunset reads ${hm(windows[0][0])}`);
    const fall = windowsAround('2026-10-23', '2026-10-27', JERUSALEM);
    assertSame(dates(fall, 'Asia/Jerusalem'), ['2026-10-23 -> 2026-10-24'], 'the Friday before the fall-back Sunday');
  });

  await check('a window whose sunset or end does not exist (the sun never gets 8.5 degrees below the horizon in Reykjavik in June; no sunset at 78 degrees north) is left out and logged', async () => {
    const reykjavik = await logged(() => windowsAround('2026-06-24', '2026-06-29', REYKJAVIK, 'ashkenazi'));
    assertSame(reykjavik.value, [], 'Reykjavik');
    assert(reykjavik.lines.some(l => l.startsWith('[zmanim]') && l.includes('end of Shabbat')), `logged: ${show(reykjavik.lines)}`);
    const svalbard = await logged(() => windowsAround('2026-06-24', '2026-06-29', SVALBARD));
    assertSame(svalbard.value, [], 'Svalbard');
    assert(svalbard.lines.some(l => l.startsWith('[zmanim]') && l.includes('no sunset')), `logged: ${show(svalbard.lines)}`);
  });

  // ============ Server only ============

  await check('server only: no client component or Mini App module imports src/services/zmanim, and the module loads nothing client-side (hebcal, the day and wall-time helpers, no React); the day list (day-list.ts) imports only pure modules', () => {
    const offenders: string[] = [];
    const scan = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) scan(file);
        else if (/\.(tsx?|jsx?)$/.test(name)) {
          const text = readFileSync(file, 'utf8');
          if (/^\s*['"]use client['"]/m.test(text) && /services\/zmanim/.test(text)) offenders.push(path.relative(ROOT, file));
        }
      }
    };
    for (const dir of ['app', 'components', 'src/lib/calendar-view']) scan(path.join(ROOT, dir));
    assertSame(offenders, [], "'use client' files that import the zmanim module");
    for (const file of ['sets.ts', 'compute.ts', 'day-list.ts']) {
      const text = readFileSync(path.join(ROOT, 'src/services/zmanim', file), 'utf8');
      assert(!/from ['"](react|next|@prisma|@upstash)/.test(text) && !/utils\/(prisma|redis)/.test(text), `${file} imports no database, Redis or React`);
    }
    // The day list is what the public pages import: only the calculator, the sets, the spec reader, the day helpers and
    // the client-safe list types, never the place lookups (place.ts: Prisma, Redis, Nominatim) or the reminder clock.
    const dayListImports = [...readFileSync(path.join(ROOT, 'src/services/zmanim/day-list.ts'), 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]);
    assertSame(dayListImports, ['./compute', './sets', './spec', '../../lib/calendar-view/zman-spec', '../../lib/calendar-view/zmanim-list', '../../utils/day-events'], 'day-list.ts imports');
    for (const file of ['compute.ts', 'day-list.ts']) {
      assert(!/fromZonedTime|\.set(Hours|Date|Month|FullYear|Minutes|Seconds)\(/.test(readFileSync(path.join(ROOT, 'src/services/zmanim', file), 'utf8')), `${file} builds no instant from local fields`);
    }
  });

  // ============ The schema and the migration ============

  await check('the schema has the five columns and the migration adds each one only if missing, and sets the pause for the Jewish calendar with a plain UPDATE', () => {
    const schema = readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');
    for (const line of [/latitude\s+Float\?/, /longitude\s+Float\?/, /elevationM\s+Int\?/, /zmanimCommunity\s+String\s+@default\("sephardi"\)/, /pauseOnShabbat\s+Boolean\s+@default\(false\)/]) {
      assert(line.test(schema), `schema.prisma lacks ${line}`);
    }
    const sql = readFileSync(path.join(ROOT, 'prisma/migrations/20261028010000_zmanim_user/migration.sql'), 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    for (const column of ['"latitude" DOUBLE PRECISION', '"longitude" DOUBLE PRECISION', '"elevationM" INTEGER', '"zmanimCommunity" TEXT NOT NULL DEFAULT \'sephardi\'', '"pauseOnShabbat" BOOLEAN NOT NULL DEFAULT false']) {
      assert(sql.includes(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS ${column};`), `the migration lacks ADD COLUMN IF NOT EXISTS ${column}`);
    }
    assert(/UPDATE "User" SET "pauseOnShabbat" = true WHERE "culture" = 'jewish';/.test(sql), 'the Jewish calendar\'s users get the pause on');
    assert((sql.match(/ADD COLUMN/g) ?? []).length === 5 && !/DROP|ALTER COLUMN|NOT NULL(?! DEFAULT)/.test(sql), 'additions only');
  });

  // ============ The place: the location save and the lazy fill ============

  installStubs();
  const place = require('../src/services/zmanim/place') as { // eslint-disable-line @typescript-eslint/no-require-imports
    elevationGrid: (centre: { latitude: number; longitude: number }, box: [number, number, number, number] | null) => Array<{ latitude: number; longitude: number }>;
    saveUserPlace: (userId: number, location: string) => Promise<{ latitude: number; longitude: number; elevationM: number | null; timeZone: string | null } | null>;
    ensureUserCoordinates: (user: PlaceUserRow, options?: { background?: boolean }) => Promise<{ latitude: number; longitude: number; elevationM: number | null } | null>;
    retryMissingElevation: (user: PlaceUserRow, zone: string) => void;
    getUserPlace: (user: PlaceUserRow) => Promise<Place | null>;
    placeOf: (user: { latitude: number | null; longitude: number | null; elevationM: number | null }, zone: string) => Place | null;
  };
  const gate = require('../src/services/native-reminders/due-gate') as { // eslint-disable-line @typescript-eslint/no-require-imports
    setNextDue: (next: Date | null, now: Date) => void;
    shouldRunPass: (now: Date) => boolean;
    __resetDueGateForTests: () => void;
  };
  const reminderTimes = require('../src/services/zmanim/reminder-times') as { // eslint-disable-line @typescript-eslint/no-require-imports
    zmanEditorInfo: (user: never, zone: string, today: string) => Promise<{ place: string; zmanim: Array<{ key: string; at: string | null }> }>;
  };
  type PlaceUserRow = { id: number; location: string; latitude: number | null; longitude: number | null; elevationM: number | null };
  const userRow = (id: number, location: string, extra: Row = {}): PlaceUserRow => {
    const row = { id, location, latitude: null, longitude: null, elevationM: null, ...extra };
    users.set(id, row);
    return row as PlaceUserRow;
  };
  const elevationRequest = () => requests.find(r => new URL(r.url).pathname === '/v1/elevation');
  const shape = () => requests.map(r => `${new URL(r.url).host}${new URL(r.url).pathname === '/v1/elevation' ? '/elevation' : ''} ${String(r.timeoutMs)}/${String(r.maxRetries)}`);

  await check('the elevation grid: 5 x 5 over the bounding box, the corners of a small box are its corners, a large box is held to 3 km around the centre on each axis, and there is just the centre where Nominatim sent no box', () => {
    const centre = { latitude: 32.46182, longitude: 35.04555 };
    const small = place.elevationGrid(centre, [32.455, 32.465, 35.04, 35.05]);
    assert(small.length === 25, `${small.length} points`);
    assertSame([small[0], small[24]], [{ latitude: 32.455, longitude: 35.04 }, { latitude: 32.465, longitude: 35.05 }], 'the corners');
    assert(small[12].latitude === 32.46 && small[12].longitude === 35.045, 'the middle');
    const big = place.elevationGrid({ latitude: 31.778, longitude: 35.235 }, [31.7191, 31.8546, 35.1218, 35.2646]);
    assert(big.length === 25, '25 points');
    for (const point of big) {
      assert(Math.abs(point.latitude - 31.778) * 111_320 <= 3000.5, `${point.latitude} is more than 3 km north-south`);
      assert(Math.abs(point.longitude - 35.235) * 111_320 * Math.cos((31.778 * Math.PI) / 180) <= 3000.5, `${point.longitude} is more than 3 km east-west`);
    }
    assert(Math.abs(big[0].latitude - (31.778 - 3000 / 111_320)) < 1e-9, 'held to 3 km, not to the box');
    assertSame(place.elevationGrid(centre, null), [centre], 'no box');
    assertSame(place.elevationGrid(centre, [40, 41, 10, 11]), [centre], 'a box that does not hold the centre gives just the centre');
  });

  await check('a saved location: one Nominatim, one zone and one elevation request (3 s, no retry, the elevation in one call of 25 points), the coordinates and the HIGHEST of the 25 are stored once, the zone is cached, and the centre and the maximum are logged', async () => {
    resetWorld();
    userRow(7, 'Harish, Israel');
    const out = await logged(() => place.saveUserPlace(7, 'Harish, Israel'));
    assertSame(shape(), ['nominatim.openstreetmap.org 3000/0', 'api.open-meteo.com 3000/0', 'api.open-meteo.com/elevation 3000/0'], 'requests');
    const url = new URL(elevationRequest()!.url);
    assert(url.origin + url.pathname === 'https://api.open-meteo.com/v1/elevation', url.toString());
    assert(url.searchParams.get('latitude')!.split(',').length === 25 && url.searchParams.get('longitude')!.split(',').length === 25, '25 points in one call');
    assertSame(out.value, { latitude: 32.46182, longitude: 35.04555, elevationM: 290, timeZone: 'Asia/Jerusalem' }, 'the result: the highest of 265..289.6, rounded');
    assertSame(writes.map(w => w.data), [{ latitude: 32.46182, longitude: 35.04555, elevationM: 290 }], 'one write of the coordinates and the maximum');
    assertSame(writes[0].where, { id: 7, location: 'Harish, Israel' }, 'compare and set on the location');
    assertSame(redisSets, [{ key: 'tz:user:7', value: 'Asia/Jerusalem', opts: { ex: 86400 } }], 'the zone is cached for 24 h');
    assert(out.lines.some(l => l.startsWith('[zmanim]') && l.includes('user 7') && l.includes('32.4618,35.0455') && l.includes('290 m')), `logged centre and maximum: ${show(out.lines)}`);
    assert(!out.lines.some(l => l.includes('Harish')), 'the place\'s name is never logged');
    assert(nCaptured() === 0, `captured ${show(captured)}`);
  });

  await check('the elevation request failing never blocks saving the place: a 503, a network error, an answer with no numbers, each keeps the coordinates with a null elevation, caches the zone and logs', async () => {
    const failures: Array<[string, () => Response, string]> = [
      ['503', () => json({ error: true, reason: 'busy' }, 503), 'warning'],
      ['network error', () => { throw new TypeError('fetch failed'); }, 'error'],
      ['no numbers', () => json({ elevation: [] }), 'warning'],
      ['not an object', () => json({ reason: 'x' }), 'warning'],
    ];
    for (const [name, answer, kind] of failures) {
      resetWorld();
      userRow(7, 'Harish, Israel');
      answers.elevation = answer;
      const saved = await place.saveUserPlace(7, 'Harish, Israel');
      assertSame(saved, { latitude: 32.46182, longitude: 35.04555, elevationM: null, timeZone: 'Asia/Jerusalem' }, `${name}: the place is kept`);
      assertSame(writes.map(w => w.data), [{ latitude: 32.46182, longitude: 35.04555, elevationM: null }], `${name}: coordinates written with a null elevation`);
      assert(nRedisSets() === 1, `${name}: the zone is still cached`);
      assert(nCaptured() === 1 && captured[0].kind === kind && captured[0].context === 'zmanim-elevation', `${name}: logged ${show(captured)}`);
    }
  });

  await check('the zone request failing still saves the coordinates and the elevation, and leaves the cached zone alone; Nominatim finding nothing writes nothing and asks for no elevation', async () => {
    resetWorld();
    userRow(7, 'Harish, Israel');
    stubbed.redis.set('tz:user:7', 'Europe/London');
    answers.zone = () => json({ error: true }, 503);
    const saved = await place.saveUserPlace(7, 'Harish, Israel');
    assert(saved !== null && saved.timeZone === null && saved.elevationM === 290, `saved ${show(saved)}`);
    assert(nWrites() === 1 && nRedisSets() === 0 && stubbed.redis.get('tz:user:7') === 'Europe/London', 'coordinates written, zone untouched');
    resetWorld();
    userRow(7, 'Atlantis');
    answers.nominatim = () => json([]);
    const lost = await logged(() => place.saveUserPlace(7, 'Atlantis'));
    assert(lost.value === null && nWrites() === 0 && elevationRequest() === undefined, 'nothing written, no elevation request');
    assert(lost.lines.some(l => l.startsWith('[zmanim]') && l.includes('user 7')), `logged: ${show(lost.lines)}`);
  });

  await check('a location that changed while it was looked up (two quick saves) is not overwritten by the older lookup: nothing is written, the zone cache stays', async () => {
    resetWorld();
    userRow(7, 'Harish, Israel');
    let release = () => {};
    heldNominatim = new Promise<void>(resolve => { release = resolve; });
    const pending = logged(() => place.saveUserPlace(7, 'Harish, Israel'));
    users.get(7)!.location = 'New York'; // the person saved another place meanwhile
    release();
    const done = await pending;
    assert(done.value === null && nWrites() === 0 && nRedisSets() === 0, `written anyway: ${show(writes)}`);
    assert(done.lines.some(l => l.includes('changed while it was looked up')), `logged: ${show(done.lines)}`);
    // And one that changes between the check and the write: the compare-and-set finds no row to update.
    resetWorld();
    userRow(7, 'Harish, Israel');
    beforeWrite = () => { users.get(7)!.location = 'New York'; };
    const racing = await logged(() => place.saveUserPlace(7, 'Harish, Israel'));
    assert(racing.value === null && nWrites() === 1 && users.get(7)!.latitude === null && nRedisSets() === 0, `the write found a row: ${show(users.get(7))}`);
    assert(racing.lines.some(l => l.includes('changed while it was saved')), `logged: ${show(racing.lines)}`);
  });

  await check('the lazy fill happens once: a user with a place name and no coordinates is filled on first need (one lookup, one write, logged), and later needs, from the same stale user object or a fresh one, ask nothing; two at once share one lookup', async () => {
    resetWorld();
    // The user as a caller read it before the fill. (The stand-in database mutates the row it stores, so a copy is kept.)
    const stale = { ...userRow(11, 'Harish, Israel') };
    const first = await logged(() => place.ensureUserCoordinates({ ...stale }));
    assertSame(first.value, { latitude: 32.46182, longitude: 35.04555, elevationM: 290 }, 'filled');
    assert(nRequests() === 3 && nWrites() === 1, `first need: ${shape().length} requests, ${nWrites()} writes`);
    assert(first.lines.some(l => l.startsWith('[zmanim]') && l.includes('user 11') && l.includes('filling')), `logged: ${show(first.lines)}`);
    const again = await place.ensureUserCoordinates({ ...stale }); // the caller still holds the user as it was
    assertSame(again, first.value, 'the same answer');
    assert(nRequests() === 3 && nWrites() === 1, 'the second need asks nothing');
    const fresh = await place.ensureUserCoordinates({ ...stale, latitude: 32.46182, longitude: 35.04555, elevationM: 290 });
    assert(fresh !== null && nRequests() === 3, 'a user that has coordinates asks nothing');
    assertSame([users.get(11)!.latitude, users.get(11)!.longitude, users.get(11)!.elevationM], [32.46182, 35.04555, 290], 'cached in the database');
    // A user read from a cache that predates the columns has them missing, not null: that is no coordinates either.
    resetWorld();
    userRow(13, 'Harish, Israel');
    const cached = await place.ensureUserCoordinates({ id: 13, location: 'Harish, Israel' } as never);
    assert(cached !== null && cached.latitude === 32.46182 && nRequests() === 3, `a user with the columns missing is filled: ${show(cached)}`);
    assert(place.placeOf({} as never, 'Asia/Jerusalem') === null, 'placeOf with the columns missing');
    assert(stale.latitude === null, 'the caller\'s copy is still the stale one');

    resetWorld();
    const racer = userRow(12, 'Harish, Israel');
    const both = await Promise.all([place.ensureUserCoordinates({ ...racer }), place.ensureUserCoordinates({ ...racer })]);
    assert(both[0] !== null && both[0] === both[1], 'one answer');
    assert(nRequests() === 3 && nWrites() === 1, `two needs at once: ${nRequests()} requests`);
  });

  await check('the lazy fill leaves out a user with no place name (nothing asked), and a place the lookup does not find is not looked up again within the hour (null, logged, retried after)', async () => {
    resetWorld();
    assert(await place.ensureUserCoordinates(userRow(21, '   ')) === null && nRequests() === 0, 'no place name');
    answers.nominatim = () => json([]);
    const lost = userRow(22, 'Atlantis');
    assert(await place.ensureUserCoordinates({ ...lost }) === null && nRequests() === 1, 'not found');
    assert(await place.ensureUserCoordinates({ ...lost }) === null && nRequests() === 1, 'not looked up again');
    const state = (globalThis as unknown as { __zmanimPlaceFill: { failedAt: Map<string, number> } }).__zmanimPlaceFill;
    state.failedAt.set('22|Atlantis', performance.now() - 61 * 60 * 1000);
    answers.nominatim = () => json([{ lat: '32.46182', lon: '35.04555', boundingbox: HARISH_BOX }]);
    assert(await place.ensureUserCoordinates({ ...lost }) !== null, 'looked up again after an hour');
  });

  // ---- The due gate, the height that failed once, and a lookup nobody waits for (review of the zmanim branch, findings 3, 4 and 5) ----

  const fillState = () => (globalThis as unknown as { __zmanimPlaceFill: { running: Map<string, Promise<unknown>>; filled: Map<string, unknown>; failedAt: Map<string, number> } }).__zmanimPlaceFill;
  /** Lets every pending microtask run: what is still waiting after this is waiting on something else (a held lookup). */
  const settleMicrotasks = () => new Promise<void>(resolve => setImmediate(resolve));
  /** The background lookup of `id|location` has finished (nothing to wait for when none is running). */
  const backgroundDone = async (id: number, location: string) => { await fillState().running.get(`${id}|${location}`); await settleMicrotasks(); };

  await check('a saved place wakes the native reminders\' due gate, so a time that moved is not kept waiting on the memo of the old place (up to an hour); a lookup that finds nothing does not', async () => {
    resetWorld();
    const now = new Date();
    const closeGate = () => { gate.__resetDueGateForTests(); gate.setNextDue(new Date(now.getTime() + 60 * 60 * 1000), now); assert(!gate.shouldRunPass(now), 'the gate is closed'); };
    closeGate();
    userRow(7, 'Harish, Israel');
    await place.saveUserPlace(7, 'Harish, Israel');
    assert(gate.shouldRunPass(now), 'the pass runs on the next tick after the place was saved');
    closeGate();
    answers.nominatim = () => json([]);
    userRow(8, 'Atlantis');
    await logged(() => place.saveUserPlace(8, 'Atlantis'));
    assert(!gate.shouldRunPass(now), 'a place that was not found moved nothing');
    gate.__resetDueGateForTests();
  });

  await check('a place saved in Israel without a height (the elevation request failed) is looked up again in the background, at most once an hour: nobody waits for it, a second need while it runs or after a second failure within the hour asks nothing, and once it has the height the stale row reads it', async () => {
    resetWorld();
    answers.elevation = () => json({ error: true }, 503);
    const stale = { ...userRow(41, 'Harish, Israel', { latitude: 32.46182, longitude: 35.04555 }) };
    // The first need: the row has coordinates and no height, so it is answered at once as it is, and a lookup starts.
    const first = await logged(async () => {
      const got = await place.ensureUserCoordinates({ ...stale });
      place.retryMissingElevation({ ...stale }, 'Asia/Jerusalem');
      return got;
    });
    assertSame(first.value, { latitude: 32.46182, longitude: 35.04555, elevationM: null }, 'answered at once, as the row is');
    assert(first.lines.some(l => l.startsWith('[zmanim]') && l.includes('user 41') && l.includes('no height')), `logged: ${show(first.lines)}`);
    place.retryMissingElevation({ ...stale }, 'Asia/Jerusalem'); // while it runs
    await backgroundDone(41, 'Harish, Israel');
    assert(nRequests() === 3 && nWrites() === 1, `one lookup: ${nRequests()} requests, ${nWrites()} writes`);
    // It failed again (503): nothing is asked again within the hour.
    place.retryMissingElevation({ ...stale }, 'Asia/Jerusalem');
    await backgroundDone(41, 'Harish, Israel');
    assert(nRequests() === 3, `asked again within the hour: ${nRequests()} requests`);
    // An hour later, with the elevation answering: the height is found, saved, and read by a caller still holding the stale row.
    fillState().failedAt.set('41|Harish, Israel', performance.now() - 61 * 60 * 1000);
    seedAnswers();
    place.retryMissingElevation({ ...stale }, 'Asia/Jerusalem');
    await backgroundDone(41, 'Harish, Israel');
    assert(nRequests() === 6 && users.get(41)!.elevationM === 290, `retried after the hour: ${nRequests()} requests, stored ${show(users.get(41)!.elevationM)}`);
    assertSame(await place.ensureUserCoordinates({ ...stale }), { latitude: 32.46182, longitude: 35.04555, elevationM: 290 }, 'the stale row reads the height');
    place.retryMissingElevation({ ...stale }, 'Asia/Jerusalem');
    await backgroundDone(41, 'Harish, Israel');
    assert(nRequests() === 6, 'with the height found it is never looked up again');
  });

  await check('the missing height is looked up again only where the height is used: not abroad (sea level there), not for a row that has it, not for a person with no place name', async () => {
    resetWorld();
    const abroad = userRow(51, 'New York', { latitude: 40.7, longitude: -74, elevationM: null });
    place.retryMissingElevation({ ...abroad }, 'America/New_York');
    const known = userRow(52, 'Harish, Israel', { latitude: 32.46182, longitude: 35.04555, elevationM: 290 });
    place.retryMissingElevation({ ...known }, 'Asia/Jerusalem');
    const nameless = userRow(53, '  ', { latitude: 32.46182, longitude: 35.04555, elevationM: null });
    place.retryMissingElevation({ ...nameless }, 'Asia/Jerusalem');
    const none = userRow(54, 'Harish, Israel');
    place.retryMissingElevation({ ...none }, 'Asia/Jerusalem'); // no coordinates at all: the lazy fill's, not this one's
    await settleMicrotasks();
    assert(nRequests() === 0 && fillState().running.size === 0, `looked up: ${show(shape())}`);
  });

  await check('getUserPlace gives a Place with no height at once for a row in Israel that lacks it and looks the height up in the background; the pause\'s windows and the clock then read it', async () => {
    resetWorld();
    stubbed.redis.set('tz:user:61', 'Asia/Jerusalem');
    const row = { ...userRow(61, 'Harish, Israel', { latitude: 32.46182, longitude: 35.04555 }) };
    const got = await place.getUserPlace({ ...row });
    assertSame(got, { latitude: 32.46182, longitude: 35.04555, elevationM: null, timeZone: 'Asia/Jerusalem' }, 'at once, with no height');
    await backgroundDone(61, 'Harish, Israel');
    assert(users.get(61)!.elevationM === 290, `looked up: ${show(users.get(61)!.elevationM)}`);
    assert((await place.getUserPlace({ ...row }))?.elevationM === 290, 'then the same stale row reads 290 m');
  });

  await check('a lazy fill that a caller does not wait for (background): the caller is answered null at once and the lookup still runs and saves, once; the next need has the place', async () => {
    resetWorld();
    let release = () => {};
    heldNominatim = new Promise<void>(resolve => { release = resolve; });
    const row = { ...userRow(71, 'Harish, Israel') };
    try {
      const asked = place.ensureUserCoordinates({ ...row }, { background: true });
      let answered = false;
      void asked.then(() => { answered = true; });
      await settleMicrotasks();
      assert(answered, 'the caller was left waiting for the lookup');
      assert((await asked) === null, 'null while it runs');
      assert(nRequests() === 1 && fillState().running.size === 1, `the lookup started: ${nRequests()} request(s)`);
      assert((await place.ensureUserCoordinates({ ...row }, { background: true })) === null && nRequests() === 1, 'a second need while it runs joins it');
    } finally {
      release();
    }
    await backgroundDone(71, 'Harish, Israel');
    assert(nRequests() === 3 && nWrites() === 1 && users.get(71)!.latitude === 32.46182, `saved once: ${nRequests()} requests, ${nWrites()} writes`);
    assertSame(await place.ensureUserCoordinates({ ...row }, { background: true }), { latitude: 32.46182, longitude: 35.04555, elevationM: 290 }, 'the next need has it');
  });

  await check('the editor\'s zmanim block does not wait for the lazy fill: for a person with a place name and no coordinates it answers at once with the zone\'s main city (place "zone"), and the fill still runs in the background; the next editor has their place', async () => {
    resetWorld();
    stubbed.redis.set('tz:user:81', 'Asia/Jerusalem');
    let release = () => {};
    heldNominatim = new Promise<void>(resolve => { release = resolve; });
    const row = { ...userRow(81, 'Harish, Israel'), zmanimCommunity: 'sephardi', pauseOnShabbat: false };
    try {
      const asked = reminderTimes.zmanEditorInfo({ ...row } as never, 'Asia/Jerusalem', '2026-10-28');
      let answered = false;
      void asked.then(() => { answered = true; });
      await settleMicrotasks();
      assert(answered, 'the editor\'s info waited for the lookup');
      const info = await asked;
      assert(info.place === 'zone' && info.zmanim.every(z => z.at !== null), `answered from the main city: ${info.place}`);
      assert(nRequests() === 1, 'and the fill has started');
    } finally {
      release();
    }
    await backgroundDone(81, 'Harish, Israel');
    const next = await reminderTimes.zmanEditorInfo({ ...row } as never, 'Asia/Jerusalem', '2026-10-28');
    assert(next.place === 'saved' && hm(new Date(next.zmanim.find(z => z.key === 'SOF_SHMA_GRA')!.at!)) === '08:37', `the next editor: ${next.place}`);
  });

  await check('getUserPlace: the user\'s coordinates (filled once if need be) with their zone from resolveUserTimezone, null with none to be had; placeOf builds a Place from saved ones', async () => {
    resetWorld();
    stubbed.redis.set('tz:user:31', 'Asia/Jerusalem');
    const user = userRow(31, 'Harish, Israel');
    const got = await place.getUserPlace({ ...user });
    assertSame(got, { latitude: 32.46182, longitude: 35.04555, elevationM: 290, timeZone: 'Asia/Jerusalem' }, 'a Place');
    assertSame(place.placeOf({ latitude: 31.778, longitude: 35.235, elevationM: 754 }, 'Asia/Jerusalem'), JERUSALEM, 'placeOf');
    assert(place.placeOf({ latitude: null, longitude: null, elevationM: null }, 'Asia/Jerusalem') === null, 'no coordinates, no Place');
    assert(await place.getUserPlace(userRow(32, '')) === null, 'no place name, no Place');
    // The Place feeds the computation: Harish at its saved 290 m still reads the same minutes the screenshot does, within one.
    const day = compute.zmanimForDay('2026-10-28', got!, 'sephardi');
    assert(Math.abs(minutesOf(hm(day.SOF_SHMA_GRA)) - minutesOf('08:37')) <= 1, 'Shema (GRA) at 290 m');
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

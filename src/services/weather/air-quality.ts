/**
 * Air quality for the dust alerts: Copernicus CAMS dust and pm10 from Open-Meteo's public open data on S3 (CC BY 4.0,
 * https://github.com/open-meteo/open-data): the same hourly series Open-Meteo's API serves, with its default "auto"
 * domains: cams_europe (0.1°) inside its grid for its hours (about 4 days), cams_global (0.4°) elsewhere and after, no
 * cross-fade. About 5 days ahead. No user data leaves the server: the files are public and the cell is found here.
 * Spec 2026-10-31-open-meteo-replacement §5; the dust spike's rulings R1-R8; plan Task 4.
 *
 * - The rolling layout data/<model>/<variable>/chunk_N.om, hourly, overwritten in place at each run.
 * - meta.json per model (chunk length, grid, data end, run times), read at most every 10 minutes.
 * - An open reader belongs to one run (last_run_modification_time): a new run retires the old readers. A stale reader
 *   reads S3's 412 as a short read, so any failed read retires the readers, refreshes the metas and retries.
 * - A point's series is cached per (model, variable, cell, run, window), never per user, on globalThis: the scheduler and
 *   the routes are separate bundles, each with its own WebAssembly.
 * - @openmeteo/file-reader 0.0.21 (GPL-2.0: server only, never a 'use client' file): its plain HTTP backend at one
 *   attempt, the shared retry loop (src/utils/fetch-retry.ts) around the whole read, never its block cache.
 * - Failure: reported once, placeless, and null, and no dust alert goes out. A run over 36 h old is a warning (the
 *   alerts read old data). What is reported is the model, the step, the HTTP status and the error's name: never the
 *   place, the coordinates or the cell, and no library message (its range errors hold the cell).
 */

import { OmDataType, OmFileReader, OmHttpBackend } from '@openmeteo/file-reader';
import type { AirQualityData } from '../../types';
import { geocodeLocation } from './geocoding';
import { captureError, captureWarning } from '../../lib/error-capture';
import { __useRetryForTests, retryWithBackoff } from '../../utils/fetch-retry';
import { instantToWallTime, wallTimeToInstant } from '../../utils/wall-time';

export const OPEN_DATA = 'https://openmeteo.s3.amazonaws.com';
type Model = 'cams_europe' | 'cams_global';
type Variable = 'dust' | 'pm10';
const META_TTL_MS = 10 * 60 * 1000;
const RUN_AGE_WARN_MS = 36 * 3_600_000;
/**
 * The library races each request against this many ms (a race that never aborts, so no timeout of ours): Node's fetch
 * gives up on headers after 300 s, so the race never fires first.
 */
export const FETCH_CEILING_MS = 300_000;
const SERIES_CACHE_MAX = 512;
const LOG = '[air-quality]';

/** The fields of a model's static/meta.json FamCal reads (times in unix seconds). */
export interface ModelMeta {
  chunk_time_length: number;
  crs_wkt: string;
  data_end_time: number;
  last_run_initialisation_time: number;
  last_run_modification_time: number;
}

// ---- The failure, as it is reported ----

type Step = 'meta' | 'grid' | 'open' | 'read';

/**
 * A failed read as Sentry and the logs get it: the model, the step, the HTTP status (when there was one) and the failing
 * error's name. The cause's own message is dropped on purpose: the library's range errors hold the grid cell.
 */
export class AirDataError extends Error {
  constructor(
    readonly model: Model | 'cams',
    readonly step: Step,
    readonly kind: string,
    readonly status?: number,
  ) {
    super(`${model} ${step} failed: ${status !== undefined ? `HTTP ${status}` : kind}`);
    this.name = 'AirDataError';
  }
}

/** The status a failed request carried: the backend's own, or the library's "Server error: 503" after its one attempt. */
function httpStatusOf(error: unknown): number | undefined {
  const code = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof code === 'number') return code;
  const text = /^(?:Server error|HTTP error): (\d{3})$/.exec(error instanceof Error ? error.message : '');
  return text ? Number(text[1]) : undefined;
}

/** Any failure as an AirDataError (one already is). */
function dataError(model: Model | 'cams', step: Step, error: unknown): AirDataError {
  if (error instanceof AirDataError) return error;
  return new AirDataError(model, step, error instanceof Error ? error.name : typeof error, httpStatusOf(error));
}

// ---- State ----

interface ReaderEntry {
  reader: Promise<OmFileReader>;
  users: number;
  retired: boolean;
  disposed: boolean;
}
interface AirState {
  metas: Map<Model, { at: number; meta: ModelMeta }>;
  metaLoads: Map<Model, Promise<ModelMeta>>;
  readers: Map<string, ReaderEntry>;
  series: Map<string, number[] | null>;
  warnedRun: Map<Model, number>;
}
const shared = globalThis as { __famcalAir?: AirState };
const state: AirState = (shared.__famcalAir ??= { metas: new Map(), metaLoads: new Map(), readers: new Map(), series: new Map(), warnedRun: new Map() });

interface Seam {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}
const seamState = globalThis as { __airForTests?: Partial<Seam> | null };
/** Tests only: replaces the clock, and (through the shared retry loop) the waits and the jitter. */
export function __useAirForTests(seam: Partial<Seam> | null): void {
  seamState.__airForTests = seam;
  __useRetryForTests(seam);
}
/** Tests only: forgets every meta, reader and series. */
export function __resetAirForTests(): void {
  retireAllReaders();
  state.metas.clear();
  state.metaLoads.clear();
  state.series.clear();
  state.warnedRun.clear();
}
const nowMs = (): number => seamState.__airForTests?.now?.() ?? Date.now();

// ---- meta.json ----

async function loadMeta(model: Model): Promise<ModelMeta> {
  let response: Response;
  try {
    response = await fetch(`${OPEN_DATA}/data/${model}/static/meta.json`);
  } catch (error) {
    throw dataError(model, 'meta', error);
  }
  if (!response.ok) {
    // Free the connection; the body of a refusal is of no use.
    response.body?.cancel().catch(error => console.warn(`${LOG} could not drop the body of a ${response.status}: ${error instanceof Error ? error.name : typeof error}`));
    throw new AirDataError(model, 'meta', 'HTTP', response.status);
  }
  let meta: ModelMeta;
  try {
    meta = (await response.json()) as ModelMeta;
  } catch (error) {
    throw dataError(model, 'meta', error);
  }
  if (!Number.isFinite(meta?.chunk_time_length) || !Number.isFinite(meta?.data_end_time) || !Number.isFinite(meta?.last_run_modification_time) || typeof meta?.crs_wkt !== 'string') {
    throw new AirDataError(model, 'meta', 'meta.json is not one FamCal can read');
  }
  return meta;
}

/** A model's meta: the stored one for 10 minutes, else read once for every caller waiting on it. */
async function modelMeta(model: Model): Promise<ModelMeta> {
  const now = nowMs();
  const hit = state.metas.get(model);
  if (hit && now - hit.at < META_TTL_MS) return hit.meta;
  let loading = state.metaLoads.get(model);
  if (!loading) {
    loading = loadMeta(model).finally(() => state.metaLoads.delete(model));
    state.metaLoads.set(model, loading);
  }
  const meta = await loading;
  state.metas.set(model, { at: now, meta });
  const age = now - meta.last_run_initialisation_time * 1000;
  if (age > RUN_AGE_WARN_MS && state.warnedRun.get(model) !== meta.last_run_initialisation_time) {
    state.warnedRun.set(model, meta.last_run_initialisation_time);
    captureWarning(`The ${model} run on Open-Meteo's open data is ${Math.round(age / 3_600_000)} h old: the dust alerts read an old forecast`, 'air-quality', { service: 'weather', model });
  }
  return meta;
}

// ---- The grid ----

/**
 * The nearest cell to the point in a model's grid (the API's cell_selection=nearest): the grid from the file's own
 * dimensions and the BBOX in meta.crs_wkt (the centres of the first and last cells; Europe's rows run north to south).
 * cams_global wraps in longitude. Null where the point is outside the grid (south of cams_europe: Eilat, the Arava).
 */
export function cellOf(meta: Pick<ModelMeta, 'crs_wkt'>, model: Model, dims: readonly number[], latitude: number, longitude: number): { iy: number; ix: number } | null {
  const [ny, nx] = dims;
  const box = /BBOX\[([^\]]+)\]/.exec(meta.crs_wkt);
  const corners = box ? box[1].split(',').map(Number) : [];
  if (corners.length !== 4 || !corners.every(Number.isFinite) || !(ny > 1) || !(nx > 1)) throw new AirDataError(model, 'grid', 'no grid FamCal can read');
  const [lat0, lon0, lat1, lon1] = corners;
  const dy = (lat1 - lat0) / (ny - 1);
  const dx = (lon1 - lon0) / (nx - 1);
  const iy = Math.round((latitude - lat0) / dy);
  let ix = Math.round((longitude - lon0) / dx);
  if (model === 'cams_global') ix = ((ix % nx) + nx) % nx;
  return iy >= 0 && iy < ny && ix >= 0 && ix < nx ? { iy, ix } : null;
}

/** The API's "auto": cams_europe's value where it has one, cams_global's for the rest, null where neither has. No cross-fade. */
export function mergeAuto(europe: readonly number[] | null, global: readonly number[]): (number | null)[] {
  return global.map((g, i) => {
    const e = europe?.[i];
    const value = e !== undefined && Number.isFinite(e) ? e : g;
    return Number.isFinite(value) ? value : null;
  });
}

// ---- Readers, one per chunk file and run ----

function dispose(entry: ReaderEntry): void {
  if (entry.disposed) return;
  entry.disposed = true;
  // A reader that failed to open has nothing to free; its failure reached the read that awaited it.
  entry.reader
    .then(reader => reader.dispose(), () => undefined)
    .catch(error => console.warn(`${LOG} a reader could not be freed: ${error instanceof Error ? error.name : typeof error}`));
}

function retire(key: string, entry: ReaderEntry): void {
  if (state.readers.get(key) === entry) state.readers.delete(key);
  entry.retired = true;
  if (entry.users === 0) dispose(entry);
}

function retireAllReaders(): void {
  for (const [key, entry] of [...state.readers]) retire(key, entry);
}

/** Runs `fn` with the open reader of a chunk for this run (opened once); a failed open or read retires the reader. */
async function withChunk<T>(meta: ModelMeta, model: Model, variable: Variable, idx: number, fn: (reader: OmFileReader) => T | Promise<T>): Promise<T> {
  const url = `${OPEN_DATA}/data/${model}/${variable}/chunk_${idx}.om`;
  const key = `${url}@${meta.last_run_modification_time}`;
  let entry = state.readers.get(key);
  if (!entry) {
    for (const [k, e] of [...state.readers]) if (k.startsWith(`${url}@`)) retire(k, e); // an older run's reader
    entry = { reader: OmFileReader.create(new OmHttpBackend({ url, retries: 1, timeoutMs: FETCH_CEILING_MS })), users: 0, retired: false, disposed: false };
    state.readers.set(key, entry);
  }
  entry.users++;
  let step: Step = 'open';
  try {
    const reader = await entry.reader;
    step = 'read';
    return await fn(reader);
  } catch (error) {
    retire(key, entry);
    throw dataError(model, step, error);
  } finally {
    entry.users--;
    if (entry.retired && entry.users === 0) dispose(entry);
  }
}

// ---- A point's series ----

function remember(key: string, values: number[] | null): void {
  state.series.set(key, values);
  if (state.series.size > SERIES_CACHE_MAX) state.series.delete(state.series.keys().next().value as string);
}

/**
 * A variable's hourly values at the point in one model, for [fromSec, toSec) (hour-aligned unix seconds): NaN for an hour
 * the model does not have (after its data_end_time). Null where the point is outside the model's grid.
 */
async function modelSeries(model: Model, variable: Variable, latitude: number, longitude: number, fromSec: number, toSec: number): Promise<number[] | null> {
  const meta = await modelMeta(model);
  const chunkSec = meta.chunk_time_length * 3600;
  const end = Math.min(toSec, meta.data_end_time); // never ask for a chunk that does not exist yet
  const out: number[] = new Array((toSec - fromSec) / 3600).fill(NaN);
  if (end <= fromSec) return out;
  const first = Math.floor(fromSec / chunkSec);
  const last = Math.floor((end - 1) / chunkSec);
  const cell = await withChunk(meta, model, variable, first, reader => cellOf(meta, model, reader.getDimensions(), latitude, longitude));
  const key = `${model}|${variable}|${cell ? `${cell.iy},${cell.ix}` : 'outside'}|${meta.last_run_modification_time}|${fromSec}|${toSec}`;
  if (state.series.has(key)) return state.series.get(key)!;
  if (!cell) {
    remember(key, null);
    return null;
  }
  await Promise.all(
    Array.from({ length: last - first + 1 }, (_, k) => first + k).map(idx =>
      withChunk(meta, model, variable, idx, async reader => {
        const nt = reader.getDimensions()[2];
        const t0 = idx * chunkSec;
        const a = Math.max(fromSec, t0);
        const b = Math.min(end, t0 + nt * 3600);
        if (b <= a) return;
        const values = (await reader.read({
          type: OmDataType.FloatArray,
          ranges: [{ start: cell.iy, end: cell.iy + 1 }, { start: cell.ix, end: cell.ix + 1 }, { start: (a - t0) / 3600, end: (b - t0) / 3600 }],
        })) as Float32Array;
        values.forEach((v, i) => { out[(a - fromSec) / 3600 + i] = v; });
      }),
    ),
  );
  remember(key, out);
  return out;
}

/** A variable at the point, the API's "auto" way, from fromSec to cams_global's end. */
async function autoSeries(variable: Variable, latitude: number, longitude: number, fromSec: number): Promise<(number | null)[]> {
  const global = await modelMeta('cams_global');
  const toSec = Math.floor(global.data_end_time / 3600) * 3600;
  if (toSec <= fromSec) throw new AirDataError('cams_global', 'meta', 'the data ends before the day starts');
  const [g, e] = await Promise.all([
    modelSeries('cams_global', variable, latitude, longitude, fromSec, toSec),
    modelSeries('cams_europe', variable, latitude, longitude, fromSec, toSec),
  ]);
  if (!g) throw new AirDataError('cams_global', 'grid', 'the grid does not cover the point');
  return mergeAuto(e, g);
}

/** Both variables at the point; any failure is one AirDataError. */
async function readBoth(latitude: number, longitude: number, fromSec: number): Promise<[(number | null)[], (number | null)[]]> {
  try {
    return await Promise.all([autoSeries('dust', latitude, longitude, fromSec), autoSeries('pm10', latitude, longitude, fromSec)]);
  } catch (error) {
    throw dataError('cams', 'read', error);
  }
}

/** The first whole UTC hour at or after today's 00:00 at the place (a half-hour zone's day starts at :30 on that grid). */
export function dayStartSec(now: number, timezone: string): number {
  const today = instantToWallTime(new Date(now), timezone).slice(0, 10);
  const start = wallTimeToInstant(`${today}T00:00`, timezone).getTime();
  if (!Number.isFinite(start)) throw new RangeError('the start of the day is not a time');
  return Math.ceil(start / 3_600_000) * 3600;
}

/**
 * CAMS dust and pm10 at a location, hourly from today's 00:00 at the place (`timezone`) to cams_global's end (about 5
 * days), as wall times at the place. Null, and reported, on any failure: no dust alert goes out. Never throws.
 */
export async function fetchAirQuality(location: string, timezone: string): Promise<AirQualityData | null> {
  let latitude: number;
  let longitude: number;
  try {
    ({ latitude, longitude } = await geocodeLocation(location));
  } catch {
    // geocodeLocation's error names the place: not in the log. The forecast for the same place logs the lookup.
    captureWarning('The place lookup failed: no air quality', 'air-quality', { service: 'weather' });
    return null;
  }
  let fromSec: number;
  try {
    fromSec = dayStartSec(nowMs(), timezone);
  } catch (error) {
    captureError(dataError('cams', 'read', error), 'air-quality', { service: 'weather', step: 'day' }, 'warning');
    return null;
  }
  let dust: (number | null)[];
  let pm10: (number | null)[];
  try {
    [dust, pm10] = await retryWithBackoff(() => readBoth(latitude, longitude, fromSec), {
      label: LOG,
      // A new run replaces the files in place: whatever failed, open the readers and read the metas again.
      onRetry: () => {
        retireAllReaders();
        state.metas.clear();
      },
      onGiveUp: (error, { retried, why }) => {
        const failure = dataError('cams', 'read', error);
        captureError(failure, 'air-quality', { service: 'weather', model: failure.model, step: failure.step, status: failure.status, retried, why }, 'warning');
      },
    });
  } catch {
    return null; // onGiveUp has reported it
  }
  let hours = Math.min(dust.length, pm10.length);
  while (hours > 0 && dust[hours - 1] === null && pm10[hours - 1] === null) hours--;
  if (hours === 0) {
    captureWarning("Open-Meteo's open data has no dust or pm10 for the place", 'air-quality', { service: 'weather' });
    return null;
  }
  const time = Array.from({ length: hours }, (_, i) => instantToWallTime(new Date((fromSec + i * 3600) * 1000), timezone).slice(0, 16));
  return { hourly: { time, pm10: pm10.slice(0, hours), dust: dust.slice(0, hours) } };
}

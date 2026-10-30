// The heights of the Israeli cities in src/site/cities.ts (spec docs/superpowers/specs/2026-10-30-public-zmanim-design.md
// §5.2), by the bot's own rule for "the highest point in the place": elevationGrid (src/services/zmanim/elevation-grid.ts)
// over the town's OpenStreetMap box, held to 3 km around the city's point, and the highest of those points, rounded.
//
// Run once, on a developer machine, never in CI or at runtime; the diff it makes to src/site/cities.ts is committed:
//   npx tsx scripts/build-city-heights.ts
//
// - The box: one Nominatim search per city (the city's Hebrew name from messages/he.json, then its English name), held
//   to a box around the city's GeoNames point and to settlements, taking the first result that is the town itself (a
//   search can rank a neighbourhood first), at one request a second with FamCal's User-Agent, as Nominatim's usage
//   policy asks (about 51 requests).
// - The heights: the Copernicus DEM GLO-90 tiles in AWS's public bucket (no account; a tile per whole degree,
//   Copernicus_DSM_COG_30_N<lat>_00_E<lon>_00_DEM), read by `geotiff` with range requests: one window per tile a town's
//   points fall in, and each point's own pixel.
// - A network step that fails (a reset, a closed socket) is tried again after 2, 4 and 8 s, and logged.
// - It stops with nothing written when a city is not found, is found more than 10 km from its point, or reads no height.
//   Only elevationM values of Israeli rows change; rows abroad keep null.

import fs from 'node:fs';
import path from 'node:path';
import { fromUrl, type GeoTIFFImage } from 'geotiff';
import { CITIES, type City } from '../src/site/cities';
import { haversineKm } from '../src/site/near-city';
import { SELLER } from '../src/lib/seller';
import { SITE_URL } from '../src/site/config';
import { elevationGrid, type Coordinates } from '../src/services/zmanim/elevation-grid';
import type { BoundingBox } from '../src/lib/timezone';

const ROOT = path.resolve(__dirname, '..');
const TABLE = path.join(ROOT, 'src/site/cities.ts');
const USER_AGENT = `FamCal/1.0 (${SITE_URL}; ${SELLER.email})`;
/** Nominatim's policy: at most one request a second. */
const NOMINATIM_GAP_MS = 1100;
/** How far a found town may be from the city's GeoNames point. */
const MAX_DRIFT_KM = 10;
/** The search box around the city's point, in degrees each way. */
const SEARCH_REACH_DEG = 0.15;
const TILES = 'https://copernicus-dem-90m.s3.amazonaws.com';
/** The kinds of result that are the town itself: a search may rank one of its neighbourhoods first (Kiryat Ata's). */
const TOWN_TYPES: ReadonlySet<string> = new Set(['city', 'town', 'village', 'municipality']);

type Names = { cities: Record<string, string> };
const names = (locale: 'en' | 'he'): Record<string, string> =>
  (JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${locale}.json`), 'utf8')) as Names).cities;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Nominatim's `boundingbox` ([south, north, west, east] as strings), or null when it is missing or not four numbers. */
function readBox(raw: unknown): BoundingBox | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const box = raw.map((value) => parseFloat(String(value)));
  return box.every(Number.isFinite) ? (box as BoundingBox) : null;
}

let lastSearch = 0;

/** The town's box from one Nominatim search for `query` near the city: its first result that is a town. Null when there is none. */
async function searchBox(city: City, query: string): Promise<{ box: BoundingBox | null; driftKm: number; name: string } | null> {
  const wait = lastSearch + NOMINATIM_GAP_MS - Date.now();
  if (wait > 0) await pause(wait);
  lastSearch = Date.now();
  const viewbox = [city.longitude - SEARCH_REACH_DEG, city.latitude + SEARCH_REACH_DEG, city.longitude + SEARCH_REACH_DEG, city.latitude - SEARCH_REACH_DEG].join(',');
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: query, format: 'jsonv2', limit: '10', featureType: 'settlement', viewbox, bounded: '1' })}`;
  const response = await withRetry(`searching ${city.slug}`, () => fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'he' } }));
  if (!response.ok) throw new Error(`Nominatim answered ${response.status} for ${city.slug}`);
  const results = (await response.json()) as Array<{ lat: string; lon: string; addresstype?: string; boundingbox?: unknown; display_name?: string }>;
  const town = Array.isArray(results) ? results.find((result) => TOWN_TYPES.has(result.addresstype ?? '')) : undefined;
  if (!town) return null;
  const found = { latitude: parseFloat(town.lat), longitude: parseFloat(town.lon) };
  if (!Number.isFinite(found.latitude) || !Number.isFinite(found.longitude)) throw new Error(`Nominatim sent coordinates that are not numbers for ${city.slug}`);
  return { box: readBox(town.boundingbox), driftKm: haversineKm(city, found), name: `${town.display_name ?? ''} (${town.addresstype})` };
}

/** A network step that failed for no fault of the request (a reset, a closed socket): tried again after 2, 4 and 8 s. */
async function withRetry<T>(what: string, step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      if (attempt === 4) throw error;
      console.warn(`[city-heights] ${what} failed (attempt ${attempt}), trying again:`, error instanceof Error ? error.message : error);
      await pause(1000 * 2 ** attempt);
    }
  }
}

const tiles = new Map<string, GeoTIFFImage>();

/** The name of the GLO-90 tile that holds `point` (Israel only: north and east). */
function tileName(point: Coordinates): string {
  if (point.latitude < 0 || point.longitude < 0) throw new Error(`no tile rule for ${point.latitude},${point.longitude}`);
  return `Copernicus_DSM_COG_30_N${String(Math.floor(point.latitude)).padStart(2, '0')}_00_E${String(Math.floor(point.longitude)).padStart(3, '0')}_00_DEM`;
}

async function tile(name: string): Promise<GeoTIFFImage> {
  const known = tiles.get(name);
  if (known) return known;
  const image = await withRetry(`opening ${name}`, async () => (await fromUrl(`${TILES}/${name}/${name}.tif`)).getImage());
  tiles.set(name, image);
  return image;
}

/** The model's height at each point, in metres (the pixel that holds it): one window read per tile the points touch. */
async function heightsAt(points: Coordinates[]): Promise<number[]> {
  const byTile = new Map<string, number[]>();
  points.forEach((point, index) => byTile.set(tileName(point), [...(byTile.get(tileName(point)) ?? []), index]));
  const heights: number[] = new Array(points.length).fill(NaN);
  for (const [name, indexes] of byTile) {
    const image = await tile(name);
    const [originX, originY] = image.getOrigin();
    const [resolutionX, resolutionY] = image.getResolution();
    const pixel = (index: number) => ({
      x: Math.min(image.getWidth() - 1, Math.max(0, Math.floor((points[index].longitude - originX) / resolutionX))),
      y: Math.min(image.getHeight() - 1, Math.max(0, Math.floor((points[index].latitude - originY) / resolutionY))),
    });
    const pixels = indexes.map(pixel);
    const left = Math.min(...pixels.map((p) => p.x));
    const top = Math.min(...pixels.map((p) => p.y));
    const width = Math.max(...pixels.map((p) => p.x)) - left + 1;
    const height = Math.max(...pixels.map((p) => p.y)) - top + 1;
    const [band] = (await withRetry(`reading ${name}`, () => image.readRasters({ window: [left, top, left + width, top + height] }))) as unknown as [ArrayLike<number>];
    indexes.forEach((index, i) => {
      heights[index] = band[(pixels[i].y - top) * width + (pixels[i].x - left)];
    });
  }
  return heights;
}

async function heightOf(city: City, he: Record<string, string>, en: Record<string, string>): Promise<number> {
  const found = (await searchBox(city, he[city.slug])) ?? (await searchBox(city, en[city.slug]));
  if (!found) throw new Error(`Nominatim found no ${city.slug} near ${city.latitude},${city.longitude}`);
  if (found.driftKm > MAX_DRIFT_KM) throw new Error(`${city.slug}: Nominatim's ${found.name} is ${found.driftKm.toFixed(1)} km from the city's point`);
  const points = elevationGrid(city, found.box);
  const heights = (await heightsAt(points)).filter((m) => Number.isFinite(m) && m > -1000);
  if (heights.length === 0) throw new Error(`${city.slug}: the model read no height`);
  const highest = Math.round(Math.max(...heights));
  console.log(`[city-heights] ${city.slug}: ${highest} m (${points.length} points over ${found.box ? found.box.join(',') : 'no box'}; ${found.name})`);
  return highest;
}

async function main(): Promise<void> {
  const he = names('he');
  const en = names('en');
  const israel = CITIES.filter((city) => city.country === 'IL');
  const heights = new Map<string, number>();
  for (const city of israel) heights.set(city.slug, await heightOf(city, he, en));

  let table = fs.readFileSync(TABLE, 'utf8');
  for (const [slug, metres] of heights) {
    const row = new RegExp(`(\\{ slug: '${slug}',[^\\n]*elevationM: )(?:null|-?\\d+)( \\})`);
    if (!row.test(table)) throw new Error(`no row for ${slug} in src/site/cities.ts`);
    table = table.replace(row, `$1${metres}$2`);
  }
  fs.writeFileSync(TABLE, table);
  console.log(`[city-heights] wrote ${heights.size} heights to src/site/cities.ts`);
}

main().catch((error: unknown) => {
  console.error('[city-heights] stopped, nothing written:', error);
  process.exit(1);
});

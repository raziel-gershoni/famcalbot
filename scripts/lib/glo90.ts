// The Copernicus DEM GLO-90 tiles in AWS's public bucket (no account; one 1 x 1 degree COG per tile,
// Copernicus_DSM_COG_30_N<lat>_00_E<lon>_00_DEM), read with geotiff (a devDependency: scripts only, never the app).
// Shared by scripts/build-city-heights.ts and scripts/build-israel-heights.ts.

import { fromUrl, type GeoTIFFImage } from 'geotiff';
import type { Coordinates } from '../../src/services/zmanim/elevation-grid';

export const TILES = 'https://copernicus-dem-90m.s3.amazonaws.com';

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A network step that failed for no fault of the request (a reset, a closed socket): tried again after 2, 4 and 8 s. */
export async function withRetry<T>(what: string, step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      if (attempt === 4) throw error;
      console.warn(`[glo90] ${what} failed (attempt ${attempt}), trying again:`, error instanceof Error ? error.message : error);
      await pause(1000 * 2 ** attempt);
    }
  }
}

const tiles = new Map<string, GeoTIFFImage>();

/** The name of the GLO-90 tile that holds `point` (north and east only). */
export function tileName(point: Coordinates): string {
  if (point.latitude < 0 || point.longitude < 0) throw new Error(`no tile rule for ${point.latitude},${point.longitude}`);
  return `Copernicus_DSM_COG_30_N${String(Math.floor(point.latitude)).padStart(2, '0')}_00_E${String(Math.floor(point.longitude)).padStart(3, '0')}_00_DEM`;
}

/** A tile, opened once. */
export async function openTile(name: string): Promise<GeoTIFFImage> {
  const known = tiles.get(name);
  if (known) return known;
  const image = await withRetry(`opening ${name}`, async () => (await fromUrl(`${TILES}/${name}/${name}.tif`)).getImage());
  tiles.set(name, image);
  return image;
}

/** A tile, or null where GLO-90 has none (all sea: the bucket answers 404). */
export async function openTileOrNull(name: string): Promise<GeoTIFFImage | null> {
  const head = await withRetry(`asking for ${name}`, () => fetch(`${TILES}/${name}/${name}.tif`, { method: 'HEAD' }));
  if (head.status === 404) return null;
  if (!head.ok) throw new Error(`${name}: the bucket answered ${head.status}`);
  return openTile(name);
}

// The Israel height map, data/israel-heights-3s.i16.br (spec 2026-10-31-open-meteo-replacement §5, "Height"): every
// Copernicus DEM GLO-90 pixel over Israel, 29.4-33.5 N and 34.2-35.95 E (Eilat to the Hermon and the Golan): the pixels
// Open-Meteo's elevation API read, so the bot's heights stay what they were, to the metre. Layout: height-map.ts.
//
// Run once, on a developer machine, never in CI or at runtime; the file it writes is committed:
//   npx tsx scripts/build-israel-heights.ts
//
// - The 10 tiles N29-N33 x E034-E035, each read whole (a few MB each); N33 E034 is all sea and does not exist (404), so
//   its cells have no height.
// - The map's edges are GLO-90 pixel edges (read from the tiles' own origin), so each cell is exactly one pixel and a
//   point falls in the cell of the pixel that holds it, as build-city-heights.ts and Open-Meteo read it.
// - A pixel index is Math.floor(x + EDGE_EPSILON), here and in heightAt (height-map.ts): a point on a pixel's edge is in the
//   pixel that edge opens, not the one before it, whatever the floating point makes of the division.
// - It stops with nothing written when a tile is not 1200 x 1200 at 3 arc-seconds, the round trip differs, or a check
//   point reads more than 3 m from what Open-Meteo answered for it (the research's parity probe: Jerusalem 741 m,
//   32.8 N 35.5 E 41 m, and 31.2 N 35.1 E 465 m, a pixel corner: the pixel that holds it reads 467 m, the one north of it 465 m).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { EDGE_EPSILON, NO_HEIGHT, decodeHeightMap, encodeHeightMap, heightAt } from '../src/services/zmanim/height-map';
import { openTileOrNull, tileName, withRetry } from './lib/glo90';

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data/israel-heights-3s.i16.br');
const BOX = { south: 29.4, north: 33.5, west: 34.2, east: 35.95 };
const CELL = 1 / 1200;
const SIDE = 1200;
/** How far a check point may read from what Open-Meteo answered (a neighbouring pixel at an edge, or a rounding), in metres. */
const TOLERANCE_M = 3;
const CHECKS = [
  { name: 'Jerusalem', latitude: 31.7768, longitude: 35.2358, openMeteo: 741 },
  { name: '32.8 N 35.5 E', latitude: 32.8, longitude: 35.5, openMeteo: 41 },
  // A pixel corner (31.2 and 35.1 are both pixel edges): Open-Meteo answered 465, the value of the pixel north of the one that holds the point, which reads 467.
  { name: '31.2 N 35.1 E (a pixel edge)', latitude: 31.2, longitude: 35.1, openMeteo: 465 },
];

type Tile = { originX: number; originY: number; band: ArrayLike<number> };

async function main(): Promise<void> {
  const tiles = new Map<string, Tile | null>();
  for (let lat = Math.floor(BOX.south); lat <= Math.floor(BOX.north); lat++) {
    for (let lon = Math.floor(BOX.west); lon <= Math.floor(BOX.east); lon++) {
      const name = tileName({ latitude: lat + 0.5, longitude: lon + 0.5 });
      const image = await openTileOrNull(name);
      if (!image) {
        tiles.set(name, null);
        console.log(`[israel-heights] ${name}: none (sea)`);
        continue;
      }
      const [resX, resY] = image.getResolution();
      if (image.getWidth() !== SIDE || image.getHeight() !== SIDE || Math.abs(resX - CELL) > 1e-12 || Math.abs(resY + CELL) > 1e-12) {
        throw new Error(`${name} is ${image.getWidth()} x ${image.getHeight()} at ${resX}, ${resY}: not GLO-90's 3 arc-seconds`);
      }
      const [originX, originY] = image.getOrigin();
      const [band] = (await withRetry(`reading ${name}`, () => image.readRasters())) as unknown as [ArrayLike<number>];
      tiles.set(name, { originX, originY, band });
      console.log(`[israel-heights] ${name}: read, origin ${originX}, ${originY}`);
    }
  }

  // Every tile's pixel grid sits the same fraction of a pixel off the whole degree: the map's edges follow it.
  const first = [...tiles.values()].find((t): t is Tile => t !== null);
  if (!first) throw new Error('no tile was read');
  const offsetY = first.originY - Math.round(first.originY);
  const offsetX = first.originX - Math.round(first.originX);
  const north = Math.ceil((BOX.north - offsetY) / CELL - EDGE_EPSILON) * CELL + offsetY;
  const west = Math.floor((BOX.west - offsetX) / CELL + EDGE_EPSILON) * CELL + offsetX;
  const rows = Math.ceil((north - BOX.south) / CELL - EDGE_EPSILON);
  const cols = Math.ceil((BOX.east - west) / CELL - EDGE_EPSILON);

  /**
   * The height of the pixel that holds a point: in its own degree's tile, or a neighbouring one where the grid's
   * sub-pixel offset puts it there. Null over the sea (a tile GLO-90 does not have) or on a void pixel.
   */
  const pixel = (latitude: number, longitude: number): number | null => {
    for (const dLat of [0, -1, 1]) {
      for (const dLon of [0, -1, 1]) {
        const t = tiles.get(tileName({ latitude: Math.floor(latitude) + dLat + 0.5, longitude: Math.floor(longitude) + dLon + 0.5 }));
        if (!t) continue; // not one of the tiles read, or a tile GLO-90 does not have
        const x = Math.floor((longitude - t.originX) / CELL + EDGE_EPSILON);
        const y = Math.floor((t.originY - latitude) / CELL + EDGE_EPSILON);
        if (x < 0 || x >= SIDE || y < 0 || y >= SIDE) continue;
        const m = t.band[y * SIDE + x];
        return Number.isFinite(m) && m > -1000 ? Math.round(m) : null;
      }
    }
    return null;
  };

  const heights = new Int16Array(rows * cols).fill(NO_HEIGHT);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const metres = pixel(north - (r + 0.5) * CELL, west + (c + 0.5) * CELL);
      if (metres !== null) heights[r * cols + c] = metres;
    }
  }
  const map = { rows, cols, north, west, cell: CELL, heights };
  const raw = encodeHeightMap(map);
  const packed = zlib.brotliCompressSync(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
  const back = decodeHeightMap(zlib.brotliDecompressSync(packed));
  if (back.rows !== rows || back.cols !== cols || !back.heights.every((m, i) => m === heights[i])) throw new Error('the round trip differs');
  for (const check of CHECKS) {
    const got = heightAt(back, check.latitude, check.longitude);
    console.log(`[israel-heights] ${check.name}: the map reads ${got} m, Open-Meteo answered ${check.openMeteo} m`);
    if (got === null || Math.abs(got - check.openMeteo) > TOLERANCE_M) {
      throw new Error(`${check.name} reads ${got} m, Open-Meteo answered ${check.openMeteo} m (more than ${TOLERANCE_M} m apart): inspect the tiles' origin and the pixel edge rounding (EDGE_EPSILON) before changing a check`);
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, packed);
  console.log(`[israel-heights] wrote ${path.relative(ROOT, OUT)}: ${rows} x ${cols} cells, ${(packed.length / 1e6).toFixed(2)} MB (north ${north}, west ${west})`);
}

main().catch((error: unknown) => {
  console.error('[israel-heights] stopped, nothing written:', error);
  process.exit(1);
});

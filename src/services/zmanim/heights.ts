// The highest ground of a place in Israel from the stored height map (data/israel-heights-3s.i16.br): the Copernicus
// DEM GLO-90 pixels Open-Meteo's elevation API read, so the answers are what they were, to the metre. Read from disk on
// first use and kept for the process on globalThis (Next 16 gives the scheduler and the routes separate module
// instances): about 21 MB, outside the JS heap. No network. Server only. Plan Task 2.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeHeightMap, heightAt, type HeightMap } from './height-map';
import type { Coordinates } from './elevation-grid';

/**
 * Where the map is: the repo's data/ folder, found from the process's folder. `next start` (Railway) runs in the repo
 * folder, and the standalone server (`node .next/standalone/server.js`) changes into its own folder, where next.config.js
 * traces the file to. The module's own path is no help: the server bundles this file into a chunk under .next/.
 */
export const HEIGHT_MAP_PATH = path.join(process.cwd(),'data', 'israel-heights-3s.i16.br');

const shared = globalThis as { __israelHeightMap?: HeightMap; __israelHeightMapLoads?: number };

function heightMap(): HeightMap {
  if (!shared.__israelHeightMap) {
    const started = performance.now();
    const map = decodeHeightMap(zlib.brotliDecompressSync(fs.readFileSync(HEIGHT_MAP_PATH)));
    shared.__israelHeightMap = map;
    shared.__israelHeightMapLoads = (shared.__israelHeightMapLoads ?? 0) + 1;
    console.log(`[heights] the Israel height map is loaded: ${map.rows} x ${map.cols} cells in ${Math.round(performance.now() - started)} ms`);
  }
  return shared.__israelHeightMap;
}

/**
 * The highest of the points' heights on the map, in whole metres; a point off the map or over the sea is skipped, and
 * null when none is left. Throws what reading or decoding the file throws (the caller logs it).
 */
export function highestHeight(points: readonly Coordinates[]): number | null {
  const map = heightMap();
  let highest: number | null = null;
  for (const point of points) {
    const metres = heightAt(map, point.latitude, point.longitude);
    if (metres !== null && (highest === null || metres > highest)) highest = metres;
  }
  return highest;
}

/** How many times this process read the map from disk (1 after any use). */
export function heightMapLoads(): number {
  return shared.__israelHeightMapLoads ?? 0;
}

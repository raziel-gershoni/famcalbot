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
export const HEIGHT_MAP_PATH = path.join(process.cwd(), 'data', 'israel-heights-3s.i16.br');

/** The file the next read opens: HEIGHT_MAP_PATH, unless a smoke pointed it elsewhere. */
let mapPath = HEIGHT_MAP_PATH;

/**
 * For the smokes only (as the other __...ForTests functions): the next read of the map opens `file` instead of the real
 * one (null: the real one again), to see the loader meet a missing or a corrupt file. Nothing in the app calls it.
 */
export function __setHeightMapPathForTests(file: string | null): void {
  mapPath = file ?? HEIGHT_MAP_PATH;
}

const shared = globalThis as { __israelHeightMap?: HeightMap; __israelHeightMapLoads?: number };

function heightMap(): HeightMap {
  if (!shared.__israelHeightMap) {
    const started = performance.now();
    // The path is a variable (the smokes' hook), so Turbopack would trace the whole project; next.config.js traces the file
    const map = decodeHeightMap(zlib.brotliDecompressSync(fs.readFileSync(/*turbopackIgnore: true*/ mapPath)));
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

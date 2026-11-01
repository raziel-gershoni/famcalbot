// The Israel height map's file layout (data/israel-heights-3s.i16.br): written once by scripts/build-israel-heights.ts,
// read by heights.ts. Pure (node:buffer only), so the script, the loader and the smoke share one encoder and decoder.
// Spec docs/superpowers/specs/2026-10-31-open-meteo-replacement-design.md §5 (height).
//
// The file is brotli over: a 36-byte header, then rows x cols heights in whole metres (int16, little-endian), row by
// row from the north-west corner, each row stored as its difference from the row above (wrapping at 16 bits; the first
// row as it is), which brotli packs far better than plain heights.
//   offset  0  'FCHM'          magic
//   offset  4  uint16  1       version
//   offset  6  uint16  rows
//   offset  8  uint16  cols
//   offset 10  uint16  0       reserved
//   offset 12  float64 north   the north edge of row 0, in degrees (a GLO-90 pixel edge)
//   offset 20  float64 west    the west edge of column 0, in degrees (a GLO-90 pixel edge)
//   offset 28  float64 cell    a cell's side in degrees (1/1200: GLO-90's 3 arc-seconds)
// NO_HEIGHT marks a cell with no height: the sea where GLO-90 has no tile, or a void pixel.

/** A cell with no height. */
export const NO_HEIGHT = -32768;
const MAGIC = 'FCHM';
const VERSION = 1;
export const HEADER_BYTES = 36;

/**
 * A point on a cell's edge is in the cell that edge opens (west and north edges are the cell's own), but the division
 * that finds it can land a hair under the whole number: (35.5 - 34.2) / (1 / 1200) is 1559.9999999999966, so a plain
 * floor reads the neighbouring cell. This much of a cell (a millionth: about a tenth of a millimetre) is added before the floor, here and in
 * scripts/build-israel-heights.ts, so a point is in a cell by the same rule on both sides.
 */
export const EDGE_EPSILON = 1e-6;

export interface HeightMap {
  rows: number;
  cols: number;
  /** The north edge of row 0 and the west edge of column 0, in degrees. */
  north: number;
  west: number;
  /** A cell's side in degrees. */
  cell: number;
  /** rows x cols whole metres, row-major from the north-west corner; NO_HEIGHT where there is none. */
  heights: Int16Array;
}

/** The file's bytes before brotli: the header, then the row-delta heights. */
export function encodeHeightMap(map: HeightMap): Buffer {
  const { rows, cols, heights } = map;
  if (heights.length !== rows * cols) throw new Error(`[heights] ${heights.length} heights for a ${rows} x ${cols} map`);
  const out = Buffer.alloc(HEADER_BYTES + rows * cols * 2);
  out.write(MAGIC, 0, 'latin1');
  out.writeUInt16LE(VERSION, 4);
  out.writeUInt16LE(rows, 6);
  out.writeUInt16LE(cols, 8);
  out.writeUInt16LE(0, 10);
  out.writeDoubleLE(map.north, 12);
  out.writeDoubleLE(map.west, 20);
  out.writeDoubleLE(map.cell, 28);
  for (let i = 0; i < rows * cols; i++) {
    const above = i >= cols ? heights[i - cols] : 0;
    out.writeInt16LE(((heights[i] - above) << 16) >> 16, HEADER_BYTES + i * 2);
  }
  return out;
}

/** The map from the file's bytes after brotli. Throws on bytes that are not one. */
export function decodeHeightMap(raw: Buffer): HeightMap {
  if (raw.length < HEADER_BYTES || raw.toString('latin1', 0, 4) !== MAGIC) throw new Error('[heights] not a FamCal height map');
  const version = raw.readUInt16LE(4);
  if (version !== VERSION) throw new Error(`[heights] height map version ${version}, this code reads ${VERSION}`);
  const rows = raw.readUInt16LE(6);
  const cols = raw.readUInt16LE(8);
  if (raw.length !== HEADER_BYTES + rows * cols * 2) throw new Error(`[heights] ${raw.length} bytes for a ${rows} x ${cols} map`);
  const heights = new Int16Array(rows * cols);
  for (let i = 0; i < rows * cols; i++) {
    const delta = raw.readInt16LE(HEADER_BYTES + i * 2);
    heights[i] = i >= cols ? ((delta + heights[i - cols]) << 16) >> 16 : delta;
  }
  return { rows, cols, north: raw.readDoubleLE(12), west: raw.readDoubleLE(20), cell: raw.readDoubleLE(28), heights };
}

/** The height of the cell that holds the point, in metres; null off the map or on a cell with none. */
export function heightAt(map: HeightMap, latitude: number, longitude: number): number | null {
  const row = Math.floor((map.north - latitude) / map.cell + EDGE_EPSILON);
  const col = Math.floor((longitude - map.west) / map.cell + EDGE_EPSILON);
  if (!(row >= 0 && row < map.rows && col >= 0 && col < map.cols)) return null;
  const metres = map.heights[row * map.cols + col];
  return metres === NO_HEIGHT ? null : metres;
}

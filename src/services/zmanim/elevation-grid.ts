// Where a place's height is read: the bot's rule for "the highest point in the place" (Rav Ovadia's), a 5 x 5 grid over
// the place's Nominatim bounding box, each edge pulled in to at most 3 km from the centre. Pure, with a type-only
// import, so the bot (place.ts, which re-exports it) and the one-off scripts/build-city-heights.ts count it the same
// way without loading the database or Redis.

import type { BoundingBox } from '../../lib/timezone';

/** The grid is this many points on a side: 5 x 5 = 25, well under Open-Meteo's 100 per request. */
const GRID_SIDE = 5;
/** The grid reaches at most this far from the place's centre, in metres. */
const MAX_REACH_M = 3000;
const METRES_PER_DEGREE_LATITUDE = 111_320;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/**
 * The 25 points to ask the elevation of: a 5 x 5 grid over the place's bounding box, each edge
 * pulled in to at most 3 km from the centre. Just the centre where Nominatim sent no box.
 */
export function elevationGrid(centre: Coordinates, box: BoundingBox | null): Coordinates[] {
  if (!box) return [centre];
  const reachLatitude = MAX_REACH_M / METRES_PER_DEGREE_LATITUDE;
  const reachLongitude = MAX_REACH_M / (METRES_PER_DEGREE_LATITUDE * Math.max(Math.cos((centre.latitude * Math.PI) / 180), 0.01));
  const south = Math.max(box[0], centre.latitude - reachLatitude);
  const north = Math.min(box[1], centre.latitude + reachLatitude);
  const west = Math.max(box[2], centre.longitude - reachLongitude);
  const east = Math.min(box[3], centre.longitude + reachLongitude);
  if (!(south <= north && west <= east)) return [centre];
  const points: Coordinates[] = [];
  for (let row = 0; row < GRID_SIDE; row++) {
    for (let column = 0; column < GRID_SIDE; column++) {
      points.push({
        latitude: south + ((north - south) * row) / (GRID_SIDE - 1),
        longitude: west + ((east - west) * column) / (GRID_SIDE - 1),
      });
    }
  }
  return points;
}

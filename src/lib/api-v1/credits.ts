// The credits an answer carries (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.8): the licences ask for
// credit where derived data is shown, and the other app shows these beside the times, as the zmanim pages do.
//   copernicus-dem  wherever an answer gives a height (the stored heights are adapted Copernicus GLO-90 data)
//   geonames        a city's position and zone (NOTICE item 2)
//   openstreetmap   a zone found from coordinates (timezone-boundary-builder's map)
// The texts are English constants, never translated (a licence's words are its own). hebcal is code and needs no credit.

import { COPERNICUS_NOTICE } from '../../site/zmanim/sources';
import type { ApiPlace } from './place';

export type Credit = { source: 'copernicus-dem' | 'geonames' | 'openstreetmap'; text: string; url?: string };

const COPERNICUS: Credit = { source: 'copernicus-dem', text: COPERNICUS_NOTICE };
const GEONAMES: Credit = { source: 'geonames', text: 'City positions: GeoNames, under CC BY 4.0.', url: 'https://www.geonames.org/' };
const OPENSTREETMAP: Credit = { source: 'openstreetmap', text: 'Time zone map © OpenStreetMap contributors, under ODbL.', url: 'https://www.openstreetmap.org/copyright' };

export function creditsFor(place: ApiPlace): Credit[] {
  const out: Credit[] = [];
  if (place.place.elevationM !== null) out.push(COPERNICUS);
  out.push(place.source === 'city' ? GEONAMES : OPENSTREETMAP);
  return out;
}

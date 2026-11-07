// A request's place (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.2) as the engine reads one.
//
// - A city: its stored point, height and zone (cityPlace; every Israeli city is Asia/Jerusalem).
// - Coordinates (checked and rounded in params.ts): the zone from zoneForCoords; none (the open sea) is NO_TIME_ZONE, which
//   zoneForCoords reports as a warning with no coordinates. In Israel's zone the height is the stored map's at the point
//   itself (open point A); a map that cannot be read is reported under api-v1 and the place counts at sea level, as the
//   bot does. Abroad the height is null (no set uses it there).
// - `il` is inIsrael(zone): the Yom Tov days, the height, the Sephardi end of Shabbat, the holidays' { il }, the default
//   community. Asia/Hebron and Asia/Gaza count as abroad, as in the app.
// No place reaches a log or Sentry.

import { inIsrael, type Place } from '../../services/zmanim/compute';
import { highestHeight } from '../../services/zmanim/heights';
import { cityBySlug } from '../../site/cities';
import { cityPlace } from '../../site/zmanim/city-view';
import { captureError } from '../error-capture';
import { zoneForCoords } from '../zone-for-coords';
import type { PlaceParam } from './params';
import { ApiError, reportable } from './respond';

export type ApiPlace = {
  source: 'city' | 'coords';
  /** The city's slug, null for coordinates. */
  slug: string | null;
  place: Place;
  il: boolean;
};

function pointHeight(latitude: number, longitude: number): number | null {
  try {
    return highestHeight([{ latitude, longitude }]);
  } catch (error) {
    captureError(reportable(error, 'the Israel height map could not be read: counted at sea level'), 'api-v1', { service: 'api-v1', step: 'height' });
    return null;
  }
}

export function resolveApiPlace(param: PlaceParam): ApiPlace {
  if (param.kind === 'city') {
    const city = cityBySlug(param.slug);
    if (!city) throw new ApiError('UNKNOWN_CITY', 'city is not a slug of the city list (see the reference\'s city list)');
    return { source: 'city', slug: city.slug, place: cityPlace(city), il: inIsrael(city.timeZone) };
  }
  const zone = zoneForCoords(param.latitude, param.longitude);
  if (zone === null) throw new ApiError('NO_TIME_ZONE', 'there is no time zone at these coordinates (the open sea)');
  const il = inIsrael(zone);
  return {
    source: 'coords',
    slug: null,
    place: { latitude: param.latitude, longitude: param.longitude, timeZone: zone, elevationM: il ? pointHeight(param.latitude, param.longitude) : null },
    il,
  };
}

import type { CityView } from '@/src/site/zmanim/city-view';
import type { SiteT } from './words';

// The note under the month (spec §4.2.5): the times are for the city's centre (and, for Sephardi in Israel, at its
// height), candle lighting is 20 minutes before sunset, and a halachic time that matters is checked with a reliable source.
export function PageNote({ view, t }: { view: CityView; t: SiteT }) {
  const city = t(`cities.${view.city.slug}`);
  return <p className="site-zm-note">{view.heightM !== null ? t('zmanimSite.note.height', { city, height: view.heightM }) : t('zmanimSite.note.plain', { city })}</p>;
}

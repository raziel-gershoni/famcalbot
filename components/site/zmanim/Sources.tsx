import { COPERNICUS_NOTICE } from '@/src/site/zmanim/sources';
import type { SiteT } from './words';

// The credits at the bottom of the zmanim pages (spec §5.3): GeoNames (CC BY 4.0) with a link, the OpenStreetMap
// contributors for the town outlines behind the heights, and the Copernicus DEM with its required notice, in English on
// every page (src/site/zmanim/sources.ts).
export function Sources({ t }: { t: SiteT }) {
  return (
    <section className="site-zm-sources" aria-labelledby="sources-title">
      <h2 id="sources-title" className="site-h3">
        {t('zmanimSite.sources.title')}
      </h2>
      <ul>
        <li>{t.rich('zmanimSite.sources.geonames', { link: (chunks) => <a href="https://www.geonames.org/">{chunks}</a> })}</li>
        <li>{t.rich('zmanimSite.sources.osm', { link: (chunks) => <a href="https://www.openstreetmap.org/copyright">{chunks}</a> })}</li>
        <li>
          {t('zmanimSite.sources.copernicus')}{' '}
          <span lang="en" dir="ltr">
            {COPERNICUS_NOTICE}
          </span>
        </li>
      </ul>
    </section>
  );
}

import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { SitePage } from '@/components/site/SitePage';
import { NearMe } from '@/components/site/zmanim/NearMe';
import { Sources } from '@/components/site/zmanim/Sources';
import { intlLocale } from '@/src/lib/calendar-view/format';
import { CITIES } from '@/src/site/cities';
import { siteMetadata } from '@/src/site/seo';
import { cityGroups } from '@/src/site/zmanim/city-groups';
import { cityPath, localeHref } from '@/src/site/zmanim/links';
import { nearWords } from '@/src/site/zmanim/near-words';

// The zmanim index (spec 2026-10-30-public-zmanim §4.1): the title and one line, Near me (the page's only script), and the
// city list: Israel first, then the countries, each sorted by name in the page's language, each city a 44 px link to its
// clean page (a plain anchor: a prefetching list of city pages would spend a reader's request allowance). Static per
// locale. The sources at the bottom, as on a city's page.

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return siteMetadata({ locale, path: '/zmanim', title: t('zmanimSite.index.metaTitle'), description: t('zmanimSite.index.description', { count: CITIES.length }), imageAlt: t('landing.meta.ogImageAlt') });
}

export default async function ZmanimIndexPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale });
  const cityName = (slug: string) => t(`cities.${slug}`);
  const groups = cityGroups(CITIES, cityName, (code) => t(`countries.${code}`), new Intl.Collator(intlLocale(locale)));
  const near = CITIES.map((c) => ({ slug: c.slug, latitude: c.latitude, longitude: c.longitude, timeZone: c.timeZone, name: cityName(c.slug), href: localeHref(locale, cityPath(c.slug)) }));
  return (
    <SitePage locale={locale} path="/zmanim">
      <main id="main" className="site-section site-page-main">
        <div className="site-wrap site-narrow">
          <h1 className="site-h1 site-page-title">{t('zmanimSite.index.title')}</h1>
          <p className="site-lead">{t('zmanimSite.index.lead', { count: CITIES.length })}</p>
          <section className="site-zm-near" aria-labelledby="near-title">
            <h2 id="near-title" className="site-h3">
              {t('zmanimSite.near.title')}
            </h2>
            <NearMe cities={near} words={nearWords(t)} />
          </section>
          <section id="cities" className="site-zm-section" aria-labelledby="cities-title">
            <h2 id="cities-title" className="site-h2">
              {t('zmanimSite.index.listTitle')}
            </h2>
            <div className="site-zm-countries">
              {groups.map((group) => (
                <section key={group.country} className="site-zm-country" aria-labelledby={`country-${group.country}`}>
                  <h3 id={`country-${group.country}`} className="site-h3">
                    {group.name}
                  </h3>
                  <ul className="site-zm-cities">
                    {group.cities.map((city) => (
                      <li key={city.slug}>
                        <a href={localeHref(locale, cityPath(city.slug))}>{city.name}</a>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </section>
          <Sources t={t} />
        </div>
      </main>
    </SitePage>
  );
}

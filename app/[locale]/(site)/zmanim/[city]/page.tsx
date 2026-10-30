import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { SitePage } from '@/components/site/SitePage';
import { AheadCard } from '@/components/site/zmanim/AheadCard';
import { DayCard } from '@/components/site/zmanim/DayCard';
import { FamCalBlock } from '@/components/site/zmanim/FamCalBlock';
import { MonthGrid } from '@/components/site/zmanim/MonthGrid';
import { MonthList } from '@/components/site/zmanim/MonthList';
import { PageNote } from '@/components/site/zmanim/PageNote';
import { Sources } from '@/components/site/zmanim/Sources';
import { Link } from '@/i18n/navigation';
import { captureError } from '@/src/lib/error-capture';
import { cityBySlug } from '@/src/site/cities';
import { siteMetadata } from '@/src/site/seo';
import { buildCityView, readCityParams } from '@/src/site/zmanim/city-view';
import { cityPath } from '@/src/site/zmanim/links';

// One city's zmanim page (spec 2026-10-30-public-zmanim §4.2): the day's zmanim, the Shabbat and Yom Tov ahead, the
// month, the note, FamCal and the sources. Computed on each request (the city's today; ?date and ?community from the URL,
// read by readCityParams), from the same engine as the bot's sun sheet, with no database and no network. The canonical
// URL and the language links are always the clean one. A section that fails is logged with the city, the day and the
// community, and says so; the rest of the page renders. The page ships no script of its own.

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: string; city: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, city: slug } = await params;
  const city = cityBySlug(slug);
  if (!city) return {};
  const t = await getTranslations({ locale });
  const name = t(`cities.${city.slug}`);
  return siteMetadata({ locale, path: cityPath(city.slug), title: t('zmanimSite.city.metaTitle', { city: name }), description: t('zmanimSite.city.description', { city: name }), imageAlt: t('landing.meta.ogImageAlt') });
}

export default async function CityZmanimPage({ params, searchParams }: Props) {
  const { locale, city: slug } = await params;
  setRequestLocale(locale);
  const city = cityBySlug(slug);
  if (!city) notFound();
  const view = buildCityView(city, readCityParams(city, await searchParams, new Date()), locale);
  for (const failure of view.failures) {
    captureError(failure.error, 'zmanim-site', { service: 'zmanim-site', slug: city.slug, day: view.day, community: view.community, section: failure.section });
  }
  const t = await getTranslations({ locale });
  const tc = await getTranslations({ locale, namespace: 'calendarHome' });
  return (
    <SitePage locale={locale} path={cityPath(city.slug)}>
      <main id="main" className="site-section site-page-main">
        <div className="site-wrap site-narrow">
          <p className="site-back">
            <Link href="/zmanim">{t('zmanimSite.city.back')}</Link>
          </p>
          <h1 className="site-h1 site-page-title">{t('zmanimSite.city.heading', { city: t(`cities.${city.slug}`) })}</h1>
          <DayCard view={view} locale={locale} t={t} tc={tc} />
          <AheadCard view={view} locale={locale} t={t} tc={tc} />
          <section className="site-zm-section" aria-labelledby="month-title">
            <MonthGrid view={view} locale={locale} t={t} tc={tc} />
            <MonthList view={view} locale={locale} t={t} tc={tc} />
          </section>
          <PageNote view={view} t={t} />
          <FamCalBlock t={t} />
          <Sources t={t} />
        </div>
      </main>
    </SitePage>
  );
}

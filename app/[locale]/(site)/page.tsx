import type { Metadata } from 'next';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import { HeroDemo } from '@/components/site/HeroDemo';
import { Channels, Features, Founder, HowItWorks, Plans, StartAgain } from '@/components/site/LandingSections';
import { SitePage } from '@/components/site/SitePage';
import { HonestLine, StartButtons, startWords } from '@/components/site/StartButtons';
import { SITE_URL } from '@/src/site/config';
import { buildSampleWeek, sampleWords } from '@/src/site/sample-week';

// The landing (spec 2026-10-28-public-website §3.2): the hero (the headline, the line under it, the two start buttons
// with the honest line, and the voice note becoming an event, built from the app's live parts), then How it works,
// What it does, Telegram or WhatsApp, Plans, From the founder and Start again.
//
// Static: rendered per locale at build time, and again once a day (revalidate) so the sample week's Thursday is
// always the coming one. It reads nothing on the server beyond the plan table (src/config/plans.ts) and messages; it
// never reads the early-access switch.

export const revalidate = 86400;

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  const url = locale === 'en' ? SITE_URL : `${SITE_URL}/${locale}`;
  return {
    title: { absolute: t('landing.meta.title') },
    description: t('landing.meta.description'),
    openGraph: { title: t('landing.meta.ogTitle'), description: t('landing.meta.description'), type: 'website', url },
    alternates: {
      canonical: url,
      languages: { en: SITE_URL, he: `${SITE_URL}/he`, ru: `${SITE_URL}/ru`, 'x-default': SITE_URL },
    },
  };
}

export default async function LandingPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale });
  const messages = await getMessages({ locale });
  const week = buildSampleWeek(sampleWords(t));
  const words = startWords(t);
  // Two lines by design; a dash never starts a line (a no-break space before it, as Russian sets it)
  const headline = t('landing.hero.headline').split('\n').map((line) => line.replace(/ —/g, '\u00a0—'));

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'FamCal',
      applicationCategory: 'LifestyleApplication',
      operatingSystem: 'Telegram, WhatsApp',
      description: t('site.jsonLd.description'),
      url: locale === 'en' ? SITE_URL : `${SITE_URL}/${locale}`,
      author: { '@type': 'Person', name: 'Raziel' },
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', description: t('site.jsonLd.offer') },
      featureList: t.raw('site.jsonLd.features'),
      inLanguage: ['he', 'en', 'ru'],
    },
    { '@context': 'https://schema.org', '@type': 'Organization', name: 'FamCal', url: SITE_URL, logo: `${SITE_URL}/icon.png` },
  ];

  return (
    <SitePage locale={locale} path="/">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
      <main id="main">
        <section className="site-hero" aria-labelledby="hero-title">
          <div className="site-wrap">
            <h1 id="hero-title" className="site-h1">
              {headline.map((line) => (
                <span key={line} className="site-h1-line">
                  {line}
                </span>
              ))}
            </h1>
            <div className="site-hero-grid">
              <div className="site-hero-text">
                <p className="site-hero-lead">{t('landing.hero.subtitle')}</p>
                <StartButtons words={words} />
                <HonestLine text={t('site.cta.honest')} />
              </div>
              <HeroDemo t={t} locale={locale} week={week} messages={messages} />
            </div>
          </div>
        </section>
        <HowItWorks t={t} />
        <Features t={t} />
        <Channels t={t} />
        <Plans t={t} />
        <Founder t={t} />
        <StartAgain t={t} words={words} />
      </main>
    </SitePage>
  );
}

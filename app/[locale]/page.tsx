import { getTranslations } from 'next-intl/server';
import { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import SiteHeader from '@/components/Layout/SiteHeader';
import SiteFooter from '@/components/Layout/Footer';

type Props = {
  params: Promise<{ locale: string }>;
};

const BOT_URL = 'https://t.me/family_calendar_telegram_bot';

function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className ?? 'w-6 h-6'}>
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161c-.18 1.897-.962 6.502-1.359 8.627-.168.9-.5 1.201-.82 1.23-.697.064-1.226-.461-1.901-.903-1.056-.692-1.653-1.123-2.678-1.799-1.185-.781-.417-1.21.258-1.911.177-.184 3.247-2.977 3.307-3.23.007-.032.015-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.139-5.062 3.345-.479.329-.913.489-1.302.481-.428-.009-1.252-.242-1.865-.442-.752-.244-1.349-.374-1.297-.789.027-.216.324-.437.893-.663 3.498-1.524 5.831-2.529 6.998-3.015 3.333-1.386 4.025-1.627 4.477-1.635.099-.002.321.023.465.141.121.099.154.232.17.325.015.093.034.306.019.472z" />
    </svg>
  );
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'landing' });
  const baseUrl = 'https://famcal.bot';

  return {
    title: t('meta.title'),
    description: t('meta.description'),
    openGraph: {
      title: t('meta.ogTitle'),
      description: t('meta.ogDescription'),
      type: 'website',
      images: [{ url: `${baseUrl}/og-image.png` }],
    },
    alternates: {
      canonical: locale === 'en' ? baseUrl : `${baseUrl}/${locale}`,
      languages: {
        en: baseUrl,
        he: `${baseUrl}/he`,
        ru: `${baseUrl}/ru`,
        'x-default': baseUrl,
      },
    },
  };
}

export default async function LandingPage({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'landing' });

  const features = [
    { key: 'voiceSummaries', icon: '🎧' },
    { key: 'voiceCommands', icon: '🎤' },
    { key: 'smartPickup', icon: '🚗' },
    { key: 'weatherContext', icon: '🌤️' },
    { key: 'hebrewCalendar', icon: '📅' },
    { key: 'familyView', icon: '👨‍👩‍👧‍👦' },
  ] as const;

  const jsonLdApp = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'FamCal',
    applicationCategory: 'LifestyleApplication',
    operatingSystem: 'Telegram',
    description:
      'AI-powered family calendar assistant that merges Google Calendars into daily briefings on Telegram with voice summaries, smart pickup order, and Hebrew calendar support.',
    url: 'https://famcal.bot',
    author: { '@type': 'Person', name: 'Raziel' },
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      description: 'Free during early access',
    },
    featureList: [
      'Voice daily schedule summaries',
      'Voice event creation and management',
      'Smart kids pickup order',
      'Context-aware weather integration',
      'Hebrew calendar with gematriya',
      'Multilingual support (Hebrew, English, Russian)',
      'Google Calendar integration',
      'AI conflict detection',
    ],
    inLanguage: ['he', 'en', 'ru'],
  };

  const jsonLdOrg = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'FamCal',
    url: 'https://famcal.bot',
    logo: 'https://famcal.bot/icon.png',
  };

  return (
    <>
      {/* ─── JSON-LD STRUCTURED DATA ─── */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLdApp) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLdOrg) }}
      />

      <SiteHeader locale={locale} ctaText={t('header.startFree')} />

      {/* ─── HERO ─── */}
      <section
        className="relative flex min-h-[85vh] flex-col items-center justify-center overflow-hidden px-6 py-24 text-center sm:py-32"
        style={{ background: 'var(--gradient-hero)' }}
      >
        <div className="pointer-events-none absolute -end-32 -top-32 h-80 w-80 rounded-full bg-brand-primary/[0.07] blur-3xl sm:h-[500px] sm:w-[500px]" />
        <div className="pointer-events-none absolute -bottom-32 -start-32 h-80 w-80 rounded-full bg-brand-secondary/[0.07] blur-3xl sm:h-[500px] sm:w-[500px]" />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-[0.03]">
          <Image src="/icon.png" alt="" width={500} height={500} priority />
        </div>
        <div className="relative z-10 max-w-2xl">
          <h1 className="mb-6 whitespace-pre-line text-4xl font-bold leading-tight text-text-primary sm:text-5xl lg:text-6xl">
            {t('hero.headline')}
          </h1>
          <p className="mx-auto mb-10 max-w-xl text-lg leading-relaxed text-text-secondary sm:text-xl">
            {t('hero.subtitle')}
          </p>
          <a
            href={BOT_URL}
            className="inline-flex items-center gap-3 rounded-xl bg-brand-telegram px-8 py-4 text-lg font-semibold text-white shadow-lg shadow-brand-telegram/25 transition-all hover:scale-105 hover:shadow-xl"
          >
            <TelegramIcon />
            {t('hero.cta')}
          </a>
          <p className="mt-5 text-sm text-text-muted">{t('hero.ctaSecondary')}</p>
        </div>
      </section>

      {/* ─── PAIN POINTS ─── */}
      <section className="bg-bg-section px-6 py-20">
        <div className="mx-auto max-w-xl">
          <h2 className="mb-12 text-center text-3xl font-bold text-text-primary">
            {t('painPoints.title')}
          </h2>
          <div className="space-y-4">
            {(['item1', 'item2', 'item3', 'item4'] as const).map((key, i) => (
              <div
                key={key}
                className={`max-w-[88%] rounded-2xl border border-gray-100 bg-white px-5 py-3.5 shadow-sm ${
                  i % 2 === 1 ? 'ms-auto' : ''
                }`}
              >
                <p className="text-[15px] leading-relaxed italic text-text-primary">
                  &ldquo;{t(`painPoints.${key}`)}&rdquo;
                </p>
              </div>
            ))}
          </div>
          <p className="mt-12 text-center text-xl font-semibold text-brand-primary sm:text-2xl">
            {t('painPoints.resolution')}
          </p>
        </div>
      </section>

      {/* ─── CORE VALUE PROP ─── */}
      <section className="bg-white px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-14 text-center text-3xl font-bold text-text-primary">
            {t('coreValue.title')}
          </h2>
          <div className="grid items-start gap-10 md:grid-cols-2">
            {/* Mock Telegram message */}
            <div
              className="overflow-hidden rounded-2xl border border-gray-200 shadow-lg"
              style={{ background: 'var(--gradient-card)' }}
            >
              <div className="flex items-center gap-2 bg-brand-telegram px-4 py-2.5">
                <Image src="/icon.png" alt="" width={24} height={24} className="rounded-full" />
                <span className="text-sm font-medium text-white">FamCal</span>
              </div>
              <div className="space-y-3 px-4 py-4 text-sm leading-relaxed text-text-primary">
                <p className="font-medium">{t('coreValue.mockGreeting')}</p>
                <div>
                  <p className="font-semibold">{t('coreValue.mockDate')}</p>
                  <p className="text-xs text-text-muted">{t('coreValue.mockHebrewDate')}</p>
                </div>
                <div>
                  <p className="font-semibold text-brand-primary">{t('coreValue.mockYourSchedule')}</p>
                  <p>{t('coreValue.mockEvent1')}</p>
                  <p>{t('coreValue.mockEvent2')}</p>
                </div>
                <div>
                  <p className="font-semibold text-brand-primary">{t('coreValue.mockSpouseSchedule')}</p>
                  <p>{t('coreValue.mockSpouseEvent')}</p>
                </div>
                <div>
                  <p className="font-semibold text-brand-primary">{t('coreValue.mockPickupTitle')}</p>
                  <p>{t('coreValue.mockPickup1')}</p>
                  <p>{t('coreValue.mockPickup2')}</p>
                </div>
                <p className="rounded-lg bg-brand-primary/5 px-3 py-2 text-[13px] text-text-secondary">
                  💡 {t('coreValue.mockInsight')}
                </p>
                <p className="text-[13px] text-text-secondary">
                  🌤️ {t('coreValue.mockWeather')}
                </p>
              </div>
            </div>

            {/* Bullet points */}
            <div className="space-y-6 py-4">
              {(['bullet1', 'bullet2', 'bullet3', 'bullet4', 'bullet5'] as const).map((key) => (
                <div key={key} className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-accent-teal/20">
                    <div className="h-2 w-2 rounded-full bg-brand-accent-teal" />
                  </div>
                  <p className="leading-relaxed text-text-secondary">{t(`coreValue.${key}`)}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ─── FEATURES GRID ─── */}
      <section className="bg-bg-light px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-14 text-center text-3xl font-bold text-text-primary">
            {t('features.title')}
          </h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {features.map(({ key, icon }) => (
              <div
                key={key}
                className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm transition-all hover:-translate-y-1 hover:shadow-md"
              >
                <div className="mb-4 text-4xl">{icon}</div>
                <h3 className="mb-2 text-lg font-semibold text-text-primary">
                  {t(`features.${key}.title`)}
                </h3>
                <p className="text-sm leading-relaxed text-text-secondary">
                  {t(`features.${key}.description`)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── HOW IT WORKS ─── */}
      <section className="bg-white px-6 py-20">
        <div className="mx-auto max-w-3xl">
          <h2 className="mb-14 text-center text-3xl font-bold text-text-primary">
            {t('howItWorks.title')}
          </h2>
          <div className="flex flex-col gap-10 sm:flex-row sm:gap-6">
            {([1, 2, 3] as const).map((num) => (
              <div key={num} className="flex flex-1 flex-col items-center text-center">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand-primary text-lg font-bold text-white">
                  {num}
                </div>
                <h3 className="mb-2 font-semibold text-text-primary">
                  {t(`howItWorks.step${num}.title`)}
                </h3>
                <p className="text-sm leading-relaxed text-text-secondary">
                  {t(`howItWorks.step${num}.description`)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── EARLY ACCESS BANNER ─── */}
      <section
        className="px-6 py-20 text-center text-white"
        style={{ background: 'var(--gradient-brand)' }}
      >
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-4 text-3xl font-bold sm:text-4xl">{t('earlyAccess.title')}</h2>
          <p className="mb-10 text-lg leading-relaxed text-white/90">
            {t('earlyAccess.subtitle')}
          </p>
          <a
            href={BOT_URL}
            className="inline-flex items-center gap-3 rounded-xl bg-white px-8 py-4 text-lg font-semibold text-brand-primary shadow-lg transition-transform hover:scale-105"
          >
            <TelegramIcon />
            {t('earlyAccess.cta')}
          </a>
        </div>
      </section>

      {/* ─── PERSONAL STORY ─── */}
      <section className="bg-bg-light px-6 py-20">
        <div className="mx-auto max-w-2xl text-center">
          <Image src="/icon.png" alt="FamCal" width={48} height={48} className="mx-auto mb-6 rounded-xl" />
          <blockquote className="mb-6 text-lg leading-relaxed italic text-text-secondary sm:text-xl">
            &ldquo;{t('personalStory.quote')}&rdquo;
          </blockquote>
          <p className="mb-4 font-semibold text-text-primary">
            — {t('personalStory.author')}
          </p>
          <Link
            href={`/${locale}/blog/why-i-built-famcal`}
            className="font-medium text-brand-primary hover:underline"
          >
            {t('personalStory.readMore')}
          </Link>
        </div>
      </section>

      <SiteFooter
        locale={locale}
        tagline={t('footer.tagline')}
        privacy={t('footer.privacy')}
        terms={t('footer.terms')}
        contact={t('footer.contact')}
        madeIn={t('footer.madeIn')}
        copyright={t('footer.copyright')}
      />
    </>
  );
}

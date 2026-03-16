import { getTranslations } from 'next-intl/server';
import { Metadata } from 'next';
import Link from 'next/link';
import SiteHeader from '@/components/Layout/SiteHeader';
import SiteFooter from '@/components/Layout/Footer';

type Props = {
  params: Promise<{ locale: string }>;
};

const BOT_URL = 'https://t.me/family_calendar_telegram_bot';

function TelegramIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161c-.18 1.897-.962 6.502-1.359 8.627-.168.9-.5 1.201-.82 1.23-.697.064-1.226-.461-1.901-.903-1.056-.692-1.653-1.123-2.678-1.799-1.185-.781-.417-1.21.258-1.911.177-.184 3.247-2.977 3.307-3.23.007-.032.015-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.139-5.062 3.345-.479.329-.913.489-1.302.481-.428-.009-1.252-.242-1.865-.442-.752-.244-1.349-.374-1.297-.789.027-.216.324-.437.893-.663 3.498-1.524 5.831-2.529 6.998-3.015 3.333-1.386 4.025-1.627 4.477-1.635.099-.002.321.023.465.141.121.099.154.232.17.325.015.093.034.306.019.472z" />
    </svg>
  );
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'howItWorksPage' });

  return {
    title: t('meta.title'),
    description: t('meta.description'),
  };
}

export default async function HowItWorksPage({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'howItWorksPage' });
  const tNav = await getTranslations({ locale, namespace: 'nav' });
  const tLanding = await getTranslations({ locale, namespace: 'landing' });

  const navLinks = [
    { href: `/${locale}/how-it-works`, label: tNav('howItWorks') },
    { href: `/${locale}/blog`, label: tNav('blog') },
  ];

  const steps = [
    { num: 1, title: t('step1.title'), description: t('step1.description') },
    { num: 2, title: t('step2.title'), description: t('step2.description'), note: t('step2.note') },
    { num: 3, title: t('step3.title'), description: t('step3.description') },
  ];

  const dailyKeys = ['summary', 'merged', 'pickup', 'weather', 'voice', 'insights'] as const;

  const noNeedItems = t.raw('noNeed') as string[];

  return (
    <>
      <SiteHeader locale={locale} ctaText={tLanding('header.startFree')} navLinks={navLinks} />

      {/* ─── HERO ─── */}
      <section className="bg-bg-light px-6 py-20 text-center">
        <div className="mx-auto max-w-2xl">
          <h1 className="mb-4 text-4xl font-bold text-text-primary sm:text-5xl">
            {t('heroTitle')}
          </h1>
          <p className="text-lg text-text-secondary leading-relaxed">
            {t('heroSubtitle')}
          </p>
        </div>
      </section>

      {/* ─── SETUP STEPS ─── */}
      <section className="bg-white px-6 py-20">
        <div className="mx-auto max-w-3xl">
          <h2 className="mb-14 text-center text-sm font-semibold uppercase tracking-widest text-text-muted">
            {t('setupTitle')}
          </h2>
          <div className="relative space-y-12">
            {/* Vertical connecting line */}
            <div className="absolute start-6 top-6 bottom-6 w-px bg-brand-primary/15 hidden sm:block" />

            {steps.map((step) => (
              <div key={step.num} className="flex gap-6 items-start">
                <div className="relative z-10 flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-primary text-lg font-bold text-white shadow-md shadow-brand-primary/20">
                  {step.num}
                </div>
                <div className="pt-1">
                  <h3 className="mb-2 text-xl font-semibold text-text-primary">{step.title}</h3>
                  <p className="leading-relaxed text-text-secondary">{step.description}</p>
                  {step.note && (
                    <p className="mt-2 text-sm text-text-muted italic">{step.note}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── DAILY EXPERIENCE ─── */}
      <section className="bg-bg-light px-6 py-20">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-14 text-center text-3xl font-bold text-text-primary">
            {t('dailyTitle')}
          </h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {dailyKeys.map((key) => (
              <div
                key={key}
                className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm"
              >
                <div className="mb-3 text-3xl">{t(`daily.${key}.icon`)}</div>
                <h3 className="mb-2 text-lg font-semibold text-text-primary">
                  {t(`daily.${key}.title`)}
                </h3>
                <p className="text-sm leading-relaxed text-text-secondary">
                  {t(`daily.${key}.description`)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── WHAT YOU DON'T NEED ─── */}
      <section className="bg-white px-6 py-20">
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-10 text-center text-3xl font-bold text-text-primary">
            {t('noNeedTitle')}
          </h2>
          <div className="space-y-4">
            {noNeedItems.map((item, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-accent-teal/20">
                  <svg className="h-3.5 w-3.5 text-brand-accent-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-text-secondary leading-relaxed">{item}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── CTA ─── */}
      <section
        className="px-6 py-20 text-center text-white"
        style={{ background: 'var(--gradient-brand)' }}
      >
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-4 text-3xl font-bold sm:text-4xl">{t('ctaTitle')}</h2>
          <p className="mb-10 text-white/90">{t('ctaSubtitle')}</p>
          <a
            href={BOT_URL}
            className="inline-flex items-center gap-3 rounded-xl bg-white px-8 py-4 text-lg font-semibold text-brand-primary shadow-lg transition-transform hover:scale-105"
          >
            <TelegramIcon />
            {tLanding('earlyAccess.cta')}
          </a>
        </div>
      </section>

      <SiteFooter
        locale={locale}
        tagline={tLanding('footer.tagline')}
        privacy={tLanding('footer.privacy')}
        terms={tLanding('footer.terms')}
        contact={tLanding('footer.contact')}
        share={tLanding('footer.share')}
        madeIn={tLanding('footer.madeIn')}
        copyright={tLanding('footer.copyright')}
      />
    </>
  );
}

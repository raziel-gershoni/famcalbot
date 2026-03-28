import { getTranslations } from 'next-intl/server';
import { Metadata } from 'next';
import SiteHeader from '@/components/Layout/SiteHeader';
import SiteFooter from '@/components/Layout/Footer';
import { CopyButton, QRSection } from './ShareClient';

type Props = {
  params: Promise<{ locale: string }>;
};

const BOT_URL = 'https://t.me/family_calendar_telegram_bot';
const SITE_URL = 'https://famcal.bot';
const WA_PHONE = '972548524687';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'share' });

  return {
    title: t('pageTitle'),
    description: t('pageSubtitle'),
    robots: { index: false, follow: false },
  };
}

export default async function SharePage({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'share' });
  const tLanding = await getTranslations({ locale, namespace: 'landing' });
  const tNav = await getTranslations({ locale, namespace: 'nav' });
  const tBot = await getTranslations({ locale, namespace: 'bot' });

  const waUrl = `https://wa.me/${WA_PHONE}?text=${encodeURIComponent(tBot('whatsapp.greeting'))}`;

  const navLinks = [
    { href: `/${locale}/how-it-works`, label: tNav('howItWorks') },
    { href: `/${locale}/blog`, label: tNav('blog') },
  ];

  const messages = [
    { label: t('shortLabel'), text: t('msgShort') },
    { label: t('mediumLabel'), text: t('msgMedium') },
    { label: t('parentLabel'), text: t('msgParent') },
  ];

  return (
    <>
      <SiteHeader locale={locale} ctaText={tLanding('header.startFree')} navLinks={navLinks} waUrl={waUrl} />

      <main className="mx-auto max-w-3xl px-6 py-16">
        <div className="mb-14 text-center">
          <h1 className="mb-3 text-4xl font-bold text-text-primary">{t('pageTitle')}</h1>
          <p className="text-lg text-text-secondary">{t('pageSubtitle')}</p>
        </div>

        {/* ─── PITCH MESSAGES ─── */}
        <section className="mb-16">
          <h2 className="mb-6 text-2xl font-bold text-text-primary">{t('messagesTitle')}</h2>
          <div className="space-y-6">
            {messages.map(({ label, text }) => (
              <div
                key={label}
                className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm"
              >
                <div className="mb-3 flex items-center justify-between gap-4">
                  <span className="text-sm font-semibold text-text-muted">{label}</span>
                  <CopyButton text={text} copiedLabel={t('copied')} />
                </div>
                <p className="whitespace-pre-line text-[15px] leading-relaxed text-text-secondary">
                  {text}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ─── QR CODE ─── */}
        <section className="mb-16">
          <h2 className="mb-2 text-center text-2xl font-bold text-text-primary">
            {t('qrTitle')}
          </h2>
          <p className="mb-8 text-center text-sm text-text-muted">{t('qrSubtitle')}</p>
          <QRSection
            botUrl={BOT_URL}
            waUrl={waUrl}
            siteUrl={SITE_URL}
            downloadLabel={t('downloadQr')}
            labelTelegram={t('qrTelegram')}
            labelWhatsapp={t('qrWhatsapp')}
            labelWebsite={t('qrWebsite')}
          />
        </section>

        {/* ─── BOT LINK ─── */}
        <section className="mb-10">
          <h2 className="mb-4 text-xl font-bold text-text-primary">{t('botLinkTitle')}</h2>
          <div className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
            <code className="min-w-0 flex-1 truncate text-sm text-brand-primary">{BOT_URL}</code>
            <CopyButton text={BOT_URL} copiedLabel={t('copied')} />
          </div>
        </section>

        {/* ─── WHATSAPP BOT LINK ─── */}
        <section className="mb-10">
          <h2 className="mb-4 text-xl font-bold text-text-primary">{t('whatsappLinkTitle')}</h2>
          <div className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
            <code className="min-w-0 flex-1 truncate text-sm text-brand-primary">{waUrl}</code>
            <CopyButton text={waUrl} copiedLabel={t('copied')} />
          </div>
        </section>

        {/* ─── WEBSITE LINK ─── */}
        <section className="mb-10">
          <h2 className="mb-4 text-xl font-bold text-text-primary">{t('siteLinkTitle')}</h2>
          <div className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
            <code className="min-w-0 flex-1 truncate text-sm text-brand-primary">{SITE_URL}</code>
            <CopyButton text={SITE_URL} copiedLabel={t('copied')} />
          </div>
        </section>
      </main>

      <SiteFooter
        locale={locale}
        tagline={tLanding('footer.tagline')}
        privacy={tLanding('footer.privacy')}
        terms={tLanding('footer.terms')}
        contact={tLanding('footer.contact')}
        madeIn={tLanding('footer.madeIn')}
        copyright={tLanding('footer.copyright')}
        startTelegram={tLanding('footer.startTelegram')}
        startWhatsapp={tLanding('footer.startWhatsapp')}
        waUrl={waUrl}
      />
    </>
  );
}

import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { SitePage } from '@/components/site/SitePage';
import { SITE_URL, TELEGRAM_BOT_URL, whatsappStartUrl } from '@/src/site/config';
import { CopyButton, QrCodes } from './ShareClient';

// The share page (spec 2026-10-28-public-website §3.3): ready-made messages a parent sends a friend or a group, QR
// codes, and the three links, in the site's chrome. Reached by its own link only, and kept out of search (noindex).

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return { title: t('site.meta.share.title'), description: t('site.meta.share.description'), robots: { index: false, follow: false } };
}

export default async function SharePage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale });
  const waUrl = whatsappStartUrl(String(t.raw('bot.whatsapp.greeting')));
  const copy = { copyLabel: t('share.copy'), copiedLabel: t('share.copied') };
  const pitches = [
    { label: t('share.shortLabel'), text: t('share.msgShort') },
    { label: t('share.mediumLabel'), text: t('share.msgMedium') },
    { label: t('share.parentLabel'), text: t('share.msgParent') },
  ];
  const links = [
    { title: t('share.botLinkTitle'), url: TELEGRAM_BOT_URL },
    { title: t('share.whatsappLinkTitle'), url: waUrl },
    { title: t('share.siteLinkTitle'), url: SITE_URL },
  ];
  return (
    <SitePage locale={locale} path="/share">
      <main id="main" className="site-section site-page-main">
        <div className="site-wrap site-narrow">
          <h1 className="site-h1 site-page-title">{t('share.pageTitle')}</h1>
          <p className="site-lead">{t('share.pageSubtitle')}</p>

          <section className="site-share-block" aria-labelledby="share-messages">
            <h2 id="share-messages" className="site-h2">
              {t('share.messagesTitle')}
            </h2>
            <ul className="site-pitches">
              {pitches.map((pitch) => (
                <li key={pitch.label} className="site-pitch">
                  <div className="site-pitch-head">
                    <h3 className="site-pitch-label">{pitch.label}</h3>
                    <CopyButton text={pitch.text} {...copy} />
                  </div>
                  <p dir="auto">{pitch.text}</p>
                </li>
              ))}
            </ul>
          </section>

          <section className="site-share-block" aria-labelledby="share-qr">
            <h2 id="share-qr" className="site-h2">
              {t('share.qrTitle')}
            </h2>
            <p className="site-lead">{t('share.qrSubtitle')}</p>
            <QrCodes
              downloadLabel={t('share.downloadQr')}
              codes={[
                { label: t('share.qrTelegram'), value: TELEGRAM_BOT_URL, filename: 'famcal-qr-telegram.png' },
                { label: t('share.qrWhatsapp'), value: waUrl, filename: 'famcal-qr-whatsapp.png' },
                { label: t('share.qrWebsite'), value: SITE_URL, filename: 'famcal-qr-website.png' },
              ]}
            />
          </section>

          {links.map((link) => (
            <section key={link.url} className="site-share-block site-share-link" aria-label={link.title}>
              <h2 className="site-h3">{link.title}</h2>
              <div className="site-link-row">
                <code dir="ltr">{link.url}</code>
                <CopyButton text={link.url} {...copy} />
              </div>
            </section>
          ))}
        </div>
      </main>
    </SitePage>
  );
}

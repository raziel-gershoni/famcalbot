import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { Metadata, Viewport } from 'next';
import { routing } from '@/i18n/routing';
import { SITE_URL } from '@/src/site/config';
import { SITE_CLIENT_NAMESPACES, pickMessages } from '@/src/site/messages';
import { SITE_CSS_HREF } from '@/src/site/site-css';

// The public site's root layout (spec 2026-10-28-public-website §6.1): the landing, the blog, Privacy, Terms and the
// share page. The Mini App has its own root layout (../(app)/layout.tsx); moving between the two is a full page load.
//
// - Zoom is allowed (a document, read by anyone): the viewport sets no maximum and no userScalable. Light and dark
//   follow the device (color-scheme: light dark, and the style sheet's prefers-color-scheme); no script decides it.
// - No Telegram SDK: nothing here runs inside Telegram, and a visitor's browser has no use for it.
// - No web font: the app's system font stack, so there is no third party to load and none to name in the privacy policy.
// - Only the namespaces the site's client components read reach the client (SITE_CLIENT_NAMESPACES); the pages
//   themselves read their words on the server.
// - Static: every page is rendered per locale at build time (generateStaticParams, setRequestLocale).
// - The site's one style sheet (/site.css, versioned: the app's colour values, light and dark from the device's setting).

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
};

const OG_LOCALE: Record<string, string> = { en: 'en_US', he: 'he_IL', ru: 'ru_RU' };
// next-intl's zone for the client components (they format no date; without one, development logs a fallback warning)
const SITE_TIME_ZONE = 'Asia/Jerusalem';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return {
    metadataBase: new URL(SITE_URL),
    title: { default: t('landing.meta.title'), template: '%s | FamCal' },
    description: t('landing.meta.description'),
    keywords: t('site.meta.keywords'),
    authors: [{ name: 'FamCal' }],
    creator: 'FamCal',
    openGraph: {
      type: 'website',
      siteName: 'FamCal',
      locale: OG_LOCALE[locale] ?? OG_LOCALE.en,
      images: [{ url: '/og-image.png', width: 1200, height: 630, alt: t('landing.meta.ogImageAlt') }],
    },
    twitter: { card: 'summary_large_image', images: ['/og-image.png'] },
  };
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function SiteLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);
  const messages = pickMessages(await getMessages({ locale }), SITE_CLIENT_NAMESPACES);

  return (
    <html lang={locale} dir={locale === 'he' ? 'rtl' : 'ltr'}>
      <head>
        <link rel="stylesheet" href={SITE_CSS_HREF} />
      </head>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages} timeZone={SITE_TIME_ZONE}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

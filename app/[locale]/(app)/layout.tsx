import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { notFound } from 'next/navigation';
import Script from 'next/script';
import { locales, type Locale } from '@/i18n';
import type { Metadata, Viewport } from 'next';
import '../../globals.css';

// The Mini App's root layout (spec 2026-10-28-public-website §6.1): every page that opens inside Telegram, or in a
// browser from the bot's magic link. The public pages have their own root layout (../(site)/layout.tsx); moving
// between the two is a full page load. URLs don't change: route groups add nothing to the path.
//
// - The Telegram SDK loads before the app (beforeInteractive), so the pages read Telegram.WebApp on their first render.
// - No zoom (the Mini App is an app, not a document), 16 px inputs (iOS zooms into anything smaller) and
//   touch-action: manipulation (no double-tap zoom).
// - Every page here is private to its person: none is indexed. The tab's title, in a browser, is the brand alone.
// - The whole message catalogue reaches the client, as the pages read many namespaces.

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export const metadata: Metadata = {
  title: 'FamCal',
  robots: { index: false, follow: false },
};

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default async function AppLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!locales.includes(locale as Locale)) {
    notFound();
  }
  const messages = await getMessages();

  return (
    <html lang={locale} dir={locale === 'he' ? 'rtl' : 'ltr'}>
      <head>
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
        <style>{`
          /* Prevent iOS auto-zoom on input focus (requires 16px minimum) */
          input, select, textarea {
            font-size: 16px !important;
          }
          /* Disable touch manipulation zoom */
          html {
            touch-action: manipulation;
          }
        `}</style>
      </head>
      <body>
        <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}

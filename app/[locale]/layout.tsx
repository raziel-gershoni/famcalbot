import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { notFound } from 'next/navigation';
import Script from 'next/script';
import { locales } from '@/i18n';
import type { Metadata, Viewport } from 'next';
import '../globals.css';

// Disable zoom on mobile (especially important for Telegram WebApp)
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

const localeMetadata: Record<string, { title: string; description: string }> = {
  en: {
    title: "FamCal \u2014 Your Family\u2019s AI Calendar Assistant on Telegram",
    description: "FamCal merges your family\u2019s Google Calendars into one daily briefing \u2014 delivered as text and voice on Telegram. Smart pickup order, weather in context, Hebrew calendar support. Free during early access.",
  },
  he: {
    title: "FamCal \u2014 \u05d4\u05e2\u05d5\u05d6\u05e8 \u05d4\u05d7\u05db\u05dd \u05dc\u05dc\u05d5\u05d7 \u05d4\u05d6\u05de\u05e0\u05d9\u05dd \u05d4\u05de\u05e9\u05e4\u05d7\u05ea\u05d9 \u05d1\u05d8\u05dc\u05d2\u05e8\u05dd",
    description: "FamCal \u05de\u05de\u05d6\u05d2 \u05d0\u05ea \u05d9\u05d5\u05de\u05e0\u05d9 Google \u05e9\u05dc \u05db\u05dc \u05d4\u05de\u05e9\u05e4\u05d7\u05d4 \u05dc\u05e1\u05d9\u05db\u05d5\u05dd \u05d9\u05d5\u05de\u05d9 \u05d0\u05d7\u05d3 \u2014 \u05d8\u05e7\u05e1\u05d8 \u05d5\u05e7\u05d5\u05dc \u05d1\u05d8\u05dc\u05d2\u05e8\u05dd. \u05e1\u05d3\u05e8 \u05d0\u05d9\u05e1\u05d5\u05e3 \u05d9\u05dc\u05d3\u05d9\u05dd \u05d7\u05db\u05dd, \u05de\u05d6\u05d2 \u05d0\u05d5\u05d5\u05d9\u05e8 \u05d1\u05d4\u05e7\u05e9\u05e8 \u05dc\u05dc\u05d5\u05d7 \u05d4\u05d6\u05de\u05e0\u05d9\u05dd, \u05dc\u05d5\u05d7 \u05e2\u05d1\u05e8\u05d9. \u05d7\u05d9\u05e0\u05dd \u05d1\u05ea\u05e7\u05d5\u05e4\u05ea \u05d4\u05d4\u05e9\u05e7\u05d4.",
  },
  ru: {
    title: "FamCal \u2014 AI-\u0430\u0441\u0441\u0438\u0441\u0442\u0435\u043d\u0442 \u0441\u0435\u043c\u0435\u0439\u043d\u043e\u0433\u043e \u043a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u044f \u0432 Telegram",
    description: "FamCal \u043e\u0431\u044a\u0435\u0434\u0438\u043d\u044f\u0435\u0442 Google \u041a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u0438 \u0432\u0441\u0435\u0439 \u0441\u0435\u043c\u044c\u0438 \u0432 \u043e\u0434\u043d\u0443 \u0435\u0436\u0435\u0434\u043d\u0435\u0432\u043d\u0443\u044e \u0441\u0432\u043e\u0434\u043a\u0443 \u2014 \u0442\u0435\u043a\u0441\u0442 \u0438 \u0433\u043e\u043b\u043e\u0441 \u0432 Telegram. \u0423\u043c\u043d\u044b\u0439 \u043f\u043e\u0440\u044f\u0434\u043e\u043a \u0441\u0431\u043e\u0440\u0430 \u0434\u0435\u0442\u0435\u0439, \u043f\u043e\u0433\u043e\u0434\u0430 \u043f\u0440\u0438\u0432\u044f\u0437\u0430\u043d\u043d\u0430\u044f \u043a \u0440\u0430\u0441\u043f\u0438\u0441\u0430\u043d\u0438\u044e, \u0435\u0432\u0440\u0435\u0439\u0441\u043a\u0438\u0439 \u043a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u044c. \u0411\u0435\u0441\u043f\u043b\u0430\u0442\u043d\u043e \u0432 \u0440\u0430\u043d\u043d\u0435\u043c \u0434\u043e\u0441\u0442\u0443\u043f\u0435.",
  },
};

const ogLocaleMap: Record<string, string> = { en: 'en_US', he: 'he_IL', ru: 'ru_RU' };

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const meta = localeMetadata[locale] ?? localeMetadata.en;

  return {
    metadataBase: new URL('https://famcal.bot'),
    title: { default: meta.title, template: `%s | FamCal` },
    description: meta.description,
    keywords: 'family calendar, telegram bot, google calendar, kids schedule, pickup order, voice calendar, Hebrew calendar, Israeli families, family organizer, \u05dc\u05d5\u05d7 \u05d6\u05de\u05e0\u05d9\u05dd \u05de\u05e9\u05e4\u05d7\u05ea\u05d9, \u05d1\u05d5\u05d8 \u05d8\u05dc\u05d2\u05e8\u05dd, \u0441\u0435\u043c\u0435\u0439\u043d\u044b\u0439 \u043a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u044c',
    authors: [{ name: 'FamCal' }],
    creator: 'FamCal',
    alternates: {
      languages: { en: '/en', he: '/he', ru: '/ru' },
    },
    openGraph: {
      type: 'website',
      siteName: 'FamCal',
      locale: ogLocaleMap[locale] ?? 'en_US',
      images: [{
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'FamCal \u2014 Family Calendar Assistant on Telegram',
      }],
    },
    twitter: {
      card: 'summary_large_image',
      images: ['/og-image.png'],
    },
  };
}

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  // Await params (Next.js 15+ requirement)
  const { locale } = await params;

  // Validate locale
  if (!locales.includes(locale as any)) {
    notFound();
  }

  // Fetch messages for the locale
  const messages = await getMessages();

  return (
    <html lang={locale} dir={locale === 'he' ? 'rtl' : 'ltr'}>
      <head>
        {/* Google Fonts for landing page */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href={`https://fonts.googleapis.com/css2?family=${locale === 'he' ? 'Heebo' : 'Inter'}:wght@400;500;600;700&display=swap`}
          rel="stylesheet"
        />
        <Script
          src="https://telegram.org/js/telegram-web-app.js"
          strategy="beforeInteractive"
        />
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
        <NextIntlClientProvider messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

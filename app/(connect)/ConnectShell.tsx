import type { ReactNode } from 'react';
import Script from 'next/script';
import { NextIntlClientProvider } from 'next-intl';
import { getLocaleInfo, type Locale } from '@/src/utils/locale';
import enMessages from '@/messages/en.json';
import heMessages from '@/messages/he.json';
import ruMessages from '@/messages/ru.json';

// The document of a Google connect page (plan W4-3), which the page renders inside the group's pass-through
// layout (./layout.tsx, which loads the global CSS):
// - <html lang dir> in the page's language;
// - the page's <title>;
// - the Telegram SDK before hydration, only where the page runs inside Telegram (/refresh-token). The dashboard
//   reaches it with a full page load and no #tgWebAppData hash, and the SDK restores initData from its
//   sessionStorage copy; on a direct launch it stores the hash's initData for select-calendars, which comes next.
//   The two browser pages (the callback and the finish page) never load it;
// - a NextIntlClientProvider with `ui`, `pageGate` and the page's own namespaces. No date is formatted on these
//   pages, so the zone is only there to be set.
//
// Server-only: it reads the three messages files.

const MESSAGES = { en: enMessages, he: heMessages, ru: ruMessages };

export type ConnectNamespace = keyof typeof enMessages;

export const TELEGRAM_SDK = 'https://telegram.org/js/telegram-web-app.js';

export interface ConnectShellProps {
  locale: Locale;
  /** The page's own namespaces, beside `ui` and `pageGate`. */
  namespaces: ConnectNamespace[];
  /** The document's title. */
  title: string;
  /** Load the Telegram SDK before hydration (the page runs inside Telegram). */
  telegram?: boolean;
  children: ReactNode;
}

export function ConnectShell({ locale, namespaces, title, telegram = false, children }: ConnectShellProps) {
  const { dir } = getLocaleInfo(locale);
  const all = MESSAGES[locale];
  const messages = Object.fromEntries((['ui', 'pageGate', ...namespaces] as ConnectNamespace[]).map((n) => [n, all[n]]));
  return (
    <html lang={locale} dir={dir}>
      <head>
        <title>{title}</title>
        {telegram ? <Script src={TELEGRAM_SDK} strategy="beforeInteractive" /> : null}
      </head>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
